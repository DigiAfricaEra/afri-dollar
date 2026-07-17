import { Router } from 'express';

import { ReportController } from '../controllers/report.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const reportRouter = Router();

reportRouter.post('/', authMiddleware, (req, res, next) => {
  ReportController.generate(req, res).catch(next);
});

reportRouter.get('/', authMiddleware, (req, res, next) => {
  ReportController.listReports(req, res).catch(next);
});

reportRouter.get('/:id', authMiddleware, (req, res, next) => {
  ReportController.getReport(req, res).catch(next);
});

reportRouter.get('/:id/download', authMiddleware, (req, res, next) => {
  ReportController.download(req, res).catch(next);
});

export default reportRouter;
