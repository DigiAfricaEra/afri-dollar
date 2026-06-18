import { Router } from 'express';

import { PayrollController } from '../controllers/payroll.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { createBatchSchema, addItemSchema } from '../utils/validation';

/**
 * Payroll Routes
 * Defines payroll management API endpoints
 */
const payrollRouter = Router();

payrollRouter.post('/batches', authMiddleware, validate(createBatchSchema), (req, res, next) => {
  PayrollController.createBatch(req, res).catch(next);
});

payrollRouter.get('/batches', authMiddleware, (req, res, next) => {
  PayrollController.listBatches(req, res).catch(next);
});

payrollRouter.get('/batches/:id', authMiddleware, (req, res, next) => {
  PayrollController.getBatch(req, res).catch(next);
});

payrollRouter.post(
  '/batches/:id/items',
  authMiddleware,
  validate(addItemSchema),
  (req, res, next) => {
    PayrollController.addItem(req, res).catch(next);
  }
);

payrollRouter.post('/batches/:id/approve', authMiddleware, (req, res, next) => {
  PayrollController.approveBatch(req, res).catch(next);
});

payrollRouter.post('/batches/:id/process', authMiddleware, (req, res, next) => {
  PayrollController.processBatch(req, res).catch(next);
});

payrollRouter.get('/history', authMiddleware, (req, res, next) => {
  PayrollController.getHistory(req, res).catch(next);
});

export default payrollRouter;
