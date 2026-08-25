import { Router } from 'express';

import { StellarSepController } from '../controllers/stellar-sep.controller';
import { generalRateLimiter, ipPreAuthRateLimiter } from '../middleware/rate-limit.middleware';
import {
  optionalSepAuthMiddleware,
  requireSepRole,
  sepAuthMiddleware,
} from '../middleware/sep-auth.middleware';
import { validate } from '../middleware/validation.middleware';
import {
  sep10TokenBodySchema,
  sep24CompleteSchema,
  sep24InteractiveSchema,
} from '../utils/validation';

const stellarSepRouter = Router();

stellarSepRouter.get(
  '/.well-known/stellar.toml',
  ipPreAuthRateLimiter,
  generalRateLimiter,
  (req, res) => {
    StellarSepController.getStellarToml(req, res);
  }
);

stellarSepRouter.get('/auth', ipPreAuthRateLimiter, generalRateLimiter, (req, res) => {
  StellarSepController.getChallenge(req, res);
});

stellarSepRouter.post(
  '/auth',
  ipPreAuthRateLimiter,
  generalRateLimiter,
  validate(sep10TokenBodySchema),
  (req, res, next) => {
    StellarSepController.postChallenge(req, res).catch(next);
  }
);

stellarSepRouter.get(
  '/sep24/info',
  ipPreAuthRateLimiter,
  optionalSepAuthMiddleware,
  generalRateLimiter,
  (req, res, next) => {
    try {
      StellarSepController.getInfo(req, res);
    } catch (error) {
      next(error);
    }
  }
);

stellarSepRouter.post(
  '/sep24/transactions/deposit/interactive',
  ipPreAuthRateLimiter,
  sepAuthMiddleware,
  requireSepRole,
  generalRateLimiter,
  validate(sep24InteractiveSchema),
  (req, res, next) => {
    StellarSepController.startDeposit(req, res).catch(next);
  }
);

stellarSepRouter.post(
  '/sep24/transactions/withdraw/interactive',
  ipPreAuthRateLimiter,
  sepAuthMiddleware,
  requireSepRole,
  generalRateLimiter,
  validate(sep24InteractiveSchema),
  (req, res, next) => {
    StellarSepController.startWithdraw(req, res).catch(next);
  }
);

stellarSepRouter.get(
  '/sep24/transaction',
  ipPreAuthRateLimiter,
  sepAuthMiddleware,
  requireSepRole,
  generalRateLimiter,
  (req, res, next) => {
    StellarSepController.getTransaction(req, res).catch(next);
  }
);

stellarSepRouter.get(
  '/sep24/transactions',
  ipPreAuthRateLimiter,
  sepAuthMiddleware,
  requireSepRole,
  generalRateLimiter,
  (req, res, next) => {
    StellarSepController.getTransactions(req, res).catch(next);
  }
);

stellarSepRouter.get(
  '/sep24/interactive/:kind/:sessionId/:token',
  ipPreAuthRateLimiter,
  generalRateLimiter,
  (req, res, next) => {
    StellarSepController.startInteractivePage(req, res).catch(next);
  }
);

stellarSepRouter.post(
  '/sep24/interactive/complete/:sessionId',
  ipPreAuthRateLimiter,
  generalRateLimiter,
  validate(sep24CompleteSchema),
  (req, res, next) => {
    StellarSepController.completeInteractive(req, res).catch(next);
  }
);

export default stellarSepRouter;
