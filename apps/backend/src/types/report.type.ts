type ReportType =
  | 'transaction-history'
  | 'compliance-report'
  | 'financial-statment'
  | 'payroll-report'
  | 'treasury-report'
  | 'audit-log';

interface ReportRequest {
  id: string;
  userId: string;
  reportType: string;
  format: 'csv' | 'pdf' | 'xlsx';
  parameters: Record<string, any>;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  downloadUrl?: string;
}

interface ReportTemplate {
  id: string;
  name: string;
  reportType: string;
  query: string;
  format: string;
  schedule?: string;
}

interface ReportParameters {
  startDate?: Date;
  endDate?: Date;
  userId?: string;
  assetCode?: string;
  status?: string;
}
