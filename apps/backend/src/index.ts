import type { Server } from 'http';
import path from 'path';

import cors from 'cors';
import { config } from 'dotenv';
import express, { json, urlencoded } from 'express';
import helmet from 'helmet';

// Express's RequestHandler uses `any` as default generic params, which triggers
// @typescript-eslint/no-unsafe-argument. This interface provides non-any types.
interface MountableRouter {
  (req: express.Request, res: express.Response, next: express.NextFunction): void;
}
import prisma from './config/database';
import { errorMiddleware } from './middleware/error.middleware';
import adminRouter from './routes/admin.routes';
import auditRouter from './routes/audit.routes';
import authRouter from './routes/auth.routes';
import fxRouter, { adminFxRouter } from './routes/fx.routes';
import jobRouter from './routes/job.routes';
import paymentRouter from './routes/payment.routes';
import payrollRouter from './routes/payroll.routes';
import reportRouter from './routes/report.routes';
import securityRouter from './routes/security.routes';
import stellarRouter from './routes/stellar.routes';
import treasuryRouter from './routes/treasury.routes';
import walletRouter from './routes/wallet.routes';
import { jobQueueService } from './services/job-queue.service';
import { reportWorker } from './services/report-worker.service';
// Load backend-level .env file
config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3001;
let httpServer: Server | null = null;

// Export prisma for easy access
export { prisma };
export { app };

// Middleware
app.use(helmet());
app.use(cors());
app.use(json());
app.use(urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: 'AfriDollar Backend API is running' });
});

// API routes
app.get('/api/v1', (_req, res) => {
  res.json({
    name: 'AfriDollar API',
    version: '0.1.0',
    description: 'Stellar-powered financial infrastructure API',
  });
});

// Auth routes
app.use('/api/v1/auth', authRouter as MountableRouter);

// FX routes
app.use('/api/v1/fx', fxRouter as MountableRouter);

// Payment routes
app.use('/api/v1/payments', paymentRouter as MountableRouter);

// Admin FX routes (mounted before general admin router)
app.use('/api/v1/admin/fx', adminFxRouter as MountableRouter);

// Admin dashboard routes
app.use('/api/v1/admin', adminRouter as MountableRouter);

// Payroll routes
app.use('/api/v1/payroll', payrollRouter as MountableRouter);

// Stellar routes
app.use('/api/v1/stellar', stellarRouter as MountableRouter);

// Treasury routes (admin only)
app.use('/api/v1/treasury', treasuryRouter as MountableRouter);

// Audit routes (admin only)
app.use('/api/v1/audit', auditRouter as MountableRouter);

// Security routes (admin only)
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/security', securityRouter);

// Wallet routes
app.use('/api/v1/wallet', walletRouter as MountableRouter);

// Job routes (admin only)
app.use('/api/v1/jobs', jobRouter as MountableRouter);

// Report routes
app.use('/api/v1/reports', reportRouter as MountableRouter);

// Global error handler
app.use(errorMiddleware);

// Database connection check and server start
async function startServer(): Promise<void> {
  try {
    // Check database connection
    await prisma.$connect();
    console.log('🐘 Database connected successfully');

    await jobQueueService.start();
    await reportWorker.start();

    httpServer = app.listen(PORT, () => {
      console.log(`🚀 AfriDollar Backend API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  void startServer();
}

async function closeHttpServer(): Promise<void> {
  if (httpServer === null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer?.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function shutdown(signal: 'SIGTERM' | 'SIGINT'): void {
  console.log(`${signal} signal received: closing HTTP server`);
  void closeHttpServer()
    .then(() => jobQueueService.stop())
    .then(() => reportWorker.stop())
    .then(() => prisma.$disconnect())
    .catch((error) => {
      console.error('Graceful shutdown failed:', error);
    })
    .finally(() => process.exit(0));
}

// Graceful shutdown
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
