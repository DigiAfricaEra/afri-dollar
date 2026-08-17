/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import fs from 'fs';
import path from 'path';

import type { ReportFormat, ReportType, ReportParameters, ReportData } from '../../types';
import { getDataFetcher, getMimeType, type StorageAdapter } from '../report.helpers';

import { generateCSV } from './csv-writer';
import { generatePDF } from './pdf-writer';
import { generateXLSX } from './xlsx-writer';

export interface ReportGenerationRequest {
  id: string;
  userId: string;
  reportType: ReportType;
  format: ReportFormat;
  parameters?: ReportParameters;
}

export interface ReportGenerationResult {
  storageKey: string;
  fileSizeBytes: number;
  mimeType: string;
  downloadUrl: string;
}

const REPORT_TITLES: Record<ReportType, string> = {
  'transaction-history': 'Transaction History Report',
  'compliance-report': 'Compliance & KYC Report',
  'financial-statement': 'Financial Statement Snapshot',
  'payroll-report': 'Payroll Batches Report',
  'treasury-report': 'Treasury Positions Report',
  'audit-log': 'Audit Log Report',
};

export async function generateReportFile(
  request: ReportGenerationRequest,
  storageAdapter: StorageAdapter
): Promise<ReportGenerationResult> {
  const fetcher = getDataFetcher(request.reportType);
  if (!fetcher) {
    throw new Error(`Unsupported report type: ${request.reportType}`);
  }

  const data: ReportData[] = await fetcher(request.userId, request.parameters);
  const title = REPORT_TITLES[request.reportType] || `${request.reportType} Report`;

  const storageKey = `reports/${request.id}.${request.format}`;
  const tempPath = path.resolve(process.cwd(), `tmp_${request.id}.${request.format}`);

  try {
    switch (request.format) {
      case 'csv':
        await generateCSV(data, tempPath);
        break;
      case 'pdf':
        await generatePDF(data, tempPath, {
          title,
          parameters: request.parameters as Record<string, unknown> | undefined,
        });
        break;
      case 'xlsx':
        await generateXLSX(data, tempPath, title);
        break;
      default:
        throw new Error(`Unsupported report format: ${request.format as string}`);
    }

    const stats = fs.statSync(tempPath);
    const fileSizeBytes = stats.size;
    const readStream = fs.createReadStream(tempPath);
    const writeStream = storageAdapter.writeStream(storageKey);

    await new Promise<void>((resolve, reject) => {
      readStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      readStream.on('error', reject);
    });

    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    const mimeType = getMimeType(request.format);
    const downloadUrl = `/api/v1/reports/${request.id}/download`;

    return {
      storageKey,
      fileSizeBytes,
      mimeType,
      downloadUrl,
    };
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw error;
  }
}
