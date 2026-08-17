import { TransactionMonitorService } from '../transaction-monitor.service';

export async function screenTransactions(): Promise<void> {
  const result = await TransactionMonitorService.screenPastTransactions();
  console.log(
    `[screen-transactions] scanned=${result.scanned} flagged=${result.flagged} failed=${result.failed}`
  );
}
