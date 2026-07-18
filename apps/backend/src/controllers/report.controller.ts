import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { ReportService } from '../services/report.service';
import { AppError } from '../types';
import { generateReportSchema, reportIdParamSchema } from '../utils/validation';

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
      const { reportType, format, parameters } = generateReportSchema.parse(req.body);
      const report = await ReportService.generate(req.user!.userId, reportType, format, parameters);

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
          res.destroy(err);
         }
       });
    } catch (error) {
      handleError(res, error);
    }
  },
};
