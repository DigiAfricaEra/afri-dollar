import { redisSetIfNotExists } from '../middleware/rate-limit.middleware';

const memoryClaims = new Map<string, number>();

/**
 * Claims `key` for `ttlSeconds`. Returns false if the key is already held.
 * Uses Redis SET NX when available, otherwise an in-process map.
 */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  const redisClaimed = await redisSetIfNotExists(key, ttlSeconds);
  if (redisClaimed !== null) {
    return redisClaimed;
  }

  const now = Date.now();
  const expiresAt = memoryClaims.get(key);
  if (expiresAt !== undefined && expiresAt > now) {
    return false;
  }

  memoryClaims.set(key, now + ttlSeconds * 1000);
  return true;
}

export function resetOnceClaims(): void {
  memoryClaims.clear();
}
