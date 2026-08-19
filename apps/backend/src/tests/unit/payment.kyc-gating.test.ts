/* eslint-disable */

// ── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../config/env', () => ({
  env: {
    ENCRYPTION_KEY: 'test-encryption-key-32-octets-long-for-jest',
    JWT_SECRET: 'test-jwt',
    KYC_REQUIRED_THRESHOLD_USD: 1000,
    AML_THRESHOLD_USD: 50000,
    SUMSUB_API_KEY: 'test-api-key',
    SUMSUB_SECRET_KEY: 'test-secret-key-32-bytes-long!!',
    SUMSUB_BASE_URL: 'https://api.test.sumsub.com',
  },
}));

jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  const mockLoadAccount = jest.fn();
  const mockSubmitTransaction = jest.fn();

  (global as Record<string, unknown>).__mockLoadAccount = mockLoadAccount;
  (global as Record<string, unknown>).__mockSubmitTransaction = mockSubmitTransaction;

  return {
    ...original,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
      })),
    },
  };
});

jest.mock('../../config/database', () => {
  const client: Record<string, unknown> = {
    wallet: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    transaction: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    systemConfig: {
      findMany: jest.fn(),
    },
    complianceAlert: {
      create: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    kYCRecord: {
      findFirst: jest.fn(),
    },
  };

  client.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => Promise<unknown>)(client);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    throw new TypeError('Unsupported $transaction argument');
  });

  return {
    __esModule: true,
    default: client,
  };
});

import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { env } from '../../config/env';
import { PaymentService } from '../../services/payment.service';
import { encrypt } from '../../utils/crypto';

const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockTransactionCreate = prisma.transaction.create as jest.Mock;
const mockTransactionUpdateMany = prisma.transaction.updateMany as jest.Mock;
const mockTransactionCount = prisma.transaction.count as jest.Mock;
const mockTransactionFindMany = prisma.transaction.findMany as jest.Mock;
const mockSystemConfigFindMany = prisma.systemConfig.findMany as jest.Mock;
const mockComplianceAlertCreate = prisma.complianceAlert.create as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;
const mockKYCRecordFindFirst = prisma.kYCRecord.findFirst as jest.Mock;

const testKeypair = Keypair.random();
const mockPublicKey = testKeypair.publicKey();
const mockSecretKey = testKeypair.secret();
const mockUserId = 'user-1';
const mockWalletId = 'wallet-id-123';
const mockDestination = Keypair.random().publicKey();
let mockSecretEncrypted: string;

const baseOptions = {
  sourceWalletId: mockWalletId,
  destinationAddress: mockDestination,
  amount: '100',
  assetCode: 'XLM',
  purpose: 'Supplier payment',
};

beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'test-encryption-key-32-octets-long-for-jest';
  mockSecretEncrypted = encrypt(mockSecretKey);
});

describe('PaymentService — KYC Gating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLogCreate.mockResolvedValue({});
    mockSystemConfigFindMany.mockResolvedValue([]);
    mockTransactionCount.mockResolvedValue(0);
    mockTransactionFindMany.mockResolvedValue([]);
    mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
    mockComplianceAlertCreate.mockResolvedValue({});

    // Default wallet and user mocks
    mockWalletFindUnique.mockResolvedValue({
      id: mockWalletId,
      userId: mockUserId,
      publicKey: mockPublicKey,
      secretKeyEncrypted: mockSecretEncrypted,
    });
    mockUserFindUnique.mockResolvedValue({
      id: mockUserId,
      isVerified: true,
      kycRecords: [],
    });
  });

  // ── Payments below $1,000 ─────────────────────────────────────────────

  it('should allow payment below $1,000 without KYC', async () => {
    const mockTx = {
      id: 'tx-1',
      status: 'created',
      stellarTxId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      errorMessage: null,
      walletId: mockWalletId,
      userId: mockUserId,
      amount: '500',
      assetCode: 'XLM',
      assetIssuer: null,
      toAddress: mockDestination,
    };
    mockTransactionCreate.mockResolvedValue(mockTx);

    const result = await PaymentService.createCrossBorderPayment(
      { ...baseOptions, amount: '500' },
      mockUserId
    );

    expect(result.payment.id).toBe('tx-1');
    expect(result.payment.status).toBe('created');
    expect(mockTransactionCreate).toHaveBeenCalled();
  });

  // ── Payments >= $1,000 without KYC ────────────────────────────────────

  it('should block payment >= $1,000 without approved KYC', async () => {
    // No KYC record exists
    mockKYCRecordFindFirst.mockResolvedValue(null);

    await expect(
      PaymentService.createCrossBorderPayment(
        { ...baseOptions, amount: '1000', beneficiaryInfo: { name: 'Supplier Co', country: 'NG' } },
        mockUserId
      )
    ).rejects.toThrow('KYC verification required');
  });

  it('should block payment >= $1,000 with pending KYC (not approved)', async () => {
    mockKYCRecordFindFirst.mockResolvedValue({
      id: 'kyc-1',
      userId: mockUserId,
      level: 'BASIC',
      status: 'pending',
    });

    await expect(
      PaymentService.createCrossBorderPayment(
        { ...baseOptions, amount: '1500', beneficiaryInfo: { name: 'Supplier Co', country: 'NG' } },
        mockUserId
      )
    ).rejects.toThrow('KYC verification required');
  });

  it('should block payment >= $1,000 with rejected KYC', async () => {
    mockKYCRecordFindFirst.mockResolvedValue({
      id: 'kyc-1',
      userId: mockUserId,
      level: 'BASIC',
      status: 'rejected',
    });

    await expect(
      PaymentService.createCrossBorderPayment(
        { ...baseOptions, amount: '1500', beneficiaryInfo: { name: 'Supplier Co', country: 'NG' } },
        mockUserId
      )
    ).rejects.toThrow('KYC verification required');
  });

  // ── Payments >= $1,000 with BASIC KYC ─────────────────────────────────

  it('should block payment >= $1,000 with only BASIC level KYC', async () => {
    mockKYCRecordFindFirst.mockResolvedValue({
      id: 'kyc-1',
      userId: mockUserId,
      level: 'BASIC',
      status: 'approved',
    });

    await expect(
      PaymentService.createCrossBorderPayment(
        { ...baseOptions, amount: '1000', beneficiaryInfo: { name: 'Supplier Co', country: 'NG' } },
        mockUserId
      )
    ).rejects.toThrow('Standard KYC verification (Level 2) required');
  });

  // ── Payments >= $10,000 without ENHANCED KYC ──────────────────────────

  it('should block payment >= $10,000 without ENHANCED KYC level', async () => {
    mockKYCRecordFindFirst.mockResolvedValue({
      id: 'kyc-1',
      userId: mockUserId,
      level: 'STANDARD',
      status: 'approved',
    });

    await expect(
      PaymentService.createCrossBorderPayment(
        {
          ...baseOptions,
          amount: '10000',
          beneficiaryInfo: { name: 'Supplier Co', country: 'NG' },
        },
        mockUserId
      )
    ).rejects.toThrow('Enhanced due diligence (KYC Level ENHANCED) required');
  });

  // ── Payments with full ENHANCED KYC ───────────────────────────────────

  it('should allow payment >= $10,000 with ENHANCED KYC', async () => {
    mockKYCRecordFindFirst.mockResolvedValue({
      id: 'kyc-1',
      userId: mockUserId,
      level: 'ENHANCED',
      status: 'approved',
    });

    const mockTx = {
      id: 'tx-large',
      status: 'created',
      stellarTxId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
      errorMessage: null,
      walletId: mockWalletId,
      userId: mockUserId,
      amount: '15000',
      assetCode: 'XLM',
      assetIssuer: null,
      toAddress: mockDestination,
    };
    mockTransactionCreate.mockResolvedValue(mockTx);

    const result = await PaymentService.createCrossBorderPayment(
      { ...baseOptions, amount: '15000', beneficiaryInfo: { name: 'Supplier Co', country: 'NG' } },
      mockUserId
    );

    expect(result.payment.id).toBe('tx-large');
    expect(result.payment.status).toBe('created');
  });

  // ── KYC gating disabled when threshold is 0 ───────────────────────────

  it('should allow all payments when KYC threshold is 0 (gating disabled)', async () => {
    const originalThreshold = env.KYC_REQUIRED_THRESHOLD_USD;
    (env as Record<string, unknown>).KYC_REQUIRED_THRESHOLD_USD = 0;

    try {
      const mockTx = {
        id: 'tx-no-gate',
        status: 'created',
        stellarTxId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        walletId: mockWalletId,
        userId: mockUserId,
        amount: '5000',
        assetCode: 'XLM',
        assetIssuer: null,
        toAddress: mockDestination,
      };
      mockTransactionCreate.mockResolvedValue(mockTx);

      const result = await PaymentService.createCrossBorderPayment(
        { ...baseOptions, amount: '5000', beneficiaryInfo: { name: 'Supplier Co', country: 'NG' } },
        mockUserId
      );

      expect(result.payment.id).toBe('tx-no-gate');
      expect(result.payment.status).toBe('created');
    } finally {
      (env as Record<string, unknown>).KYC_REQUIRED_THRESHOLD_USD = originalThreshold;
    }
  });
});
