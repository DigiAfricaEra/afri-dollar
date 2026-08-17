/* eslint-disable @typescript-eslint/unbound-method */
import prisma from '../../config/database';
import {
  TransactionMonitorService,
  resetConfigCacheForTests,
} from '../../services/transaction-monitor.service';

jest.mock('../../config/database', () => {
  const client: Record<string, unknown> = {
    systemConfig: {
      findMany: jest.fn(),
    },
    transaction: {
      count: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    complianceAlert: {
      create: jest.fn(),
    },
  };

  client.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => Promise<unknown>)(client);
    }

    throw new TypeError('Unsupported $transaction argument');
  });

  return {
    __esModule: true,
    default: client,
  };
});

const mockSystemConfigFindMany = prisma.systemConfig.findMany as jest.Mock;
const mockTransactionCount = prisma.transaction.count as jest.Mock;
const mockTransactionFindMany = prisma.transaction.findMany as jest.Mock;
const mockTransactionUpdateMany = prisma.transaction.updateMany as jest.Mock;
const mockComplianceAlertCreate = prisma.complianceAlert.create as jest.Mock;

function resetMonitorMocks(): void {
  jest.clearAllMocks();
  resetConfigCacheForTests();
  mockSystemConfigFindMany.mockResolvedValue([]);
  mockTransactionCount.mockResolvedValue(0);
  mockTransactionFindMany.mockResolvedValue([]);
  mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
  mockComplianceAlertCreate.mockResolvedValue({});
}

const baseTransaction = {
  id: 'tx-1',
  userId: 'user-1',
  amount: '100',
  assetCode: 'XLM',
  createdAt: new Date(),
  metadata: {},
};

describe('TransactionMonitorService', () => {
  beforeEach(resetMonitorMocks);

  describe('evaluate', () => {
    it('flags a transaction above the large transaction threshold as high severity LARGE_TX', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '15000',
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'LARGE_TX', severity: 'high' })])
      );
    });

    it('does not flag a round amount below the round amount floor', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '9000',
      });

      expect(result.flagged).toBe(false);
      expect(result.alerts).toHaveLength(0);
    });

    it('flags a round amount at or above the floor as low severity ROUND_AMOUNT', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '10000',
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'ROUND_AMOUNT', severity: 'low' }),
        ])
      );
    });

    it('does not flag a non-round amount at or above the floor', async () => {
      mockSystemConfigFindMany.mockResolvedValue([
        { key: 'monitor.largeTxThresholdUsd', value: 20000 },
      ]);

      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '10400',
      });

      expect(result.flagged).toBe(false);
      expect(result.alerts).toHaveLength(0);
    });

    it('flags high velocity within the window as medium severity VELOCITY', async () => {
      mockTransactionCount.mockResolvedValue(11);

      const result = await TransactionMonitorService.evaluate(baseTransaction);

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'VELOCITY', severity: 'medium' }),
        ])
      );
    });

    it('does not flag velocity at or below the limit', async () => {
      mockTransactionCount.mockResolvedValue(9);

      const result = await TransactionMonitorService.evaluate(baseTransaction);

      expect(result.flagged).toBe(false);
      expect(result.alerts).toHaveLength(0);
    });

    it('flags a high risk destination country as HIGH_RISK_COUNTRY', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        metadata: { beneficiaryInfo: { name: 'Buyer', country: 'IR' } },
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'HIGH_RISK_COUNTRY', severity: 'high' }),
        ])
      );
    });

    it('normalizes lowercase and padded country codes', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        metadata: { beneficiaryInfo: { name: 'Buyer', country: ' ir ' } },
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'HIGH_RISK_COUNTRY' })])
      );
    });

    it('does not flag a low risk destination country', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        metadata: { beneficiaryInfo: { name: 'Buyer', country: 'NG' } },
      });

      expect(result.flagged).toBe(false);
    });

    it('applies configured thresholds from system config', async () => {
      mockSystemConfigFindMany.mockResolvedValue([
        { key: 'monitor.largeTxThresholdUsd', value: 5000 },
      ]);

      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '6000',
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'LARGE_TX' })])
      );
    });

    it('flags structuring at create time when the user has three transactions in the band', async () => {
      const now = baseTransaction.createdAt;
      const earlier = [
        { id: 'tx-prev-1', amount: '9500', createdAt: new Date(now.getTime() - 30 * 60_000) },
        { id: 'tx-prev-2', amount: '9500', createdAt: new Date(now.getTime() - 15 * 60_000) },
      ];
      const current = { ...baseTransaction, amount: '9500' };
      mockTransactionFindMany.mockResolvedValue([...earlier, current]);

      const result = await TransactionMonitorService.evaluate(current);

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'STRUCTURING',
            severity: 'medium',
            message: expect.stringContaining('3 transactions'),
          }),
        ])
      );
    });

    it('does not flag structuring when fewer than three transactions are in the band', async () => {
      const now = baseTransaction.createdAt;
      const current = { ...baseTransaction, amount: '9500' };
      mockTransactionFindMany.mockResolvedValue([
        { id: 'tx-prev-1', amount: '9500', createdAt: new Date(now.getTime() - 30 * 60_000) },
        current,
      ]);

      const result = await TransactionMonitorService.evaluate(current);

      expect(result.flagged).toBe(false);
      expect(result.alerts).toHaveLength(0);
    });

    it('flags an unparseable amount as high severity UNPARSEABLE_AMOUNT', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: 'not-a-number',
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: 'UNPARSEABLE_AMOUNT', severity: 'high' }),
        ])
      );
    });

    it('flags an empty amount as high severity UNPARSEABLE_AMOUNT', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '',
      });

      expect(result.flagged).toBe(true);
      expect(result.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'UNPARSEABLE_AMOUNT' })])
      );
    });
  });

  describe('getMonitorConfig', () => {
    it('falls back to defaults when the config query fails', async () => {
      mockSystemConfigFindMany.mockRejectedValue(new Error('database unavailable'));

      const config = await TransactionMonitorService.getMonitorConfig();

      expect(config.largeTxThresholdUsd).toBe(10000);
      expect(config.velocityWindowMinutes).toBe(60);
      expect(config.structuringRatio).toBe(0.8);
    });

    it('clamps out-of-range configured values to defaults', async () => {
      mockSystemConfigFindMany.mockResolvedValue([
        { key: 'monitor.velocityWindowMinutes', value: -5 },
        { key: 'monitor.structuringRatio', value: 2 },
        { key: 'monitor.roundAmountModulus', value: 0 },
      ]);

      const config = await TransactionMonitorService.getMonitorConfig();

      expect(config.velocityWindowMinutes).toBe(60);
      expect(config.structuringRatio).toBe(0.8);
      expect(config.roundAmountModulus).toBe(1000);
    });
  });

  describe('applyFlags', () => {
    it('creates a single compliance alert with the top severity rule', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '15000',
      });

      await TransactionMonitorService.applyFlags(baseTransaction, result);

      expect(mockTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tx-1', isFlagged: false },
          data: expect.objectContaining({
            isFlagged: true,
            flaggedBy: 'monitoring',
          }),
        })
      );
      expect(mockComplianceAlertCreate).toHaveBeenCalledTimes(1);
      expect(mockComplianceAlertCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ruleId: 'LARGE_TX',
            severity: 'high',
            transactionId: 'tx-1',
            userId: 'user-1',
          }),
        })
      );
    });

    it('does nothing when the transaction is not flagged', async () => {
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '100',
      });

      await TransactionMonitorService.applyFlags(baseTransaction, result);

      expect(mockTransactionUpdateMany).not.toHaveBeenCalled();
      expect(mockComplianceAlertCreate).not.toHaveBeenCalled();
    });

    it('does not create an alert when the transaction was already claimed by another process', async () => {
      mockTransactionUpdateMany.mockResolvedValue({ count: 0 });
      const result = await TransactionMonitorService.evaluate({
        ...baseTransaction,
        amount: '15000',
      });

      await TransactionMonitorService.applyFlags(baseTransaction, result);

      expect(mockComplianceAlertCreate).not.toHaveBeenCalled();
    });
  });

  describe('screenPastTransactions', () => {
    const windowTransaction = (id: string, amount: string, createdAt: Date) => ({
      id,
      userId: 'user-1',
      amount,
      assetCode: 'XLM',
      metadata: {},
      createdAt,
    });

    function mockScreeningCalls(rows: Array<{ id: string; amount: string; createdAt: Date }>) {
      mockTransactionFindMany.mockImplementation(
        (args: { where?: Record<string, unknown>; cursor?: { id: string } }) => {
          if (args?.where?.isFlagged === false) {
            if (args?.cursor) {
              return Promise.resolve([]);
            }
            return Promise.resolve(rows);
          }
          if (args?.where?.userId) {
            return Promise.resolve(rows);
          }
          return Promise.resolve([]);
        }
      );
    }

    it('flags the third structuring transaction of a user', async () => {
      const now = new Date();
      const first = windowTransaction('tx-1', '9500', new Date(now.getTime() - 30 * 60_000));
      const second = windowTransaction('tx-2', '9500', new Date(now.getTime() - 15 * 60_000));
      const third = windowTransaction('tx-3', '9500', new Date(now.getTime() - 5 * 60_000));
      mockScreeningCalls([first, second, third]);

      const result = await TransactionMonitorService.screenPastTransactions();

      expect(result.scanned).toBe(3);
      expect(result.flagged).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockComplianceAlertCreate).toHaveBeenCalledTimes(1);
      expect(mockComplianceAlertCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ruleId: 'STRUCTURING',
            severity: 'medium',
            transactionId: 'tx-3',
          }),
        })
      );
    });

    it('does not flag a user with fewer than three structuring transactions', async () => {
      const now = new Date();
      const first = windowTransaction('tx-1', '9500', new Date(now.getTime() - 30 * 60_000));
      const second = windowTransaction('tx-2', '9500', new Date(now.getTime() - 15 * 60_000));
      mockScreeningCalls([first, second]);

      const result = await TransactionMonitorService.screenPastTransactions();

      expect(result.scanned).toBe(2);
      expect(result.flagged).toBe(0);
      expect(mockComplianceAlertCreate).not.toHaveBeenCalled();
    });

    it('does not flag transactions at or above the large threshold', async () => {
      const now = new Date();
      const rows = [
        windowTransaction('tx-1', '15000', new Date(now.getTime() - 30 * 60_000)),
        windowTransaction('tx-2', '15000', new Date(now.getTime() - 15 * 60_000)),
        windowTransaction('tx-3', '15000', new Date(now.getTime() - 5 * 60_000)),
      ];
      mockScreeningCalls(rows);

      const result = await TransactionMonitorService.screenPastTransactions();

      expect(result.flagged).toBe(0);
      expect(mockComplianceAlertCreate).not.toHaveBeenCalled();
    });

    it('continues screening after a per-row failure and reports the failure count', async () => {
      const now = new Date();
      const first = windowTransaction('tx-1', '9500', new Date(now.getTime() - 30 * 60_000));
      const second = windowTransaction('tx-2', '9500', new Date(now.getTime() - 15 * 60_000));
      let windowQueryCount = 0;

      mockTransactionFindMany.mockImplementation(
        (args: { where?: Record<string, unknown>; cursor?: { id: string } }) => {
          if (args?.where?.isFlagged === false) {
            if (args?.cursor) {
              return Promise.resolve([]);
            }
            return Promise.resolve([first, second]);
          }
          if (args?.where?.userId) {
            windowQueryCount += 1;
            if (windowQueryCount === 1) {
              return Promise.reject(new Error('database unavailable'));
            }
            return Promise.resolve([first, second]);
          }
          return Promise.resolve([]);
        }
      );

      const result = await TransactionMonitorService.screenPastTransactions();

      expect(result.scanned).toBe(2);
      expect(result.flagged).toBe(0);
      expect(result.failed).toBe(1);
    });
  });
});
