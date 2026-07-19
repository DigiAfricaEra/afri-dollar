export type AdminUserStatus = 'active' | 'suspended' | 'banned';

export type SystemHealthStatus = 'healthy' | 'degraded' | 'down';
export type ConnectionStatus = 'connected' | 'disconnected';

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  status: AdminUserStatus;
  kycStatus: string;
  createdAt: Date;
  lastLoginAt?: Date;
  firstName?: string | null;
  lastName?: string | null;
  isVerified: boolean;
  phoneNumber?: string | null;
  walletAddress?: string | null;
}

export interface SystemHealth {
  status: SystemHealthStatus;
  database: ConnectionStatus;
  redis: ConnectionStatus;
  stellar: ConnectionStatus;
  uptime: number;
  version: string;
}

export interface AdminPerformanceMetrics {
  uptime: number;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  users: {
    total: number;
    active: number;
    suspended: number;
    banned: number;
  };
  transactions: {
    total: number;
    pending: number;
    completed: number;
    failed: number;
    flagged: number;
  };
  compliance: {
    openAlerts: number;
    resolvedAlerts: number;
  };
  security: {
    totalBlockedIps: number;
    totalFlaggedIps: number;
    totalFailedAttempts: number;
  };
  jobQueue: 'disabled' | 'ready' | 'error';
}

export interface AdminTransaction {
  id: string;
  userId: string;
  walletId: string;
  type: string;
  status: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  stellarTxId?: string | null;
  isFlagged: boolean;
  flagReason?: string | null;
  flaggedAt?: Date | null;
  flaggedBy?: string | null;
  metadata?: unknown;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
  user?: {
    id: string;
    email: string;
    status: AdminUserStatus;
  };
}

export interface ComplianceAlert {
  id: string;
  type: string;
  severity: string;
  status: 'open' | 'resolved' | 'dismissed';
  title: string;
  description?: string | null;
  userId?: string | null;
  transactionId?: string | null;
  metadata?: unknown;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  resolutionNote?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SystemConfigEntry {
  id: string;
  key: string;
  value: unknown;
  description?: string | null;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComplianceReportSummary {
  generatedAt: Date;
  kyc: {
    pending: number;
    approved: number;
    rejected: number;
    review: number;
  };
  alerts: {
    open: number;
    resolved: number;
    dismissed: number;
    bySeverity: Record<string, number>;
  };
  flaggedTransactions: number;
}
