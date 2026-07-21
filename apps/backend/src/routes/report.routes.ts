import { Router } from 'express';

import { ReportController } from '../controllers/report.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { generalRateLimiter, sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

const reportRouter = Router();

reportRouter.post('/', authMiddleware, sensitiveRateLimiter, (req, res, next) => {
  ReportController.generate(req, res).catch(next);
});

reportRouter.get('/', authMiddleware, generalRateLimiter, (req, res, next) => {
  ReportController.listReports(req, res).catch(next);
});

// Admin template routes (before /:id to avoid param collision)
reportRouter.get('/templates', authMiddleware, adminMiddleware, generalRateLimiter, (req, res, next) => {
  ReportController.listTemplates(req, res).catch(next);
});

reportRouter.post('/templates', authMiddleware, adminMiddleware, sensitiveRateLimiter, (req, res, next) => {
  ReportController.createTemplate(req, res).catch(next);
});

reportRouter.get(
  '/templates/:templateId',
  authMiddleware,
  adminMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    ReportController.getTemplate(req, res).catch(next);
  }
);

reportRouter.put(
  '/templates/:templateId',
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    ReportController.updateTemplate(req, res).catch(next);
  }
);

reportRouter.delete(
  '/templates/:templateId',
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    ReportController.deleteTemplate(req, res).catch(next);
  }
);

reportRouter.get('/:id', authMiddleware, generalRateLimiter, (req, res, next) => {
  ReportController.getReport(req, res).catch(next);
});

reportRouter.get('/:id/download', authMiddleware, generalRateLimiter, (req, res, next) => {
  ReportController.download(req, res).catch(next);
});

export default reportRouter;
