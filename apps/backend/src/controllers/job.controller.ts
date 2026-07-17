import type { Request, Response } from 'express';

import { jobQueueService } from '../services/job-queue.service';

export const JobController = {
  async listJobs(_req: Request, res: Response): Promise<void> {
    const executions = await jobQueueService.listExecutions();

    res.status(200).json({
      success: true,
      data: {
        queueStatus: jobQueueService.getStatus(),
        definitions: jobQueueService.getDefinitions(),
        executions,
      },
    });
  },

  async getJobExecution(req: Request, res: Response): Promise<void> {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        success: false,
        error: 'Job execution ID is required',
      });
      return;
    }

    const execution = await jobQueueService.getExecution(id);

    if (!execution) {
      res.status(404).json({
        success: false,
        error: 'Job execution not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: execution,
    });
  },
};
