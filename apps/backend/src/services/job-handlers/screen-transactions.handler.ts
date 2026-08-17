import { TransactionMonitorService } from '../transaction-monitor.service';

/**
 * Runs the nightly structuring screen and logs the scanned, flagged, and
 * failed counts so partial sweeps are visible.
 */
export async function screenTransactions(): Promise<void> {
  const result = await TransactionMonitorService.screenPastTransactions();
  console.log(
    `[screen-transactions] scanned=${result.scanned} flagged=${result.flagged} failed=${result.failed}`
  );
}
