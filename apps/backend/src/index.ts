import path from 'path';

import cors from 'cors';
import { config } from 'dotenv';
import express, { json, urlencoded } from 'express';
import helmet from 'helmet';

import prisma from './config/database';
import redisClient from './config/redis';
import { adminLimiter, apiLimiter, authLimiter } from './middleware/rate-limit.middleware';
import authRouter from './routes/auth.routes';
import fxRouter from './routes/fx.routes';
import payrollRouter from './routes/payroll.routes';
import treasuryRouter from './routes/treasury.routes';
// Load backend-level .env file
config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Export prisma for easy access
export { prisma };

app.set('trust proxy', 1);

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

// Auth routes — stricter rate limit (brute-force / credential-stuffing protection)
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/auth', authLimiter, authRouter);

// FX routes — standard rate limit
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/fx', apiLimiter, fxRouter);

// Payroll routes — standard rate limit
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/payroll', apiLimiter, payrollRouter);

// Treasury routes (admin only) — more permissive rate limit
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/treasury', adminLimiter, treasuryRouter);

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
// allSettled guarantees process.exit is always called even if one of the
// disconnect/quit calls rejects — Promise.all would silently stall here.
const shutdown = (signal: 'SIGTERM' | 'SIGINT'): void => {
  console.log(`${signal} signal received: closing HTTP server`);
  void Promise.allSettled([prisma.$disconnect(), redisClient.quit()]).then((results) => {
    const hasFailure = results.some((r) => r.status === 'rejected');
    if (hasFailure) {
      console.error('❌ One or more shutdown tasks failed:', results);
    }
    process.exit(hasFailure ? 1 : 0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
