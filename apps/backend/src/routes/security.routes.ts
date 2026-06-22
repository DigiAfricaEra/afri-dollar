import { Router } from 'express';

import { SecurityController } from '../controllers/security.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { adminSecurityMiddleware } from '../middleware/security.middleware';

const securityRouter = Router();

securityRouter.get(
  '/metrics',
  authMiddleware,
  adminMiddleware,
  adminSecurityMiddleware,
  (req, res, next) => {
    SecurityController.getMetrics(req, res).catch(next);
  }
);

securityRouter.get(
  '/blocked-ips',
  authMiddleware,
  adminMiddleware,
  adminSecurityMiddleware,
  (req, res, next) => {
    SecurityController.getBlockedIps(req, res).catch(next);
  }
);

securityRouter.get(
  '/flagged-ips',
  authMiddleware,
  adminMiddleware,
  adminSecurityMiddleware,
  (req, res, next) => {
    SecurityController.getFlaggedIps(req, res).catch(next);
  }
);

export default securityRouter;
