export interface JobDefinition {
  name: string;
  schedule: string; // cron expression
  handler: string; // function to execute
  priority: 'high' | 'medium' | 'low';
  retryAttempts: number;
  retryDelay: number;
}

export interface JobExecution {
  id: string;
  jobName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}
