import { Router } from 'express';

import { JobController } from '../controllers/job.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';
import { sensitiveRateLimiter } from '../middleware/rate-limit.middleware';

const jobRouter = Router();

jobRouter.use(authMiddleware, adminMiddleware, sensitiveRateLimiter);

jobRouter.get('/', (req, res, next) => {
  JobController.listJobs(req, res).catch(next);
});

jobRouter.get('/:id', (req, res, next) => {
  JobController.getJobExecution(req, res).catch(next);
});

export default jobRouter;
