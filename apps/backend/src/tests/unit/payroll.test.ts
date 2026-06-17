/* eslint-disable */
import { Account, Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { PayrollService } from '../../services/payroll.service';
import { encrypt } from '../../utils/crypto';

// Setup Stellar Horizon mocks using global variables to avoid hoisting initialization issues
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
      Memo: original.Horizon.Memo,
    },
  };
});

const mockLoadAccount = (global as Record<string, unknown>).__mockLoadAccount as jest.Mock;
const mockSubmitTransaction = (global as Record<string, unknown>)
  .__mockSubmitTransaction as jest.Mock;

// Mock Prisma client
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    wallet: {
      findUnique: jest.fn(),
    },
    payrollBatch: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    payrollItem: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

// Typed prisma mock helpers to satisfy ESLint unbound-method rules
const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockPayrollBatchCreate = prisma.payrollBatch.create as jest.Mock;
const mockPayrollBatchFindUnique = prisma.payrollBatch.findUnique as jest.Mock;
const mockPayrollBatchUpdate = prisma.payrollBatch.update as jest.Mock;
const mockPayrollBatchFindMany = prisma.payrollBatch.findMany as jest.Mock;
const mockPayrollBatchUpdateMany = prisma.payrollBatch.updateMany as jest.Mock;
const mockPayrollItemCreate = prisma.payrollItem.create as jest.Mock;
const mockPayrollItemUpdate = prisma.payrollItem.update as jest.Mock;
const mockPayrollItemUpdateMany = prisma.payrollItem.updateMany as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;

describe('PayrollService', () => {
  const mockUserId = 'user-1';
  const mockWalletId = 'wallet-id-123';
  const testKeypair = Keypair.random();
  const mockPublicKey = testKeypair.publicKey();
  const mockSecretKey = testKeypair.secret();
  let mockSecretEncrypted: string;
  const mockAssetIssuer = Keypair.random().publicKey();

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
  });

  describe('createPayrollBatch', () => {
    it('should create a batch successfully when the wallet exists', async () => {
      const mockWallet = { id: mockWalletId, publicKey: mockPublicKey, userId: mockUserId };
      mockWalletFindUnique.mockResolvedValue(mockWallet);

      const mockBatch = {
        id: 'batch-123',
        name: 'June Payroll',
        walletId: mockWalletId,
        status: 'pending',
      };
      mockPayrollBatchCreate.mockResolvedValue(mockBatch);

      const result = await PayrollService.createPayrollBatch(
        { name: 'June Payroll', description: 'June payouts', walletId: mockWalletId },
        mockUserId
      );

      expect(mockWalletFindUnique).toHaveBeenCalledWith({ where: { id: mockWalletId } });
      expect(mockPayrollBatchCreate).toHaveBeenCalledWith({
        data: {
          name: 'June Payroll',
          description: 'June payouts',
          walletId: mockWalletId,
          status: 'pending',
        },
      });
      expect(mockAuditLogCreate).toHaveBeenCalled();
      expect(result).toEqual(mockBatch);
    });

    it('should throw an error when the wallet does not exist', async () => {
      mockWalletFindUnique.mockResolvedValue(null);

      await expect(
        PayrollService.createPayrollBatch(
          { name: 'June Payroll', walletId: 'invalid-wallet' },
          mockUserId
        )
      ).rejects.toThrow('Wallet not found');

      expect(mockPayrollBatchCreate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payroll_batch_create_failed',
            success: false,
          }),
        })
      );
    });

    it('should throw an error when the wallet belongs to another user', async () => {
      mockWalletFindUnique.mockResolvedValue({
        id: mockWalletId,
        publicKey: mockPublicKey,
        userId: 'other-user',
      });

      await expect(
        PayrollService.createPayrollBatch(
          { name: 'June Payroll', walletId: mockWalletId },
          mockUserId
        )
      ).rejects.toThrow('Wallet does not belong to user');

      expect(mockPayrollBatchCreate).not.toHaveBeenCalled();
    });
  });

  describe('addPayrollItem', () => {
    const ownedBatch = {
      id: 'batch-123',
      status: 'pending',
      wallet: { userId: mockUserId },
    };

    it('should add a payroll item successfully to a pending batch', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(ownedBatch);

      const mockItem = {
        id: 'item-1',
        payrollBatchId: 'batch-123',
        recipientAddress: mockPublicKey,
        amount: '100.00',
        assetCode: 'USDC',
        assetIssuer: mockAssetIssuer,
        status: 'pending',
      };
      mockPayrollItemCreate.mockResolvedValue(mockItem);

      const result = await PayrollService.addPayrollItem(
        'batch-123',
        {
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
        },
        mockUserId
      );

      expect(mockPayrollBatchFindUnique).toHaveBeenCalledWith({
        where: { id: 'batch-123' },
        include: { wallet: { select: { userId: true } } },
      });
      expect(mockPayrollItemCreate).toHaveBeenCalledWith({
        data: {
          payrollBatchId: 'batch-123',
          recipientAddress: mockPublicKey,
          amount: '100.00',
          assetCode: 'USDC',
          assetIssuer: mockAssetIssuer,
          memo: null,
          status: 'pending',
        },
      });
      expect(result).toEqual(mockItem);
    });

    it('should throw an error if the batch does not exist', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(null);

      await expect(
        PayrollService.addPayrollItem(
          'invalid-batch',
          {
            recipientAddress: mockPublicKey,
            amount: '100.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Payroll batch not found');
    });

    it('should throw an error if the batch belongs to another user', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue({
        id: 'batch-123',
        status: 'pending',
        wallet: { userId: 'other-user' },
      });

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '100.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Payroll batch not found');
    });

    it('should throw an error if the batch is not pending approval', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue({
        id: 'batch-123',
        status: 'approved',
        wallet: { userId: mockUserId },
      });

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '100.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Cannot add items to a batch that is not pending approval');
    });

    it('should throw an error if recipientAddress is invalid', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(ownedBatch);

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: 'invalid-address',
            amount: '100.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Invalid Stellar recipient address');
    });

    it('should throw an error if amount is zero or negative', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(ownedBatch);

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '-50.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Amount must be a positive number');

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '0.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Amount must be a positive number');

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: 'invalid-num',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Amount must be a positive number');
    });

    it('should throw an error if assetCode is invalid', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(ownedBatch);

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '100.00',
            assetCode: 'INVALIDASSETCODE12345',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Asset code must be a non-empty alphanumeric string of 1 to 12 characters');
    });

    it('should throw an error if assetIssuer is missing for non-XLM asset', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(ownedBatch);

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '100.00',
            assetCode: 'USDC',
          },
          mockUserId
        )
      ).rejects.toThrow('Asset issuer is required for non-XLM assets');
    });

    it('should throw an error if assetIssuer is provided for XLM (native)', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(ownedBatch);

      await expect(
        PayrollService.addPayrollItem(
          'batch-123',
          {
            recipientAddress: mockPublicKey,
            amount: '100.00',
            assetCode: 'XLM',
            assetIssuer: mockAssetIssuer,
          },
          mockUserId
        )
      ).rejects.toThrow('Asset issuer must not be provided for XLM (native asset)');
    });
  });

  describe('approvePayrollBatch', () => {
    it('should approve a pending batch successfully', async () => {
      const mockBatch = {
        id: 'batch-123',
        status: 'pending',
        wallet: { userId: mockUserId },
      };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdate.mockResolvedValue({
        ...mockBatch,
        status: 'approved',
      });

      const result = await PayrollService.approvePayrollBatch('batch-123', mockUserId);

      expect(mockPayrollBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-123' },
        data: { status: 'approved' },
      });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payroll_batch_approve',
            resourceId: 'batch-123',
            success: true,
          }),
        })
      );
      expect(result.status).toBe('approved');
    });

    it('should throw an error if trying to approve a non-pending batch', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue({
        id: 'batch-123',
        status: 'processing',
        wallet: { userId: mockUserId },
      });

      await expect(PayrollService.approvePayrollBatch('batch-123', mockUserId)).rejects.toThrow(
        'Only pending batches can be approved'
      );
    });
  });

  describe('getPayrollBatches', () => {
    it('should return batches scoped to the authenticated user', async () => {
      const mockBatches = [{ id: 'batch-123', name: 'June Payroll' }];
      mockPayrollBatchFindMany.mockResolvedValue(mockBatches);

      const result = await PayrollService.getPayrollBatches(mockUserId);

      expect(mockPayrollBatchFindMany).toHaveBeenCalledWith({
        where: { wallet: { userId: mockUserId } },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual(mockBatches);
    });
  });

  describe('getPayrollHistory', () => {
    it('should return history scoped to the authenticated user', async () => {
      const mockBatches = [
        {
          id: 'batch-123',
          name: 'June Payroll',
          items: [
            {
              id: 'item-1',
              payrollBatchId: 'batch-123',
              recipientAddress: mockPublicKey,
              amount: '100.00',
              assetCode: 'USDC',
              assetIssuer: mockAssetIssuer,
              memo: null,
              status: 'completed',
              stellarTxId: 'tx-1',
              errorMessage: null,
            },
          ],
        },
      ];
      mockPayrollBatchFindMany.mockResolvedValue(mockBatches);

      const result = await PayrollService.getPayrollHistory(mockUserId);

      expect(mockPayrollBatchFindMany).toHaveBeenCalledWith({
        where: { wallet: { userId: mockUserId } },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      });
      expect(result[0].items[0].assetIssuer).toBe(mockAssetIssuer);
    });
  });

  describe('processPayrollBatch', () => {
    let mockBatch: any;

    beforeEach(() => {
      mockBatch = {
        id: 'batch-123',
        name: 'June Payroll',
        status: 'approved',
        wallet: {
          id: mockWalletId,
          publicKey: mockPublicKey,
          secretKeyEncrypted: mockSecretEncrypted,
          userId: mockUserId,
        },
        items: [
          {
            id: 'item-1',
            recipientAddress: mockPublicKey,
            amount: '50.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
            memo: 'salary1',
            status: 'pending',
          },
          {
            id: 'item-2',
            recipientAddress: mockPublicKey,
            amount: '75.00',
            assetCode: 'USDC',
            assetIssuer: mockAssetIssuer,
            memo: 'salary1',
            status: 'pending',
          },
        ],
      };
    });

    it('should successfully submit batched transactions', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 1 });
      mockPayrollBatchUpdate.mockResolvedValue({
        ...mockBatch,
        status: 'completed',
        items: mockBatch.items.map((i: any) => ({
          ...i,
          status: 'completed',
          stellarTxId: 'tx-hash-123',
        })),
      });

      // Mock loadAccount to return a valid Account instance
      const dummyAccount = new Account(mockPublicKey, '100');
      mockLoadAccount.mockResolvedValue(dummyAccount);
      // Mock submitTransaction to succeed
      mockSubmitTransaction.mockResolvedValue({ hash: 'tx-hash-123' });

      const result = await PayrollService.processPayrollBatch('batch-123', mockUserId);

      expect(mockPayrollBatchUpdateMany).toHaveBeenCalledWith({
        where: { id: 'batch-123', status: 'approved' },
        data: { status: 'processing' },
      });

      expect(mockLoadAccount).toHaveBeenCalledWith(mockPublicKey);
      expect(mockSubmitTransaction).toHaveBeenCalled();
      expect(mockPayrollItemUpdate).toHaveBeenCalledTimes(2); // Each item updated to completed
      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.items[0].status).toBe('completed');
    });

    it('should fallback to individual transactions if the batch submission fails', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 1 });

      const completedItem1 = {
        ...mockBatch.items[0],
        status: 'completed',
        stellarTxId: 'tx-single-1',
      };
      const failedItem2 = {
        ...mockBatch.items[1],
        status: 'failed',
        errorMessage: 'Stellar payment failed',
      };

      // Mock update to reflect single updates
      mockPayrollItemUpdate
        .mockResolvedValueOnce(completedItem1)
        .mockResolvedValueOnce(failedItem2);

      mockPayrollBatchUpdate.mockResolvedValue({
        ...mockBatch,
        status: 'completed',
        items: [completedItem1, failedItem2],
      });

      // Mock Horizon loadAccount
      const dummyAccount = new Account(mockPublicKey, '100');
      mockLoadAccount.mockResolvedValue(dummyAccount);

      // First call (batch) fails
      mockSubmitTransaction.mockRejectedValueOnce(new Error('Batch failed'));
      // Second call (item 1 single retry) succeeds
      mockSubmitTransaction.mockResolvedValueOnce({ hash: 'tx-single-1' });
      // Third call (item 2 single retry) fails
      const horizonError = new Error('Destination not found') as Error & { response: unknown };
      horizonError.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_failed',
              operations: ['op_no_destination'],
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValueOnce(horizonError);

      const result = await PayrollService.processPayrollBatch('batch-123', mockUserId);

      expect(mockSubmitTransaction).toHaveBeenCalledTimes(3); // 1 batch + 2 retries
      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.items[0].status).toBe('completed');
      expect(result.items[1].status).toBe('failed');
      consoleWarnSpy.mockRestore();
    });

    it('should throw an error if the batch is already being processed', async () => {
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatch);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 0 }); // simulating batch already processing

      await expect(PayrollService.processPayrollBatch('batch-123', mockUserId)).rejects.toThrow(
        'Batch is already being processed'
      );

      expect(mockLoadAccount).not.toHaveBeenCalled();
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
      expect(mockPayrollItemUpdate).not.toHaveBeenCalled();
      expect(mockPayrollItemUpdateMany).not.toHaveBeenCalled();
      expect(mockPayrollBatchUpdate).not.toHaveBeenCalled();
    });

    it('should revert batch status to approved and log failure on decryption error', async () => {
      const mockBatchWithInvalidSecret = {
        ...mockBatch,
        wallet: {
          ...mockBatch.wallet,
          secretKeyEncrypted: 'invalid-encrypted-key-format', // will cause decrypt() to fail
        },
      };
      mockPayrollBatchFindUnique.mockResolvedValue(mockBatchWithInvalidSecret);
      mockPayrollBatchUpdateMany.mockResolvedValue({ count: 1 });

      await expect(PayrollService.processPayrollBatch('batch-123', mockUserId)).rejects.toThrow(
        'Wallet decryption failure'
      );

      expect(mockPayrollBatchUpdate).toHaveBeenCalledWith({
        where: { id: 'batch-123' },
        data: { status: 'approved' },
      });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'payroll_batch_process_failed',
            success: false,
          }),
        })
      );
    });
  });
});
