import http from 'http';

import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { sign } from 'jsonwebtoken';

import prisma from '../../config/database';

const serverKey = Keypair.random();

process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_TOML_SIGNING_KEY = serverKey.secret();
process.env.SEP10_HOME_DOMAIN = 'localhost:3001';
process.env.JWT_SECRET = 'app-jwt-secret';
process.env.SEP10_JWT_SECRET = 'sep10-test-secret';
process.env.SEP_API_PUBLIC_URL = 'http://localhost:3001';
process.env.SEP24_INTERACTIVE_FRONTEND_BASE_URL = 'http://localhost:3000';
process.env['NODE_ENV'] = 'test';

jest.mock('../../services/job-queue.service', () => ({
  jobQueueService: {
    getStatus: jest.fn(() => 'disabled'),
    getDefinitions: jest.fn(() => []),
    listExecutions: jest.fn(async () => []),
    getExecution: jest.fn(async () => null),
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  },
}));

jest.mock('../../services/report-worker.service', () => ({
  reportWorker: {
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  },
}));

jest.mock('../../services/webhook-delivery.worker', () => ({
  webhookDeliveryWorker: {
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  },
}));

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    sepSession: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  },
}));

function sepToken(role: string): string {
  return sign(
    {
      iss: 'http://localhost:3001/auth',
      sub: Keypair.random().publicKey(),
      jti: 'test-jti',
      home_domain: 'localhost:3001',
      userId: 'user-1',
      role,
    },
    'sep10-test-secret',
    { expiresIn: '1h', algorithm: 'HS256' }
  );
}

describe('SEP-10 / SEP-24 routes', () => {
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
      throw new Error('Expected TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('serves stellar.toml with the configured SIGNING_KEY', async () => {
    const response = await fetch(`${baseUrl}/.well-known/stellar.toml`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(`SIGNING_KEY="${serverKey.publicKey()}"`);
    expect(body).toContain('WEB_AUTH_ENDPOINT=');
    expect(body).toContain('TRANSFER_SERVER_SEP0024=');
  });

  it('returns 401 when SEP-24 transactions are requested without a token', async () => {
    const response = await fetch(`${baseUrl}/sep24/transactions`);
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toMatch(/SEP-10 token is required/i);
  });

  it('returns 403 when SEP-24 transactions are requested with an auditor token', async () => {
    const response = await fetch(`${baseUrl}/sep24/transactions`, {
      headers: { Authorization: `Bearer ${sepToken('AUDITOR')}` },
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/Insufficient permissions/i);
  });

  it('returns 400 when SEP-24 transactions are requested with a non-integer limit', async () => {
    const response = await fetch(`${baseUrl}/sep24/transactions?limit=1.5`, {
      headers: { Authorization: `Bearer ${sepToken('USER')}` },
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/limit must be a positive integer/i);
  });

  it('returns 400 when SEP-24 transactions are requested with an invalid kind', async () => {
    const response = await fetch(`${baseUrl}/sep24/transactions?kind=swap`, {
      headers: { Authorization: `Bearer ${sepToken('USER')}` },
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/kind must be deposit or withdraw/i);
  });

  it('issues a server-signed SEP-10 challenge and accepts a USER token for transaction listing', async () => {
    const account = Keypair.random().publicKey();
    const challengeResponse = await fetch(`${baseUrl}/auth?account=${account}`);
    const challengeBody = (await challengeResponse.json()) as {
      transaction: string;
      network_passphrase: string;
    };

    expect(challengeResponse.status).toBe(200);
    const challengeTx = new Transaction(
      challengeBody.transaction,
      challengeBody.network_passphrase
    );
    const serverSignature = challengeTx.signatures[0]?.signature();
    expect(serverSignature).toBeDefined();
    if (serverSignature === undefined) {
      throw new Error('Challenge is missing a server signature');
    }
    expect(serverKey.verify(challengeTx.hash(), serverSignature)).toBe(true);

    (prisma.sepSession.findMany as jest.Mock).mockResolvedValue([]);
    const listResponse = await fetch(`${baseUrl}/sep24/transactions`, {
      headers: { Authorization: `Bearer ${sepToken('USER')}` },
    });

    expect(listResponse.status).toBe(200);
  });

  it('rejects a challenge signed by a different keypair', async () => {
    const account = Keypair.random();
    const challengeResponse = await fetch(`${baseUrl}/auth?account=${account.publicKey()}`);
    const challengeBody = (await challengeResponse.json()) as {
      transaction: string;
      network_passphrase: string;
    };
    const tx = new Transaction(challengeBody.transaction, challengeBody.network_passphrase);
    tx.sign(Keypair.random());

    const verifyResponse = await fetch(`${baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: tx.toEnvelope().toXDR('base64') }),
    });
    const body = (await verifyResponse.json()) as { error: string };

    expect(verifyResponse.status).toBe(401);
    expect(body.error).toMatch(/Challenge signatures are invalid/i);
  });
});
