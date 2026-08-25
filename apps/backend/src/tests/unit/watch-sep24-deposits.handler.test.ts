/* eslint-disable @typescript-eslint/unbound-method */
import { watchSep24Deposits } from '../../services/job-handlers/watch-sep24-deposits.handler';
import { StellarSep24Service } from '../../services/stellar-sep24.service';

jest.mock('../../services/stellar-sep24.service', () => ({
  StellarSep24Service: {
    watchDeposits: jest.fn(),
  },
}));

const mockWatchDeposits = StellarSep24Service.watchDeposits as jest.Mock;

describe('watchSep24Deposits handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates to StellarSep24Service.watchDeposits', async () => {
    mockWatchDeposits.mockResolvedValue(undefined);

    await watchSep24Deposits();

    expect(mockWatchDeposits).toHaveBeenCalledTimes(1);
  });
});
