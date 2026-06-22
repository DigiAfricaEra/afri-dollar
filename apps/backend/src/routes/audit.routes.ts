import { Router } from 'express';

import { AuditController } from '../controllers/audit.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { auditMiddleware } from '../middleware/audit.middleware';

const auditRouter = Router();

auditRouter.get('/logs', authMiddleware, adminMiddleware, auditMiddleware, (req, res, next) => {
  AuditController.queryLogs(req, res).catch(next);
});

export default auditRouter;
