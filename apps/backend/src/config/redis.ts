import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redisClient.on('connect', () => {
  console.log('🔴 Redis connected successfully');
});

redisClient.on('error', (error: Error) => {
  console.error('❌ Redis connection error:', error.message);
});

export default redisClient;
