/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/prefer-nullish-coalescing */
import http from 'http';

import type { NextFunction, Response } from 'express';

import prisma from '../../config/database';
import type { AuthRequest } from '../../middleware/auth.middleware';
import { getStorageAdapter } from '../../services/report.helpers';

jest.mock('../../config/database', () => {
  const reportsStore = new Map<string, Record<string, unknown>>();

  const client: Record<string, unknown> = {
    user: {
      upsert: jest.fn(async ({ where, create }) => ({ id: where.id, ...create })),
      delete: jest.fn(async () => ({})),
    },
    reportRequest: {
      create: jest.fn(async ({ data }) => {
        const item = {
          id: data.id || 'report_' + Date.now(),
          userId: data.userId,
          reportType: data.reportType,
          format: data.format,
          parameters: data.parameters || {},
          status: data.status || 'pending',
          createdAt: new Date(),
          completedAt: data.completedAt || null,
          downloadUrl: data.downloadUrl || null,
          storageKey: data.storageKey || null,
          mimeType: data.mimeType || null,
          fileSizeBytes: data.fileSizeBytes || null,
        };
        reportsStore.set(item.id, item);
        return item;
      }),
      findUnique: jest.fn(async ({ where }) => {
        return reportsStore.get(where.id) || null;
      }),
      findMany: jest.fn(async ({ where }) => {
        return Array.from(reportsStore.values()).filter((r) => r.userId === where.userId);
      }),
      count: jest.fn(async () => reportsStore.size),
      updateMany: jest.fn(async ({ where, data }) => {
        const item = reportsStore.get(where.id);
        if (item) {
          Object.assign(item, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
      update: jest.fn(async ({ where, data }) => {
        const item = reportsStore.get(where.id);
        if (item) {
          Object.assign(item, data);
          return item;
        }
        return null;
      }),
      deleteMany: jest.fn(async () => {
        reportsStore.clear();
        return { count: 0 };
      }),
    },
    transaction: {
      findMany: jest.fn(async () => []),
    },
  };

  return {
    __esModule: true,
    default: client,
    __reportsStore: reportsStore,
  };
});

jest.mock('../../middleware/auth.middleware', () => {
  const actual = jest.requireActual('../../middleware/auth.middleware');

  return {
    ...actual,
    authMiddleware: (req: AuthRequest, _res: Response, next: NextFunction): void => {
      const authHeader = req.header('authorization');
      const userId = authHeader === 'Bearer other-user' ? 'user-other' : 'user-test-1';
      const role = authHeader === 'Bearer admin-user' ? 'ADMIN' : 'USER';

      req.user = {
        userId,
        email: `${userId}@example.com`,
        role,
        iat: 0,
        exp: 0,
      };
      next();
    },
  };
});

describe('Report Routes Integration Tests', () => {
  let server: http.Server | null = null;
  let baseUrl: string;

  beforeAll(async () => {
    const { app } = await import('../../index');

    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server?.once('listening', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected server to listen on a TCP port');
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('POST /api/v1/reports creates a report request', async () => {
    const res = await fetch(`${baseUrl}/api/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        reportType: 'transaction-history',
        format: 'csv',
      }),
    });

    const body = (await res.json()) as { success: boolean; data: { id: string; status: string } };

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.id).toBeDefined();
    expect(['pending', 'completed']).toContain(body.data.status);
  });

  it('GET /api/v1/reports/:id checks status and validates ownership', async () => {
    const report = await prisma.reportRequest.create({
      data: {
        userId: 'user-test-1',
        reportType: 'transaction_history',
        format: 'csv',
        status: 'completed',
      },
    });

    // Valid owner
    const res1 = await fetch(`${baseUrl}/api/v1/reports/${report.id}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res1.status).toBe(200);

    // Other user
    const res2 = await fetch(`${baseUrl}/api/v1/reports/${report.id}`, {
      headers: { Authorization: 'Bearer other-user' },
    });
    expect(res2.status).toBe(404);
  });

  it('GET /api/v1/reports/:id/download streams completed report file', async () => {
    const reportId = 'report_download_test';
    const storageKey = `reports/${reportId}.csv`;
    const storageAdapter = getStorageAdapter();

    const writeStream = storageAdapter.writeStream(storageKey);
    writeStream.write('id,amount\n1,100');
    writeStream.end();
    await new Promise<void>((res) => writeStream.on('finish', () => res()));

    await prisma.reportRequest.create({
      data: {
        id: reportId,
        userId: 'user-test-1',
        reportType: 'transaction_history',
        format: 'csv',
        status: 'completed',
        storageKey,
        mimeType: 'text/csv',
      },
    });

    const res = await fetch(`${baseUrl}/api/v1/reports/${reportId}/download`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('id,amount');

    await storageAdapter.delete(storageKey);
  });

  it('GET /api/v1/reports lists reports with pagination', async () => {
    const res = await fetch(`${baseUrl}/api/v1/reports?page=1&limit=5`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    const body = (await res.json()) as {
      success: boolean;
      data: unknown[];
      pagination: { page: number };
    };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.page).toBe(1);
  });
});
