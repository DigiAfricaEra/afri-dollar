import fs from 'fs';
import path from 'path';

import prisma from '../config/database';
import { AppError } from '../types';
import type { ReportType, ReportFormat, ReportParameters, ReportData } from '../types';

export const REPORT_STORAGE_DIR =
  process.env.REPORT_STORAGE_DIR || path.resolve(__dirname, '../../uploads/reports');

if (!fs.existsSync(REPORT_STORAGE_DIR)) {
  fs.mkdirSync(REPORT_STORAGE_DIR, { recursive: true });
}

export const REPORT_FETCH_LIMIT = 10_000;

export interface StorageAdapter {
  writeStream(key: string): fs.WriteStream;
  getReadStream(key: string): fs.ReadStream;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
}

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || REPORT_STORAGE_DIR;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private getFullPath(key: string): string {
    const safeKey = key.startsWith('/') ? key.substring(1) : key;
    const fullPath = path.join(this.baseDir, safeKey);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fullPath;
  }

  writeStream(key: string): fs.WriteStream {
    return fs.createWriteStream(this.getFullPath(key));
  }

  getReadStream(key: string): fs.ReadStream {
    return fs.createReadStream(this.getFullPath(key));
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.getFullPath(key));
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.getFullPath(key);
    if (fs.existsSync(fullPath)) {
      await fs.promises.unlink(fullPath);
    }
  }

  getUrl(key: string): string {
    return `/uploads/${key}`;
  }
}

export class S3StorageAdapter implements StorageAdapter {
  writeStream(_key: string): fs.WriteStream {
    throw new Error('S3StorageAdapter writeStream not implemented yet');
  }
  getReadStream(_key: string): fs.ReadStream {
    throw new Error('S3StorageAdapter getReadStream not implemented yet');
  }
  async exists(_key: string): Promise<boolean> {
    return false;
  }
  async delete(_key: string): Promise<void> {}
  getUrl(key: string): string {
    return `https://s3.amazonaws.com/my-bucket/${key}`;
  }
}

export function getStorageAdapter(): StorageAdapter {
  if (process.env.STORAGE_PROVIDER === 's3') {
    return new S3StorageAdapter();
  }
  return new LocalStorageAdapter();
}

export function getMimeType(format: ReportFormat | string): string {
  const types: Record<string, string> = {
    csv: 'text/csv',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[format] || 'application/octet-stream';
}

export function buildQueryParams(params?: ReportParameters): Record<string, unknown> {
  if (!params) return {};
  const query: Record<string, unknown> = {};
  if (params.startDate) query.startDate = params.startDate;
  if (params.endDate) query.endDate = params.endDate;
  if (params.assetCode) query.assetCode = params.assetCode;
  if (params.status) query.status = params.status;
  if (params.userId) query.userId = params.userId;
  return query;
}

export function resolveFilename(
  reportType: ReportType | string,
  format: ReportFormat | string
): string {
  const cleanType = String(reportType).replace(/-/g, '_');
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.]/g, '')
    .substring(0, 14);
  return `${cleanType}_${timestamp}.${format}`;
}

export function getFilePath(requestId: string, format: ReportFormat): string {
  return path.join(REPORT_STORAGE_DIR, `${requestId}.${format}`);
}

export function validateReportType(value: string): ReportType {
  const normalize = (s: string) => s.replace(/_/g, '-');
  const valid: ReportType[] = [
    'transaction-history',
    'compliance-report',
    'financial-statement',
    'payroll-report',
    'treasury-report',
    'audit-log',
  ];

  const normalized = normalize(value);
  for (const v of valid) {
    if (normalized === v) return v;
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
  userId: string,
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = { userId };

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  if (params?.assetCode != null) where.assetCode = params.assetCode;
  if (params?.status != null) where.status = params.status;

  const records =
    (await prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  return records.map((tx) => ({
    id: tx.id,
    userId: tx.userId,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    assetCode: tx.assetCode,
    assetIssuer: tx.assetIssuer ?? '',
    fromAddress: tx.fromAddress ?? '',
    toAddress: tx.toAddress ?? '',
    stellarTxId: tx.stellarTxId ?? '',
    createdAt: tx.createdAt,
    completedAt: tx.completedAt ?? '',
  }));
}

async function fetchComplianceData(
  userId: string,
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const kycWhere: Record<string, unknown> = { userId };
  if (params?.status != null) kycWhere.status = params.status;

  const records =
    (await prisma.kYCRecord.findMany({
      where: kycWhere,
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  const alerts =
    (await prisma.complianceAlert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  const kycRows = records.map((record) => ({
    id: record.id,
    type: 'KYC_RECORD',
    userName: `${record.user?.firstName ?? ''} ${record.user?.lastName ?? ''}`.trim() || 'N/A',
    email: record.user?.email ?? '',
    provider: record.provider,
    status: record.status,
    documentType: record.documentType ?? '',
    details: `Provider ID: ${record.providerId ?? 'N/A'}`,
    createdAt: record.createdAt,
    reviewedAt: record.reviewedAt ?? '',
  }));

  const alertRows = alerts.map((alert) => ({
    id: alert.id,
    type: `ALERT_${alert.type.toUpperCase()}`,
    userName: 'N/A',
    email: 'N/A',
    provider: 'INTERNAL_AML',
    status: alert.status,
    documentType: alert.severity,
    details: `${alert.title}: ${alert.description ?? ''}`,
    createdAt: alert.createdAt,
    reviewedAt: alert.resolvedAt ?? '',
  }));

  return [...kycRows, ...alertRows];
}

async function fetchFinancialStatement(
  userId: string,
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = { userId };

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  if (params?.assetCode != null) where.assetCode = params.assetCode;
  if (params?.status != null) where.status = params.status;

  const txs =
    (await prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  return txs.map((tx) => ({
    transactionId: tx.id,
    type: tx.type,
    amount: tx.amount,
    assetCode: tx.assetCode,
    status: tx.status,
    isFlagged: tx.isFlagged ? 'YES' : 'NO',
    createdAt: tx.createdAt,
  }));
}

async function fetchPayrollReport(
  userId: string,
  _params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const batches =
    (await prisma.payrollBatch.findMany({
      where: { wallet: { userId } },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  if (batches.length === 0) {
    return [];
  }

  return batches.flatMap((batch) => {
    if (!batch.items || batch.items.length === 0) {
      return [
        {
          batchId: batch.id,
          batchName: batch.name,
          description: batch.description ?? '',
          batchStatus: batch.status,
          itemCount: 0,
          recipientAddress: 'N/A',
          itemAmount: '0.00',
          assetCode: 'N/A',
          itemStatus: 'N/A',
          createdAt: batch.createdAt,
        },
      ];
    }

    return batch.items.map((item) => ({
      batchId: batch.id,
      batchName: batch.name,
      description: batch.description ?? '',
      batchStatus: batch.status,
      itemCount: batch.items.length,
      recipientAddress: item.recipientAddress,
      itemAmount: item.amount,
      assetCode: item.assetCode,
      itemStatus: item.status,
      createdAt: batch.createdAt,
    }));
  });
}

async function fetchTreasuryReport(
  userId: string,
  _params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const wallets =
    (await prisma.wallet.findMany({
      where: { userId, isActive: true },
      include: { balances: true },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  return wallets.flatMap((wallet) => {
    if (!wallet.balances || wallet.balances.length === 0) {
      return [
        {
          walletId: wallet.id,
          walletType: wallet.walletType,
          network: wallet.network,
          publicKey: wallet.publicKey,
          assetCode: 'N/A',
          assetIssuer: '',
          balance: '0.00',
          updatedAt: wallet.updatedAt,
        },
      ];
    }

    return wallet.balances.map((balance) => ({
      walletId: wallet.id,
      walletType: wallet.walletType,
      network: wallet.network,
      publicKey: wallet.publicKey,
      assetCode: balance.assetCode,
      assetIssuer: balance.assetIssuer ?? '',
      balance: balance.balance,
      updatedAt: balance.updatedAt,
    }));
  });
}

async function fetchAuditLogs(
  userId: string,
  params?: ReportParameters,
  limit?: number
): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};
  if (userId && userId !== 'system') {
    where.userId = userId;
  }

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  const logs =
    (await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit ?? REPORT_FETCH_LIMIT,
    })) || [];

  return logs.map((log) => ({
    id: log.id,
    userId: log.userId ?? 'N/A',
    action: log.action,
    resource: log.resource,
    resourceId: log.resourceId ?? '',
    ipAddress: log.ipAddress ?? '',
    userAgent: log.userAgent ?? '',
    success: log.success ? 'SUCCESS' : 'FAILED',
    createdAt: log.createdAt,
  }));
}

export function getDataFetcher(
  reportType: ReportType | string
): ((userId: string, params?: ReportParameters, limit?: number) => Promise<ReportData[]>) | null {
  const normalized = String(reportType).replace(/_/g, '-');
  switch (normalized) {
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
