/* eslint-disable */
import type { Server } from 'http';

import prisma from '../../config/database';

jest.mock('../../middleware/auth.middleware', () => ({
  ...jest.requireActual('../../middleware/auth.middleware'),
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: 'user-1', email: 'user@example.com', role: 'USER', iat: 0, exp: 0 };
    next();
  },
}));

jest.mock('../../config/database', () => {
  const mockFn = () => jest.fn();
  const client: Record<string, unknown> = {
    webhookConfig: {
      create: mockFn(),
      findMany: mockFn(),
      findUnique: mockFn(),
      update: mockFn(),
      delete: mockFn(),
    },
    webhookDelivery: {
      create: mockFn(),
      findMany: mockFn(),
      findUnique: mockFn(),
      update: mockFn(),
      count: mockFn(),
    },
    $connect: mockFn(),
    $disconnect: mockFn(),
  };
  client.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') return arg(client);
    if (Array.isArray(arg)) return Promise.all(arg);
    return arg;
  });
  return { __esModule: true, default: client };
});

jest.mock('../../utils/crypto', () => ({
  encrypt: jest.fn((text: string) => `encrypted:${text}`),
  decrypt: jest.fn((text: string) => text.replace('encrypted:', '')),
}));

describe('Webhook routes (integration)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = await import('../../index');
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address && typeof address === 'object') {
      baseUrl = `http://127.0.0.1:${address.port}`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/webhooks', () => {
    it('should create a webhook', async () => {
      const mockWebhook = {
        id: 'wh-1',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        active: true,
        headers: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      (prisma.webhookConfig.create as jest.Mock).mockResolvedValue(mockWebhook);

      const response = await fetch(`${baseUrl}/api/v1/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://example.com/hook',
          events: ['transaction.completed'],
        }),
      });

      const data = (await response.json()) as { success: boolean };
      expect(response.status).toBe(201);
      expect(data.success).toBe(true);
    });

    it('should return 400 for invalid body', async () => {
      const response = await fetch(`${baseUrl}/api/v1/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url', events: [] }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/v1/webhooks', () => {
    it('should list webhooks', async () => {
      (prisma.webhookConfig.findMany as jest.Mock).mockResolvedValue([]);

      const response = await fetch(`${baseUrl}/api/v1/webhooks`);
      const data = (await response.json()) as { success: boolean; data: unknown[] };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual([]);
    });
  });

  describe('DELETE /api/v1/webhooks/:id', () => {
    it('should delete a webhook', async () => {
      (prisma.webhookConfig.findUnique as jest.Mock).mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
      });
      (prisma.webhookConfig.delete as jest.Mock).mockResolvedValue({});

      const response = await fetch(`${baseUrl}/api/v1/webhooks/wh-1`, {
        method: 'DELETE',
      });

      const data = (await response.json()) as { success: boolean };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it('should return 404 for non-existent webhook', async () => {
      (prisma.webhookConfig.findUnique as jest.Mock).mockResolvedValue(null);

      const response = await fetch(`${baseUrl}/api/v1/webhooks/wh-999`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/webhooks/:id/toggle', () => {
    it('should toggle a webhook', async () => {
      (prisma.webhookConfig.findUnique as jest.Mock).mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
        active: true,
      });
      (prisma.webhookConfig.update as jest.Mock).mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
        url: 'https://example.com/hook',
        events: ['transaction.completed'],
        active: false,
        headers: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await fetch(`${baseUrl}/api/v1/webhooks/wh-1/toggle`, {
        method: 'PATCH',
      });

      const data = (await response.json()) as { success: boolean };
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });
  });

  describe('GET /api/v1/webhooks/:id/deliveries', () => {
    it('should return deliveries', async () => {
      (prisma.webhookConfig.findUnique as jest.Mock).mockResolvedValue({
        id: 'wh-1',
        userId: 'user-1',
      });
      (prisma.webhookDelivery.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.webhookDelivery.count as jest.Mock).mockResolvedValue(0);

      const response = await fetch(`${baseUrl}/api/v1/webhooks/wh-1/deliveries`);
      const data = (await response.json()) as { success: boolean; data: unknown[] };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data).toEqual([]);
    });
  });
});
