/* eslint-disable */
import { lookup } from 'node:dns/promises';

import prisma from '../../config/database';
import { NotificationService } from '../../services/notification.service';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
}));

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
    },
    notification: {
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
    },
    notificationPreference: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    pushSubscription: {
      findMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

// Mock external SDKs so tests don't require real credentials
jest.mock('@sendgrid/mail', () => ({
  setApiKey: jest.fn(),
  send: jest.fn().mockResolvedValue([{ statusCode: 202 }]),
}));

jest.mock('twilio', () =>
  jest.fn(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({ sid: 'SM_TEST' }),
    },
  }))
);

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn().mockResolvedValue({}),
}));

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockNotificationCreate = prisma.notification.create as jest.Mock;
const mockNotificationUpdate = prisma.notification.update as jest.Mock;
const mockNotificationFindMany = prisma.notification.findMany as jest.Mock;
const mockNotificationCount = prisma.notification.count as jest.Mock;
const mockNotificationUpdateMany = prisma.notification.updateMany as jest.Mock;
const mockPreferenceUpsert = prisma.notificationPreference.upsert as jest.Mock;
const mockPushSubFindMany = prisma.pushSubscription.findMany as jest.Mock;
const mockPushSubUpsert = prisma.pushSubscription.upsert as jest.Mock;
const mockPushSubDeleteMany = prisma.pushSubscription.deleteMany as jest.Mock;
const mockLookup = lookup as jest.Mock;

function prefsRow(
  userId: string,
  overrides: Partial<{
    email: boolean;
    sms: boolean;
    push: boolean;
    transactionAlerts: boolean;
    securityAlerts: boolean;
    payrollAlerts: boolean;
    marketing: boolean;
  }> = {}
) {
  return {
    userId,
    email: true,
    sms: true,
    push: true,
    transactionAlerts: true,
    securityAlerts: true,
    payrollAlerts: true,
    marketing: false,
    ...overrides,
  };
}

function notifRow(
  userId: string,
  channel: string,
  type: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: `notif-${channel}-${Date.now()}`,
    userId,
    type,
    channel,
    template: type,
    data: {},
    status: 'pending',
    sentAt: null,
    readAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('NotificationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockUserFindUnique.mockResolvedValue({ email: 'user@test.com', phoneNumber: null });
    mockPreferenceUpsert.mockResolvedValue(prefsRow('default-user'));
    mockPushSubFindMany.mockResolvedValue([]);
    mockNotificationCreate.mockResolvedValue(notifRow('default-user', 'email', 'kyc-approved'));
    mockNotificationUpdate.mockResolvedValue({});
    mockNotificationFindMany.mockResolvedValue([]);
    mockNotificationCount.mockResolvedValue(0);
    mockNotificationUpdateMany.mockResolvedValue({ count: 0 });
  });

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------
  describe('getTemplates', () => {
    it('should return all built-in templates', () => {
      const templates = NotificationService.getTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(6);
      const ids = templates.map((t) => t.id);
      expect(ids).toContain('transaction-completed');
      expect(ids).toContain('transaction-failed');
      expect(ids).toContain('kyc-approved');
      expect(ids).toContain('kyc-rejected');
      expect(ids).toContain('security-alert');
      expect(ids).toContain('payroll-processed');
    });
  });

  describe('getTemplate', () => {
    it('should return a specific template by id', () => {
      const tmpl = NotificationService.getTemplate('transaction-completed');
      expect(tmpl).toBeDefined();
      expect(tmpl!.id).toBe('transaction-completed');
      expect(tmpl!.variables).toContain('amount');
    });

    it('should return undefined for unknown template', () => {
      expect(NotificationService.getTemplate('does-not-exist')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // sendEmail
  // -------------------------------------------------------------------------
  describe('sendEmail', () => {
    it('should throw for an unknown template', async () => {
      await expect(
        NotificationService.sendEmail('user@test.com', 'unknown-template', {})
      ).rejects.toThrow('Unknown template: unknown-template');
    });

    it('should call deliverEmail without throwing when SENDGRID_API_KEY is absent', async () => {
      delete process.env.SENDGRID_API_KEY;
      // Should resolve without throwing (graceful degradation)
      await expect(
        NotificationService.sendEmail('user@test.com', 'transaction-completed', {
          amount: '100',
          currency: 'USD',
          transactionId: 'tx-1',
        })
      ).resolves.toBeUndefined();
    });

    it('should send email when SENDGRID_API_KEY is set', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      process.env.SENDGRID_FROM_EMAIL = 'noreply@test.com';

      const sgMail = require('@sendgrid/mail');

      await NotificationService.sendEmail('user@test.com', 'kyc-approved', {
        firstName: 'Alice',
      });

      expect(sgMail.setApiKey).toHaveBeenCalledWith('SG.test-key');
      expect(sgMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@test.com',
          subject: 'KYC Verification Approved',
        })
      );

      delete process.env.SENDGRID_API_KEY;
    });

    it('should HTML escape variable values in HTML email body while preserving raw text in text body', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      const sgMail = require('@sendgrid/mail');

      await NotificationService.sendEmail('user@test.com', 'kyc-approved', {
        firstName: '<script>alert("xss")</script>',
      });

      expect(sgMail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('<script>alert("xss")</script>'),
          html: expect.stringContaining('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'),
        })
      );

      delete process.env.SENDGRID_API_KEY;
    });
  });

  // -------------------------------------------------------------------------
  // sendSMS
  // -------------------------------------------------------------------------
  describe('sendSMS', () => {
    it('should gracefully skip when Twilio env vars are absent', async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE_NUMBER;
      await expect(
        NotificationService.sendSMS('+1234567890', 'Hello World')
      ).resolves.toBeUndefined();
    });

    it('should send SMS when Twilio is configured', async () => {
      process.env.TWILIO_ACCOUNT_SID = 'AC_TEST';
      process.env.TWILIO_AUTH_TOKEN = 'AUTH_TEST';
      process.env.TWILIO_PHONE_NUMBER = '+15550000000';

      const twilio = require('twilio');
      const mockClientInstance = {
        messages: { create: jest.fn().mockResolvedValue({ sid: 'SM_TEST' }) },
      };
      twilio.mockReturnValue(mockClientInstance);

      await NotificationService.sendSMS('+19998887777', 'Test message');

      expect(mockClientInstance.messages.create).toHaveBeenCalledWith(
        expect.objectContaining({
          body: 'Test message',
          to: '+19998887777',
        })
      );

      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE_NUMBER;
    });
  });

  // -------------------------------------------------------------------------
  // sendPush
  // -------------------------------------------------------------------------
  describe('sendPush', () => {
    const mockSubscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    };

    it('should gracefully skip when VAPID keys are absent', async () => {
      delete process.env.VAPID_SUBJECT;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
      await expect(
        NotificationService.sendPush(mockSubscription, { title: 'Test' })
      ).resolves.toBeUndefined();
    });

    it('should send push notification when VAPID is configured', async () => {
      process.env.VAPID_SUBJECT = 'mailto:test@test.com';
      process.env.VAPID_PUBLIC_KEY = 'public-key';
      process.env.VAPID_PRIVATE_KEY = 'private-key';

      const webpush = require('web-push');

      await NotificationService.sendPush(mockSubscription, { title: 'Alert', body: 'Test' });

      expect(webpush.setVapidDetails).toHaveBeenCalledWith(
        'mailto:test@test.com',
        'public-key',
        'private-key'
      );
      expect(webpush.sendNotification).toHaveBeenCalledWith(mockSubscription, expect.any(String));

      delete process.env.VAPID_SUBJECT;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;
    });
  });

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------
  describe('getPreferences', () => {
    it('should return default preferences and persist them for a new user', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-new'));

      const prefs = await NotificationService.getPreferences('user-new');

      expect(mockPreferenceUpsert).toHaveBeenCalledWith({
        where: { userId: 'user-new' },
        update: {},
        create: { userId: 'user-new' },
      });
      expect(prefs.userId).toBe('user-new');
      expect(prefs.email).toBe(true);
      expect(prefs.sms).toBe(true);
      expect(prefs.push).toBe(true);
      expect(prefs.transactionAlerts).toBe(true);
      expect(prefs.securityAlerts).toBe(true);
      expect(prefs.payrollAlerts).toBe(true);
      expect(prefs.marketing).toBe(false);
    });

    it('should return existing preferences without creating new ones', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-existing', { email: false }));

      const prefs = await NotificationService.getPreferences('user-existing');

      expect(mockPreferenceUpsert).toHaveBeenCalledWith({
        where: { userId: 'user-existing' },
        update: {},
        create: { userId: 'user-existing' },
      });
      expect(prefs.email).toBe(false);
    });

    it('should handle concurrent first access without a unique-key failure', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-concurrent'));

      const [first, second] = await Promise.all([
        NotificationService.getPreferences('user-concurrent'),
        NotificationService.getPreferences('user-concurrent'),
      ]);

      expect(first.userId).toBe('user-concurrent');
      expect(second.userId).toBe('user-concurrent');
      expect(mockPreferenceUpsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('updatePreferences', () => {
    it('should update notification preferences via upsert', async () => {
      mockPreferenceUpsert.mockResolvedValue(
        prefsRow('user-1', { email: false, payrollAlerts: false, marketing: true })
      );

      const updated = await NotificationService.updatePreferences('user-1', {
        email: false,
        payrollAlerts: false,
        marketing: true,
      });

      expect(mockPreferenceUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          update: expect.objectContaining({ email: false, payrollAlerts: false, marketing: true }),
          create: expect.objectContaining({ userId: 'user-1' }),
        })
      );
      expect(updated.email).toBe(false);
      expect(updated.payrollAlerts).toBe(false);
      expect(updated.marketing).toBe(true);
      expect(updated.sms).toBe(true); // unchanged default
    });

    it('should persist updated preferences', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-2', { push: false }));

      await NotificationService.updatePreferences('user-2', { push: false });
      const prefs = await NotificationService.getPreferences('user-2');
      expect(prefs.push).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // notify
  // -------------------------------------------------------------------------
  describe('notify', () => {
    it('should persist a notification row per enabled channel', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      process.env.SENDGRID_FROM_EMAIL = 'noreply@test.com';
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-100', { sms: false, push: false }));

      await NotificationService.notify('user-100', 'kyc-approved', {
        email: 'alice@test.com',
        firstName: 'Alice',
      });

      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
      expect(mockNotificationCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-100',
            type: 'kyc-approved',
            channel: 'email',
            template: 'kyc-approved',
            status: 'pending',
          }),
        })
      );
      // Delivered row updated to sent
      expect(mockNotificationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'sent' }),
        })
      );

      delete process.env.SENDGRID_API_KEY;
    });

    it('should mark notification as failed when the provider is not configured', async () => {
      delete process.env.SENDGRID_API_KEY;
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-800', { sms: false, push: false }));

      await NotificationService.notify('user-800', 'kyc-approved', {
        email: 'provider-absent@test.com',
        firstName: 'Alice',
      });

      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
      expect(mockNotificationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        })
      );
    });

    it('should not send transaction alerts when disabled in preferences', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-200', { transactionAlerts: false }));

      await NotificationService.notify('user-200', 'transaction-completed', {
        amount: '50',
        currency: 'USD',
        transactionId: 'tx-abc',
        email: 'bob@test.com',
      });

      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it('should not send security alerts when disabled in preferences', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-300', { securityAlerts: false }));

      await NotificationService.notify('user-300', 'security-alert', {
        activity: 'login from new device',
        email: 'carol@test.com',
      });

      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it('should not send payroll alerts when disabled in preferences', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-350', { payrollAlerts: false }));

      await NotificationService.notify('user-350', 'payroll-processed', {
        batchName: 'July Salary',
        count: '10',
        total: '5000',
        currency: 'USD',
        email: 'payroll@test.com',
      });

      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it('should not persist anything when all channels are disabled', async () => {
      mockPreferenceUpsert.mockResolvedValue(
        prefsRow('user-400', { email: false, sms: false, push: false })
      );

      await NotificationService.notify('user-400', 'transaction-completed', {
        amount: '20',
        currency: 'USD',
        transactionId: 'tx-xyz',
        email: 'dave@test.com',
      });

      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it('should mark notification as failed when recipient info is missing', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-500', { sms: false, push: false }));
      mockUserFindUnique.mockResolvedValue({ email: null, phoneNumber: null });

      await NotificationService.notify('user-500', 'kyc-approved', { firstName: 'Eve' });

      expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
      expect(mockNotificationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed' }),
        })
      );
    });

    it('should fall back to the stored user email/phone when not provided', async () => {
      mockPreferenceUpsert.mockResolvedValue(prefsRow('user-700', { sms: true, push: false }));
      mockUserFindUnique.mockResolvedValue({
        email: 'stored@test.com',
        phoneNumber: '+1111111111',
      });

      await NotificationService.notify('user-700', 'security-alert', { activity: 'new login' });

      expect(mockNotificationCreate).toHaveBeenCalledTimes(2); // email + sms
    });

    it('should return early for an unknown notification type', async () => {
      await expect(
        NotificationService.notify('user-600', 'unknown-type' as any, {})
      ).resolves.toBeUndefined();
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getNotifications (pagination + unread filter)
  // -------------------------------------------------------------------------
  describe('getNotifications', () => {
    it('should return empty list for user with no notifications', async () => {
      mockNotificationFindMany.mockResolvedValue([]);
      mockNotificationCount.mockResolvedValue(0);

      const result = await NotificationService.getNotifications('user-no-notifs');

      expect(result.notifications).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should paginate and filter unread notifications', async () => {
      mockNotificationFindMany.mockResolvedValue([
        notifRow('user-1', 'email', 'kyc-approved', { status: 'sent' }),
      ]);
      mockNotificationCount.mockResolvedValue(1);

      const result = await NotificationService.getNotifications('user-1', {
        page: 2,
        limit: 10,
        unreadOnly: true,
      });

      expect(mockNotificationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1', readAt: null },
          skip: 10,
          take: 10,
        })
      );
      expect(result.notifications).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.hasMore).toBe(false);
    });

    it('should clamp out-of-range page and limit values defensively', async () => {
      mockNotificationFindMany.mockResolvedValue([]);
      mockNotificationCount.mockResolvedValue(0);

      const result = await NotificationService.getNotifications('user-clamp', {
        page: -5,
        limit: 999999,
      });

      expect(mockNotificationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 100 })
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(100);
    });

    it('should fall back to defaults for non-numeric or fractional page/limit', async () => {
      mockNotificationFindMany.mockResolvedValue([]);
      mockNotificationCount.mockResolvedValue(0);

      const result = await NotificationService.getNotifications('user-nan', {
        page: NaN,
        limit: 1.5,
      });

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // markRead
  // -------------------------------------------------------------------------
  describe('markRead', () => {
    it('should mark the given notification ids as read for the user', async () => {
      mockNotificationUpdateMany.mockResolvedValue({ count: 2 });

      const count = await NotificationService.markRead('user-1', ['n1', 'n2']);

      expect(mockNotificationUpdateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', id: { in: ['n1', 'n2'] } },
        data: expect.objectContaining({ readAt: expect.any(Date) }),
      });
      expect(count).toBe(2);
    });

    it('should return 0 for an empty id list', async () => {
      const count = await NotificationService.markRead('user-1', []);
      expect(count).toBe(0);
      expect(mockNotificationUpdateMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Push subscriptions
  // -------------------------------------------------------------------------
  describe('push subscriptions', () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      userAgent: 'Chrome/120',
    };

    it('should register a push subscription via upsert', async () => {
      mockPushSubUpsert.mockResolvedValue({});

      await NotificationService.registerPushSubscription('user-1', subscription);

      expect(mockPushSubUpsert).toHaveBeenCalledWith({
        where: { userId_endpoint: { userId: 'user-1', endpoint: subscription.endpoint } },
        update: expect.objectContaining({ p256dh: 'p256dh-key', auth: 'auth-key' }),
        create: expect.objectContaining({ userId: 'user-1', endpoint: subscription.endpoint }),
      });
    });

    it('should throw for an invalid push subscription', async () => {
      await expect(
        NotificationService.registerPushSubscription('user-1', {
          endpoint: '',
          keys: { p256dh: '', auth: '' },
        } as any)
      ).rejects.toThrow('Invalid push subscription');
      expect(mockPushSubUpsert).not.toHaveBeenCalled();
    });

    it('should reject a push subscription with a non-public endpoint', async () => {
      await expect(
        NotificationService.registerPushSubscription('user-1', {
          endpoint: 'https://10.0.0.1/send',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        })
      ).rejects.toThrow('Invalid push subscription');
      expect(mockPushSubUpsert).not.toHaveBeenCalled();
    });

    it('should reject a push subscription that is not HTTPS', async () => {
      await expect(
        NotificationService.registerPushSubscription('user-1', {
          endpoint: 'http://fcm.googleapis.com/send',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        })
      ).rejects.toThrow('Invalid push subscription');
      expect(mockPushSubUpsert).not.toHaveBeenCalled();
    });

    it('should reject a push subscription whose hostname resolves to a private address', async () => {
      mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

      await expect(
        NotificationService.registerPushSubscription('user-1', {
          endpoint: 'https://internal.push.test/send',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        })
      ).rejects.toThrow('Invalid push subscription');
      expect(mockPushSubUpsert).not.toHaveBeenCalled();
    });

    it('should delete a push subscription owned by the user', async () => {
      mockPushSubDeleteMany.mockResolvedValue({ count: 1 });
      const deleted = await NotificationService.deletePushSubscription('user-1', 'sub-1');
      expect(deleted).toBe(true);
      expect(mockPushSubDeleteMany).toHaveBeenCalledWith({
        where: { id: 'sub-1', userId: 'user-1' },
      });
    });

    it('should return false when deleting a subscription not owned by the user', async () => {
      mockPushSubDeleteMany.mockResolvedValue({ count: 0 });
      const deleted = await NotificationService.deletePushSubscription('user-1', 'sub-1');
      expect(deleted).toBe(false);
    });

    it('should list push subscriptions in web-push shape', async () => {
      mockPushSubFindMany.mockResolvedValue([
        {
          id: 'sub-1',
          userId: 'user-1',
          endpoint: 'https://fcm.googleapis.com/fcm/send/test',
          p256dh: 'p256dh-key',
          auth: 'auth-key',
          userAgent: 'Chrome/120',
        },
      ]);

      const subs = await NotificationService.getPushSubscriptions('user-1');

      expect(subs).toEqual([
        {
          id: 'sub-1',
          endpoint: 'https://fcm.googleapis.com/fcm/send/test',
          keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
          userAgent: 'Chrome/120',
        },
      ]);
    });
  });
});
