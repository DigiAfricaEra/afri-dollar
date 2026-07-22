export interface FailedAttemptRecord {
  ip: string;
  userId?: string;
  attempts: number;
  lastAttemptAt: Date;
}

export interface IpReputationAssessment {
  ip: string;
  riskScore: number;
  flagged: boolean;
  reasons: string[];
  source: 'local' | 'external' | 'combined';
}

export interface AuthSecurityDecision {
  allowed: boolean;
  assessment: IpReputationAssessment;
  retryAfterSeconds?: number;
}

export interface SecurityMetrics {
  blockedIps: FailedAttemptRecord[];
  flaggedIps: FailedAttemptRecord[];
  totalBlockedIps: number;
  totalFlaggedIps: number;
  totalFailedAttempts: number;
}
