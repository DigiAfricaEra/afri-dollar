import { Prisma } from '@afri-dollar/database';
import Bull from 'bull';

import prisma from '../config/database';
import {
  WEBHOOK_DELIVERY_QUEUE,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_DELIVERY_TIMEOUT_MS,
  WEBHOOK_RETRYABLE_STATUS_CODES,
  type WebhookDeliveryJobPayload,
  type CreateWebhookOptions,
  type EmitWebhookEventOptions,
  type WebhookConfigResponse,
  type WebhookConfigWithSecret,
  type WebhookDeliveryResponse,
  type ListWebhookDeliveriesOptions,
} from '../types/webhook.types';
import { decrypt, encrypt } from '../utils/crypto';
import { generateWebhookSecret, signWebhookPayload } from '../utils/webhook';

type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

function mapDeliveryRecord(record: {
  id: string;
  webhookId: string;
  eventType: string;
  payload: unknown;
  statusCode: number | null;
  response: string | null;
  error: string | null;
  attemptCount: number;
  maxAttempts: number;
  status: string;
  nextRetryAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): WebhookDeliveryResponse {
  return {
    id: record.id,
    webhookId: record.webhookId,
    eventType: record.eventType,
    payload: (record.payload as Record<string, unknown>) || {},
    statusCode: record.statusCode ?? undefined,
    response: record.response ?? undefined,
    error: record.error ?? undefined,
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    status: (['pending', 'delivered', 'failed', 'retrying'].includes(record.status)
      ? record.status
      : 'pending') as DeliveryStatus,
    nextRetryAt: record.nextRetryAt ?? undefined,
    deliveredAt: record.deliveredAt ?? undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapConfigRecord(record: {
  id: string;
  userId: string;
  url: string;
  events: string[];
  active: boolean;
  headers: unknown;
  createdAt: Date;
  updatedAt: Date;
}): WebhookConfigResponse {
  return {
    id: record.id,
    userId: record.userId,
    url: record.url,
    events: record.events,
    active: record.active,
    headers: (record.headers as Record<string, string>) || undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createDeliveryQueue(): Bull.Queue<WebhookDeliveryJobPayload> | null {
  if (!process.env.REDIS_URL) {
    return null;
  }

  const queue = new Bull<WebhookDeliveryJobPayload>(WEBHOOK_DELIVERY_QUEUE, process.env.REDIS_URL, {
    settings: {
      retryProcessDelay: 5000,
    },
  });

  queue.on('error', (error: Error) => {
    console.error('Webhook delivery queue Redis error:', error);
  });

  return queue;
}

export const WebhookService = {
  async createWebhook(
    options: CreateWebhookOptions,
    userId: string
  ): Promise<WebhookConfigWithSecret> {
    const rawSecret = generateWebhookSecret();
    const encryptedSecret = encrypt(rawSecret);

    const webhook = await prisma.webhookConfig.create({
      data: {
        userId,
        url: options.url,
        events: options.events,
        secret: encryptedSecret,
        headers: options.headers || undefined,
      },
    });

    return {
      ...mapConfigRecord(webhook),
      secret: rawSecret,
    };
  },

  async listWebhooks(userId: string): Promise<WebhookConfigResponse[]> {
    const webhooks = await prisma.webhookConfig.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return webhooks.map(mapConfigRecord);
  },

  async deleteWebhook(webhookId: string, userId: string): Promise<void> {
    const webhook = await prisma.webhookConfig.findUnique({
      where: { id: webhookId },
    });

    if (!webhook) {
      throw new Error('Webhook not found');
    }

    if (webhook.userId !== userId) {
      throw new Error('Webhook not found');
    }

    await prisma.webhookConfig.delete({
      where: { id: webhookId },
    });
  },

  async emitEvent(options: EmitWebhookEventOptions): Promise<void> {
    try {
      const where: Record<string, unknown> = {
        active: true,
        events: { has: options.eventType },
      };

      if (options.userId) {
        where.userId = options.userId;
      }

      const matchingWebhooks = await prisma.webhookConfig.findMany({
        where,
      });

      if (matchingWebhooks.length === 0) {
        return;
      }

      for (const webhook of matchingWebhooks) {
        const delivery = await prisma.webhookDelivery.create({
          data: {
            webhookId: webhook.id,
            eventType: options.eventType,
            payload: options.payload as Prisma.InputJsonValue,
            status: 'pending',
            maxAttempts: WEBHOOK_MAX_ATTEMPTS,
          },
        });

        await this.enqueueDelivery({
          deliveryId: delivery.id,
          webhookId: webhook.id,
          eventType: options.eventType,
          payload: options.payload,
          url: webhook.url,
          secret: webhook.secret,
          headers: (webhook.headers as Record<string, string>) || undefined,
        });
      }
    } catch (error) {
      console.error('Failed to emit webhook event:', error);
    }
  },

  async enqueueDelivery(payload: WebhookDeliveryJobPayload): Promise<void> {
    if (!process.env.REDIS_URL) {
      await processDeliveryInline(payload);
      return;
    }

    try {
      const queue = createDeliveryQueue();
      if (!queue) {
        await processDeliveryInline(payload);
        return;
      }

      await queue.add('deliver', payload, {
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      });

      await queue.close();
    } catch (error) {
      console.error('Failed to enqueue webhook delivery, falling back to inline:', error);
      await processDeliveryInline(payload);
    }
  },

  async processDelivery(payload: WebhookDeliveryJobPayload): Promise<void> {
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: payload.deliveryId },
    });

    if (!delivery) {
      return;
    }

    if (delivery.status === 'delivered') {
      return;
    }

    if (delivery.attemptCount >= delivery.maxAttempts) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          error: 'Max retry attempts exceeded',
        },
      });
      return;
    }

    const decryptedSecret = decrypt(payload.secret);
    const body = JSON.stringify(payload.payload);
    const signature = signWebhookPayload(body, decryptedSecret);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
      'X-Webhook-Id': payload.webhookId,
      'X-Webhook-Event': payload.eventType,
      'X-Webhook-Delivery': payload.deliveryId,
      'X-Webhook-Timestamp': Math.floor(Date.now() / 1000).toString(),
      ...(payload.headers || {}),
    };

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attemptCount: delivery.attemptCount + 1,
        status: 'retrying',
      },
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS);

      const response = await fetch(payload.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseText = await response.text().catch(() => '');

      if (response.ok) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'delivered',
            statusCode: response.status,
            response: responseText.slice(0, 1000),
            deliveredAt: new Date(),
          },
        });
        return;
      }

      if (!WEBHOOK_RETRYABLE_STATUS_CODES.includes(response.status)) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'delivered',
            statusCode: response.status,
            response: responseText.slice(0, 1000),
            deliveredAt: new Date(),
          },
        });
        return;
      }

      const nextRetryAt = calculateNextRetryTime(delivery.attemptCount);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'retrying',
          statusCode: response.status,
          response: responseText.slice(0, 1000),
          nextRetryAt,
        },
      });
    } catch (fetchError: unknown) {
      const errorMessage =
        fetchError instanceof Error ? fetchError.message : 'Unknown delivery error';

      if (delivery.attemptCount + 1 >= delivery.maxAttempts) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'failed',
            error: errorMessage,
          },
        });
        return;
      }

      const nextRetryAt = calculateNextRetryTime(delivery.attemptCount);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'retrying',
          error: errorMessage,
          nextRetryAt,
        },
      });
    }
  },

  async testWebhook(webhookId: string, userId: string): Promise<WebhookDeliveryResponse> {
    const webhook = await prisma.webhookConfig.findUnique({
      where: { id: webhookId },
    });

    if (!webhook) {
      throw new Error('Webhook not found');
    }

    if (webhook.userId !== userId) {
      throw new Error('Webhook not found');
    }

    const testPayload = {
      event: 'webhook.test',
      timestamp: new Date().toISOString(),
      data: {
        message: 'This is a test webhook delivery',
        webhookId: webhook.id,
      },
    };

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        eventType: 'webhook.test',
        payload: testPayload,
        status: 'pending',
        maxAttempts: 1,
      },
    });

    const decryptedSecret = decrypt(webhook.secret);
    const body = JSON.stringify(testPayload);
    const signature = signWebhookPayload(body, decryptedSecret);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature,
      'X-Webhook-Id': webhook.id,
      'X-Webhook-Event': 'webhook.test',
      'X-Webhook-Delivery': delivery.id,
      'X-Webhook-Timestamp': Math.floor(Date.now() / 1000).toString(),
      ...((webhook.headers as Record<string, string>) || {}),
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseText = await response.text().catch(() => '');

      const updatedDelivery = await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: response.ok ? 'delivered' : 'failed',
          statusCode: response.status,
          response: responseText.slice(0, 1000),
          attemptCount: 1,
          deliveredAt: response.ok ? new Date() : null,
          error: response.ok ? null : `HTTP ${response.status}`,
        },
      });

      return mapDeliveryRecord(updatedDelivery);
    } catch (fetchError: unknown) {
      const errorMessage =
        fetchError instanceof Error ? fetchError.message : 'Unknown delivery error';

      const updatedDelivery = await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'failed',
          attemptCount: 1,
          error: errorMessage,
        },
      });

      return mapDeliveryRecord(updatedDelivery);
    }
  },

  async getDeliveries(
    webhookId: string,
    userId: string,
    options: ListWebhookDeliveriesOptions = {}
  ): Promise<{
    data: WebhookDeliveryResponse[];
    pagination: { total: number; limit: number; hasMore: boolean };
  }> {
    const webhook = await prisma.webhookConfig.findUnique({
      where: { id: webhookId },
    });

    if (!webhook) {
      throw new Error('Webhook not found');
    }

    if (webhook.userId !== userId) {
      throw new Error('Webhook not found');
    }

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    const where = { webhookId };

    const [deliveries, total] = await Promise.all([
      prisma.webhookDelivery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      }),
      prisma.webhookDelivery.count({ where }),
    ]);

    const hasMore = deliveries.length > limit;
    const result = hasMore ? deliveries.slice(0, limit) : deliveries;

    return {
      data: result.map(mapDeliveryRecord),
      pagination: {
        total,
        limit,
        hasMore,
      },
    };
  },

  async retryPendingDeliveries(): Promise<void> {
    const pendingDeliveries = await prisma.webhookDelivery.findMany({
      where: {
        status: 'retrying',
        nextRetryAt: { lte: new Date() },
      },
      take: 50,
    });

    for (const delivery of pendingDeliveries) {
      if (delivery.attemptCount >= delivery.maxAttempts) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'failed',
            error: 'Max retry attempts exceeded',
          },
        });
        continue;
      }

      const webhook = await prisma.webhookConfig.findUnique({
        where: { id: delivery.webhookId },
      });

      if (!webhook?.active) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'failed', error: 'Webhook config not found or inactive' },
        });
        continue;
      }

      await this.enqueueDelivery({
        deliveryId: delivery.id,
        webhookId: webhook.id,
        eventType: delivery.eventType,
        payload: (delivery.payload as Record<string, unknown>) || {},
        url: webhook.url,
        secret: webhook.secret,
        headers: (webhook.headers as Record<string, string>) || undefined,
      });
    }
  },
};

async function processDeliveryInline(payload: WebhookDeliveryJobPayload): Promise<void> {
  await WebhookService.processDelivery(payload);
}

function calculateBackoffDelay(attempt: number): number {
  const baseDelay = 1000;
  const maxDelay = 300_000;
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}

function calculateNextRetryTime(attemptCount: number): Date {
  const delayMs = calculateBackoffDelay(attemptCount);
  return new Date(Date.now() + delayMs);
}
