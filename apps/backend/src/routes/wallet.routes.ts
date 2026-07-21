import { Router } from 'express';

import { WalletController } from '../controllers/wallet.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { ipPreAuthRateLimiter, sensitiveRateLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validation.middleware';
import { createWalletSchema } from '../utils/validation';

const walletRouter = Router();

walletRouter.post(
  '/create',
  ipPreAuthRateLimiter,
  authMiddleware,
  sensitiveRateLimiter,
  validate(createWalletSchema),
  (req, res, next) => {
    WalletController.create(req, res).catch(next);
  }
);

export default walletRouter;
