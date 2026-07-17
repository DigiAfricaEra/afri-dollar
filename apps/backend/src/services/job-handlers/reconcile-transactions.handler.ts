import { TreasuryService } from '../treasury.service';

export async function reconcileTransactions(): Promise<void> {
  await TreasuryService.getTreasuryHistory({ limit: 100 });
  // TODO: Reconcile local transaction records with Stellar once reconciliation
  // provider/service APIs are available.
}
