/* eslint-disable @typescript-eslint/unbound-method */
import { createHash } from 'crypto';

import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { StellarSep24Service } from '../../services/stellar-sep24.service';
import { StellarService } from '../../services/stellar.service';
import { WebhookService } from '../../services/webhook.service';
import type { SepJwtPayload } from '../../types/sep.types';
import { encrypt } from '../../utils/crypto';

jest.mock('../../config/database', () => {
  const client: Record<string, unknown> = {
    sepSession: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    sepWatchCursor: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    wallet: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };
  return { __esModule: true, default: client };
});

jest.mock('../../services/stellar.service', () => ({
  StellarService: {
    getHorizonServer: jest.fn(),
    submitPayment: jest.fn(),
  },
}));

jest.mock('../../services/webhook.service', () => ({
  WebhookService: {
    emitEvent: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../utils/crypto', () => ({
  decrypt: jest.fn(() => 'SSECRET'),
  encrypt: jest.fn(() => 'ciphertext'),
}));

const mockSepSession = prisma.sepSession as unknown as {
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  findUnique: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
  findUniqueOrThrow: jest.Mock;
};
const mockSepWatchCursor = prisma.sepWatchCursor as unknown as {
  findUnique: jest.Mock;
  upsert: jest.Mock;
};
const mockWalletFindFirst = prisma.wallet.findFirst as jest.Mock;
const mockSubmitPayment = StellarService.submitPayment as jest.Mock;
const mockGetHorizonServer = StellarService.getHorizonServer as jest.Mock;
const mockEmitEvent = WebhookService.emitEvent as jest.Mock;
const mockEncrypt = encrypt as jest.Mock;

const client = Keypair.random();
const server = Keypair.random();

function userJwt(role: SepJwtPayload['role'] = 'USER'): SepJwtPayload {
  return {
    iss: 'http://localhost:3001/auth',
    sub: client.publicKey(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: 'jti-1',
    home_domain: 'localhost:3001',
    userId: 'user-1',
    role,
  };
}

describe('StellarSep24Service', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_TOML_SIGNING_KEY = server.secret();
    process.env.SEP10_HOME_DOMAIN = 'localhost:3001';
    process.env.JWT_SECRET = 'app-jwt-secret';
    process.env.SEP10_JWT_SECRET = 'sep10-test-secret';
    process.env.SEP_API_PUBLIC_URL = 'http://localhost:3001';
    process.env.SEP24_INTERACTIVE_FRONTEND_BASE_URL = 'http://localhost:3000';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSepSession.updateMany.mockResolvedValue({ count: 1 });
    mockSepWatchCursor.findUnique.mockResolvedValue(null);
    mockSepWatchCursor.upsert.mockResolvedValue({ id: 'payments', pagingToken: '1' });
  });

  it('returns deposit and withdraw methods with min/max limits', () => {
    const info = StellarSep24Service.getInfo();
    expect(info.deposit.USDC.enabled).toBe(true);
    expect(info.withdraw.USDC.min_amount).toBe(1);
    expect(info.withdraw.USDC.max_amount).toBe(100000);
  });

  it('runs the deposit interactive flow then completes after a treasury payment', async () => {
    mockSepSession.create.mockResolvedValue({
      id: 'session-deposit',
      userId: 'user-1',
      type: 'deposit',
      asset: 'USDC',
      amount: '25',
      status: 'incomplete',
      metadata: {},
    });
    mockSepSession.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'session-deposit',
        userId: 'user-1',
        type: 'deposit',
        asset: 'USDC',
        amount: '25',
        stellarTxId: (data.stellarTxId as string) || null,
        status: data.status,
        metadata: data.metadata || {},
        createdAt: new Date(),
        completedAt: data.completedAt || null,
      })
    );
    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-deposit',
      userId: 'user-1',
      type: 'deposit',
      asset: 'USDC',
      amount: '25',
      stellarTxId: null,
      status: 'pending_anchor',
      metadata: {
        clientAccount: client.publicKey(),
        assetCode: 'USDC',
        assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        memo: 'sessiondeposit',
      },
    });
    mockWalletFindFirst.mockResolvedValue({
      publicKey: 'Gtreasury',
      secretKeyEncrypted: 'encrypted',
    });
    mockSubmitPayment.mockResolvedValue({ hash: 'stellar-hash-1' });

    const started = await StellarSep24Service.startInteractiveDeposit(userJwt(), {
      asset_code: 'USDC',
      amount: '25',
    });
    expect(started.id).toBe('session-deposit');
    expect(started.url).toMatch(/\/sep24\/interactive\/deposit\/session-deposit\/[a-f0-9]{64}$/);

    const pendingAnchor = await StellarSep24Service.completeInteractive(
      'session-deposit',
      client.publicKey(),
      { bankName: 'GTBank', accountName: 'Ada', accountNumber: '123', amount: '25' }
    );

    expect(pendingAnchor.status).toBe('pending_anchor');
    expect(mockSubmitPayment).not.toHaveBeenCalled();

    const completed = await StellarSep24Service.completeDeposit('session-deposit');

    expect(completed.status).toBe('completed');
    expect(completed.stellarTxId).toBe('stellar-hash-1');
    expect(mockSubmitPayment).toHaveBeenCalled();
    expect(mockEncrypt).toHaveBeenCalledWith(expect.stringContaining('"accountNumber":"123"'));
    expect(mockSepSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            payoutDetailsEncrypted: 'ciphertext',
          }),
        }),
      })
    );
    const storedMetadata = mockSepSession.update.mock.calls
      .map((call) => call[0]?.data?.metadata)
      .filter((metadata): metadata is Record<string, unknown> => metadata !== undefined);
    for (const metadata of storedMetadata) {
      expect(metadata).not.toHaveProperty('accountNumber');
      expect(metadata).not.toHaveProperty('bankDetails');
    }
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sep24.transaction.status_update' })
    );
  });

  it('marks a pending deposit completed when Horizon reports an incoming credit', async () => {
    mockWalletFindFirst.mockResolvedValue({ publicKey: 'Ghot' });
    mockSepSession.findMany.mockResolvedValue([
      {
        id: 'session-watch',
        userId: 'user-1',
        type: 'deposit',
        asset: 'USDC',
        amount: '25',
        stellarTxId: null,
        status: 'pending_stellar',
        metadata: {
          memo: 'sessionwatchmemo',
          clientAccount: client.publicKey(),
          assetCode: 'USDC',
        },
      },
    ]);
    mockSepSession.update.mockResolvedValue({
      id: 'session-watch',
      userId: 'user-1',
      type: 'deposit',
      status: 'completed',
      stellarTxId: 'incoming-hash',
    });

    mockGetHorizonServer.mockReturnValue({
      payments: () => ({
        forAccount: () => ({
          order: () => ({
            limit: () => ({
              call: async () => ({
                records: [
                  {
                    type: 'payment',
                    to: 'Ghot',
                    from: client.publicKey(),
                    amount: '25',
                    asset_code: 'USDC',
                    asset_type: 'credit_alphanum4',
                    paging_token: '100',
                    transaction_hash: 'incoming-hash',
                    transaction: async () => ({ memo: 'sessionwatchmemo', hash: 'incoming-hash' }),
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    });

    await StellarSep24Service.watchDeposits();

    expect(mockSepSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          stellarTxId: 'incoming-hash',
        }),
      })
    );
  });

  it('runs withdraw request, pending funds transfer, then bank payout finalize', async () => {
    mockSepSession.create.mockResolvedValue({
      id: 'session-withdraw',
      userId: 'user-1',
      type: 'withdraw',
      asset: 'USDC',
      amount: '40',
      status: 'incomplete',
    });
    mockSepSession.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'session-withdraw',
        userId: 'user-1',
        type: 'withdraw',
        asset: 'USDC',
        amount: '40',
        stellarTxId: (data.stellarTxId as string) || null,
        externalRef: (data.externalRef as string) || null,
        status: data.status,
        metadata: data.metadata || { clientAccount: client.publicKey(), memo: 'sessionwithdraw' },
      })
    );
    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-withdraw',
      userId: 'user-1',
      type: 'withdraw',
      asset: 'USDC',
      amount: '40',
      stellarTxId: null,
      status: 'incomplete',
      metadata: { clientAccount: client.publicKey(), memo: 'sessionwithdraw' },
    });
    mockWalletFindFirst.mockResolvedValue({ publicKey: 'Ghot', secretKeyEncrypted: 'encrypted' });
    mockSepSession.updateMany.mockResolvedValue({ count: 1 });
    mockSepSession.findUniqueOrThrow.mockResolvedValue({
      id: 'session-withdraw',
      type: 'withdraw',
      status: 'completed',
      stellarTxId: 'user-stellar-tx',
      userId: 'user-1',
    });

    const started = await StellarSep24Service.startInteractiveWithdrawal(userJwt(), {
      asset_code: 'USDC',
      amount: '40',
    });
    expect(started.id).toBe('session-withdraw');

    const pendingUser = await StellarSep24Service.completeInteractive(
      'session-withdraw',
      client.publicKey(),
      { bankName: 'Equity', accountNumber: '999' }
    );
    expect(pendingUser.status).toBe('pending_user_transfer_start');
    expect(pendingUser.sendTo).toBe('Ghot');

    await StellarSep24Service.markPendingFundsTransfer('session-withdraw', 'user-stellar-tx');
    const finalized = await StellarSep24Service.finalizeWithdrawal(
      'session-withdraw',
      'bank-payout-ref'
    );

    expect(finalized.status).toBe('completed');
  });

  it('consumes a single-use interactive token before issuing the state cookie', async () => {
    const token = 'a'.repeat(64);
    const tokenHash = createHash('sha256').update(token).digest('hex');

    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-token',
      type: 'deposit',
      metadata: {
        clientAccount: client.publicKey(),
        interactiveTokenHash: tokenHash,
        interactiveTokenExp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    mockSepSession.updateMany.mockResolvedValue({ count: 1 });

    const cookie = await StellarSep24Service.issueInteractiveCookie(
      'session-token',
      'deposit',
      token
    );

    expect(cookie).toContain('session-token');
    const updateArg = mockSepSession.updateMany.mock.calls[0][0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(updateArg.data.metadata).not.toHaveProperty('interactiveTokenHash');
    expect(updateArg.data.metadata).not.toHaveProperty('interactiveTokenExp');

    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-token',
      type: 'deposit',
      metadata: { clientAccount: client.publicKey() },
    });

    await expect(
      StellarSep24Service.issueInteractiveCookie('session-token', 'deposit', token)
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a wrong or expired interactive token without consuming it', async () => {
    const token = 'b'.repeat(64);
    const tokenHash = createHash('sha256').update(token).digest('hex');

    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-token',
      type: 'deposit',
      metadata: {
        clientAccount: client.publicKey(),
        interactiveTokenHash: tokenHash,
        interactiveTokenExp: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    await expect(
      StellarSep24Service.issueInteractiveCookie('session-token', 'deposit', 'c'.repeat(64))
    ).rejects.toMatchObject({ status: 401 });
    expect(mockSepSession.updateMany).not.toHaveBeenCalled();

    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-token',
      type: 'deposit',
      metadata: {
        clientAccount: client.publicKey(),
        interactiveTokenHash: tokenHash,
        interactiveTokenExp: Math.floor(Date.now() / 1000) - 10,
      },
    });

    await expect(
      StellarSep24Service.issueInteractiveCookie('session-token', 'deposit', token)
    ).rejects.toMatchObject({ status: 401 });
    expect(mockSepSession.updateMany).not.toHaveBeenCalled();
  });

  it('rejects interactive deposit for an auditor role', async () => {
    await expect(
      StellarSep24Service.startInteractiveDeposit(userJwt('AUDITOR'), { asset_code: 'USDC' })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects completeInteractive when the cookie account does not own the session', async () => {
    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-deposit',
      type: 'deposit',
      status: 'incomplete',
      metadata: { clientAccount: client.publicKey() },
    });

    await expect(
      StellarSep24Service.completeInteractive('session-deposit', Keypair.random().publicKey(), {
        bankName: 'GTBank',
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects completeInteractive for an already completed session', async () => {
    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-deposit',
      type: 'deposit',
      status: 'completed',
      metadata: { clientAccount: client.publicKey() },
    });

    await expect(
      StellarSep24Service.completeInteractive('session-deposit', client.publicKey(), {
        bankName: 'GTBank',
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows only one concurrent interactive token claim to succeed', async () => {
    const token = 'd'.repeat(64);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    mockSepSession.findUnique.mockResolvedValue({
      id: 'session-token',
      type: 'deposit',
      metadata: {
        clientAccount: client.publicKey(),
        interactiveTokenHash: tokenHash,
        interactiveTokenExp: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    let claimed = false;
    mockSepSession.updateMany.mockImplementation(async () => {
      if (claimed) {
        return { count: 0 };
      }
      claimed = true;
      return { count: 1 };
    });

    const results = await Promise.allSettled([
      StellarSep24Service.issueInteractiveCookie('session-token', 'deposit', token),
      StellarSep24Service.issueInteractiveCookie('session-token', 'deposit', token),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects an interactive account that does not match the SEP-10 subject', async () => {
    await expect(
      StellarSep24Service.startInteractiveDeposit(userJwt(), {
        asset_code: 'USDC',
        account: Keypair.random().publicKey(),
      })
    ).rejects.toMatchObject({ status: 403 });
  });
});
