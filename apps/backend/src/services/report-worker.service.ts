import fs from 'fs';

import { Prisma } from '@afri-dollar/database';
import Bull from 'bull';

import prisma from '../config/database';
import { AppError } from '../types';
import type { ReportParameters } from '../types';

import {
  generateCSV,
  generatePDF,
  generateXLSX,
  getDataFetcher,
  getFilePath,
  validateReportType,
  validateReportFormat,
} from './report.helpers';

const REPORT_WORKER_QUEUE = 'report-generation';
const WORKER_CONCURRENCY = 3;
const FETCH_LIMIT = 10_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30_000;

type ReportJobPayload = {
  requestId?: string;
  templateId?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientError(error: unknown): boolean {
  if (error instanceof AppError) return false;

  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return true;
  if (error instanceof Prisma.PrismaClientRustPanicError) return true;

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const transientCodes = new Set(['P1001', 'P1008', 'P1017', 'P2024']);
    return transientCodes.has(error.code);
  }

  return true;
}

async function processReport(requestId: string): Promise<void> {
  const result = await prisma.reportRequest.updateMany({
    where: { id: requestId, status: 'pending' },
    data: { status: 'generating' },
  });

  if (result.count === 0) return;

  const report = await prisma.reportRequest.findUnique({
    where: { id: requestId },
  });

  if (!report) return;

  const reportType = validateReportType(report.reportType);
  const fetcher = getDataFetcher(reportType);

  if (!fetcher) {
    throw new AppError(400, `Unknown report type: ${report.reportType}`);
  }

  const params = report.parameters as ReportParameters | undefined;
  const data = await fetcher(report.userId, params, FETCH_LIMIT);

  const format = validateReportFormat(report.format);
  const filePath = getFilePath(requestId, format);
  const tempPath = `${filePath}.tmp`;

  switch (format) {
    case 'csv':
      await generateCSV(data, tempPath);
      break;
    case 'pdf':
      await generatePDF(data, tempPath, `${report.reportType} Report`);
      break;
    case 'xlsx':
      await generateXLSX(data, tempPath);
      break;
  }

  fs.renameSync(tempPath, filePath);

  await prisma.reportRequest.update({
    where: { id: requestId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      downloadUrl: `/api/v1/reports/${requestId}/download`,
    },
  });
}

async function processScheduledReport(templateId: string): Promise<void> {
  const template = await prisma.reportTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template?.schedule) return;

  const report = await prisma.reportRequest.create({
    data: {
      userId: 'system',
      reportType: template.reportType,
      format: template.format,
      status: 'pending',
    },
  });

  await processReport(report.id);
}

function buildJobOptions(): Bull.JobOptions {
  return {
    attempts: RETRY_ATTEMPTS,
    backoff: { type: 'fixed', delay: RETRY_DELAY_MS },
    removeOnComplete: 100,
    removeOnFail: 100,
  };
}

export class ReportWorkerService {
  private queue: Bull.Queue<ReportJobPayload> | null = null;
  private status: 'disabled' | 'ready' | 'error' = 'disabled';

  async start(): Promise<void> {
    if (this.queue) return;

    if (!process.env.REDIS_URL) {
      this.status = 'disabled';
      console.warn('Report worker disabled: REDIS_URL is not configured');
      return;
    }

    this.queue = new Bull<ReportJobPayload>(REPORT_WORKER_QUEUE, process.env.REDIS_URL, {
      settings: {
        retryProcessDelay: 5000,
        stalledInterval: 30000,
        maxStalledCount: 2,
      },
    });

    this.queue.on('error', (error: Error) => {
      this.status = 'error';
      console.error('Report worker Redis error:', error);
    });

    void this.queue.process(WORKER_CONCURRENCY, async (job: Bull.Job<ReportJobPayload>) => {
      if (job.data.requestId) {
        await this.processReportWithRetry(job, job.data.requestId);
      } else if (job.data.templateId) {
        await processScheduledReport(job.data.templateId);
      }
    });

    this.status = 'ready';
  }

  private async processReportWithRetry(
    job: Bull.Job<ReportJobPayload>,
    requestId: string
  ): Promise<void> {
    try {
      await processReport(requestId);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error(`Report generation failed for ${requestId}:`, message);

      const isLastAttempt = job.attemptsMade >= (job.opts.attempts || 1);

      if (isTransientError(error) && !isLastAttempt) {
        await prisma.reportRequest
          .update({
            where: { id: requestId },
            data: { status: 'pending' },
          })
          .catch((err) => {
            console.error(`Failed to reset report status for ${requestId}:`, err);
          });

        throw error;
      }

      await prisma.reportRequest
        .update({
          where: { id: requestId },
          data: {
            status: 'failed',
            completedAt: new Date(),
          },
        })
        .catch((err) => {
          console.error(`Failed to update report status for ${requestId}:`, err);
        });
    }
  }

  async stop(): Promise<void> {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }

    this.status = 'disabled';
  }

  getStatus(): string {
    return this.status;
  }

  async enqueue(requestId: string): Promise<void> {
    if (!this.queue) {
      throw new AppError(503, 'Report worker is not initialized');
    }

    await this.queue.add({ requestId }, buildJobOptions());
  }

  async scheduleTemplate(templateId: string): Promise<void> {
    if (!this.queue) return;

    const template = await prisma.reportTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template?.schedule) return;

    await this.queue.add(
      { templateId },
      {
        ...buildJobOptions(),
        repeat: { cron: template.schedule },
        jobId: `template-${templateId}`,
      }
    );
  }

  async cancelScheduledTemplate(templateId: string): Promise<void> {
    if (!this.queue) return;

    const jobs = await this.queue.getRepeatableJobs();
    const job = jobs.find((j) => j.id === `template-${templateId}`);

    if (job) {
      await this.queue.removeRepeatableByKey(job.key);
    }
  }
}

export const reportWorker = new ReportWorkerService();
