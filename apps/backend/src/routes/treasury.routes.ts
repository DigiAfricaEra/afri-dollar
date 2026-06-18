import { Router } from 'express';

import { TreasuryController } from '../controllers/treasury.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';

/**
 * Treasury Routes
 * Defines platform treasury management API endpoints. All routes require an
 * authenticated user with the ADMIN role.
 */
const treasuryRouter = Router();

treasuryRouter.get('/balance', authMiddleware, adminMiddleware, (req, res, next) => {
  TreasuryController.getBalance(req, res).catch(next);
});

treasuryRouter.get('/positions', authMiddleware, adminMiddleware, (req, res, next) => {
  TreasuryController.getPositions(req, res).catch(next);
});

treasuryRouter.post('/rebalance', authMiddleware, adminMiddleware, (req, res, next) => {
  TreasuryController.rebalance(req, res).catch(next);
});

treasuryRouter.get('/history', authMiddleware, adminMiddleware, (req, res, next) => {
  TreasuryController.getHistory(req, res).catch(next);
});

export default treasuryRouter;
