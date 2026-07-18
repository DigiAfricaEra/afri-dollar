import fs from 'fs';
import path from 'path';

import { createObjectCsvWriter } from 'csv-writer';
import { Workbook } from 'exceljs';
import PDFDocument from 'pdfkit';

import prisma from '../config/database';
import { AppError } from '../types';
import type {
  ReportType,
  ReportFormat,
  ReportParameters,
  ReportData,
} from '../types';

const REPORTS_DIR = path.resolve(__dirname, '../../uploads/reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

export const REPORT_FETCH_LIMIT = 10_000;

export function getFilePath(requestId: string, format: ReportFormat): string {
  return path.join(REPORTS_DIR, `${requestId}.${format}`);
}

export function validateReportType(value: string): ReportType {
  const valid: ReportType[] = [
    'transaction-history',
    'compliance-report',
    'financial-statement',
    'payroll-report',
    'treasury-report',
    'audit-log',
  ];

  for (const v of valid) {
    if (value === v) return v;
  }

  throw new AppError(400, `Invalid report type: ${value}`);
}

export function validateReportFormat(value: string): ReportFormat {
  const valid: ReportFormat[] = ['csv', 'pdf', 'xlsx'];

  for (const v of valid) {
    if (value === v) return v;
  }

  throw new AppError(400, `Invalid report format: ${value}`);
}

async function fetchTransactionHistory(
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  if (params?.userId != null) where.userId = params.userId;
  if (params?.assetCode != null) where.assetCode = params.assetCode;
  if (params?.status != null) where.status = params.status;

  return prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit ?? REPORT_FETCH_LIMIT });
}

async function fetchComplianceData(
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.status != null) where.status = params.status;

  const records = await prisma.kYCRecord.findMany({
    where,
    include: { user: { select: { email: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit ?? REPORT_FETCH_LIMIT,
  });

  return records.map((record) => ({
    id: record.id,
    userName: `${record.user.firstName ?? ''} ${record.user.lastName ?? ''}`.trim(),
    email: record.user?.email ?? '',
    provider: record.provider,
    status: record.status,
    documentType: record.documentType ?? '',
    createdAt: record.createdAt,
    reviewedAt: record.reviewedAt ?? undefined,
  }));
}

async function fetchFinancialStatement(
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  return prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit ?? REPORT_FETCH_LIMIT });
}

async function fetchPayrollReport(
  _params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const batches = await prisma.payrollBatch.findMany({
    include: { items: true },
    orderBy: { createdAt: 'desc' },
    take: limit ?? REPORT_FETCH_LIMIT,
  });

  return batches.map((batch) => ({
    id: batch.id,
    name: batch.name,
    description: batch.description ?? '',
    status: batch.status,
    itemCount: batch.items.length,
    totalAmount: batch.items.reduce((sum, item) => sum + Number(item.amount), 0).toString(),
    createdAt: batch.createdAt,
  }));
}

async function fetchTreasuryReport(
  _params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const wallets = await prisma.wallet.findMany({
    where: { walletType: 'treasury', isActive: true },
    include: { balances: true },
    take: limit ?? REPORT_FETCH_LIMIT,
  });

  return wallets.flatMap((wallet) =>
    wallet.balances.map((balance) => ({
      walletId: wallet.id,
      assetCode: balance.assetCode,
      assetIssuer: balance.assetIssuer ?? '',
      balance: balance.balance,
    }))
  );
}

async function fetchAuditLogs(
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  if (params?.userId != null) where.userId = params.userId;

  return prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit ?? REPORT_FETCH_LIMIT });
}

export function getDataFetcher(
  reportType: ReportType
): ((params?: ReportParameters, limit?: number) => Promise<ReportData[]>) | null {
  switch (reportType) {
    case 'transaction-history':
      return fetchTransactionHistory;
    case 'compliance-report':
      return fetchComplianceData;
    case 'financial-statement':
      return fetchFinancialStatement;
    case 'payroll-report':
      return fetchPayrollReport;
    case 'treasury-report':
      return fetchTreasuryReport;
    case 'audit-log':
      return fetchAuditLogs;
    default:
      return null;
  }
}

export async function generateCSV(data: ReportData[], filePath: string): Promise<void> {
  if (data.length === 0) {
    fs.writeFileSync(filePath, '');
    return;
  }

  const headers = Object.keys(data[0]).map((key) => ({ id: key, title: key }));
  const writer = createObjectCsvWriter({ path: filePath, header: headers });
  await writer.writeRecords(data);
}

export async function generatePDF(data: ReportData[], filePath: string, title: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30 });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);
    doc.fontSize(18).text(title, { align: 'center' });
    doc.moveDown();

    if (data.length > 0) {
      const headers = Object.keys(data[0]);
      const colWidth = (doc.page.width - 60) / headers.length;

      doc.fontSize(10).font('Helvetica-Bold');
      let xPosition = 30;
      const tableTop = doc.y;

      headers.forEach((header) => {
        doc.text(header, xPosition, tableTop, { width: colWidth, align: 'left' });
        xPosition += colWidth;
      });

      doc.moveDown();
      doc.font('Helvetica').fontSize(8);

      for (const row of data) {
        if (doc.y > doc.page.height - 50) {
          doc.addPage();
        }

        xPosition = 30;
        headers.forEach((header) => {
          const cellValue = row[header];
          // eslint-disable-next-line @typescript-eslint/no-base-to-string
          const displayValue = cellValue == null ? '' : String(cellValue);
          doc.text(displayValue, xPosition, doc.y, { width: colWidth, align: 'left' });
          xPosition += colWidth;
        });
        doc.moveDown(0.5);
      }
    } else {
      doc.fontSize(12).text('No data available', { align: 'center' });
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

export async function generateXLSX(data: ReportData[], filePath: string): Promise<void> {
  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet('Report');

  if (data.length > 0) {
    const headers = Object.keys(data[0]);

    worksheet.columns = headers.map((header) => ({ header, key: header, width: 20 }));
    data.forEach((row) => worksheet.addRow(row));
  }

  await workbook.xlsx.writeFile(filePath);
}
