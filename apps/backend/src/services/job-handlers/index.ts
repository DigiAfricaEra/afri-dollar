import { cleanupOldLogs } from './cleanup-old-logs.handler';
import { processPendingPayments } from './process-pending-payments.handler';
import { reconcileTransactions } from './reconcile-transactions.handler';
import { screenTransactions } from './screen-transactions.handler';
import { sendReminders } from './send-reminders.handler';
import { syncFxRates } from './sync-fx-rates.handler';

export const jobHandlers = {
  syncFxRates,
  reconcileTransactions,
  processPendingPayments,
  cleanupOldLogs,
  sendReminders,
  screenTransactions,
};

export type JobHandlerName = keyof typeof jobHandlers;
