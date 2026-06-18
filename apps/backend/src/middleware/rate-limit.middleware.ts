import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

import redisClient from '../config/redis';

const redisStore = new RedisStore({
  sendCommand: (...args: string[]): Promise<number> => {
    const [command, ...rest] = args;
    return redisClient.call(command, ...rest) as Promise<number>;
  },
});

const rateLimitExceededResponse = {
  success: false,
  error: {
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please try again later',
  },
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Pre-parse all rate-limit env vars once at module load time.
const windowMs = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const authMax = parsePositiveInt(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS, 20);
const apiMax = parsePositiveInt(process.env.RATE_LIMIT_MAX_REQUESTS, 100);
const adminMax = parsePositiveInt(process.env.RATE_LIMIT_ADMIN_MAX_REQUESTS, 200);

export const authLimiter = rateLimit({
  windowMs,
  max: authMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore,
  passOnStoreError: false,
  message: rateLimitExceededResponse,
  keyGenerator: (req) => `auth:${req.ip ?? 'unknown'}`,
});

export const apiLimiter = rateLimit({
  windowMs,
  max: apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore,
  passOnStoreError: true,
  message: rateLimitExceededResponse,
  keyGenerator: (req) => `api:${req.ip ?? 'unknown'}`,
});

export const adminLimiter = rateLimit({
  windowMs,
  max: adminMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore,
  passOnStoreError: false,
  message: rateLimitExceededResponse,
  keyGenerator: (req) => `admin:${req.ip ?? 'unknown'}`,
});
