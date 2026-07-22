import { Router } from 'express';

import { SecurityController } from '../controllers/security.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';
import { adminSecurityMiddleware } from '../middleware/security.middleware';

const securityRouter = Router();

securityRouter.use(authMiddleware, adminMiddleware, sensitiveRateLimiter);

securityRouter.get('/metrics', adminSecurityMiddleware, (req, res, next) => {
  SecurityController.getMetrics(req, res).catch(next);
});

securityRouter.get('/blocked-ips', adminSecurityMiddleware, (req, res, next) => {
  SecurityController.getBlockedIps(req, res).catch(next);
});

securityRouter.get('/flagged-ips', adminSecurityMiddleware, (req, res, next) => {
  SecurityController.getFlaggedIps(req, res).catch(next);
});

export default securityRouter;
