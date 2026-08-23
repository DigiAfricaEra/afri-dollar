import { Router } from 'express';

import { PaymentController } from '../controllers/payment.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';
import { validate, validateQuery } from '../middleware/validation.middleware';
import { createUnifiedPaymentSchema, listPaymentsQuerySchema } from '../utils/validation';

const paymentRouter = Router();

paymentRouter.use(authMiddleware, sensitiveRateLimiter);

// Instant Stellar payment (destination body) or legacy cross-border payment.
paymentRouter.post('/', validate(createUnifiedPaymentSchema), (req, res, next) => {
  PaymentController.createPayment(req, res).catch(next);
});

// List my instant payments with filters + pagination.
// NOTE: static paths must be registered before parameterized ones.
paymentRouter.get('/history', (req, res, next) => {
  PaymentController.getPaymentHistory(req, res).catch(next);
});

paymentRouter.get('/', validateQuery(listPaymentsQuerySchema), (req, res, next) => {
  PaymentController.listPayments(req, res).catch(next);
});

paymentRouter.post('/:id/process', (req, res, next) => {
  PaymentController.processPayment(req, res).catch(next);
});

paymentRouter.get('/:id/status', (req, res, next) => {
  PaymentController.getPaymentStatus(req, res).catch(next);
});

paymentRouter.post('/:id/cancel', (req, res, next) => {
  PaymentController.cancelPayment(req, res).catch(next);
});

// Single payment detail (status + Horizon enrichment).
paymentRouter.get('/:id', (req, res, next) => {
  PaymentController.getPaymentDetails(req, res).catch(next);
});

export default paymentRouter;
