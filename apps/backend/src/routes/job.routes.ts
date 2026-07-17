import { Router } from 'express';

import { JobController } from '../controllers/job.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';

const jobRouter = Router();

jobRouter.get('/', authMiddleware, adminMiddleware, (req, res, next) => {
  JobController.listJobs(req, res).catch(next);
});

jobRouter.get('/:id', authMiddleware, adminMiddleware, (req, res, next) => {
  JobController.getJobExecution(req, res).catch(next);
});

export default jobRouter;
