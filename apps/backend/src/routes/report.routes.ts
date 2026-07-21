import { Router } from 'express';

import { ReportController } from '../controllers/report.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import {
  generalRateLimiter,
  ipPreAuthRateLimiter,
  sensitiveRateLimiter,
} from '../middleware/rate-limit.middleware';

const reportRouter = Router();

reportRouter.post(
  '/',
  ipPreAuthRateLimiter,
  authMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    ReportController.generate(req, res).catch(next);
  }
);

reportRouter.get(
  '/',
  ipPreAuthRateLimiter,
  authMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    ReportController.listReports(req, res).catch(next);
  }
);

// Admin template routes (before /:id to avoid param collision)
reportRouter.get(
  '/templates',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    ReportController.listTemplates(req, res).catch(next);
  }
);

reportRouter.post(
  '/templates',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    ReportController.createTemplate(req, res).catch(next);
  }
);

reportRouter.get(
  '/templates/:templateId',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    ReportController.getTemplate(req, res).catch(next);
  }
);

reportRouter.put(
  '/templates/:templateId',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    ReportController.updateTemplate(req, res).catch(next);
  }
);

reportRouter.delete(
  '/templates/:templateId',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    ReportController.deleteTemplate(req, res).catch(next);
  }
);

reportRouter.get(
  '/:id',
  ipPreAuthRateLimiter,
  authMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    ReportController.getReport(req, res).catch(next);
  }
);

reportRouter.get(
  '/:id/download',
  ipPreAuthRateLimiter,
  authMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    ReportController.download(req, res).catch(next);
  }
);

export default reportRouter;
