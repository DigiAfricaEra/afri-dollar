import { Router } from 'express';

import { PaymentController } from '../controllers/payment.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validation.middleware';
import { createCrossBorderPaymentSchema } from '../utils/validation';

const paymentRouter = Router();

paymentRouter.use(authMiddleware, sensitiveRateLimiter);

paymentRouter.post('/', validate(createCrossBorderPaymentSchema), (req, res, next) => {
  PaymentController.createPayment(req, res).catch(next);
});

paymentRouter.post('/:id/process', (req, res, next) => {
  PaymentController.processPayment(req, res).catch(next);
});

paymentRouter.get('/:id/status', (req, res, next) => {
  PaymentController.getPaymentStatus(req, res).catch(next);
});

paymentRouter.get('/history', (req, res, next) => {
  PaymentController.getPaymentHistory(req, res).catch(next);
});

paymentRouter.post('/:id/cancel', (req, res, next) => {
  PaymentController.cancelPayment(req, res).catch(next);
});

export default paymentRouter;
