import { Router } from 'express';

import { WalletController } from '../controllers/wallet.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { createWalletSchema } from '../utils/validation';

const walletRouter = Router();

walletRouter.post('/create', authMiddleware, validate(createWalletSchema), (req, res, next) => {
  WalletController.create(req, res).catch(next);
});

export default walletRouter;
