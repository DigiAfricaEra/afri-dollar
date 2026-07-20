/* eslint-disable @typescript-eslint/unbound-method */
import type { Response } from 'express';

import { WebhookController } from '../../controllers/webhook.controller';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { WebhookService } from '../../services/webhook.service';

jest.mock('../../services/webhook.service', () => ({
  WebhookService: {
    createWebhook: jest.fn(),
    listWebhooks: jest.fn(),
    toggleWebhook: jest.fn(),
    deleteWebhook: jest.fn(),
    testWebhook: jest.fn(),
    getDeliveries: jest.fn(),
  },
}));

const mockCreateWebhook = WebhookService.createWebhook as jest.Mock;
const mockListWebhooks = WebhookService.listWebhooks as jest.Mock;
const mockToggleWebhook = WebhookService.toggleWebhook as jest.Mock;
const mockDeleteWebhook = WebhookService.deleteWebhook as jest.Mock;
const mockTestWebhook = WebhookService.testWebhook as jest.Mock;
const mockGetDeliveries = WebhookService.getDeliveries as jest.Mock;

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

function createAuthRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    body: {},
    params: {},
    query: {},
    user: { userId: 'user-1', email: 'user@example.com', role: 'USER', iat: 0, exp: 0 },
    ...overrides,
  } as AuthRequest;
}

describe('WebhookController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createWebhook', () => {
    it('should return 401 if not authenticated', async () => {
      const req = createAuthRequest({ user: undefined });
      const res = createMockResponse();

      await WebhookController.createWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('should create a webhook and return 201', async () => {
      const req = createAuthRequest({
        body: {
          url: 'https://example.com/hook',
          events: ['transaction.completed'],
        },
      });
      const res = createMockResponse();

      const mockResult = {
        id: 'wh-1',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        active: true,
        secret: 'test-secret',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockCreateWebhook.mockResolvedValue(mockResult);

      await WebhookController.createWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(201);
      expect(res.body).toEqual({ success: true, data: mockResult });
    });

    it('should return 400 on validation error', async () => {
      const req = createAuthRequest({
        body: {
          url: 'not-a-url',
          events: [],
        },
      });
      const res = createMockResponse();

      await WebhookController.createWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('listWebhooks', () => {
    it('should return 401 if not authenticated', async () => {
      const req = createAuthRequest({ user: undefined });
      const res = createMockResponse();

      await WebhookController.listWebhooks(req, res as unknown as Response);

      expect(res.statusCode).toBe(401);
    });

    it('should list webhooks and return 200', async () => {
      const req = createAuthRequest();
      const res = createMockResponse();

      mockListWebhooks.mockResolvedValue([]);

      await WebhookController.listWebhooks(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true, data: [] });
    });
  });

  describe('toggleWebhook', () => {
    it('should return 401 if not authenticated', async () => {
      const req = createAuthRequest({ user: undefined, params: { id: 'wh-1' } });
      const res = createMockResponse();

      await WebhookController.toggleWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(401);
    });

    it('should toggle a webhook and return 200', async () => {
      const req = createAuthRequest({ params: { id: 'wh-1' } });
      const res = createMockResponse();

      mockToggleWebhook.mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        active: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await WebhookController.toggleWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
    });

    it('should return 404 if webhook not found', async () => {
      const req = createAuthRequest({ params: { id: 'wh-999' } });
      const res = createMockResponse();

      mockToggleWebhook.mockRejectedValue(new Error('Webhook not found'));

      await WebhookController.toggleWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(404);
    });
  });

  describe('deleteWebhook', () => {
    it('should return 401 if not authenticated', async () => {
      const req = createAuthRequest({ user: undefined, params: { id: 'wh-1' } });
      const res = createMockResponse();

      await WebhookController.deleteWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(401);
    });

    it('should delete a webhook and return 200', async () => {
      const req = createAuthRequest({ params: { id: 'wh-1' } });
      const res = createMockResponse();

      mockDeleteWebhook.mockResolvedValue(undefined);

      await WebhookController.deleteWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('should return 404 if webhook not found', async () => {
      const req = createAuthRequest({ params: { id: 'wh-999' } });
      const res = createMockResponse();

      mockDeleteWebhook.mockRejectedValue(new Error('Webhook not found'));

      await WebhookController.deleteWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(404);
    });
  });

  describe('testWebhook', () => {
    it('should return 401 if not authenticated', async () => {
      const req = createAuthRequest({ user: undefined, params: { id: 'wh-1' } });
      const res = createMockResponse();

      await WebhookController.testWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(401);
    });

    it('should test a webhook and return 200', async () => {
      const req = createAuthRequest({ params: { id: 'wh-1' } });
      const res = createMockResponse();

      const mockDelivery = {
        id: 'del-1',
        webhookId: 'wh-1',
        eventType: 'webhook.test',
        payload: {},
        status: 'delivered',
        statusCode: 200,
        attemptCount: 1,
        maxAttempts: 1,
        deliveredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockTestWebhook.mockResolvedValue(mockDelivery);

      await WebhookController.testWebhook(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('getDeliveries', () => {
    it('should return 401 if not authenticated', async () => {
      const req = createAuthRequest({ user: undefined, params: { id: 'wh-1' }, query: {} });
      const res = createMockResponse();

      await WebhookController.getDeliveries(req, res as unknown as Response);

      expect(res.statusCode).toBe(401);
    });

    it('should return deliveries with pagination', async () => {
      const req = createAuthRequest({
        params: { id: 'wh-1' },
        query: { limit: '10' },
      });
      const res = createMockResponse();

      mockGetDeliveries.mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 10, hasMore: false },
      });

      await WebhookController.getDeliveries(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
    });
  });
});
