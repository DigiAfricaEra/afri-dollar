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

export const authLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '') || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS ?? '') || 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore,
  message: rateLimitExceededResponse,
  keyGenerator: (req) => `auth:${req.ip ?? 'unknown'}`,
});

export const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '') || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? '') || 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore,
  message: rateLimitExceededResponse,
  keyGenerator: (req) => `api:${req.ip ?? 'unknown'}`,
});

export const adminLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '') || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_ADMIN_MAX_REQUESTS ?? '') || 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore,
  message: rateLimitExceededResponse,
  keyGenerator: (req) => `admin:${req.ip ?? 'unknown'}`,
});
