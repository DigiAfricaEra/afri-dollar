import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { Prisma } from '@afri-dollar/database';

import prisma from '../config/database';
import type {
  Notification,
  NotificationPreferences,
  NotificationTemplate,
  PushSubscription,
  NotificationType,
} from '../types/notification.types';

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_PAGE = 1000;
export const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
const TEMPLATES: Record<string, NotificationTemplate> = {
  'transaction-completed': {
    id: 'transaction-completed',
    name: 'Transaction Completed',
    subject: 'Payment Successful',
    body: 'Your payment of {{amount}} {{currency}} has been successfully processed. Transaction ID: {{transactionId}}.',
    variables: ['amount', 'currency', 'transactionId'],
  },
  'transaction-failed': {
    id: 'transaction-failed',
    name: 'Transaction Failed',
    subject: 'Payment Failed',
    body: 'Your payment of {{amount}} {{currency}} could not be processed. Reason: {{reason}}. Transaction ID: {{transactionId}}.',
    variables: ['amount', 'currency', 'reason', 'transactionId'],
  },
  'kyc-approved': {
    id: 'kyc-approved',
    name: 'KYC Approved',
    subject: 'KYC Verification Approved',
    body: 'Congratulations {{firstName}}! Your KYC verification has been approved. You can now access all features.',
    variables: ['firstName'],
  },
  'kyc-rejected': {
    id: 'kyc-rejected',
    name: 'KYC Rejected',
    subject: 'KYC Verification Rejected',
    body: 'We regret to inform you that your KYC verification was rejected. Reason: {{reason}}. Please contact support for assistance.',
    variables: ['reason'],
  },
  'security-alert': {
    id: 'security-alert',
    name: 'Security Alert',
    subject: 'Suspicious Activity Detected',
    body: 'We detected suspicious activity on your account: {{activity}}. If this was not you, please contact support immediately.',
    variables: ['activity'],
  },
  'payroll-processed': {
    id: 'payroll-processed',
    name: 'Payroll Processed',
    subject: 'Payroll Batch Completed',
    body: 'Your payroll batch "{{batchName}}" has been processed successfully. {{count}} payments totalling {{total}} {{currency}} were disbursed.',
    variables: ['batchName', 'count', 'total', 'currency'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PROVIDER_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number = PROVIDER_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Provider request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this" network
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 224) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved + broadcast
  return false;
}

/**
 * Returns true for loopback, private, link-local, reserved, multicast, or
 * otherwise non-public destinations so we never push to internal networks.
 */
function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isPrivateIPv4(mapped[1]);
    }
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified + loopback
    if (/^f[c-d]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith('ff')) return true; // ff00::/8 multicast
    if (lower.startsWith('2001:db8')) return true; // documentation range
    return false;
  }
  return isPrivateIPv4(ip);
}

/**
 * Resolve the push endpoint hostname and reject loopback, private, link-local,
 * reserved, or otherwise non-public destinations. Only public HTTPS endpoints
 * are allowed. This guards against SSRF via a stored/malicious endpoint.
 */
async function assertPublicEndpoint(endpoint: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('Invalid push subscription');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Invalid push subscription');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) {
      throw new Error('Invalid push subscription');
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Invalid push subscription');
  }

  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Invalid push subscription');
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key in data ? String(data[key]) : `{{${key}}}`
  );
}

function toPreferences(row: {
  userId: string;
  email: boolean;
  sms: boolean;
  push: boolean;
  transactionAlerts: boolean;
  securityAlerts: boolean;
  payrollAlerts: boolean;
  marketing: boolean;
}): NotificationPreferences {
  return {
    userId: row.userId,
    email: row.email,
    sms: row.sms,
    push: row.push,
    transactionAlerts: row.transactionAlerts,
    securityAlerts: row.securityAlerts,
    payrollAlerts: row.payrollAlerts,
    marketing: row.marketing,
  };
}

function toNotification(row: {
  id: string;
  userId: string;
  type: string;
  channel: 'email' | 'sms' | 'push';
  template: string;
  data: Prisma.JsonValue;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}): Notification {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as NotificationType,
    channel: row.channel,
    template: row.template,
    data: (row.data ?? {}) as Record<string, unknown>,
    status: row.status,
    sentAt: row.sentAt ?? undefined,
    readAt: row.readAt ?? undefined,
    createdAt: row.createdAt,
  };
}

function toWebPushSubscription(row: {
  endpoint: string;
  p256dh: string;
  auth: string;
}): PushSubscription {
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

// ---------------------------------------------------------------------------
// Channel-level senders (thin wrappers — real integration injected via env)
// ---------------------------------------------------------------------------

async function deliverEmail(to: string, subject: string, body: string): Promise<boolean> {
  const sgMail = await getEmailClient();
  if (!sgMail) {
    console.warn('[NotificationService] SendGrid not configured – skipping email delivery');
    return false;
  }

  await withTimeout(
    sgMail.send({
      to,
      from: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@afridollar.com',
      subject,
      text: body,
      html: `<p>${escapeHtml(body).replace(/\n/g, '<br/>')}</p>`,
    })
  );

  return true;
}

async function deliverSMS(to: string, message: string): Promise<boolean> {
  const twilioClient = await getTwilioClient();
  if (!twilioClient) {
    console.warn('[NotificationService] Twilio not configured – skipping SMS delivery');
    return false;
  }

  await withTimeout(
    twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER ?? '',
      to,
    })
  );

  return true;
}

async function deliverPush(
  subscription: PushSubscription,
  payload: Record<string, unknown>
): Promise<boolean> {
  const webpush = await getWebPushClient();
  if (!webpush) {
    console.warn('[NotificationService] web-push not configured – skipping push notification');
    return false;
  }

  await assertPublicEndpoint(subscription.endpoint);

  await withTimeout(webpush.sendNotification(subscription, JSON.stringify(payload)));

  return true;
}

// ---------------------------------------------------------------------------
// Lazy client factories (gracefully degrade if packages are absent / not configured)
// ---------------------------------------------------------------------------

async function getEmailClient(): Promise<{
  send: (data: unknown) => Promise<unknown>;
} | null> {
  try {
    if (!process.env.SENDGRID_API_KEY) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    return sgMail;
  } catch {
    return null;
  }
}

async function getTwilioClient(): Promise<{
  messages: { create: (data: unknown) => Promise<unknown> };
} | null> {
  try {
    const { accountSid, authToken, phoneNumber } = {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    };
    if (!accountSid || !authToken || !phoneNumber) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const twilio = require('twilio');
    return twilio(accountSid, authToken);
  } catch {
    return null;
  }
}

async function getWebPushClient(): Promise<{
  sendNotification: (sub: unknown, payload: string) => Promise<unknown>;
  setVapidDetails: (s: string, pub: string, priv: string) => void;
} | null> {
  try {
    const { subject, publicKey, privateKey } = {
      subject: process.env.VAPID_SUBJECT,
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
    if (!subject || !publicKey || !privateKey) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpush = require('web-push');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return webpush;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------
export const NotificationService = {
  /**
   * Send an email using a template.
   */
  async sendEmail(to: string, template: string, data: Record<string, unknown>): Promise<void> {
    const tmpl = TEMPLATES[template];
    if (!tmpl) throw new Error(`Unknown template: ${template}`);

    const subject = tmpl.subject ? renderTemplate(tmpl.subject, data) : 'Notification';
    const body = renderTemplate(tmpl.body, data);

    await deliverEmail(to, subject, body);
  },

  /**
   * Send an SMS message.
   */
  async sendSMS(to: string, message: string): Promise<void> {
    await deliverSMS(to, message);
  },

  /**
   * Send a web push notification.
   */
  async sendPush(subscription: PushSubscription, data: Record<string, unknown>): Promise<void> {
    await deliverPush(subscription, data);
  },

  /**
   * High-level notify: reads preferences and recipient contact info from the
   * database, then dispatches across all enabled channels concurrently while
   * persisting a per-channel Notification row.
   */
  async notify(
    userId: string,
    type: NotificationType,
    data: Record<string, unknown>
  ): Promise<void> {
    const [prefs, user, pushSubscriptions] = await Promise.all([
      this.getPreferences(userId),
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, phoneNumber: true },
      }),
      prisma.pushSubscription.findMany({ where: { userId } }),
    ]);

    // Determine whether to send based on notification category
    const isTransactionEvent = type === 'transaction-completed' || type === 'transaction-failed';
    const isSecurityEvent =
      type === 'security-alert' || type === 'kyc-approved' || type === 'kyc-rejected';
    const isPayrollEvent = type === 'payroll-processed';

    if (isTransactionEvent && !prefs.transactionAlerts) return;
    if (isSecurityEvent && !prefs.securityAlerts) return;
    if (isPayrollEvent && !prefs.payrollAlerts) return;

    const tmpl = TEMPLATES[type];
    if (!tmpl) {
      console.warn('[NotificationService] No template for type:', type);
      return;
    }

    const body = renderTemplate(tmpl.body, data);
    const subject = tmpl.subject ? renderTemplate(tmpl.subject, data) : 'Notification';

    const email = typeof data.email === 'string' ? data.email : (user?.email ?? undefined);
    const phone = typeof data.phone === 'string' ? data.phone : (user?.phoneNumber ?? undefined);

    const channels: Array<'email' | 'sms' | 'push'> = [];
    if (prefs.email) channels.push('email');
    if (prefs.sms) channels.push('sms');
    if (prefs.push) channels.push('push');

    const channelTasks = channels.map(async (channel) => {
      const notif = await prisma.notification.create({
        data: {
          userId,
          type,
          channel,
          template: type,
          data: data as Prisma.InputJsonValue,
          status: 'pending',
        },
      });

      try {
        let delivered = false;

        if (channel === 'email' && email) {
          delivered = await deliverEmail(email, subject, body);
        } else if (channel === 'sms' && phone) {
          delivered = await deliverSMS(phone, body);
        } else if (channel === 'push' && pushSubscriptions.length > 0) {
          const results = await Promise.all(
            pushSubscriptions.map((sub) =>
              deliverPush(toWebPushSubscription(sub), { title: subject, body, type })
            )
          );
          delivered = results.some((result) => result);
        }

        await prisma.notification.update({
          where: { id: notif.id },
          data: delivered ? { status: 'sent', sentAt: new Date() } : { status: 'failed' },
        });
      } catch (err) {
        console.error(`[NotificationService] Failed to send ${channel} notification:`, err);
        await prisma.notification.update({
          where: { id: notif.id },
          data: { status: 'failed' },
        });
      }
    });

    await Promise.all(channelTasks);
  },

  /**
   * Update notification preferences for a user (creates defaults on first write).
   */
  async updatePreferences(
    userId: string,
    preferences: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    const updates = {
      email: preferences.email,
      sms: preferences.sms,
      push: preferences.push,
      transactionAlerts: preferences.transactionAlerts,
      securityAlerts: preferences.securityAlerts,
      payrollAlerts: preferences.payrollAlerts,
      marketing: preferences.marketing,
    };

    const updated = await prisma.notificationPreference.upsert({
      where: { userId },
      update: updates,
      create: { userId, ...updates },
    });

    return toPreferences(updated);
  },

  /**
   * Get notification preferences for a user (creates defaults on first access).
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const row = await prisma.notificationPreference.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    return toPreferences(row);
  },

  /**
   * Get paginated notifications for a user (delivery tracking).
   */
  async getNotifications(
    userId: string,
    options: { page?: number; limit?: number; unreadOnly?: boolean } = {}
  ): Promise<{
    notifications: Notification[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    const rawPage = options.page ?? DEFAULT_PAGE;
    const rawLimit = options.limit ?? DEFAULT_LIMIT;

    const page =
      Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, MAX_PAGE) : DEFAULT_PAGE;
    const limit =
      Number.isSafeInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const where = {
      userId,
      ...(options.unreadOnly === true ? { readAt: null } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where }),
    ]);

    return {
      notifications: rows.map(toNotification),
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
  },

  /**
   * Mark the given notifications as read for a user.
   */
  async markRead(userId: string, ids: string[]): Promise<number> {
    if (!ids || ids.length === 0) return 0;

    const result = await prisma.notification.updateMany({
      where: { userId, id: { in: ids } },
      data: { readAt: new Date() },
    });

    return result.count;
  },

  /**
   * Register (or refresh) a device web-push subscription for a user.
   */
  async registerPushSubscription(
    userId: string,
    subscription: PushSubscription
  ): Promise<PushSubscription> {
    const { endpoint, keys, userAgent } = subscription;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error('Invalid push subscription');
    }

    await assertPublicEndpoint(endpoint);

    await prisma.pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint } },
      update: {
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: userAgent ?? null,
      },
      create: {
        userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: userAgent ?? null,
      },
    });

    return { endpoint, keys, userAgent };
  },

  /**
   * Remove a device web-push subscription for a user.
   */
  async deletePushSubscription(userId: string, id: string): Promise<boolean> {
    const result = await prisma.pushSubscription.deleteMany({
      where: { id, userId },
    });

    return result.count > 0;
  },

  /**
   * List registered push subscriptions for a user.
   */
  async getPushSubscriptions(userId: string): Promise<PushSubscription[]> {
    const rows = await prisma.pushSubscription.findMany({ where: { userId } });

    return rows.map((row) => ({
      id: row.id,
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
      userAgent: row.userAgent ?? undefined,
    }));
  },

  /**
   * Get all available templates.
   */
  getTemplates(): NotificationTemplate[] {
    return Object.values(TEMPLATES);
  },

  /**
   * Get a single template by id.
   */
  getTemplate(id: string): NotificationTemplate | undefined {
    return TEMPLATES[id];
  },
};
