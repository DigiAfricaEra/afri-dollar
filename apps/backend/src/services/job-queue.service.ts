import { JobExecutionStatus as DbJobExecutionStatus } from '@afri-dollar/database';
import Bull, { Job, JobOptions } from 'bull';
import { validate } from 'node-cron';

import prisma from '../config/database';
import { jobs as defaultJobs } from '../config/jobs.config';
import type { JobDefinition, JobExecution } from '../types/job.types';

import { jobHandlers, type JobHandlerName } from './job-handlers';

type JobQueuePayload = {
  executionId?: string;
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
const JOB_QUEUE_CONCURRENCY = 5;
const MEMORY_EXECUTION_LIMIT = 1000;
const DEFAULT_EXECUTION_LIMIT = 100;
const MAX_EXECUTION_LIMIT = 200;
const PRIORITY_VALUES: Record<JobDefinition['priority'], number> = {
  high: 1,
  medium: 5,
  low: 10,
};

export interface ListJobExecutionsOptions {
  limit?: number;
  cursor?: string;
}

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
  private status: QueueStatus = 'disabled';
  private readonly memoryExecutions = new Map<string, JobExecution>();

  constructor(definitions: JobDefinition[] = defaultJobs) {
    this.definitions = definitions;
  }

  async start(): Promise<void> {
    if (this.queue) {
      return;
    }

    if (!process.env.REDIS_URL) {
      this.status = 'disabled';
      console.warn('Job queue disabled: REDIS_URL is not configured');
      this.validateSchedules();
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

    void this.queue.process(
      JOB_QUEUE_CONCURRENCY,
      async (job: Job<JobQueuePayload>): Promise<void> => {
        await this.runJob(job.data);
      }
    );

    await this.registerRepeatableSchedules();

    this.status = 'ready';
  }

  async stop(): Promise<void> {
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

  async listExecutions(options: ListJobExecutionsOptions = {}): Promise<JobExecution[]> {
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_EXECUTION_LIMIT, 1),
      MAX_EXECUTION_LIMIT
    );

    try {
      const executions = await prisma.jobExecution.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      });

      return executions.map(mapExecution);
    } catch (error) {
      console.error('Unable to read persisted job executions:', error);
      const executions = Array.from(this.memoryExecutions.values()).reverse();
      const startIndex = options.cursor
        ? executions.findIndex((execution) => execution.id === options.cursor) + 1
        : 0;

      return executions.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit);
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
      try {
        await this.runJob(payload);
      } catch (error) {
        console.error(`Local execution failed for job ${definition.name}:`, error);
      }
      const completedExecution = await this.getExecution(execution.id);
      return completedExecution ?? execution;
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

  private validateSchedules(): void {
    for (const definition of this.definitions) {
      if (!validate(definition.schedule)) {
        console.error(`Invalid cron schedule for job ${definition.name}: ${definition.schedule}`);
      }
    }
  }

  private async registerRepeatableSchedules(): Promise<void> {
    if (!this.queue) {
      return;
    }

    for (const definition of this.definitions) {
      if (!validate(definition.schedule)) {
        console.error(`Invalid cron schedule for job ${definition.name}: ${definition.schedule}`);
        continue;
      }

      await this.queue.add(
        definition.name,
        {
          jobName: definition.name,
          handler: definition.handler,
        },
        {
          ...buildJobOptions(definition),
          jobId: definition.name,
          repeat: {
            cron: definition.schedule,
          },
        }
      );
    }
  }

  private async runJob(payload: JobQueuePayload): Promise<JobExecution> {
    const execution =
      payload.executionId !== undefined
        ? await this.getExecution(payload.executionId)
        : await this.createExecution(payload.jobName);
    const executionId = execution?.id ?? payload.executionId;

    if (executionId === undefined) {
      throw new Error(`Unable to create execution record for job ${payload.jobName}`);
    }

    await this.markExecutionRunning(executionId);

    const handler = getJobHandler(payload.handler);
    if (handler === null) {
      const message = `Job handler not found: ${payload.handler}`;
      await this.markExecutionFailed(executionId, message);
      throw new Error(message);
    }

    try {
      await handler();
      await this.markExecutionCompleted(executionId);
      const completedExecution = await this.getExecution(executionId);
      if (completedExecution === null) {
        throw new Error(`Job execution not found after completion: ${executionId}`);
      }
      return completedExecution;
    } catch (error) {
      const message = getErrorMessage(error);
      await this.markExecutionFailed(executionId, message);
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
          status: DbJobExecutionStatus.pending,
        },
      });

      return mapExecution(execution);
    } catch (error) {
      console.error('Unable to persist pending job execution:', error);
      this.memoryExecutions.set(fallback.id, fallback);
      this.evictOldMemoryExecutions();
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
        data: {
          ...data,
          status: data.status,
        },
      });
    } catch (error) {
      console.error(`Unable to update job execution ${id}:`, error);
    }
  }

  private evictOldMemoryExecutions(): void {
    while (this.memoryExecutions.size > MEMORY_EXECUTION_LIMIT) {
      const oldestKey = this.memoryExecutions.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.memoryExecutions.delete(oldestKey);
    }
  }
}

export const jobQueueService = new JobQueueService();
