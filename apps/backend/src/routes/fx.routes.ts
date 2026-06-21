import { Router } from 'express';

import { FXController } from '../controllers/fx.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';

const fxRouter = Router();

fxRouter.get('/rates', (req, res, next) => {
  FXController.getRates(req, res).catch(next);
});

fxRouter.post('/quote', (req, res, next) => {
  FXController.createQuote(req, res).catch(next);
});

fxRouter.post('/convert', authMiddleware, (req, res, next) => {
  FXController.convert(req, res).catch(next);
});

fxRouter.get('/history', authMiddleware, (req, res, next) => {
  FXController.history(req, res).catch(next);
});

const adminFxRouter = Router();

adminFxRouter.post('/rates', authMiddleware, adminMiddleware, (req, res, next) => {
  FXController.upsertRate(req, res).catch(next);
});

adminFxRouter.delete('/rates/:id', authMiddleware, adminMiddleware, (req, res, next) => {
  FXController.deactivateRate(req, res).catch(next);
});

export default fxRouter;
export { adminFxRouter };
