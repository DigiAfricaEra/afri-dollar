export type ReportType =
  | 'transaction-history'
  | 'compliance-report'
  | 'financial-statement'
  | 'payroll-report'
  | 'treasury-report'
  | 'audit-log';

export type ReportStatus = 'pending' | 'generating' | 'completed' | 'failed';

export type ReportFormat = 'csv' | 'pdf' | 'xlsx';

export type ReportData = Record<string, unknown>;

export interface ReportRequest {
  id: string;
  userId: string;
  reportType: ReportType;
  format: ReportFormat;
  parameters: ReportParameters;
  status: ReportStatus;
  createdAt: Date;
  completedAt?: Date;
  downloadUrl?: string;
}

export interface ReportTemplate {
  id: string;
  name: string;
  reportType: ReportType;
  query: string;
  format: ReportFormat;
  schedule?: string;
}

export interface ReportParameters {
  startDate?: string;
  endDate?: string;
  userId?: string;
  assetCode?: string;
  status?: string;
}
