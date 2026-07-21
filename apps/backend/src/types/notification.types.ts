export interface Notification {
  id: string;
  userId: string;
  type: 'email' | 'sms' | 'push';
  channel: 'email' | 'sms' | 'push';
  template: string;
  data: Record<string, unknown>;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  sentAt?: Date;
  deliveredAt?: Date;
}

export interface NotificationPreferences {
  userId: string;
  email: boolean;
  sms: boolean;
  push: boolean;
  transactionAlerts: boolean;
  securityAlerts: boolean;
  payrollAlerts: boolean;
  marketing: boolean;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  subject?: string;
  body: string;
  variables: string[];
}

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export type NotificationType =
  | 'transaction-completed'
  | 'transaction-failed'
  | 'kyc-approved'
  | 'kyc-rejected'
  | 'security-alert'
  | 'payroll-processed';
