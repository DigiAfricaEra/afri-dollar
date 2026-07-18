import { createClient } from 'redis';

import type {
  AuthSecurityDecision,
  FailedAttemptRecord,
  IpReputationAssessment,
  SecurityMetrics,
} from '../types';

const FAILED_ATTEMPT_THRESHOLD = 3;
const FLAGGED_ATTEMPT_THRESHOLD = 5;
const BLOCK_THRESHOLD = 8;
const MAX_PROGRESSIVE_DELAY_MS = 60_000;
const LOCKOUT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_AUTH_WINDOW_MS = 15 * 60 * 1000;

type AuthEndpoint = 'login' | 'register' | 'refresh' | 'logout';

type RateLimitConfig = {
  windowMs: number;
  max: number;
};

type StoredFailedAttempt = FailedAttemptRecord & {
  blockedUntil?: string;
  flagged?: boolean;
  riskScore?: number;
  flagReason?: string;
};

type RateLimitBucket = {
  count: number;
  windowEndsAt: number;
};

type RedisClient = ReturnType<typeof createClient>;

const AUTH_RATE_LIMITS: Record<AuthEndpoint, RateLimitConfig> = {
  login: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 20 },
  register: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 12 },
  refresh: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 30 },
  logout: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 30 },
};

const FLAGGED_AUTH_RATE_LIMITS: Record<AuthEndpoint, RateLimitConfig> = {
  login: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 5 },
  register: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 4 },
  refresh: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 10 },
  logout: { windowMs: DEFAULT_AUTH_WINDOW_MS, max: 10 },
};

function encodeKeySegment(value: string): string {
  return encodeURIComponent(value);
}

function getNow(): Date {
  return new Date();
}

function toJsonDate(value: Date): string {
  return value.toISOString();
}

function fromJsonDate(value: string): Date {
  return new Date(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SecurityStore {
  private redisClient: RedisClient | null = null;
  private redisConnectPromise: Promise<RedisClient | null> | null = null;
  private redisDisabled = false;

  private readonly failedAttempts = new Map<string, StoredFailedAttempt>();

  private readonly rateLimits = new Map<string, RateLimitBucket>();

  private readonly externalAssessmentCache = new Map<
    string,
    { assessment: IpReputationAssessment; expiresAt: number }
  >();

  private async getRedisClient(): Promise<RedisClient | null> {
    if (this.redisDisabled || !process.env.REDIS_URL) {
      return null;
    }

    if (this.redisClient) {
      return this.redisClient;
    }

    if (!this.redisConnectPromise) {
      this.redisConnectPromise = (async (): Promise<RedisClient | null> => {
        try {
          const client = createClient({
            url: process.env.REDIS_URL,
          });

          client.on('error', (error: unknown) => {
            console.error('Redis security store error:', error);
          });

          await client.connect();
          this.redisClient = client;
          return client;
        } catch (error) {
          console.error('Redis security store unavailable, using in-memory fallback:', error);
          this.redisDisabled = true;
          return null;
        }
      })();
    }

    return this.redisConnectPromise;
  }

  private getFailedAttemptKey(ip: string): string {
    return `security:failed_attempt:${encodeKeySegment(ip)}`;
  }

  private getBlockedIpKey(ip: string): string {
    return `security:blocked_ip:${encodeKeySegment(ip)}`;
  }

  private getFlaggedIpKey(ip: string): string {
    return `security:flagged_ip:${encodeKeySegment(ip)}`;
  }

  private getRateLimitKey(ip: string, endpoint: AuthEndpoint, flagged: boolean): string {
    return `security:rate_limit:${flagged ? 'flagged' : 'default'}:${endpoint}:${encodeKeySegment(ip)}`;
  }

  private async readStoredFailedAttempt(ip: string): Promise<StoredFailedAttempt | null> {
    const redis = await this.getRedisClient();
    const key = this.getFailedAttemptKey(ip);

    if (redis) {
      const raw = await redis.get(key);
      if (!raw) {
        return null;
      }

      return this.deserializeStoredFailedAttempt(raw);
    }

    return this.failedAttempts.get(key) ?? null;
  }

  private async writeStoredFailedAttempt(record: StoredFailedAttempt): Promise<void> {
    const redis = await this.getRedisClient();
    const key = this.getFailedAttemptKey(record.ip);

    if (redis) {
      await redis.set(key, JSON.stringify(this.serializeStoredFailedAttempt(record)));
      return;
    }

    this.failedAttempts.set(key, record);
  }

  private async removeStoredFailedAttempt(ip: string): Promise<void> {
    const redis = await this.getRedisClient();
    const key = this.getFailedAttemptKey(ip);

    if (redis) {
      await redis.del(key);
      await redis.del(this.getBlockedIpKey(ip));
      await redis.del(this.getFlaggedIpKey(ip));
      return;
    }

    this.failedAttempts.delete(key);
  }

  private serializeStoredFailedAttempt(record: StoredFailedAttempt): Record<string, unknown> {
    return {
      ...record,
      lastAttemptAt: toJsonDate(record.lastAttemptAt),
      blockedUntil: record.blockedUntil ?? null,
    };
  }

  private deserializeStoredFailedAttempt(record: string): StoredFailedAttempt {
    const parsed = JSON.parse(record) as Record<string, unknown>;

    return {
      ip: String(parsed.ip),
      userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
      attempts: Number(parsed.attempts ?? 0),
      lastAttemptAt: fromJsonDate(String(parsed.lastAttemptAt)),
      blockedUntil: typeof parsed.blockedUntil === 'string' ? parsed.blockedUntil : undefined,
      flagged: typeof parsed.flagged === 'boolean' ? parsed.flagged : undefined,
      riskScore: typeof parsed.riskScore === 'number' ? parsed.riskScore : undefined,
      flagReason: typeof parsed.flagReason === 'string' ? parsed.flagReason : undefined,
    };
  }

  private async persistBlockState(record: StoredFailedAttempt, reason: string): Promise<void> {
    const redis = await this.getRedisClient();
    const blockedUntil = new Date(Date.now() + LOCKOUT_WINDOW_MS);
    const enriched = {
      ...record,
      flagged: true,
      riskScore: Math.max(record.riskScore ?? 0, 90),
      flagReason: reason,
      blockedUntil: blockedUntil.toISOString(),
    };

    if (redis) {
      await redis.set(this.getBlockedIpKey(record.ip), JSON.stringify(enriched), {
        PX: LOCKOUT_WINDOW_MS,
      });
      await redis.set(this.getFlaggedIpKey(record.ip), JSON.stringify(enriched), {
        PX: LOCKOUT_WINDOW_MS,
      });
      await redis.set(
        this.getFailedAttemptKey(record.ip),
        JSON.stringify(this.serializeStoredFailedAttempt(enriched))
      );
      return;
    }

    this.failedAttempts.set(this.getFailedAttemptKey(record.ip), enriched);
  }

  private async cacheExternalAssessment(
    ip: string,
    assessment: IpReputationAssessment
  ): Promise<void> {
    const ttlMs = 5 * 60 * 1000;
    this.externalAssessmentCache.set(ip, {
      assessment,
      expiresAt: Date.now() + ttlMs,
    });
  }

  private getCachedExternalAssessment(ip: string): IpReputationAssessment | null {
    const cached = this.externalAssessmentCache.get(ip);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.externalAssessmentCache.delete(ip);
      return null;
    }

    return cached.assessment;
  }

  private async assessWithExternalProvider(ip: string): Promise<IpReputationAssessment | null> {
    const providerUrl = process.env.IP_REPUTATION_SERVICE_URL;
    if (!providerUrl) {
      return null;
    }

    const cached = this.getCachedExternalAssessment(ip);
    if (cached) {
      return cached;
    }

    try {
      const response = await fetch(
        `${providerUrl.replace(/\/$/, '')}?ip=${encodeURIComponent(ip)}`
      );
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        riskScore?: number;
        flagged?: boolean;
        reasons?: string[];
      };

      const assessment: IpReputationAssessment = {
        ip,
        riskScore: typeof payload.riskScore === 'number' ? payload.riskScore : 0,
        flagged: Boolean(payload.flagged),
        reasons: Array.isArray(payload.reasons)
          ? payload.reasons.filter((item): item is string => typeof item === 'string')
          : [],
        source: 'external',
      };

      await this.cacheExternalAssessment(ip, assessment);
      return assessment;
    } catch (error) {
      console.error(
        'External IP reputation service failed, falling back to local heuristics:',
        error
      );
      return null;
    }
  }

  private buildLocalAssessment(
    ip: string,
    record: StoredFailedAttempt | null
  ): IpReputationAssessment {
    const attempts = record?.attempts ?? 0;
    const reasons: string[] = [];

    let riskScore = 10;

    if (attempts >= BLOCK_THRESHOLD) {
      riskScore = 95;
      reasons.push('IP is temporarily blocked after repeated failed logins');
    } else if (attempts >= FLAGGED_ATTEMPT_THRESHOLD) {
      riskScore = 80;
      reasons.push('Repeated failed login attempts detected');
    } else if (attempts >= FAILED_ATTEMPT_THRESHOLD) {
      riskScore = 55;
      reasons.push('Suspicious login failure pattern detected');
    }

    if (record?.blockedUntil) {
      riskScore = 100;
      reasons.push('IP is currently within a lockout window');
    }

    return {
      ip,
      riskScore,
      flagged: riskScore >= 60,
      reasons,
      source: 'local',
    };
  }

  private async checkAndConsumeRateLimit(
    ip: string,
    endpoint: AuthEndpoint,
    flagged: boolean
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    const redis = await this.getRedisClient();
    const config = flagged ? FLAGGED_AUTH_RATE_LIMITS[endpoint] : AUTH_RATE_LIMITS[endpoint];
    const key = this.getRateLimitKey(ip, endpoint, flagged);

    if (redis) {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.pExpire(key, config.windowMs);
      }

      if (current > config.max) {
        const ttl = await redis.pTTL(key);
        return {
          allowed: false,
          retryAfterSeconds: ttl > 0 ? Math.ceil(ttl / 1000) : Math.ceil(config.windowMs / 1000),
        };
      }

      return { allowed: true };
    }

    const now = Date.now();
    const bucket = this.rateLimits.get(key);

    if (!bucket || bucket.windowEndsAt <= now) {
      this.rateLimits.set(key, { count: 1, windowEndsAt: now + config.windowMs });
      return { allowed: true };
    }

    bucket.count += 1;
    this.rateLimits.set(key, bucket);

    if (bucket.count > config.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((bucket.windowEndsAt - now) / 1000),
      };
    }

    return { allowed: true };
  }

  async assessIpReputation(ip: string): Promise<IpReputationAssessment> {
    const record = await this.readStoredFailedAttempt(ip);
    const externalAssessment = await this.assessWithExternalProvider(ip);

    if (externalAssessment) {
      const blocked = record?.blockedUntil
        ? new Date(record.blockedUntil).getTime() > Date.now()
        : false;
      if (blocked) {
        return {
          ...externalAssessment,
          flagged: true,
          riskScore: Math.max(externalAssessment.riskScore, 100),
          reasons: [...externalAssessment.reasons, 'Current lockout state detected locally'],
        };
      }

      return externalAssessment;
    }

    return this.buildLocalAssessment(ip, record);
  }

  async evaluateAuthRequest(ip: string, endpoint: AuthEndpoint): Promise<AuthSecurityDecision> {
    const assessment = await this.assessIpReputation(ip);
    const rateLimitResult = await this.checkAndConsumeRateLimit(ip, endpoint, assessment.flagged);

    if (!rateLimitResult.allowed) {
      return {
        allowed: false,
        assessment,
        retryAfterSeconds: rateLimitResult.retryAfterSeconds,
      };
    }

    const record = await this.readStoredFailedAttempt(ip);
    if (record?.blockedUntil && new Date(record.blockedUntil).getTime() > Date.now()) {
      return {
        allowed: false,
        assessment: {
          ...assessment,
          flagged: true,
          riskScore: Math.max(assessment.riskScore, 100),
          reasons: [...assessment.reasons, 'Lockout is still active'],
        },
        retryAfterSeconds: Math.ceil((new Date(record.blockedUntil).getTime() - Date.now()) / 1000),
      };
    }

    return { allowed: true, assessment };
  }

  async recordFailedAttempt(data: { ip: string; userId?: string }): Promise<{
    record: FailedAttemptRecord;
    delayMs: number;
    blockedUntil?: Date;
    assessment: IpReputationAssessment;
  }> {
    const existing = await this.readStoredFailedAttempt(data.ip);
    const now = getNow();
    const attempts = (existing?.attempts ?? 0) + 1;
    const delayMs =
      attempts < FAILED_ATTEMPT_THRESHOLD
        ? 0
        : Math.min(1000 * 2 ** (attempts - FAILED_ATTEMPT_THRESHOLD), MAX_PROGRESSIVE_DELAY_MS);

    const record: StoredFailedAttempt = {
      ip: data.ip,
      userId: data.userId ?? existing?.userId,
      attempts,
      lastAttemptAt: now,
    };

    if (attempts >= BLOCK_THRESHOLD) {
      record.flagged = true;
      record.riskScore = 95;
      record.flagReason = 'Too many failed login attempts';
      record.blockedUntil = new Date(Date.now() + LOCKOUT_WINDOW_MS).toISOString();
      await this.persistBlockState(record, record.flagReason);
    } else if (attempts >= FLAGGED_ATTEMPT_THRESHOLD) {
      record.flagged = true;
      record.riskScore = 80;
      record.flagReason = 'Repeated login failures';
      await this.writeStoredFailedAttempt(record);
      const redis = await this.getRedisClient();
      if (redis) {
        await redis.set(
          this.getFlaggedIpKey(data.ip),
          JSON.stringify(this.serializeStoredFailedAttempt(record)),
          {
            PX: LOCKOUT_WINDOW_MS,
          }
        );
      }
    } else {
      await this.writeStoredFailedAttempt(record);
    }

    const assessment = await this.assessIpReputation(data.ip);

    return {
      record: {
        ip: record.ip,
        userId: record.userId,
        attempts: record.attempts,
        lastAttemptAt: record.lastAttemptAt,
      },
      delayMs,
      blockedUntil: record.blockedUntil ? fromJsonDate(record.blockedUntil) : undefined,
      assessment,
    };
  }

  async clearFailedAttempts(ip: string): Promise<void> {
    await this.removeStoredFailedAttempt(ip);
  }

  async sleep(ms: number): Promise<void> {
    if (ms > 0) {
      await delay(ms);
    }
  }

  async getSecurityMetrics(): Promise<SecurityMetrics> {
    const redis = await this.getRedisClient();

    if (redis) {
      const blockedIps: FailedAttemptRecord[] = [];
      const flaggedIps: FailedAttemptRecord[] = [];
      let totalFailedAttempts = 0;

      for await (const keys of redis.scanIterator({
        MATCH: 'security:failed_attempt:*',
      })) {
        for (const key of keys) {
          const raw = await redis.get(key);
          if (!raw) {
            continue;
          }

          const parsed = this.deserializeStoredFailedAttempt(raw);
          const record: FailedAttemptRecord = {
            ip: parsed.ip,
            userId: parsed.userId,
            attempts: parsed.attempts,
            lastAttemptAt: parsed.lastAttemptAt,
          };

          totalFailedAttempts += record.attempts;

          if (parsed.blockedUntil && new Date(parsed.blockedUntil).getTime() > Date.now()) {
            blockedIps.push(record);
          }

          if (parsed.flagged || parsed.attempts >= FLAGGED_ATTEMPT_THRESHOLD) {
            flaggedIps.push(record);
          }
        }
      }

      return {
        blockedIps,
        flaggedIps,
        totalBlockedIps: blockedIps.length,
        totalFlaggedIps: flaggedIps.length,
        totalFailedAttempts,
      };
    }

    const records = Array.from(this.failedAttempts.values());
    const blockedIps = records.filter(
      (record) => record.blockedUntil && new Date(record.blockedUntil).getTime() > Date.now()
    );
    const flaggedIps = records.filter(
      (record) => record.flagged || record.attempts >= FLAGGED_ATTEMPT_THRESHOLD
    );

    return {
      blockedIps: blockedIps.map((record) => ({
        ip: record.ip,
        userId: record.userId,
        attempts: record.attempts,
        lastAttemptAt: record.lastAttemptAt,
      })),
      flaggedIps: flaggedIps.map((record) => ({
        ip: record.ip,
        userId: record.userId,
        attempts: record.attempts,
        lastAttemptAt: record.lastAttemptAt,
      })),
      totalBlockedIps: blockedIps.length,
      totalFlaggedIps: flaggedIps.length,
      totalFailedAttempts: records.reduce((sum, record) => sum + record.attempts, 0),
    };
  }

  async getFailedAttempt(ip: string): Promise<FailedAttemptRecord | null> {
    const record = await this.readStoredFailedAttempt(ip);
    if (!record) {
      return null;
    }

    return {
      ip: record.ip,
      userId: record.userId,
      attempts: record.attempts,
      lastAttemptAt: record.lastAttemptAt,
    };
  }

  async getBlockedIps(): Promise<FailedAttemptRecord[]> {
    const metrics = await this.getSecurityMetrics();
    return metrics.blockedIps;
  }

  async getFlaggedIps(): Promise<FailedAttemptRecord[]> {
    const metrics = await this.getSecurityMetrics();
    return metrics.flaggedIps;
  }
}

export const SecurityService = new SecurityStore();

export type { AuthEndpoint };
