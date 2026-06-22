import type { Response, NextFunction } from 'express';

import { AuditService } from '../services/audit.service';
import type { AuthRequest } from './auth.middleware';

export const auditMiddleware = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    next();
    return;
  }

  res.on('finish', () => {
    AuditService.log({
      userId: req.user?.userId,
      action: `${req.method} ${req.baseUrl}${req.path}`,
      resource: 'api_endpoint',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      success: res.statusCode < 400,
      metadata: {
        statusCode: res.statusCode,
      },
    }).catch((err) => {
      console.error('Failed to write middleware audit log:', err);
    });
  });

  next();
};
