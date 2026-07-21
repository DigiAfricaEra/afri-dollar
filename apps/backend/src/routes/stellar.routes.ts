import { Router } from 'express';

import { StellarController } from '../controllers/stellar.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { generalRateLimiter, ipPreAuthRateLimiter } from '../middleware/rate-limit.middleware';

/**
 * Router for Stellar-related endpoints.
 *
 * All routes require authentication via authMiddleware.
 *
 * GET /balances/:publicKey  - Fetch Stellar account balances
 * GET /transactions/:publicKey - Fetch paginated transaction history
 * POST /fund/:publicKey     - Fund a testnet account via Friendbot
 */
const stellarRouter = Router();

stellarRouter.use(ipPreAuthRateLimiter, authMiddleware, generalRateLimiter);

/**
 * GET /balances/:publicKey
 * Fetch Stellar account balances for the given public key.
 */
stellarRouter.get('/balances/:publicKey', (req, res, next) => {
  StellarController.getBalances(req, res).catch(next);
});

/**
 * GET /transactions/:publicKey
 * Fetch paginated transaction history. Optional query params: ?limit=, ?cursor=.
 */
stellarRouter.get('/transactions/:publicKey', (req, res, next) => {
  StellarController.getTransactions(req, res).catch(next);
});

/**
 * POST /fund/:publicKey
 * Fund a Stellar testnet account via Friendbot (testnet only).
 */
stellarRouter.post('/fund/:publicKey', (req, res, next) => {
  StellarController.fundAccount(req, res).catch(next);
});

export default stellarRouter;
