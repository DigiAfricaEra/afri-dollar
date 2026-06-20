import path from 'path';

import cors from 'cors';
import { config } from 'dotenv';
import express, { json, urlencoded } from 'express';
import helmet from 'helmet';

import prisma from './config/database';
import { errorMiddleware } from './middleware/error.middleware';
import authRouter from './routes/auth.routes';
import fxRouter from './routes/fx.routes';
import paymentRouter from './routes/payment.routes';
import payrollRouter from './routes/payroll.routes';
import treasuryRouter from './routes/treasury.routes';
import walletRouter from './routes/wallet.routes';
// Load backend-level .env file
config({ path: path.resolve(__dirname, '../.env') });

const app = express();
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
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/auth', authRouter);

// FX routes
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/fx', fxRouter);

// Payment routes
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/payments', paymentRouter);

// Payroll routes
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/payroll', payrollRouter);

// Treasury routes (admin only)
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/treasury', treasuryRouter);

// Wallet routes
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
app.use('/api/v1/wallet', walletRouter);

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
