/* eslint-disable */
import prisma from '../../config/database';
import { WebhookService } from '../../services/webhook.service';

jest.mock('../../config/database', () => {
  const mockFn = () => jest.fn();
  const client: Record<string, unknown> = {
    webhookConfig: {
      create: mockFn(),
      findMany: mockFn(),
      findUnique: mockFn(),
      delete: mockFn(),
    },
    webhookDelivery: {
      create: mockFn(),
      findMany: mockFn(),
      findUnique: mockFn(),
      update: mockFn(),
      count: mockFn(),
    },
  };
  client.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') return arg(client);
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  });
  return { __esModule: true, default: client };
});

jest.mock('../../utils/webhook', () => ({
  generateWebhookSecret: jest.fn(() => 'test-secret-hex-value-32-bytes-long'),
  signWebhookPayload: jest.fn(() => 'sha256=test-signature'),
  verifyWebhookSignature: jest.fn(() => true),
}));

jest.mock('../../utils/crypto', () => ({
  encrypt: jest.fn((val: string) => `encrypted:${val}`),
  decrypt: jest.fn((val: string) => val.replace('encrypted:', '')),
}));

const mockWebhookConfigCreate = prisma.webhookConfig.create as jest.Mock;
const mockWebhookConfigFindMany = prisma.webhookConfig.findMany as jest.Mock;
const mockWebhookConfigFindUnique = prisma.webhookConfig.findUnique as jest.Mock;
const mockWebhookConfigDelete = prisma.webhookConfig.delete as jest.Mock;
const mockWebhookDeliveryCreate = prisma.webhookDelivery.create as jest.Mock;
const mockWebhookDeliveryFindMany = prisma.webhookDelivery.findMany as jest.Mock;
const mockWebhookDeliveryUpdate = prisma.webhookDelivery.update as jest.Mock;
const mockWebhookDeliveryCount = prisma.webhookDelivery.count as jest.Mock;

describe('WebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createWebhook', () => {
    it('should create a webhook and return config with secret', async () => {
      const mockWebhook = {
        id: 'wh-1',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        active: true,
        headers: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWebhookConfigCreate.mockResolvedValue(mockWebhook);

      const result = await WebhookService.createWebhook(
        { url: 'https://example.com/hook', events: ['transaction.completed'] },
        'user-1'
      );

      expect(result.id).toBe('wh-1');
      expect(result.secret).toBeDefined();
      expect(result.url).toBe('https://example.com/hook');
      expect(mockWebhookConfigCreate).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          url: 'https://example.com/hook',
          events: ['transaction.completed'],
          secret: 'encrypted:test-secret-hex-value-32-bytes-long',
          headers: undefined,
        },
      });
    });

    it('should include custom headers when provided', async () => {
      const mockWebhook = {
        id: 'wh-2',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['wallet.created'],
        active: true,
        headers: { 'X-Custom': 'value' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWebhookConfigCreate.mockResolvedValue(mockWebhook);

      await WebhookService.createWebhook(
        {
          url: 'https://example.com/hook',
          events: ['wallet.created'],
          headers: { 'X-Custom': 'value' },
        },
        'user-1'
      );

      expect(mockWebhookConfigCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            headers: { 'X-Custom': 'value' },
          }),
        })
      );
    });
  });

  describe('listWebhooks', () => {
    it('should return all webhooks for a user', async () => {
      const mockWebhooks = [
        {
          id: 'wh-1',
          userId: 'user-1',
          url: 'https://example.com/hook',
          events: ['transaction.completed'],
          active: true,
          headers: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      mockWebhookConfigFindMany.mockResolvedValue(mockWebhooks);

      const result = await WebhookService.listWebhooks('user-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('wh-1');
      expect(mockWebhookConfigFindMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('deleteWebhook', () => {
    it('should delete a webhook owned by the user', async () => {
      mockWebhookConfigFindUnique.mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
      });
      mockWebhookConfigDelete.mockResolvedValue({});

      await WebhookService.deleteWebhook('wh-1', 'user-1');

      expect(mockWebhookConfigDelete).toHaveBeenCalledWith({ where: { id: 'wh-1' } });
    });

    it('should throw if webhook not found', async () => {
      mockWebhookConfigFindUnique.mockResolvedValue(null);

      await expect(WebhookService.deleteWebhook('wh-999', 'user-1')).rejects.toThrow(
        'Webhook not found'
      );
    });

    it('should throw if webhook belongs to different user', async () => {
      mockWebhookConfigFindUnique.mockResolvedValue({
        id: 'wh-1',
        userId: 'user-2',
      });

      await expect(WebhookService.deleteWebhook('wh-1', 'user-1')).rejects.toThrow(
        'Webhook not found'
      );
    });
  });

  describe('emitEvent', () => {
    it('should create deliveries for matching webhooks', async () => {
      const mockWebhooks = [
        {
          id: 'wh-1',
          userId: 'user-1',
          url: 'https://example.com/hook',
          events: ['transaction.completed'],
          secret: 'encrypted:secret123',
          active: true,
          headers: null,
        },
      ];
      mockWebhookConfigFindMany.mockResolvedValue(mockWebhooks);
      mockWebhookDeliveryCreate.mockResolvedValue({
        id: 'del-1',
        webhookId: 'wh-1',
        eventType: 'transaction.completed',
        payload: {},
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await WebhookService.emitEvent({
        eventType: 'transaction.completed',
        payload: { transactionId: 'tx-1' },
        userId: 'user-1',
      });

      expect(mockWebhookDeliveryCreate).toHaveBeenCalled();
    });

    it('should not create deliveries when no matching webhooks', async () => {
      mockWebhookConfigFindMany.mockResolvedValue([]);

      await WebhookService.emitEvent({
        eventType: 'transaction.completed',
        payload: { transactionId: 'tx-1' },
        userId: 'user-1',
      });

      expect(mockWebhookDeliveryCreate).not.toHaveBeenCalled();
    });

    it('should not throw on emit errors', async () => {
      mockWebhookConfigFindMany.mockRejectedValue(new Error('DB error'));

      await expect(
        WebhookService.emitEvent({
          eventType: 'transaction.completed',
          payload: {},
          userId: 'user-1',
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('testWebhook', () => {
    it('should test a webhook and return delivery result', async () => {
      const mockWebhook = {
        id: 'wh-1',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        secret: 'encrypted:secret123',
        active: true,
        headers: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockWebhookConfigFindUnique.mockResolvedValue(mockWebhook);
      mockWebhookDeliveryCreate.mockResolvedValue({
        id: 'del-test',
        webhookId: 'wh-1',
        eventType: 'webhook.test',
        payload: {},
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockWebhookDeliveryUpdate.mockResolvedValue({
        id: 'del-test',
        webhookId: 'wh-1',
        eventType: 'webhook.test',
        payload: {},
        status: 'delivered',
        statusCode: 200,
        response: 'OK',
        attemptCount: 1,
        maxAttempts: 1,
        deliveredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('OK'),
      });

      const result = await WebhookService.testWebhook('wh-1', 'user-1');

      expect(result.status).toBe('delivered');
      expect(result.statusCode).toBe(200);

      jest.restoreAllMocks();
    });

    it('should throw if webhook not found', async () => {
      mockWebhookConfigFindUnique.mockResolvedValue(null);

      await expect(WebhookService.testWebhook('wh-999', 'user-1')).rejects.toThrow(
        'Webhook not found'
      );
    });
  });

  describe('getDeliveries', () => {
    it('should return paginated deliveries', async () => {
      mockWebhookConfigFindUnique.mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
      });

      const mockDeliveries = [
        {
          id: 'del-1',
          webhookId: 'wh-1',
          eventType: 'transaction.completed',
          payload: { txId: 'tx-1' },
          statusCode: 200,
          response: 'OK',
          error: null,
          attemptCount: 1,
          maxAttempts: 5,
          status: 'delivered',
          nextRetryAt: null,
          deliveredAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      mockWebhookDeliveryFindMany.mockResolvedValue(mockDeliveries);
      mockWebhookDeliveryCount.mockResolvedValue(1);

      const result = await WebhookService.getDeliveries('wh-1', 'user-1', { limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('should throw if webhook not found', async () => {
      mockWebhookConfigFindUnique.mockResolvedValue(null);

      await expect(WebhookService.getDeliveries('wh-999', 'user-1')).rejects.toThrow(
        'Webhook not found'
      );
    });
  });
});
