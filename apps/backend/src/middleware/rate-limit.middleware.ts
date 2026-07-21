import type { NextFunction, RequestHandler, Response } from 'express';
import { createClient } from 'redis';

import type { AuthRequest } from './auth.middleware';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export const rateLimits = {
  auth: { windowMs: 15 * 60 * 1000, maxRequests: 5 },
  general: { windowMs: 15 * 60 * 1000, maxRequests: 100 },
  sensitive: { windowMs: 60 * 60 * 1000, maxRequests: 10 },
} satisfies Record<string, RateLimitConfig>;

type RedisClient = ReturnType<typeof createClient>;

type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  key: string;
  member: string;
};

const memoryStore = new Map<string, number[]>();
let redisClient: RedisClient | null = null;
let redisConnectPromise: Promise<RedisClient | null> | null = null;
let redisDisabled = false;

function getRequestIp(req: AuthRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function getRequestIdentity(req: AuthRequest): string {
  if (req.user?.userId) {
    return `user:${req.user.userId}`;
  }

  return `ip:${getRequestIp(req)}`;
}

function getRateLimitKey(req: AuthRequest, config: RateLimitConfig): string {
  const identity = encodeURIComponent(getRequestIdentity(req));
  return `rate_limit:${config.windowMs}:${config.maxRequests}:${identity}`;
}

function getUnixResetTimestamp(resetAtMs: number): number {
  return Math.ceil(resetAtMs / 1000);
}

function setRateLimitHeaders(res: Response, decision: RateLimitDecision): void {
  res.setHeader('X-RateLimit-Limit', String(decision.limit));
  res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
  res.setHeader('X-RateLimit-Reset', String(getUnixResetTimestamp(decision.resetAt)));
}

async function getRedisClient(): Promise<RedisClient | null> {
  if (redisDisabled || !process.env.REDIS_URL) {
    return null;
  }

  if (redisClient) {
    return redisClient;
  }

  if (!redisConnectPromise) {
    redisConnectPromise = (async (): Promise<RedisClient | null> => {
      try {
        const client = createClient({ url: process.env.REDIS_URL });

        client.on('error', (error: unknown) => {
          console.error('Redis rate limit store error:', error);
        });

        await client.connect();
        redisClient = client;
        return client;
      } catch (error) {
        console.error('Redis rate limit store unavailable, using in-memory fallback:', error);
        redisDisabled = true;
        return null;
      }
    })();
  }

  return redisConnectPromise;
}

async function consumeRedisLimit(
  key: string,
  config: RateLimitConfig,
  now: number
): Promise<RateLimitDecision | null> {
  const redis = await getRedisClient();

  if (!redis) {
    return null;
  }

  const windowStart = now - config.windowMs;
  const member = `${now}:${process.hrtime.bigint().toString()}:${Math.random()}`;

  await redis.zRemRangeByScore(key, 0, windowStart);
  await redis.zAdd(key, { score: now, value: member });
  await redis.pExpire(key, config.windowMs);

  const count = await redis.zCard(key);
  const oldest = await redis.zRangeWithScores(key, 0, 0);
  const oldestScore = oldest[0]?.score ?? now;
  const resetAt = oldestScore + config.windowMs;
  const remaining = Math.max(config.maxRequests - count, 0);

  return {
    allowed: count <= config.maxRequests,
    limit: config.maxRequests,
    remaining,
    resetAt,
    key,
    member,
  };
}

function consumeMemoryLimit(key: string, config: RateLimitConfig, now: number): RateLimitDecision {
  const windowStart = now - config.windowMs;
  const existing = memoryStore.get(key) ?? [];
  const requests = existing.filter((timestamp) => timestamp > windowStart);

  requests.push(now);
  memoryStore.set(key, requests);

  const oldest = requests[0] ?? now;
  const count = requests.length;

  return {
    allowed: count <= config.maxRequests,
    limit: config.maxRequests,
    remaining: Math.max(config.maxRequests - count, 0),
    resetAt: oldest + config.windowMs,
    key,
    member: String(now),
  };
}

async function decrementRedisLimit(decision: RateLimitDecision): Promise<boolean> {
  const redis = await getRedisClient();

  if (!redis) {
    return false;
  }

  await redis.zRem(decision.key, decision.member);
  return true;
}

function decrementMemoryLimit(decision: RateLimitDecision): void {
  const requests = memoryStore.get(decision.key);

  if (!requests) {
    return;
  }

  const requestIndex = requests.findIndex((timestamp) => String(timestamp) === decision.member);
  if (requestIndex >= 0) {
    requests.splice(requestIndex, 1);
  }

  if (requests.length === 0) {
    memoryStore.delete(decision.key);
  }
}

function shouldSkipRequest(config: RateLimitConfig, statusCode: number): boolean {
  if (config.skipSuccessfulRequests && statusCode < 400) {
    return true;
  }

  return Boolean(config.skipFailedRequests && statusCode >= 400);
}

async function applyRateLimit(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  config: RateLimitConfig
): Promise<void> {
  const now = Date.now();
  const key = getRateLimitKey(req, config);
  const decision =
    (await consumeRedisLimit(key, config, now)) ?? consumeMemoryLimit(key, config, now);

  setRateLimitHeaders(res, decision);

  res.on('finish', () => {
    if (!shouldSkipRequest(config, res.statusCode)) {
      return;
    }

    void decrementRedisLimit(decision).then((decrementedInRedis) => {
      if (!decrementedInRedis) {
        decrementMemoryLimit(decision);
      }
    });
  });

  if (!decision.allowed) {
    res.status(429).json({
      success: false,
      error: 'Too many requests',
      retryAfterSeconds: Math.max(1, Math.ceil((decision.resetAt - now) / 1000)),
    });
    return;
  }

  next();
}

export const rateLimiter = (config: RateLimitConfig): RequestHandler => {
  return (req, res, next): void => {
    void applyRateLimit(req as AuthRequest, res, next, config).catch(next);
  };
};

export const authRateLimiter: RequestHandler = rateLimiter(rateLimits.auth);
export const sensitiveRateLimiter: RequestHandler = rateLimiter(rateLimits.sensitive);
export const generalRateLimiter: RequestHandler = rateLimiter(rateLimits.general);
