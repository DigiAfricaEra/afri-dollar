import fs from 'fs';

import { Prisma } from '@afri-dollar/database';
import type {
  ReportType as PrismaReportType,
  ReportFormat as PrismaReportFormat,
} from '@afri-dollar/database';

import prisma from '../config/database';
import { AppError } from '../types';
import type {
  ReportType,
  ReportFormat,
  ReportRequest,
  ReportTemplate,
  ReportParameters,
  ReportStatus,
} from '../types';

import { reportWorker } from './report-worker.service';
import { getFilePath, validateReportFormat } from './report.helpers';

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
        reportType: reportType as unknown as PrismaReportType,
        format: format,
        parameters: (parameters ?? {}) as Prisma.InputJsonValue,
        status: 'pending',
      },
    });

    try {
      await reportWorker.enqueue(report.id);
    } catch (error) {
      await prisma.reportRequest.update({
        where: { id: report.id },
        data: { status: 'failed', completedAt: new Date() },
      });
      throw error;
    }

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
        reportType: data.reportType as unknown as PrismaReportType,
        format: data.format as unknown as PrismaReportFormat,
        query: data.query ?? null,
        schedule: data.schedule ?? null,
      },
    });

    if (data.schedule) {
      await reportWorker.scheduleTemplate(template.id);
    }

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
        ...(data.reportType !== undefined && {
          reportType: data.reportType as unknown as PrismaReportType,
        }),
        ...(data.format !== undefined && { format: data.format as unknown as PrismaReportFormat }),
        ...(data.query !== undefined && { query: data.query }),
        ...(data.schedule !== undefined && { schedule: data.schedule }),
      },
    });

    if (data.schedule !== undefined) {
      await reportWorker.cancelScheduledTemplate(id);
      if (data.schedule) {
        await reportWorker.scheduleTemplate(id);
      }
    }

    return mapReportTemplate(template);
  },

  async deleteTemplate(id: string): Promise<void> {
    const existing = await prisma.reportTemplate.findUnique({ where: { id } });

    if (!existing) {
      throw new AppError(404, 'Report template not found');
    }

    await reportWorker.cancelScheduledTemplate(id);
    await prisma.reportTemplate.delete({ where: { id } });
  },
};
