import type { JobDefinition } from '../types/job.types';

export const jobs: JobDefinition[] = [
  {
    name: 'sync-fx-rates',
    schedule: '*/5 * * * *',
    handler: 'syncFxRates',
    priority: 'high',
    retryAttempts: 3,
    retryDelay: 60000,
  },
  {
    name: 'reconcile-transactions',
    schedule: '0 * * * *',
    handler: 'reconcileTransactions',
    priority: 'medium',
    retryAttempts: 3,
    retryDelay: 120000,
  },
  {
    name: 'process-pending-payments',
    schedule: '* * * * *',
    handler: 'processPendingPayments',
    priority: 'high',
    retryAttempts: 5,
    retryDelay: 30000,
  },
  {
    name: 'cleanup-old-logs',
    schedule: '0 0 * * *',
    handler: 'cleanupOldLogs',
    priority: 'low',
    retryAttempts: 2,
    retryDelay: 300000,
  },
  {
    name: 'send-reminders',
    schedule: '0 9 * * *',
    handler: 'sendReminders',
    priority: 'medium',
    retryAttempts: 3,
    retryDelay: 60000,
  },
];
