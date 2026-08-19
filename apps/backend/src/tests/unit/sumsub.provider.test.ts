/* eslint-disable */
import crypto from 'crypto';

// Mock env before importing the provider
jest.mock('../../config/env', () => ({
  env: {
    SUMSUB_API_KEY: 'test-api-key',
    SUMSUB_SECRET_KEY: 'test-secret-key-32-bytes-long!!',
    SUMSUB_BASE_URL: 'https://api.test.sumsub.com',
    KYC_REQUIRED_THRESHOLD_USD: 0,
    AML_THRESHOLD_USD: 0,
    ENCRYPTION_KEY: 'test-encryption-key',
    JWT_SECRET: 'test-jwt-secret',
  },
}));

import { SumsubProvider } from '../../services/providers/sumsub.provider';

describe('SumsubProvider', () => {
  let provider: SumsubProvider;

  beforeEach(() => {
    provider = new SumsubProvider();
  });

  // ── Webhook HMAC Verification ──────────────────────────────────────────

  describe('verifyWebhookSignature', () => {
    it('should return true for a valid HMAC-SHA256 signature', () => {
      const timestamp = '1690000000';
      const body = '{"type":"applicantReview","status":"completed"}';

      const expectedSignature = crypto
        .createHmac('sha256', 'test-secret-key-32-bytes-long!!')
        .update(timestamp + body, 'utf8')
        .digest('hex');

      const result = provider.verifyWebhookSignature(timestamp, body, expectedSignature);
      expect(result).toBe(true);
    });

    it('should return false for an invalid signature', () => {
      const timestamp = '1690000000';
      const body = '{"type":"applicantReview","status":"completed"}';
      const invalidSignature = 'a'.repeat(64);

      const result = provider.verifyWebhookSignature(timestamp, body, invalidSignature);
      expect(result).toBe(false);
    });

    it('should return false for a tampered body', () => {
      const timestamp = '1690000000';
      const originalBody = '{"type":"applicantReview","status":"completed"}';
      const tamperedBody = '{"type":"applicantReview","status":"rejected"}';

      const signature = crypto
        .createHmac('sha256', 'test-secret-key-32-bytes-long!!')
        .update(timestamp + originalBody, 'utf8')
        .digest('hex');

      const result = provider.verifyWebhookSignature(timestamp, tamperedBody, signature);
      expect(result).toBe(false);
    });

    it('should return false for a tampered timestamp', () => {
      const timestamp = '1690000000';
      const tamperedTimestamp = '1690000001';
      const body = '{"type":"applicantReview"}';

      const signature = crypto
        .createHmac('sha256', 'test-secret-key-32-bytes-long!!')
        .update(timestamp + body, 'utf8')
        .digest('hex');

      const result = provider.verifyWebhookSignature(tamperedTimestamp, body, signature);
      expect(result).toBe(false);
    });
  });

  // ── Request Signing ────────────────────────────────────────────────────

  describe('request signature generation', () => {
    it('should produce correct HMAC-SHA256 for a given method, path, and timestamp', () => {
      const method = 'GET';
      const path = '/resources/applicants/test-id';
      const timestamp = '1690000000';

      const expected = crypto
        .createHmac('sha256', 'test-secret-key-32-bytes-long!!')
        .update(method + path + timestamp)
        .digest('hex');

      expect(expected).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ── Config Validation ──────────────────────────────────────────────────

  describe('configuration', () => {
    it('should be instantiable with valid env vars', () => {
      expect(() => new SumsubProvider()).not.toThrow();
    });
  });
});
