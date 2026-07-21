import { Router } from 'express';

import { PayrollController } from '../controllers/payroll.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validation.middleware';
import { createBatchSchema, addItemSchema } from '../utils/validation';

/**
 * Payroll Routes
 * Defines payroll management API endpoints
 */
const payrollRouter = Router();

payrollRouter.use(authMiddleware, sensitiveRateLimiter);

payrollRouter.post('/batches', validate(createBatchSchema), (req, res, next) => {
  PayrollController.createBatch(req, res).catch(next);
});

payrollRouter.get('/batches', (req, res, next) => {
  PayrollController.listBatches(req, res).catch(next);
});

payrollRouter.get('/batches/:id', (req, res, next) => {
  PayrollController.getBatch(req, res).catch(next);
});

payrollRouter.post('/batches/:id/items', validate(addItemSchema), (req, res, next) => {
  PayrollController.addItem(req, res).catch(next);
});

payrollRouter.post('/batches/:id/approve', (req, res, next) => {
  PayrollController.approveBatch(req, res).catch(next);
});

payrollRouter.post('/batches/:id/process', (req, res, next) => {
  PayrollController.processBatch(req, res).catch(next);
});

payrollRouter.get('/history', (req, res, next) => {
  PayrollController.getHistory(req, res).catch(next);
});

export default payrollRouter;
