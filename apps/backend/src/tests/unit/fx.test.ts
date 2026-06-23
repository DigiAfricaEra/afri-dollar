/* eslint-disable */
import prisma from '../../config/database';
import { FXService } from '../../services/fx.service';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    exchangeRate: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    conversionQuote: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    wallet: {
      findFirst: jest.fn(),
    },
    walletBalance: {
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    transaction: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

const mockExchangeRateFindFirst = prisma.exchangeRate.findFirst as jest.Mock;
const mockExchangeRateFindMany = prisma.exchangeRate.findMany as jest.Mock;
const mockExchangeRateCreate = prisma.exchangeRate.create as jest.Mock;
const mockExchangeRateUpdateMany = prisma.exchangeRate.updateMany as jest.Mock;
const mockExchangeRateFindUnique = prisma.exchangeRate.findUnique as jest.Mock;
const mockExchangeRateUpdate = prisma.exchangeRate.update as jest.Mock;
const mockConversionQuoteCreate = prisma.conversionQuote.create as jest.Mock;
const mockConversionQuoteFindUnique = prisma.conversionQuote.findUnique as jest.Mock;
const mockConversionQuoteUpdate = prisma.conversionQuote.update as jest.Mock;
const mockWalletFindFirst = prisma.wallet.findFirst as jest.Mock;
const mockWalletBalanceFindMany = prisma.walletBalance.findMany as jest.Mock;
const mockWalletBalanceUpdate = prisma.walletBalance.update as jest.Mock;
const mockTransactionCreate = prisma.transaction.create as jest.Mock;
const mockTransactionFindMany = prisma.transaction.findMany as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;
const mockPrismaTransaction = prisma.$transaction as jest.Mock;

describe('FXService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FX_MANUAL_RATES;
    delete process.env.FX_EXTERNAL_API_URL;
  });

  describe('getCurrentRates', () => {
    it('stores a new rate snapshot when no active rate exists', async () => {
      const persistedRate = {
        fromAsset: 'USDC',
        toAsset: 'NGN',
        rate: '1550',
        source: 'internal',
        validFrom: new Date('2026-06-17T10:00:00.000Z'),
        validUntil: null,
      };

      mockExchangeRateFindFirst.mockResolvedValue(null);
      mockExchangeRateUpdateMany.mockResolvedValue({ count: 0 });
      mockExchangeRateCreate.mockResolvedValue(persistedRate);
      mockExchangeRateFindMany.mockResolvedValue([persistedRate]);
      mockPrismaTransaction.mockResolvedValue([]);

      const result = await FXService.getCurrentRates({
        fromAsset: 'USDC',
        toAsset: 'NGN',
      });

      expect(mockExchangeRateUpdateMany).toHaveBeenCalledWith({
        where: {
          fromAsset: 'USDC',
          toAsset: 'NGN',
          isActive: true,
        },
        data: expect.objectContaining({
          isActive: false,
          validUntil: expect.any(Date),
        }),
      });
      expect(mockExchangeRateCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromAsset: 'USDC',
          toAsset: 'NGN',
          rate: '1550',
          source: 'internal',
        }),
      });
      expect(result).toEqual([persistedRate]);
    });
  });

  describe('calculateQuote', () => {
    it('creates an FX quote from the active rate', async () => {
      const activeRate = {
        fromAsset: 'USDC',
        toAsset: 'NGN',
        rate: '1550',
        source: 'internal',
        validFrom: new Date('2026-06-17T10:00:00.000Z'),
        validUntil: null,
      };
      const createdQuote = {
        quoteId: 'quote-123',
        fromAsset: 'USDC',
        toAsset: 'NGN',
        fromAmount: '0.1',
        toAmount: '155',
        rate: '1550',
        expiresAt: new Date('2026-06-17T10:10:00.000Z'),
      };

      mockExchangeRateFindFirst.mockResolvedValue({
        ...activeRate,
        id: 'rate-1',
      });
      mockExchangeRateFindMany.mockResolvedValue([activeRate]);
      mockConversionQuoteCreate.mockResolvedValue(createdQuote);

      const result = await FXService.calculateQuote({
        fromAsset: 'usdc',
        toAsset: 'ngn',
        fromAmount: '0.1',
      });

      expect(mockConversionQuoteCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromAsset: 'USDC',
          toAsset: 'NGN',
          fromAmount: '0.1',
          toAmount: '155',
          rate: '1550',
          source: 'internal',
          expiresAt: expect.any(Date),
        }),
      });
      expect(result).toEqual(createdQuote);
    });
  });

  describe('executeConversion', () => {
    it('executes a valid quote and updates wallet balances', async () => {
      const validQuote = {
        quoteId: 'quote-123',
        fromAsset: 'USDC',
        toAsset: 'NGN',
        fromAmount: '100',
        toAmount: '155000',
        rate: '1550',
        source: 'internal',
        status: 'pending',
        expiresAt: new Date('2099-06-17T10:10:00.000Z'),
      };
      const sourceBalance = {
        id: 'balance-usdc',
        walletId: 'wallet-1',
        assetCode: 'USDC',
        assetIssuer: null,
        balance: '500',
        updatedAt: new Date('2026-06-17T10:00:00.000Z'),
      };
      const targetBalance = {
        id: 'balance-ngn',
        walletId: 'wallet-1',
        assetCode: 'NGN',
        assetIssuer: null,
        balance: '1000',
        updatedAt: new Date('2026-06-17T10:00:00.000Z'),
      };
      const updatedSourceBalance = { ...sourceBalance, balance: '400' };
      const updatedTargetBalance = { ...targetBalance, balance: '156000' };
      const transaction = {
        id: 'txn-123',
        walletId: 'wallet-1',
      };

      mockWalletFindFirst.mockResolvedValue({
        id: 'wallet-1',
        userId: 'user-1',
        isActive: true,
      });
      mockConversionQuoteFindUnique.mockResolvedValue(validQuote);
      mockWalletBalanceFindMany
        .mockResolvedValueOnce([sourceBalance])
        .mockResolvedValueOnce([targetBalance]);
      mockWalletBalanceUpdate
        .mockResolvedValueOnce(updatedSourceBalance)
        .mockResolvedValueOnce(updatedTargetBalance);
      mockTransactionCreate.mockResolvedValue(transaction);
      mockPrismaTransaction.mockImplementation(
        async (callback: (client: typeof prisma) => unknown) => callback(prisma)
      );

      const result = await FXService.executeConversion(
        {
          quoteId: 'quote-123',
          walletId: 'wallet-1',
        },
        'user-1'
      );

      expect(mockWalletBalanceUpdate).toHaveBeenNthCalledWith(1, {
        where: { id: 'balance-usdc' },
        data: { balance: '400' },
      });
      expect(mockWalletBalanceUpdate).toHaveBeenNthCalledWith(2, {
        where: { id: 'balance-ngn' },
        data: { balance: '156000' },
      });
      expect(mockConversionQuoteUpdate).toHaveBeenCalledWith({
        where: { quoteId: 'quote-123' },
        data: {
          status: 'executed',
          walletId: 'wallet-1',
          executedAt: expect.any(Date),
        },
      });
      expect(mockTransactionCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          walletId: 'wallet-1',
          type: 'exchange',
          status: 'completed',
          amount: '100',
          assetCode: 'USDC',
          metadata: expect.objectContaining({
            quoteId: 'quote-123',
            toAsset: 'NGN',
            toAmount: '155000',
            rate: '1550',
          }),
          completedAt: expect.any(Date),
        }),
      });
      expect(result).toEqual({
        quote: {
          quoteId: 'quote-123',
          fromAsset: 'USDC',
          toAsset: 'NGN',
          fromAmount: '100',
          toAmount: '155000',
          rate: '1550',
          expiresAt: validQuote.expiresAt,
        },
        walletId: 'wallet-1',
        transactionId: 'txn-123',
        fromBalance: '400',
        toBalance: '156000',
        executedAt: expect.any(Date),
      });
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'fx_conversion_executed',
            success: true,
          }),
        })
      );
    });
  });

  describe('getConversionHistory', () => {
    it('maps conversion transactions into FX history items', async () => {
      mockTransactionFindMany.mockResolvedValue([
        {
          id: 'txn-123',
          userId: 'user-1',
          walletId: 'wallet-1',
          type: 'exchange',
          status: 'completed',
          amount: '100',
          assetCode: 'USDC',
          assetIssuer: null,
          fromAddress: null,
          toAddress: null,
          stellarTxId: null,
          metadata: {
            quoteId: 'quote-123',
            toAsset: 'NGN',
            toAmount: '155000',
            rate: '1550',
          },
          errorMessage: null,
          createdAt: new Date('2026-06-17T10:00:00.000Z'),
          updatedAt: new Date('2026-06-17T10:00:00.000Z'),
          completedAt: new Date('2026-06-17T10:01:00.000Z'),
        },
      ]);

      const result = await FXService.getConversionHistory('user-1', {
        walletId: 'wallet-1',
        limit: 10,
      });

      expect(mockTransactionFindMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          type: 'exchange',
          walletId: 'wallet-1',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 10,
      });
      expect(result).toEqual([
        {
          transactionId: 'txn-123',
          walletId: 'wallet-1',
          quoteId: 'quote-123',
          fromAsset: 'USDC',
          toAsset: 'NGN',
          fromAmount: '100',
          toAmount: '155000',
          rate: '1550',
          status: 'completed',
          executedAt: new Date('2026-06-17T10:01:00.000Z'),
          createdAt: new Date('2026-06-17T10:00:00.000Z'),
        },
      ]);
    });
  });

  describe('getConversionHistory with cursor and date filters', () => {
    it('filters by cursor', async () => {
      mockTransactionFindMany.mockResolvedValue([]);

      await FXService.getConversionHistory('user-1', {
        cursor: 'txn-100',
      });

      expect(mockTransactionFindMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          type: 'exchange',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        cursor: { id: 'txn-100' },
        skip: 1,
      });
    });

    it('filters by date range', async () => {
      mockTransactionFindMany.mockResolvedValue([]);

      await FXService.getConversionHistory('user-1', {
        fromDate: '2026-06-01T00:00:00.000Z',
        toDate: '2026-06-30T23:59:59.000Z',
      });

      expect(mockTransactionFindMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          type: 'exchange',
          createdAt: {
            gte: new Date('2026-06-01T00:00:00.000Z'),
            lte: new Date('2026-06-30T23:59:59.000Z'),
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
    });
  });

  describe('upsertRate', () => {
    it('creates a new rate and deactivates the old one', async () => {
      const newRate = {
        id: 'rate-new',
        fromAsset: 'USDC',
        toAsset: 'NGN',
        rate: '1600',
        source: 'manual',
        isActive: true,
        validFrom: new Date('2026-06-17T12:00:00.000Z'),
        validUntil: null,
        createdAt: new Date('2026-06-17T12:00:00.000Z'),
        updatedAt: new Date('2026-06-17T12:00:00.000Z'),
      };

      mockExchangeRateCreate.mockResolvedValue(newRate);
      mockExchangeRateUpdateMany.mockResolvedValue({ count: 0 });
      mockPrismaTransaction.mockImplementation(
        async (callback: (client: typeof prisma) => unknown) => callback(prisma)
      );

      const result = await FXService.upsertRate({
        fromAsset: 'usdc',
        toAsset: 'ngn',
        rate: '1600',
      });

      expect(mockExchangeRateUpdateMany).toHaveBeenCalledWith({
        where: {
          fromAsset: 'USDC',
          toAsset: 'NGN',
          isActive: true,
        },
        data: expect.objectContaining({
          isActive: false,
          validUntil: expect.any(Date),
        }),
      });
      expect(mockExchangeRateCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fromAsset: 'USDC',
          toAsset: 'NGN',
          rate: '1600',
          source: 'manual',
          isActive: true,
        }),
      });
      expect(result).toEqual({
        fromAsset: 'USDC',
        toAsset: 'NGN',
        rate: '1600',
        source: 'manual',
        validFrom: newRate.validFrom,
        validUntil: null,
      });
    });

    it('rejects identical from and to assets', async () => {
      await expect(
        FXService.upsertRate({
          fromAsset: 'USDC',
          toAsset: 'USDC',
          rate: '1',
        })
      ).rejects.toThrow('From and to assets must be different');
    });

    it('rejects invalid rate values', async () => {
      await expect(
        FXService.upsertRate({
          fromAsset: 'USDC',
          toAsset: 'NGN',
          rate: '-5',
        })
      ).rejects.toThrow('Amount must be a positive number');
    });
  });

  describe('deactivateRate', () => {
    it('deactivates an active exchange rate', async () => {
      const activeRate = {
        id: 'rate-1',
        fromAsset: 'USDC',
        toAsset: 'NGN',
        rate: '1550',
        source: 'manual',
        isActive: true,
        validFrom: new Date('2026-06-17T10:00:00.000Z'),
        validUntil: null,
        createdAt: new Date('2026-06-17T10:00:00.000Z'),
        updatedAt: new Date('2026-06-17T10:00:00.000Z'),
      };

      mockExchangeRateFindUnique.mockResolvedValue(activeRate);
      mockExchangeRateUpdate.mockResolvedValue({
        ...activeRate,
        isActive: false,
        validUntil: new Date(),
      });

      await FXService.deactivateRate('rate-1');

      expect(mockExchangeRateFindUnique).toHaveBeenCalledWith({
        where: { id: 'rate-1' },
      });
      expect(mockExchangeRateUpdate).toHaveBeenCalledWith({
        where: { id: 'rate-1' },
        data: {
          isActive: false,
          validUntil: expect.any(Date),
        },
      });
    });

    it('throws if rate not found', async () => {
      mockExchangeRateFindUnique.mockResolvedValue(null);

      await expect(FXService.deactivateRate('nonexistent')).rejects.toThrow(
        'Exchange rate not found'
      );
    });

    it('throws if rate is already inactive', async () => {
      const inactiveRate = {
        id: 'rate-1',
        fromAsset: 'USDC',
        toAsset: 'NGN',
        rate: '1550',
        source: 'manual',
        isActive: false,
        validFrom: new Date('2026-06-17T10:00:00.000Z'),
        validUntil: new Date(),
        createdAt: new Date('2026-06-17T10:00:00.000Z'),
        updatedAt: new Date('2026-06-17T10:00:00.000Z'),
      };

      mockExchangeRateFindUnique.mockResolvedValue(inactiveRate);

      await expect(FXService.deactivateRate('rate-1')).rejects.toThrow(
        'Exchange rate is already inactive'
      );
    });
  });
});
