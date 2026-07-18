import fs from 'fs';
import path from 'path';

import { Prisma } from '@afri-dollar/database';
import { createObjectCsvWriter } from 'csv-writer';
import { Workbook } from 'exceljs';
import PDFDocument from 'pdfkit';

import prisma from '../config/database';
import { AppError } from '../types';
import type {
  ReportType,
  ReportFormat,
  ReportRequest,
  ReportTemplate,
  ReportParameters,
  ReportData,
  ReportStatus,
} from '../types';

const REPORTS_DIR = path.resolve(__dirname, '../../uploads/reports');
const BASE_URL = '/api/v1/reports';

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// ----- Helpers -----

function buildDownloadUrl(requestId: string): string {
  return `${BASE_URL}/${requestId}/download`;
}

function getFilePath(requestId: string, format: ReportFormat): string {
  return path.join(REPORTS_DIR, `${requestId}.${format}`);
}

function getMimeType(format: ReportFormat): string {
  const types: Record<ReportFormat, string> = {
    csv: 'text/csv',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[format];
}

function getFileName(reportType: ReportType, format: ReportFormat): string {
  return `${reportType.replace(/-/g, '_')}_${Date.now()}.${format}`;
}

function mapReport(report: {
  id: string;
  userId: string;
  reportType: string;
  format: string;
  parameters: unknown;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  downloadUrl: string | null;
}): ReportRequest {
  return {
    id: report.id,
    userId: report.userId,
    reportType: report.reportType as ReportType,
    format: report.format as ReportFormat,
    parameters: report.parameters as ReportParameters,
    status: report.status as ReportStatus,
    createdAt: report.createdAt,
    completedAt: report.completedAt ?? undefined,
    downloadUrl: report.downloadUrl ?? undefined,
  };
}

function mapReportTemplate(template: {
  id: string;
  name: string;
  reportType: string;
  format: string;
  query: string | null;
  schedule: string | null;
}): ReportTemplate {
  return {
    id: template.id,
    name: template.name,
    reportType: template.reportType as ReportType,
    format: template.format as ReportFormat,
    query: template.query ?? undefined,
    schedule: template.schedule ?? undefined,
  };
}

function validateReportType(value: string): ReportType {
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

function validateReportFormat(value: string): ReportFormat {
  const valid: ReportFormat[] = ['csv', 'pdf', 'xlsx'];

  for (const v of valid) {
    if (value === v) return v;
  }

  throw new AppError(400, `Invalid report format: ${value}`);
}

// ----- Data Fetchers -----

async function fetchTransactionHistory(params?: ReportParameters): Promise<ReportData[]> {
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

  return prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' } });
}

async function fetchComplianceData(params?: ReportParameters): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.status != null) where.status = params.status;

  const records = await prisma.kYCRecord.findMany({
    where,
    include: { user: { select: { email: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
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

async function fetchFinancialStatement(params?: ReportParameters): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  return prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' } });
}

async function fetchPayrollReport(_params?: ReportParameters): Promise<ReportData[]> {
  const batches = await prisma.payrollBatch.findMany({
    include: { items: true },
    orderBy: { createdAt: 'desc' },
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

async function fetchTreasuryReport(_params?: ReportParameters): Promise<ReportData[]> {
  const wallets = await prisma.wallet.findMany({
    where: { walletType: 'treasury', isActive: true },
    include: { balances: true },
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

async function fetchAuditLogs(params?: ReportParameters): Promise<ReportData[]> {
  const where: Record<string, unknown> = {};

  if (params?.startDate != null || params?.endDate != null) {
    where.createdAt = {};
    if (params.startDate != null)
      (where.createdAt as Record<string, unknown>).gte = new Date(params.startDate);
    if (params.endDate != null)
      (where.createdAt as Record<string, unknown>).lte = new Date(params.endDate);
  }

  if (params?.userId != null) where.userId = params.userId;

  return prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' } });
}

function getDataFetcher(
  reportType: ReportType
): ((params?: ReportParameters) => Promise<ReportData[]>) | null {
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

// ----- Formatters -----

async function generateCSV(data: ReportData[], filePath: string): Promise<void> {
  if (data.length === 0) {
    fs.writeFileSync(filePath, '');
    return;
  }

  const headers = Object.keys(data[0]).map((key) => ({ id: key, title: key }));
  const writer = createObjectCsvWriter({ path: filePath, header: headers });
  await writer.writeRecords(data);
}

async function generatePDF(data: ReportData[], filePath: string, title: string): Promise<void> {
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

async function generateXLSX(data: ReportData[], filePath: string): Promise<void> {
  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet('Report');

  if (data.length > 0) {
    const headers = Object.keys(data[0]);

    worksheet.columns = headers.map((header) => ({ header, key: header, width: 20 }));
    data.forEach((row) => worksheet.addRow(row));
  }

  await workbook.xlsx.writeFile(filePath);
}

// ----- Async Processing -----

async function processReport(requestId: string): Promise<void> {
  const report = await prisma.reportRequest.findUnique({ where: { id: requestId } });

  if (!report) {
    throw new AppError(404, `Report not found: ${requestId}`);
  }

  try {
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
    const data = await fetcher(params);

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
        downloadUrl: buildDownloadUrl(requestId),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Report generation failed for ${requestId}:`, message);

    await prisma.reportRequest.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        completedAt: new Date(),
      },
    });
  }
}

// ----- Exported Service -----

export const ReportService = {
  async generate(
    userId: string,
    reportType: ReportType,
    format: ReportFormat,
    parameters?: ReportParameters
  ): Promise<ReportRequest> {
    const report = await prisma.reportRequest.create({
      data: {
        userId,
        reportType,
        format,
        parameters: (parameters ?? {}) as Prisma.InputJsonValue,
        status: 'pending',
      },
    });

    void processReport(report.id);

    return mapReport(report);
  },

  async getReport(id: string, userId: string): Promise<ReportRequest> {
    const report = await prisma.reportRequest.findUnique({ where: { id } });

    if (!report) {
      throw new AppError(404, 'Report not found');
    }

    if (report.userId !== userId) {
      throw new AppError(404, 'Report not found');
    }

    return mapReport(report);
  },

  async listReports(
    userId: string,
    page: number = 1,
    limit: number = 10
  ): Promise<{
    data: ReportRequest[];
    pagination: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const skip = (page - 1) * limit;

    const [reports, total] = await Promise.all([
      prisma.reportRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.reportRequest.count({ where: { userId } }),
    ]);

    return {
      data: reports.map(mapReport),
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  },

  async getDownloadStream(
    id: string,
    userId: string
  ): Promise<{ stream: fs.ReadStream; filename: string; mimetype: string }> {
    const report = await prisma.reportRequest.findUnique({ where: { id } });

    if (!report) {
      throw new AppError(404, 'Report not found');
    }

    if (report.userId !== userId) {
      throw new AppError(404, 'Report not found');
    }

    if (report.status !== 'completed') {
      throw new AppError(400, 'Report is not yet completed');
    }

    const format = validateReportFormat(report.format);
    const filePath = getFilePath(id, format);

    if (!fs.existsSync(filePath)) {
      throw new AppError(404, 'Report file not found');
    }

    return {
      stream: fs.createReadStream(filePath),
      filename: getFileName(report.reportType as ReportType, format),
      mimetype: getMimeType(format),
    };
  },

  async listTemplates(): Promise<ReportTemplate[]> {
    const templates = await prisma.reportTemplate.findMany({
      orderBy: { name: 'asc' },
    });

    return templates.map(mapReportTemplate);
  },

  async createTemplate(data: {
    name: string;
    reportType: string;
    format: string;
    query?: string;
    schedule?: string;
  }): Promise<ReportTemplate> {
    const template = await prisma.reportTemplate.create({
      data: {
        name: data.name,
        reportType: data.reportType,
        format: data.format,
        query: data.query ?? null,
        schedule: data.schedule ?? null,
      },
    });

    return mapReportTemplate(template);
  },

  async getTemplate(id: string): Promise<ReportTemplate> {
    const template = await prisma.reportTemplate.findUnique({ where: { id } });

    if (!template) {
      throw new AppError(404, 'Report template not found');
    }

    return mapReportTemplate(template);
  },

  async updateTemplate(
    id: string,
    data: {
      name?: string;
      reportType?: string;
      format?: string;
      query?: string;
      schedule?: string;
    }
  ): Promise<ReportTemplate> {
    const existing = await prisma.reportTemplate.findUnique({ where: { id } });

    if (!existing) {
      throw new AppError(404, 'Report template not found');
    }

    const template = await prisma.reportTemplate.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.reportType !== undefined && { reportType: data.reportType }),
        ...(data.format !== undefined && { format: data.format }),
        ...(data.query !== undefined && { query: data.query }),
        ...(data.schedule !== undefined && { schedule: data.schedule }),
      },
    });

    return mapReportTemplate(template);
  },

  async deleteTemplate(id: string): Promise<void> {
    const existing = await prisma.reportTemplate.findUnique({ where: { id } });

    if (!existing) {
      throw new AppError(404, 'Report template not found');
    }

    await prisma.reportTemplate.delete({ where: { id } });
  },
};
