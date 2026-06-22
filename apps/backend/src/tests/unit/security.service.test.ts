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
});
