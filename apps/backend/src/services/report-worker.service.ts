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
  requestId: string;
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
  const report = await prisma.reportRequest.findUnique({ where: { id: requestId } });

  if (!report) {
    throw new AppError(404, `Report not found: ${requestId}`);
  }

  if (report.status === 'completed') return;

  await prisma.reportRequest.update({
    where: { id: requestId },
    data: { status: 'generating' },
  });

  const reportType = validateReportType(report.reportType);
  const fetcher = getDataFetcher(reportType);

  if (!fetcher) {
    throw new AppError(400, `Unknown report type: ${report.reportType}`);
  }

  const params = report.parameters as ReportParameters | undefined;
  const data = await fetcher(params, FETCH_LIMIT);

  const format = validateReportFormat(report.format);
  const filePath = getFilePath(requestId, format);

  switch (format) {
    case 'csv':
      await generateCSV(data, filePath);
      break;
    case 'pdf':
      await generatePDF(data, filePath, `${report.reportType} Report`);
      break;
    case 'xlsx':
      await generateXLSX(data, filePath);
      break;
  }

  await prisma.reportRequest.update({
    where: { id: requestId },
    data: {
      status: 'completed',
      completedAt: new Date(),
      downloadUrl: `/api/v1/reports/${requestId}/download`,
    },
  });
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
      const { requestId } = job.data;

      try {
        await processReport(requestId);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error(`Report generation failed for ${requestId}:`, message);

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

        if (isTransientError(error)) {
          throw error;
        }
      }
    });

    this.status = 'ready';
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
      await processReport(requestId);
      return;
    }

    await this.queue.add({ requestId }, buildJobOptions());
  }
}

export const reportWorker = new ReportWorkerService();
