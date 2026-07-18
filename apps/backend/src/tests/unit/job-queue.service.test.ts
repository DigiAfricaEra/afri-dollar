import { buildJobOptions, getJobPriorityValue } from '../../services/job-queue.service';
import type { JobDefinition } from '../../types/job.types';

const baseJob: JobDefinition = {
  name: 'sync-fx-rates',
  schedule: '*/5 * * * *',
  handler: 'syncFxRates',
  priority: 'high',
  retryAttempts: 3,
  retryDelay: 60000,
};

describe('JobQueueService helpers', () => {
  it('builds retry options with fixed backoff', () => {
    expect(buildJobOptions(baseJob)).toEqual(
      expect.objectContaining({
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: 60000,
        },
      })
    );
  });

  it('orders high priority jobs before medium and low priority jobs', () => {
    expect(getJobPriorityValue('high')).toBeLessThan(getJobPriorityValue('medium'));
    expect(getJobPriorityValue('medium')).toBeLessThan(getJobPriorityValue('low'));
  });
});
