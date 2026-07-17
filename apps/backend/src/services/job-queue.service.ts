import Bull, { Job, JobOptions } from 'bull';
import cron, { ScheduledTask } from 'node-cron';

import prisma from '../config/database';
import { jobs as defaultJobs } from '../config/jobs.config';
import type { JobDefinition, JobExecution } from '../types/job.types';

import { jobHandlers, type JobHandlerName } from './job-handlers';

type JobQueuePayload = {
  executionId: string;
  jobName: string;
  handler: string;
};

type PersistedJobExecution = {
  id: string;
  jobName: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
};

type QueueStatus = 'disabled' | 'ready' | 'error';

const JOB_QUEUE_NAME = 'scheduled-jobs';
const PRIORITY_VALUES: Record<JobDefinition['priority'], number> = {
  high: 1,
  medium: 5,
  low: 10,
};

function isJobStatus(status: string): status is JobExecution['status'] {
  return ['pending', 'running', 'completed', 'failed'].includes(status);
}

function mapExecution(record: PersistedJobExecution): JobExecution {
  return {
    id: record.id,
    jobName: record.jobName,
    status: isJobStatus(record.status) ? record.status : 'failed',
    startedAt: record.startedAt || undefined,
    completedAt: record.completedAt || undefined,
    error: record.error || undefined,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getJobHandler(handlerName: string): (() => Promise<void>) | null {
  if (Object.prototype.hasOwnProperty.call(jobHandlers, handlerName)) {
    return jobHandlers[handlerName as JobHandlerName];
  }

  return null;
}

export function getJobPriorityValue(priority: JobDefinition['priority']): number {
  return PRIORITY_VALUES[priority];
}

export function buildJobOptions(definition: JobDefinition): JobOptions {
  return {
    attempts: definition.retryAttempts,
    backoff: {
      type: 'fixed',
      delay: definition.retryDelay,
    },
    priority: getJobPriorityValue(definition.priority),
    removeOnComplete: 100,
    removeOnFail: 100,
  };
}

export class JobQueueService {
  private readonly definitions: JobDefinition[];
  private queue: Bull.Queue<JobQueuePayload> | null = null;
  private readonly scheduledTasks: ScheduledTask[] = [];
  private status: QueueStatus = 'disabled';
  private readonly memoryExecutions = new Map<string, JobExecution>();

  constructor(definitions: JobDefinition[] = defaultJobs) {
    this.definitions = definitions;
  }

  async start(): Promise<void> {
    if (this.queue || this.scheduledTasks.length > 0) {
      return;
    }

    if (!process.env.REDIS_URL) {
      this.status = 'disabled';
      console.warn('Job queue disabled: REDIS_URL is not configured');
      this.registerSchedules();
      return;
    }

    this.queue = new Bull<JobQueuePayload>(JOB_QUEUE_NAME, process.env.REDIS_URL, {
      settings: {
        retryProcessDelay: 5000,
      },
    });

    this.queue.on('error', (error: Error) => {
      this.status = 'error';
      console.error('Job queue Redis error:', error);
    });

    void this.queue.process(async (job: Job<JobQueuePayload>): Promise<void> => {
      await this.runJob(job.data);
    });

    this.status = 'ready';
    this.registerSchedules();
  }

  async stop(): Promise<void> {
    for (const task of this.scheduledTasks) {
      task.stop();
    }
    this.scheduledTasks.length = 0;

    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }

    this.status = 'disabled';
  }

  getDefinitions(): JobDefinition[] {
    return this.definitions;
  }

  getStatus(): QueueStatus {
    return this.status;
  }

  async listExecutions(): Promise<JobExecution[]> {
    try {
      const executions = await prisma.jobExecution.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });

      return executions.map(mapExecution);
    } catch (error) {
      console.error('Unable to read persisted job executions:', error);
      return Array.from(this.memoryExecutions.values());
    }
  }

  async getExecution(id: string): Promise<JobExecution | null> {
    try {
      const execution = await prisma.jobExecution.findUnique({
        where: { id },
      });

      return execution ? mapExecution(execution) : null;
    } catch (error) {
      console.error('Unable to read persisted job execution:', error);
      return this.memoryExecutions.get(id) || null;
    }
  }

  async enqueueJob(definition: JobDefinition): Promise<JobExecution> {
    const execution = await this.createExecution(definition.name);
    const payload: JobQueuePayload = {
      executionId: execution.id,
      jobName: definition.name,
      handler: definition.handler,
    };

    if (!this.queue) {
      await this.runJob(payload);
      const completedExecution = await this.getExecution(execution.id);
      return completedExecution || execution;
    }

    try {
      await this.queue.add(definition.name, payload, buildJobOptions(definition));
      return execution;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error(`Failed to enqueue job ${definition.name}:`, error);
      await this.markExecutionFailed(execution.id, message);
      return {
        ...execution,
        status: 'failed',
        completedAt: new Date(),
        error: message,
      };
    }
  }

  private registerSchedules(): void {
    for (const definition of this.definitions) {
      if (!cron.validate(definition.schedule)) {
        console.error(`Invalid cron schedule for job ${definition.name}: ${definition.schedule}`);
        continue;
      }

      const task = cron.schedule(definition.schedule, () => {
        void this.enqueueJob(definition);
      });

      this.scheduledTasks.push(task);
    }
  }

  private async runJob(payload: JobQueuePayload): Promise<void> {
    await this.markExecutionRunning(payload.executionId);

    const handler = getJobHandler(payload.handler);
    if (handler === null) {
      const message = `Job handler not found: ${payload.handler}`;
      await this.markExecutionFailed(payload.executionId, message);
      throw new Error(message);
    }

    try {
      await handler();
      await this.markExecutionCompleted(payload.executionId);
    } catch (error) {
      const message = getErrorMessage(error);
      await this.markExecutionFailed(payload.executionId, message);
      throw error;
    }
  }

  private async createExecution(jobName: string): Promise<JobExecution> {
    const fallback: JobExecution = {
      id: `memory-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      jobName,
      status: 'pending',
    };

    try {
      const execution = await prisma.jobExecution.create({
        data: {
          jobName,
          status: 'pending',
        },
      });

      return mapExecution(execution);
    } catch (error) {
      console.error('Unable to persist pending job execution:', error);
      this.memoryExecutions.set(fallback.id, fallback);
      return fallback;
    }
  }

  private async markExecutionRunning(id: string): Promise<void> {
    await this.updateExecution(id, {
      status: 'running',
      startedAt: new Date(),
      error: null,
    });
  }

  private async markExecutionCompleted(id: string): Promise<void> {
    await this.updateExecution(id, {
      status: 'completed',
      completedAt: new Date(),
      error: null,
    });
  }

  private async markExecutionFailed(id: string, error: string): Promise<void> {
    await this.updateExecution(id, {
      status: 'failed',
      completedAt: new Date(),
      error,
    });
  }

  private async updateExecution(
    id: string,
    data: {
      status: JobExecution['status'];
      startedAt?: Date;
      completedAt?: Date;
      error?: string | null;
    }
  ): Promise<void> {
    const inMemory = this.memoryExecutions.get(id);
    if (inMemory) {
      this.memoryExecutions.set(id, {
        ...inMemory,
        status: data.status,
        startedAt: data.startedAt || inMemory.startedAt,
        completedAt: data.completedAt || inMemory.completedAt,
        error: data.error === null ? undefined : data.error || inMemory.error,
      });
      return;
    }

    try {
      await prisma.jobExecution.update({
        where: { id },
        data,
      });
    } catch (error) {
      console.error(`Unable to update job execution ${id}:`, error);
    }
  }
}

export const jobQueueService = new JobQueueService();
