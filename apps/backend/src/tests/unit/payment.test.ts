/* eslint-disable */
import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { PaymentService } from '../../services/payment.service';
import { encrypt } from '../../utils/crypto';

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

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
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
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockTransactionCreate = prisma.transaction.create as jest.Mock;
const mockTransactionFindUnique = prisma.transaction.findUnique as jest.Mock;
const mockTransactionFindMany = prisma.transaction.findMany as jest.Mock;
const mockTransactionUpdate = prisma.transaction.update as jest.Mock;
const mockTransactionUpdateMany = prisma.transaction.updateMany as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;

describe('PaymentService', () => {
  const mockUserId = 'user-1';
  const mockWalletId = 'wallet-id-123';
  const testKeypair = Keypair.random();
  const mockPublicKey = testKeypair.publicKey();
  const mockSecretKey = testKeypair.secret();
  let mockSecretEncrypted: string;
  const mockDestination = Keypair.random().publicKey();

  let originalEncryptionKey: string | undefined;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-octets-long-for-jest';
    mockSecretEncrypted = encrypt(mockSecretKey);
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLogCreate.mockResolvedValue({});
  });

  describe('createCrossBorderPayment', () => {
    const baseOptions = {
      sourceWalletId: 'wallet-id-123',
      destinationAddress: '',
      amount: '100',
      assetCode: 'XLM',
      purpose: 'Supplier payment',
    };

    beforeEach(() => {
      baseOptions.destinationAddress = mockDestination;
    });

    it('should create a payment successfully and persist memo', async () => {
      const memo = 'INV-2026-001';
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: mockUserId,
        publicKey: mockPublicKey,
      });
      mockUserFindUnique.mockResolvedValue({
        id: mockUserId,
        isVerified: true,
        kycRecords: [],
      });
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
        amount: '100',
        assetCode: 'XLM',
        assetIssuer: null,
        toAddress: mockDestination,
      };
      mockTransactionCreate.mockResolvedValue(mockTx);

      const result = await PaymentService.createCrossBorderPayment(
        { ...baseOptions, memo },
        mockUserId
      );

      expect(result.payment.id).toBe('tx-1');
      expect(result.payment.status).toBe('created');
      expect(result.amount).toBe('100');
      expect(result.assetCode).toBe('XLM');
      expect(result.complianceChecks.sanctionsScreening).toBe('passed');
      expect(mockTransactionCreate).toHaveBeenCalledTimes(1);
      expect(mockTransactionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: expect.objectContaining({ memo }),
          }),
        })
      );
    });

    it('should throw on invalid destination address', async () => {
      await expect(
        PaymentService.createCrossBorderPayment(
          { ...baseOptions, destinationAddress: 'invalid' },
          mockUserId
        )
      ).rejects.toThrow('Invalid Stellar destination address');
    });

    it('should throw on zero amount', async () => {
      await expect(
        PaymentService.createCrossBorderPayment({ ...baseOptions, amount: '0' }, mockUserId)
      ).rejects.toThrow('Amount must be a positive number');
    });

    it('should throw on negative amount', async () => {
      await expect(
        PaymentService.createCrossBorderPayment({ ...baseOptions, amount: '-5' }, mockUserId)
      ).rejects.toThrow('Amount must be a positive number');
    });

    it('should throw when wallet not found', async () => {
      mockWalletFindUnique.mockResolvedValue(null);

      await expect(
        PaymentService.createCrossBorderPayment(baseOptions, mockUserId)
      ).rejects.toThrow('Wallet not found');
    });

    it('should throw when wallet belongs to another user', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: 'other-user',
        publicKey: mockPublicKey,
      });

      await expect(
        PaymentService.createCrossBorderPayment(baseOptions, mockUserId)
      ).rejects.toThrow('Wallet does not belong to user');
    });

    it('should block payment to sanctioned country', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: mockUserId,
        publicKey: mockPublicKey,
      });
      mockUserFindUnique.mockResolvedValue({
        id: mockUserId,
        isVerified: true,
        kycRecords: [],
      });

      await expect(
        PaymentService.createCrossBorderPayment(
          {
            ...baseOptions,
            beneficiaryInfo: { name: 'Test', country: 'KP' },
          },
          mockUserId
        )
      ).rejects.toThrow('Payment blocked: sanctions screening failed');
    });

    it('should block payment to sanctioned country with lowercase code', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: mockUserId,
        publicKey: mockPublicKey,
      });
      mockUserFindUnique.mockResolvedValue({
        id: mockUserId,
        isVerified: true,
        kycRecords: [],
      });

      await expect(
        PaymentService.createCrossBorderPayment(
          {
            ...baseOptions,
            beneficiaryInfo: { name: 'Test', country: 'kp' },
          },
          mockUserId
        )
      ).rejects.toThrow('Payment blocked: sanctions screening failed');
    });

    it('should block payment to sanctioned country with whitespace-padded code', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: mockUserId,
        publicKey: mockPublicKey,
      });
      mockUserFindUnique.mockResolvedValue({
        id: mockUserId,
        isVerified: true,
        kycRecords: [],
      });

      await expect(
        PaymentService.createCrossBorderPayment(
          {
            ...baseOptions,
            beneficiaryInfo: { name: 'Test', country: 'KP ' },
          },
          mockUserId
        )
      ).rejects.toThrow('Payment blocked: sanctions screening failed');
    });

    it('should require beneficiary info for amounts >= 1000', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: mockUserId,
        publicKey: mockPublicKey,
      });
      mockUserFindUnique.mockResolvedValue({
        id: mockUserId,
        isVerified: true,
        kycRecords: [],
      });

      await expect(
        PaymentService.createCrossBorderPayment({ ...baseOptions, amount: '1500' }, mockUserId)
      ).rejects.toThrow('Payment blocked: beneficiary information required for amounts >= 1000');
    });

    it('should pass travel rule for amounts >= 1000 when beneficiary info provided', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        userId: mockUserId,
        publicKey: mockPublicKey,
      });
      mockUserFindUnique.mockResolvedValue({
        id: mockUserId,
        isVerified: true,
        kycRecords: [],
      });
      const mockTx = {
        id: 'tx-2',
        status: 'created',
        stellarTxId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        walletId: mockWalletId,
        userId: mockUserId,
        amount: '1500',
        assetCode: 'XLM',
        assetIssuer: null,
        toAddress: mockDestination,
      };
      mockTransactionCreate.mockResolvedValue(mockTx);

      const result = await PaymentService.createCrossBorderPayment(
        {
          ...baseOptions,
          amount: '1500',
          beneficiaryInfo: { name: 'Supplier Co', country: 'NG' },
        },
        mockUserId
      );

      expect(result.complianceChecks.travelRule).toBe('passed');
      expect(result.complianceChecks.sanctionsScreening).toBe('passed');
    });

    it('should require asset issuer for non-XLM assets', async () => {
      await expect(
        PaymentService.createCrossBorderPayment({ ...baseOptions, assetCode: 'USDC' }, mockUserId)
      ).rejects.toThrow('Asset issuer is required for non-XLM assets');
    });
  });

  describe('getPaymentStatus', () => {
    it('should return payment status for valid payment', async () => {
      const mockTx = {
        id: 'tx-1',
        status: 'completed',
        stellarTxId: 'stellar-hash-123',
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
        errorMessage: null,
        userId: mockUserId,
        metadata: { paymentType: 'cross_border' },
      };
      mockTransactionFindUnique.mockResolvedValue(mockTx);

      const result = await PaymentService.getPaymentStatus('tx-1', mockUserId);

      expect(result.id).toBe('tx-1');
      expect(result.status).toBe('completed');
      expect(result.stellarTxId).toBe('stellar-hash-123');
    });

    it('should throw when payment not found', async () => {
      mockTransactionFindUnique.mockResolvedValue(null);

      await expect(PaymentService.getPaymentStatus('nonexistent', mockUserId)).rejects.toThrow(
        'Payment not found'
      );
    });

    it('should throw when payment belongs to another user', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        userId: 'other-user',
        metadata: { paymentType: 'cross_border' },
      });

      await expect(PaymentService.getPaymentStatus('tx-1', mockUserId)).rejects.toThrow(
        'Payment not found'
      );
    });

    it('should throw when transaction is not a cross-border payment', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        userId: mockUserId,
        metadata: { paymentType: 'other' },
      });

      await expect(PaymentService.getPaymentStatus('tx-1', mockUserId)).rejects.toThrow(
        'Payment not found'
      );
    });
  });

  describe('cancelPayment', () => {
    const crossBorderMetadata = { paymentType: 'cross_border' };

    it('should cancel a created payment atomically', async () => {
      mockTransactionFindUnique
        .mockResolvedValueOnce({
          id: 'tx-1',
          status: 'created',
          userId: mockUserId,
          metadata: crossBorderMetadata,
        })
        .mockResolvedValueOnce({
          id: 'tx-1',
          status: 'cancelled',
          stellarTxId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
          errorMessage: null,
          userId: mockUserId,
          metadata: crossBorderMetadata,
        });
      mockTransactionUpdateMany.mockResolvedValue({ count: 1 });

      const result = await PaymentService.cancelPayment('tx-1', mockUserId);

      expect(result.status).toBe('cancelled');
      expect(mockTransactionUpdateMany).toHaveBeenCalledWith({
        where: { id: 'tx-1', userId: mockUserId, status: { in: ['created', 'pending'] } },
        data: { status: 'cancelled' },
      });
    });

    it('should throw when cancelling a completed payment (atomic check)', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'completed',
        userId: mockUserId,
        metadata: crossBorderMetadata,
      });
      mockTransactionUpdateMany.mockResolvedValue({ count: 0 });

      await expect(PaymentService.cancelPayment('tx-1', mockUserId)).rejects.toThrow(
        'Only created or pending payments can be cancelled'
      );
    });

    it('should throw when cancelling a processing payment (atomic check)', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'processing',
        userId: mockUserId,
        metadata: crossBorderMetadata,
      });
      mockTransactionUpdateMany.mockResolvedValue({ count: 0 });

      await expect(PaymentService.cancelPayment('tx-1', mockUserId)).rejects.toThrow(
        'Only created or pending payments can be cancelled'
      );
    });

    it('should throw when transaction is not a cross-border payment', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'created',
        userId: mockUserId,
        metadata: { paymentType: 'other' },
      });

      await expect(PaymentService.cancelPayment('tx-1', mockUserId)).rejects.toThrow(
        'Payment not found'
      );
    });
  });

  describe('processPayment', () => {
    const crossBorderMetadata = { paymentType: 'cross_border' };

    it('should throw when payment not found', async () => {
      mockTransactionFindUnique.mockResolvedValue(null);

      await expect(PaymentService.processPayment('nonexistent', mockUserId)).rejects.toThrow(
        'Payment not found'
      );
    });

    it('should throw when transaction is not a cross-border payment', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'created',
        userId: mockUserId,
        metadata: { paymentType: 'other' },
        wallet: { secretKeyEncrypted: mockSecretEncrypted },
      });

      await expect(PaymentService.processPayment('tx-1', mockUserId)).rejects.toThrow(
        'Payment not found'
      );
    });

    it('should throw when payment is not in created status', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'completed',
        userId: mockUserId,
        metadata: crossBorderMetadata,
        wallet: { secretKeyEncrypted: mockSecretEncrypted },
      });

      await expect(PaymentService.processPayment('tx-1', mockUserId)).rejects.toThrow(
        'Only created payments can be processed'
      );
    });

    it('should throw when already being processed (race condition)', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'created',
        userId: mockUserId,
        metadata: crossBorderMetadata,
        wallet: { secretKeyEncrypted: mockSecretEncrypted },
      });
      mockTransactionUpdateMany.mockResolvedValue({ count: 0 });

      await expect(PaymentService.processPayment('tx-1', mockUserId)).rejects.toThrow(
        'Payment is already being processed'
      );
    });

    it('should handle wallet decryption failure and roll back status', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        id: 'tx-1',
        status: 'created',
        userId: mockUserId,
        metadata: crossBorderMetadata,
        wallet: { secretKeyEncrypted: 'invalid:encrypted:data' },
      });
      mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
      mockTransactionUpdate.mockResolvedValue({});

      await expect(PaymentService.processPayment('tx-1', mockUserId)).rejects.toThrow(
        'Wallet decryption failure'
      );

      expect(mockTransactionUpdate).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: { status: 'created' },
      });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payment_process_failed',
            resourceId: 'tx-1',
            success: false,
          }),
        })
      );
    });
  });

  describe('getPaymentHistory', () => {
    it('should return cross-border payment history', async () => {
      const mockTxs = [
        {
          id: 'tx-1',
          status: 'completed',
          stellarTxId: 'hash-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: new Date(),
          errorMessage: null,
          userId: mockUserId,
          walletId: mockWalletId,
          amount: '500',
          assetCode: 'XLM',
          assetIssuer: null,
          toAddress: mockDestination,
          metadata: {
            purpose: 'Supplier payment',
            beneficiaryInfo: null,
            complianceChecks: {
              sanctionsScreening: 'passed',
              travelRule: 'not_applicable',
              kycVerified: true,
              checkedAt: new Date().toISOString(),
            },
            paymentType: 'cross_border',
          },
        },
      ];
      mockTransactionFindMany.mockResolvedValue(mockTxs);

      const result = await PaymentService.getPaymentHistory(mockUserId);

      expect(result).toHaveLength(1);
      expect(result[0].payment.id).toBe('tx-1');
      expect(result[0].purpose).toBe('Supplier payment');
      expect(result[0].complianceChecks.sanctionsScreening).toBe('passed');
    });

    it('should filter by walletId when provided', async () => {
      mockTransactionFindMany.mockResolvedValue([]);

      await PaymentService.getPaymentHistory(mockUserId, mockWalletId);

      expect(mockTransactionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletId: mockWalletId,
          }),
        })
      );
    });

    it('should filter by cross_border paymentType at query level', async () => {
      mockTransactionFindMany.mockResolvedValue([]);

      await PaymentService.getPaymentHistory(mockUserId);

      expect(mockTransactionFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            metadata: {
              path: ['paymentType'],
              equals: 'cross_border',
            },
          }),
        })
      );
    });
  });
});
