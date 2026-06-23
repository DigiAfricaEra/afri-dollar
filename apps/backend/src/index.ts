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
import auditRouter from './routes/audit.routes';
import authRouter from './routes/auth.routes';
import fxRouter, { adminFxRouter } from './routes/fx.routes';
import paymentRouter from './routes/payment.routes';
import payrollRouter from './routes/payroll.routes';
import stellarRouter from './routes/stellar.routes';
import treasuryRouter from './routes/treasury.routes';
import walletRouter from './routes/wallet.routes';
// Load backend-level .env file
config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3001;

// Export prisma for easy access
export { prisma };

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

// Admin FX routes
app.use('/api/v1/admin/fx', adminFxRouter as MountableRouter);

// Payroll routes
app.use('/api/v1/payroll', payrollRouter as MountableRouter);

// Stellar routes
app.use('/api/v1/stellar', stellarRouter as MountableRouter);

// Treasury routes (admin only)
app.use('/api/v1/treasury', treasuryRouter as MountableRouter);

// Audit routes (admin only)
app.use('/api/v1/audit', auditRouter as MountableRouter);

// Wallet routes
app.use('/api/v1/wallet', walletRouter as MountableRouter);

// Global error handler
app.use(errorMiddleware);

// Database connection check and server start
async function startServer(): Promise<void> {
  try {
    // Check database connection
    await prisma.$connect();
    console.log('🐘 Database connected successfully');

    app.listen(PORT, () => {
      console.log(`🚀 AfriDollar Backend API running on port ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    process.exit(1);
  }
}

void startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  void prisma.$disconnect().then(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  void prisma.$disconnect().then(() => process.exit(0));
});
