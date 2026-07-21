import { Router } from 'express';

import { TreasuryController } from '../controllers/treasury.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

/**
 * Treasury Routes
 * Defines platform treasury management API endpoints. All routes require an
 * authenticated user with the ADMIN role.
 */
const treasuryRouter = Router();

treasuryRouter.use(authMiddleware, adminMiddleware, sensitiveRateLimiter);

treasuryRouter.get('/balance', (req, res, next) => {
  TreasuryController.getBalance(req, res).catch(next);
});

treasuryRouter.get('/positions', (req, res, next) => {
  TreasuryController.getPositions(req, res).catch(next);
});

treasuryRouter.post('/rebalance', (req, res, next) => {
  TreasuryController.rebalance(req, res).catch(next);
});

treasuryRouter.get('/history', (req, res, next) => {
  TreasuryController.getHistory(req, res).catch(next);
});

export default treasuryRouter;
