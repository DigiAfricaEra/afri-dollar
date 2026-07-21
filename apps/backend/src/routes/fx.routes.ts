import { Router } from 'express';

import { FXController } from '../controllers/fx.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { generalRateLimiter, sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

const fxRouter = Router();

fxRouter.get('/rates', generalRateLimiter, (req, res, next) => {
  FXController.getRates(req, res).catch(next);
});

fxRouter.post('/quote', generalRateLimiter, (req, res, next) => {
  FXController.createQuote(req, res).catch(next);
});

fxRouter.post('/convert', authMiddleware, sensitiveRateLimiter, (req, res, next) => {
  FXController.convert(req, res).catch(next);
});

fxRouter.get('/history', authMiddleware, generalRateLimiter, (req, res, next) => {
  FXController.history(req, res).catch(next);
});

const adminFxRouter = Router();

adminFxRouter.post('/rates', authMiddleware, adminMiddleware, sensitiveRateLimiter, (req, res, next) => {
  FXController.upsertRate(req, res).catch(next);
});

adminFxRouter.delete(
  '/rates/:id',
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    FXController.deactivateRate(req, res).catch(next);
  }
);

export default fxRouter;
export { adminFxRouter };
