import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { ReportService } from '../services/report.service';
import { AppError } from '../types';
import {
  createReportTemplateSchema,
  generateAdminReportSchema,
  generateReportSchema,
  reportIdParamSchema,
  reportTemplateIdParamSchema,
  updateReportTemplateSchema,
} from '../utils/validation';

const listReportsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(10),
});

function handleError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation error',
      details: error.errors,
    });
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({
      success: false,
      error: error.message,
    });
    return;
  }

  console.error('Report controller error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
}

export const ReportController = {
  async generate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const isAdmin = req.user!.role === 'ADMIN';
      const reportInput = (isAdmin ? generateAdminReportSchema : generateReportSchema).parse(
        req.body
      );
      const { reportType, format, parameters } = reportInput;

      const adminReportTypes = new Set([
        'payroll-report',
        'treasury-report',
        'compliance-report',
        'audit-log',
      ]);
      if (adminReportTypes.has(reportType) && !isAdmin) {
        throw new AppError(403, 'Admin privileges required for this report type');
      }

      const targetUserId = isAdmin
        ? (reportInput as z.infer<typeof generateAdminReportSchema>).targetUserId
        : undefined;
      const ownerId = targetUserId ?? req.user!.userId;
      const report = await ReportService.generate(ownerId, reportType, format, parameters);

      res.status(201).json({ success: true, data: report });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getReport(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = reportIdParamSchema.parse(req.params);
      const report = await ReportService.getReport(id, req.user!.userId);

      res.status(200).json({ success: true, data: report });
    } catch (error) {
      handleError(res, error);
    }
  },

  async listReports(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { page, limit } = listReportsQuerySchema.parse(req.query);
      const result = await ReportService.listReports(req.user!.userId, page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(res, error);
    }
  },

  async download(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { id } = reportIdParamSchema.parse(req.params);
      const { stream, filename, mimetype } = await ReportService.getDownloadStream(
        id,
        req.user!.userId
      );

      res.setHeader('Content-Type', mimetype);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      stream.on('error', (err) => {
        console.error('Report download stream error:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: 'Download failed' });
        } else {
          res.destroy();
        }
      });

      res.on('close', () => stream.destroy());

      stream.pipe(res);
    } catch (error) {
      handleError(res, error);
    }
  },

  async listTemplates(_req: AuthRequest, res: Response): Promise<void> {
    try {
      const templates = await ReportService.listTemplates();

      res.status(200).json({ success: true, data: templates });
    } catch (error) {
      handleError(res, error);
    }
  },

  async createTemplate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const data = createReportTemplateSchema.parse(req.body);
      const template = await ReportService.createTemplate(data);

      res.status(201).json({ success: true, data: template });
    } catch (error) {
      handleError(res, error);
    }
  },

  async getTemplate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { templateId } = reportTemplateIdParamSchema.parse(req.params);
      const template = await ReportService.getTemplate(templateId);

      res.status(200).json({ success: true, data: template });
    } catch (error) {
      handleError(res, error);
    }
  },

  async updateTemplate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { templateId } = reportTemplateIdParamSchema.parse(req.params);
      const data = updateReportTemplateSchema.parse(req.body);
      const template = await ReportService.updateTemplate(templateId, data);

      res.status(200).json({ success: true, data: template });
    } catch (error) {
      handleError(res, error);
    }
  },

  async deleteTemplate(req: AuthRequest, res: Response): Promise<void> {
    try {
      const { templateId } = reportTemplateIdParamSchema.parse(req.params);
      await ReportService.deleteTemplate(templateId);

      res.status(200).json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  },
};
