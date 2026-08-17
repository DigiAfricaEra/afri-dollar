/* eslint-disable @typescript-eslint/unbound-method */
import { screenTransactions } from '../../services/job-handlers/screen-transactions.handler';
import { TransactionMonitorService } from '../../services/transaction-monitor.service';

jest.mock('../../services/transaction-monitor.service', () => ({
  TransactionMonitorService: {
    screenPastTransactions: jest.fn(),
  },
}));

const mockScreenPastTransactions = TransactionMonitorService.screenPastTransactions as jest.Mock;

describe('screenTransactions handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs the structuring scan and reports scanned and flagged counts', async () => {
    mockScreenPastTransactions.mockResolvedValue({ scanned: 120, flagged: 3 });

    await screenTransactions();

    expect(mockScreenPastTransactions).toHaveBeenCalledTimes(1);
  });

  it('propagates failures from the monitor service', async () => {
    mockScreenPastTransactions.mockRejectedValue(new Error('database unavailable'));

    await expect(screenTransactions()).rejects.toThrow('database unavailable');
  });
});
