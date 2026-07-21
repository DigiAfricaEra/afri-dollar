import { Router } from 'express';

import { FXController } from '../controllers/fx.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import {
  generalRateLimiter,
  ipPreAuthRateLimiter,
  sensitiveRateLimiter,
} from '../middleware/rate-limit.middleware';

const fxRouter = Router();

fxRouter.get('/rates', generalRateLimiter, (req, res, next) => {
  FXController.getRates(req, res).catch(next);
});

fxRouter.post('/quote', generalRateLimiter, (req, res, next) => {
  FXController.createQuote(req, res).catch(next);
});

fxRouter.post(
  '/convert',
  ipPreAuthRateLimiter,
  authMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    FXController.convert(req, res).catch(next);
  }
);

fxRouter.get(
  '/history',
  ipPreAuthRateLimiter,
  authMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    FXController.history(req, res).catch(next);
  }
);

const adminFxRouter = Router();

adminFxRouter.post(
  '/rates',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    FXController.upsertRate(req, res).catch(next);
  }
);

adminFxRouter.delete(
  '/rates/:id',
  ipPreAuthRateLimiter,
  authMiddleware,
  adminMiddleware,
  sensitiveRateLimiter,
  (req, res, next) => {
    FXController.deactivateRate(req, res).catch(next);
  }
);

export default fxRouter;
export { adminFxRouter };
