import Bull, { Job } from 'bull';

import {
  WEBHOOK_DELIVERY_QUEUE,
  WEBHOOK_DELIVERY_CONCURRENCY,
  type WebhookDeliveryJobPayload,
} from '../types/webhook.types';

import { WebhookService, getDeliveryQueue, closeDeliveryQueue } from './webhook.service';

export class WebhookDeliveryWorker {
  private queue: Bull.Queue<WebhookDeliveryJobPayload> | null = null;
  private status: 'disabled' | 'ready' | 'error' = 'disabled';

  async start(): Promise<void> {
    if (this.queue) {
      return;
    }

    if (!process.env.REDIS_URL) {
      this.status = 'disabled';
      console.warn('Webhook delivery worker disabled: REDIS_URL is not configured');
      return;
    }

    this.queue = getDeliveryQueue();
    if (!this.queue) {
      this.status = 'disabled';
      return;
    }

    this.queue.on('error', (error: Error) => {
      this.status = 'error';
      console.error('Webhook delivery worker Redis error:', error);
    });

    void this.queue.process(
      WEBHOOK_DELIVERY_QUEUE,
      WEBHOOK_DELIVERY_CONCURRENCY,
      async (job: Job<WebhookDeliveryJobPayload>): Promise<void> => {
        await WebhookService.processDelivery(job.data);
      }
    );

    this.status = 'ready';
    console.log('Webhook delivery worker started');
  }

  async stop(): Promise<void> {
    this.queue = null;
    await closeDeliveryQueue();
    this.status = 'disabled';
  }

  getStatus(): string {
    return this.status;
  }
}

export const webhookDeliveryWorker = new WebhookDeliveryWorker();
