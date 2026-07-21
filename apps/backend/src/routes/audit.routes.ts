import { Router } from 'express';

import { AuditController } from '../controllers/audit.controller';
import { auditMiddleware } from '../middleware/audit.middleware';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

const auditRouter = Router();

auditRouter.use(authMiddleware, adminMiddleware, sensitiveRateLimiter);

auditRouter.get('/logs', auditMiddleware, (req, res, next) => {
  AuditController.queryLogs(req, res).catch(next);
});

export default auditRouter;
