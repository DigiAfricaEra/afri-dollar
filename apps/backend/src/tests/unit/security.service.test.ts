import { SecurityService } from '../../services/security.service';

describe('SecurityService', () => {
  beforeEach(async () => {
    delete process.env.REDIS_URL;
    delete process.env.IP_REPUTATION_SERVICE_URL;

    await SecurityService.clearFailedAttempts('203.0.113.10');
    await SecurityService.clearFailedAttempts('203.0.113.11');
  });

  it('applies progressive delays after repeated failed attempts', async () => {
    const ip = '203.0.113.10';

    await SecurityService.recordFailedAttempt({ ip });
    await SecurityService.recordFailedAttempt({ ip });
    const thirdAttempt = await SecurityService.recordFailedAttempt({ ip });

    expect(thirdAttempt.record.attempts).toBe(3);
    expect(thirdAttempt.delayMs).toBeGreaterThanOrEqual(1000);
    expect(thirdAttempt.assessment.flagged).toBe(false);
  });

  it('locks out an IP after repeated failures and reports it in metrics', async () => {
    const ip = '203.0.113.11';

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await SecurityService.recordFailedAttempt({ ip });
    }

    const decision = await SecurityService.evaluateAuthRequest(ip, 'login');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);

    const metrics = await SecurityService.getSecurityMetrics();
    expect(metrics.blockedIps.some((record) => record.ip === ip)).toBe(true);
    expect(metrics.flaggedIps.some((record) => record.ip === ip)).toBe(true);
  });

  it('clears failed attempts after a successful login', async () => {
    const ip = '203.0.113.10';

    await SecurityService.recordFailedAttempt({ ip });
    expect(await SecurityService.getFailedAttempt(ip)).not.toBeNull();

    await SecurityService.clearFailedAttempts(ip);

    expect(await SecurityService.getFailedAttempt(ip)).toBeNull();
  });

  describe('external IP reputation integration', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      delete process.env.IP_REPUTATION_SERVICE_URL;
    });

    it('queries and incorporates external IP reputation assessment when configured', async () => {
      const ip = '203.0.113.20';
      process.env.IP_REPUTATION_SERVICE_URL = 'https://ip-rep.example.com';

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          riskScore: 75,
          flagged: true,
          reasons: ['High risk proxy'],
        }),
      });

      const assessment = await SecurityService.assessIpReputation(ip);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://ip-rep.example.com?ip=203.0.113.20',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(assessment.riskScore).toBe(75);
      expect(assessment.flagged).toBe(true);
      expect(assessment.reasons).toContain('High risk proxy');
    });

    it('honors local brute-force evidence even if external provider returns low risk', async () => {
      const ip = '203.0.113.21';
      process.env.IP_REPUTATION_SERVICE_URL = 'https://ip-rep.example.com';

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          riskScore: 0,
          flagged: false,
          reasons: [],
        }),
      });

      for (let i = 0; i < 5; i++) {
        await SecurityService.recordFailedAttempt({ ip });
      }

      const assessment = await SecurityService.assessIpReputation(ip);

      expect(assessment.flagged).toBe(true);
      expect(assessment.riskScore).toBeGreaterThanOrEqual(80);
      expect(assessment.reasons).toContain('Repeated failed login attempts detected');
    });

    it('degrades gracefully to local heuristics when external reputation service fails or times out', async () => {
      const ip = '203.0.113.22';
      process.env.IP_REPUTATION_SERVICE_URL = 'https://ip-rep.example.com';

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch = jest.fn().mockRejectedValue(new Error('Network timeout'));

      const assessment = await SecurityService.assessIpReputation(ip);

      expect(assessment.source).toBe('local');
      expect(assessment.ip).toBe(ip);
      consoleSpy.mockRestore();
    });
  });
});
