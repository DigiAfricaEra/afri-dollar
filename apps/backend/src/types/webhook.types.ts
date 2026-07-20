export type WebhookEvent =
  | 'transaction.completed'
  | 'transaction.failed'
  | 'wallet.created'
  | 'payroll.processed'
  | 'kyc.approved'
  | 'kyc.rejected';

export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'transaction.completed',
  'transaction.failed',
  'wallet.created',
  'payroll.processed',
  'kyc.approved',
  'kyc.rejected',
];

export interface WebhookConfigResponse {
  id: string;
  userId: string;
  url: string;
  events: string[];
  active: boolean;
  headers?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookConfigWithSecret extends WebhookConfigResponse {
  secret: string;
}

export interface WebhookDeliveryResponse {
  id: string;
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  statusCode?: number;
  response?: string;
  error?: string;
  attemptCount: number;
  maxAttempts: number;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  nextRetryAt?: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmitWebhookEventOptions {
  eventType: WebhookEvent;
  payload: Record<string, unknown>;
  userId?: string;
}

export interface CreateWebhookOptions {
  url: string;
  events: WebhookEvent[];
  headers?: Record<string, string>;
}

export interface WebhookDeliveryJobPayload {
  deliveryId: string;
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  url: string;
  secret: string;
  headers?: Record<string, string>;
}

export interface ListWebhookDeliveriesOptions {
  limit?: number;
  cursor?: string;
}

export const WEBHOOK_DELIVERY_QUEUE = 'webhook-delivery';
export const WEBHOOK_DELIVERY_CONCURRENCY = 3;
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];
