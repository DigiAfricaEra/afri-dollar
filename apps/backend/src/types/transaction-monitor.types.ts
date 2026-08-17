export type MonitorSeverity = 'low' | 'medium' | 'high' | 'critical';

export type MonitorRuleId =
  | 'LARGE_TX'
  | 'VELOCITY'
  | 'STRUCTURING'
  | 'HIGH_RISK_COUNTRY'
  | 'ROUND_AMOUNT'
  | 'UNPARSEABLE_AMOUNT';

export type FlagReviewAction = 'reviewing' | 'release' | 'block';

export interface MonitorRuleResult {
  ruleId: MonitorRuleId;
  severity: MonitorSeverity;
  message: string;
}

export interface TransactionMonitorResult {
  flagged: boolean;
  alerts: MonitorRuleResult[];
}

export interface MonitorConfig {
  largeTxThresholdUsd: number;
  velocityWindowMinutes: number;
  velocityTxLimit: number;
  structuringWindowHours: number;
  structuringTxCount: number;
  structuringRatio: number;
  highRiskCountries: string[];
  roundAmountFloorUsd: number;
  roundAmountModulus: number;
  severityByRule: Record<MonitorRuleId, MonitorSeverity>;
}

export interface ScreenTransactionsResult {
  scanned: number;
  flagged: number;
  failed: number;
}

export interface FlaggedTransactionStats {
  total: number;
  pendingReview: number;
  reviewing: number;
  released: number;
  blocked: number;
  bySeverity: Record<string, number>;
  byRule: Record<string, number>;
}
