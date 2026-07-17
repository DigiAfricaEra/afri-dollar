import type { Request, Response } from 'express';
import { z } from 'zod';

import { jobQueueService } from '../services/job-queue.service';

const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  cursor: z.string().min(1).optional(),
});

export const JobController = {
  async listJobs(req: Request, res: Response): Promise<void> {
    try {
      const query = listJobsQuerySchema.parse(req.query);
      const executions = await jobQueueService.listExecutions(query);

      res.status(200).json({
        success: true,
        data: {
          queueStatus: jobQueueService.getStatus(),
          definitions: jobQueueService.getDefinitions(),
          executions,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: 'Validation error',
          details: error.errors,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
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
