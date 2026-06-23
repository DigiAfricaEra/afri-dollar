import { Router } from 'express';

import { StellarController } from '../controllers/stellar.controller';
import { authMiddleware } from '../middleware/auth.middleware';

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

/**
 * GET /balances/:publicKey
 * Fetch Stellar account balances for the given public key.
 */
stellarRouter.get('/balances/:publicKey', authMiddleware, (req, res, next) => {
  StellarController.getBalances(req, res).catch(next);
});

/**
 * GET /transactions/:publicKey
 * Fetch paginated transaction history. Optional query params: ?limit=, ?cursor=.
 */
stellarRouter.get('/transactions/:publicKey', authMiddleware, (req, res, next) => {
  StellarController.getTransactions(req, res).catch(next);
});

/**
 * POST /fund/:publicKey
 * Fund a Stellar testnet account via Friendbot (testnet only).
 */
stellarRouter.post('/fund/:publicKey', authMiddleware, (req, res, next) => {
  StellarController.fundAccount(req, res).catch(next);
});

export default stellarRouter;
