/* eslint-disable @typescript-eslint/unbound-method */
import prisma from '../../config/database';
import { TreasuryService } from '../../services/treasury.service';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    wallet: {
      findMany: jest.fn(),
    },
    walletBalance: {
      findMany: jest.fn(),
    },
    exchangeRate: {
      findFirst: jest.fn(),
    },
    transaction: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  },
}));

const mockWalletFindMany = prisma.wallet.findMany as jest.Mock;
const mockWalletBalanceFindMany = prisma.walletBalance.findMany as jest.Mock;
const mockExchangeRateFindFirst = prisma.exchangeRate.findFirst as jest.Mock;
const mockTransactionCreate = prisma.transaction.create as jest.Mock;
const mockTransactionFindMany = prisma.transaction.findMany as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;

describe('TreasuryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLogCreate.mockResolvedValue({});
  });

  describe('getTreasuryBalance', () => {
    it('aggregates balances across treasury wallets and values them in USD', async () => {
      mockWalletFindMany.mockResolvedValue([{ id: 'tw-1' }, { id: 'tw-2' }]);
      mockWalletBalanceFindMany.mockResolvedValue([
        { walletId: 'tw-1', assetCode: 'USDC', assetIssuer: null, balance: '600.0' },
        { walletId: 'tw-2', assetCode: 'USDC', assetIssuer: null, balance: '400.0' },
        { walletId: 'tw-1', assetCode: 'NGN', assetIssuer: 'GISSUER', balance: '1000.0' },
      ]);
      // NGN -> USD rate of 0.001 => 1000 NGN = 1 USD
      mockExchangeRateFindFirst.mockResolvedValue({ rate: '0.001' });

      const result = await TreasuryService.getTreasuryBalance();

      expect(mockWalletFindMany).toHaveBeenCalledWith({
        where: { walletType: 'treasury', isActive: true },
        select: { id: true },
      });
      expect(result.walletCount).toBe(2);
      expect(result.assetCount).toBe(2);
      // 1000 USDC (pegged) + 1 USD from NGN = 1001.00
      expect(result.totalValueUsd).toBe('1001.00');

      const usdc = result.positions.find((p) => p.assetCode === 'USDC');
      const ngn = result.positions.find((p) => p.assetCode === 'NGN');
      expect(usdc).toMatchObject({ balance: '1000.0', valueUsd: '1000.00' });
      expect(ngn).toMatchObject({ balance: '1000.0', valueUsd: '1.00' });
      // Largest position first
      expect(result.positions[0].assetCode).toBe('USDC');
    });

    it('returns an empty summary when there are no treasury wallets', async () => {
      mockWalletFindMany.mockResolvedValue([]);

      const result = await TreasuryService.getTreasuryBalance();

      expect(result).toEqual({
        totalValueUsd: '0.00',
        assetCount: 0,
        walletCount: 0,
        positions: [],
      });
      expect(mockWalletBalanceFindMany).not.toHaveBeenCalled();
    });

    it('treats assets without an exchange rate as zero USD value', async () => {
      mockWalletFindMany.mockResolvedValue([{ id: 'tw-1' }]);
      mockWalletBalanceFindMany.mockResolvedValue([
        { walletId: 'tw-1', assetCode: 'XLM', assetIssuer: null, balance: '50.0' },
      ]);
      mockExchangeRateFindFirst.mockResolvedValue(null);

      const result = await TreasuryService.getTreasuryBalance();

      expect(result.totalValueUsd).toBe('0.00');
      expect(result.positions[0]).toMatchObject({
        assetCode: 'XLM',
        balance: '50.0',
        valueUsd: '0.00',
        allocation: 0,
      });
    });
  });

  describe('getTreasuryPositions', () => {
    it('computes allocation percentages that reflect USD value', async () => {
      mockWalletFindMany.mockResolvedValue([{ id: 'tw-1' }]);
      mockWalletBalanceFindMany.mockResolvedValue([
        { walletId: 'tw-1', assetCode: 'USD', assetIssuer: null, balance: '750.0' },
        { walletId: 'tw-1', assetCode: 'USDC', assetIssuer: null, balance: '250.0' },
      ]);

      const positions = await TreasuryService.getTreasuryPositions();

      const usd = positions.find((p) => p.assetCode === 'USD');
      const usdc = positions.find((p) => p.assetCode === 'USDC');
      expect(usd?.allocation).toBe(75);
      expect(usdc?.allocation).toBe(25);
    });
  });

  describe('rebalance', () => {
    beforeEach(() => {
      mockWalletFindMany.mockResolvedValue([{ id: 'tw-1' }]);
      mockWalletBalanceFindMany.mockResolvedValue([
        { walletId: 'tw-1', assetCode: 'USD', assetIssuer: null, balance: '800.0' },
        { walletId: 'tw-1', assetCode: 'USDC', assetIssuer: null, balance: '200.0' },
      ]);
      mockTransactionCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'tx-generated',
          createdAt: new Date('2026-06-18T00:00:00Z'),
          ...data,
        })
      );
    });

    it('records rebalance operations for the assets that need adjustment', async () => {
      // Current: USD 80%, USDC 20%. Target: USD 50%, USDC 50%.
      const operations = await TreasuryService.rebalance(
        [
          { assetCode: 'USD', targetAllocation: 50 },
          { assetCode: 'USDC', targetAllocation: 50 },
        ],
        'admin-1'
      );

      expect(operations).toHaveLength(2);
      expect(mockTransactionCreate).toHaveBeenCalledTimes(2);

      // USD should be decreased by 300 (800 -> 500), USDC increased by 300 (200 -> 500).
      const createCalls = mockTransactionCreate.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      const createdData = createCalls.map((call) => call[0].data);
      const usdCall = createdData.find((data) => data.assetCode === 'USD');
      const usdcCall = createdData.find((data) => data.assetCode === 'USDC');

      expect(usdCall).toMatchObject({
        type: 'rebalance',
        status: 'completed',
        amount: '300.0',
        walletId: 'tw-1',
        userId: 'admin-1',
        metadata: { direction: 'decrease' },
      });
      expect(usdcCall).toMatchObject({
        amount: '300.0',
        metadata: { direction: 'increase' },
      });

      const auditCalls = mockAuditLogCreate.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      const auditData = auditCalls.map((call) => call[0].data);
      expect(auditData).toContainEqual(
        expect.objectContaining({ action: 'treasury_rebalance', success: true })
      );
    });

    it('skips assets that are already at their target allocation', async () => {
      const operations = await TreasuryService.rebalance(
        [
          { assetCode: 'USD', targetAllocation: 80 },
          { assetCode: 'USDC', targetAllocation: 20 },
        ],
        'admin-1'
      );

      expect(operations).toHaveLength(0);
      expect(mockTransactionCreate).not.toHaveBeenCalled();
    });

    it('rejects allocations that do not sum to 100', async () => {
      await expect(
        TreasuryService.rebalance([{ assetCode: 'USD', targetAllocation: 80 }], 'admin-1')
      ).rejects.toThrow('Target allocations must sum to 100 percent');
      expect(mockTransactionCreate).not.toHaveBeenCalled();
    });

    it('rejects duplicate assets', async () => {
      await expect(
        TreasuryService.rebalance(
          [
            { assetCode: 'USD', targetAllocation: 50 },
            { assetCode: 'USD', targetAllocation: 50 },
          ],
          'admin-1'
        )
      ).rejects.toThrow('Duplicate asset in rebalance targets');
    });

    it('rejects out-of-range allocations', async () => {
      await expect(
        TreasuryService.rebalance(
          [
            { assetCode: 'USD', targetAllocation: 150 },
            { assetCode: 'USDC', targetAllocation: -50 },
          ],
          'admin-1'
        )
      ).rejects.toThrow('Allocation must be between 0 and 100');
    });

    it('throws when there is no treasury wallet', async () => {
      mockWalletFindMany.mockResolvedValue([]);

      await expect(
        TreasuryService.rebalance([{ assetCode: 'USD', targetAllocation: 100 }], 'admin-1')
      ).rejects.toThrow('No treasury wallet found');
    });

    it('throws when the treasury has no value', async () => {
      mockWalletBalanceFindMany.mockResolvedValue([]);

      await expect(
        TreasuryService.rebalance([{ assetCode: 'USD', targetAllocation: 100 }], 'admin-1')
      ).rejects.toThrow('Treasury has no value to rebalance');
    });
  });

  describe('getTreasuryHistory', () => {
    it('returns mapped operations for treasury wallets', async () => {
      mockWalletFindMany.mockResolvedValue([{ id: 'tw-1' }]);
      const createdAt = new Date('2026-06-18T00:00:00Z');
      mockTransactionFindMany.mockResolvedValue([
        {
          id: 'tx-1',
          type: 'rebalance',
          amount: '300.0',
          assetCode: 'USDC',
          status: 'completed',
          createdAt,
        },
      ]);

      const history = await TreasuryService.getTreasuryHistory({ type: 'rebalance', limit: 10 });

      expect(mockTransactionFindMany).toHaveBeenCalledWith({
        where: { walletId: { in: ['tw-1'] }, type: 'rebalance' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      expect(history).toEqual([
        {
          id: 'tx-1',
          type: 'rebalance',
          amount: '300.0',
          assetCode: 'USDC',
          status: 'completed',
          createdAt,
        },
      ]);
    });

    it('returns an empty array when there are no treasury wallets', async () => {
      mockWalletFindMany.mockResolvedValue([]);

      const history = await TreasuryService.getTreasuryHistory();

      expect(history).toEqual([]);
      expect(mockTransactionFindMany).not.toHaveBeenCalled();
    });
  });
});
