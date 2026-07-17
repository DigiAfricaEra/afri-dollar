import http from 'http';

const mockListExecutions = jest.fn(async () => [
  {
    id: 'job-execution-1',
    jobName: 'sync-fx-rates',
    status: 'completed',
    startedAt: new Date('2026-07-17T08:00:00.000Z'),
    completedAt: new Date('2026-07-17T08:00:01.000Z'),
  },
]);

jest.mock('../../middleware/auth.middleware', () => ({
  authMiddleware: (_req: http.IncomingMessage, _res: http.ServerResponse, next: () => void): void =>
    next(),
  adminMiddleware: (
    _req: http.IncomingMessage,
    _res: http.ServerResponse,
    next: () => void
  ): void => next(),
}));

jest.mock('../../services/job-queue.service', () => ({
  jobQueueService: {
    getStatus: jest.fn(() => 'disabled'),
    getDefinitions: jest.fn(() => [
      {
        name: 'sync-fx-rates',
        schedule: '*/5 * * * *',
        handler: 'syncFxRates',
        priority: 'high',
        retryAttempts: 3,
        retryDelay: 60000,
      },
    ]),
    listExecutions: mockListExecutions,
    getExecution: jest.fn(async (id: string) =>
      id === 'job-execution-1'
        ? {
            id: 'job-execution-1',
            jobName: 'sync-fx-rates',
            status: 'completed',
            startedAt: new Date('2026-07-17T08:00:00.000Z'),
            completedAt: new Date('2026-07-17T08:00:01.000Z'),
          }
        : null
    ),
    stop: jest.fn(async () => undefined),
  },
}));

describe('Job status routes', () => {
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
    if (server === null) {
      return;
    }

    const runningServer = server;
    await new Promise<void>((resolve, reject) => {
      runningServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  it('lists job definitions and current status', async () => {
    const response = await fetch(`${baseUrl}/api/v1/jobs?limit=25&cursor=cursor-1`);
    const rawBody: unknown = await response.json();
    const body = rawBody as {
      success: boolean;
      data: {
        queueStatus: string;
        definitions: Array<{ name: string }>;
        executions: Array<{ id: string; status: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.queueStatus).toBe('disabled');
    expect(body.data.definitions).toEqual([expect.objectContaining({ name: 'sync-fx-rates' })]);
    expect(body.data.executions).toEqual([
      expect.objectContaining({ id: 'job-execution-1', status: 'completed' }),
    ]);
    expect(mockListExecutions).toHaveBeenCalledWith({
      limit: 25,
      cursor: 'cursor-1',
    });
  });

  it('returns a single job execution detail', async () => {
    const response = await fetch(`${baseUrl}/api/v1/jobs/job-execution-1`);
    const rawBody: unknown = await response.json();
    const body = rawBody as {
      success: boolean;
      data: { id: string; jobName: string; status: string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('job-execution-1');
    expect(body.data.jobName).toBe('sync-fx-rates');
    expect(body.data.status).toBe('completed');
  });
});
