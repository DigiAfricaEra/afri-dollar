import type {
  Notification,
  NotificationPreferences,
  NotificationTemplate,
  PushSubscription,
  NotificationType,
} from '../types/notification.types';

// ---------------------------------------------------------------------------
// In-memory stores (replace with DB persistence in production)
// ---------------------------------------------------------------------------
const notificationStore: Notification[] = [];
const preferencesStore: Map<string, NotificationPreferences> = new Map();

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
function generateId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    key in data ? String(data[key]) : `{{${key}}}`
  );
}

function getDefaultPreferences(userId: string): NotificationPreferences {
  return {
    userId,
    email: true,
    sms: true,
    push: true,
    transactionAlerts: true,
    securityAlerts: true,
    marketing: false,
  };
}

function getUserPreferences(userId: string): NotificationPreferences {
  return preferencesStore.get(userId) ?? getDefaultPreferences(userId);
}

// ---------------------------------------------------------------------------
// Channel-level senders (thin wrappers — real integration injected via env)
// ---------------------------------------------------------------------------

async function deliverEmail(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const sgMail = await getEmailClient();
  if (!sgMail) {
    console.warn('[NotificationService] SendGrid not configured – skipping email to', to);
    return;
  }

  await sgMail.send({
    to,
    from: process.env.SENDGRID_FROM_EMAIL ?? 'noreply@afridollar.com',
    subject,
    text: body,
    html: `<p>${body.replace(/\n/g, '<br/>')}</p>`,
  });
}

async function deliverSMS(to: string, message: string): Promise<void> {
  const twilioClient = await getTwilioClient();
  if (!twilioClient) {
    console.warn('[NotificationService] Twilio not configured – skipping SMS to', to);
    return;
  }

  await twilioClient.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER ?? '',
    to,
  });
}

async function deliverPush(
  subscription: PushSubscription,
  payload: Record<string, unknown>
): Promise<void> {
  const webpush = await getWebPushClient();
  if (!webpush) {
    console.warn('[NotificationService] web-push not configured – skipping push notification');
    return;
  }

  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Lazy client factories (gracefully degrade if packages are absent / not configured)
// ---------------------------------------------------------------------------

async function getEmailClient(): Promise<{ send: Function } | null> {
  try {
    if (!process.env.SENDGRID_API_KEY) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    return sgMail;
  } catch {
    return null;
  }
}

async function getTwilioClient(): Promise<{ messages: { create: Function } } | null> {
  try {
    const { accountSid, authToken } = {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
    };
    if (!accountSid || !authToken) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require('twilio');
    return twilio(accountSid, authToken);
  } catch {
    return null;
  }
}

async function getWebPushClient(): Promise<{
  sendNotification: Function;
  setVapidDetails: Function;
} | null> {
  try {
    const { subject, publicKey, privateKey } = {
      subject: process.env.VAPID_SUBJECT,
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
    if (!subject || !publicKey || !privateKey) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
  async sendEmail(
    to: string,
    template: string,
    data: Record<string, unknown>
  ): Promise<void> {
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
  async sendPush(
    subscription: PushSubscription,
    data: Record<string, unknown>
  ): Promise<void> {
    await deliverPush(subscription, data);
  },

  /**
   * High-level notify: checks user preferences and dispatches across all
   * enabled channels.
   */
  async notify(
    userId: string,
    type: NotificationType,
    data: Record<string, unknown>
  ): Promise<void> {
    const prefs = getUserPreferences(userId);

    // Determine whether to send based on notification category
    const isTransactionEvent = type === 'transaction-completed' || type === 'transaction-failed';
    const isSecurityEvent = type === 'security-alert' || type === 'kyc-approved' || type === 'kyc-rejected';

    if (isTransactionEvent && !prefs.transactionAlerts) return;
    if (isSecurityEvent && !prefs.securityAlerts) return;

    const tmpl = TEMPLATES[type];
    if (!tmpl) {
      console.warn('[NotificationService] No template for type:', type);
      return;
    }

    const body = renderTemplate(tmpl.body, data);
    const subject = tmpl.subject ? renderTemplate(tmpl.subject, data) : 'Notification';

    const channels: Array<'email' | 'sms' | 'push'> = [];
    if (prefs.email) channels.push('email');
    if (prefs.sms) channels.push('sms');
    if (prefs.push) channels.push('push');

    for (const channel of channels) {
      const notif: Notification = {
        id: generateId(),
        userId,
        type: channel,
        channel,
        template: type,
        data,
        status: 'pending',
      };
      notificationStore.push(notif);

      try {
        if (channel === 'email' && data.email) {
          await deliverEmail(String(data.email), subject, body);
          notif.status = 'sent';
          notif.sentAt = new Date();
        } else if (channel === 'sms' && data.phone) {
          await deliverSMS(String(data.phone), body);
          notif.status = 'sent';
          notif.sentAt = new Date();
        } else if (channel === 'push' && data.pushSubscription) {
          await deliverPush(
            data.pushSubscription as PushSubscription,
            { title: subject, body, type }
          );
          notif.status = 'sent';
          notif.sentAt = new Date();
        } else {
          // Recipient info not available for this channel; mark as failed
          notif.status = 'failed';
        }
      } catch (err) {
        console.error(`[NotificationService] Failed to send ${channel} notification:`, err);
        notif.status = 'failed';
      }
    }
  },

  /**
   * Update notification preferences for a user.
   */
  async updatePreferences(
    userId: string,
    preferences: Partial<NotificationPreferences>
  ): Promise<NotificationPreferences> {
    const existing = getUserPreferences(userId);
    const updated: NotificationPreferences = { ...existing, ...preferences, userId };
    preferencesStore.set(userId, updated);
    return updated;
  },

  /**
   * Get notification preferences for a user.
   */
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    return getUserPreferences(userId);
  },

  /**
   * Get all notifications for a user (delivery tracking).
   */
  async getNotifications(userId: string): Promise<Notification[]> {
    return notificationStore.filter((n) => n.userId === userId);
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

  // Expose for testing purposes
  _notificationStore: notificationStore,
  _preferencesStore: preferencesStore,
};
