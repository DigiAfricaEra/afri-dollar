/* eslint-disable */
import { NotificationService } from '../../services/notification.service';

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

describe('NotificationService', () => {
  beforeEach(() => {
    // Clear in-memory stores between tests
    NotificationService._notificationStore.length = 0;
    NotificationService._preferencesStore.clear();
    jest.clearAllMocks();
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
    it('should return default preferences for a new user', async () => {
      const prefs = await NotificationService.getPreferences('user-new');
      expect(prefs.userId).toBe('user-new');
      expect(prefs.email).toBe(true);
      expect(prefs.sms).toBe(true);
      expect(prefs.push).toBe(true);
      expect(prefs.transactionAlerts).toBe(true);
      expect(prefs.securityAlerts).toBe(true);
      expect(prefs.payrollAlerts).toBe(true);
      expect(prefs.marketing).toBe(false);
    });
  });

  describe('updatePreferences', () => {
    it('should update notification preferences', async () => {
      const updated = await NotificationService.updatePreferences('user-1', {
        email: false,
        payrollAlerts: false,
        marketing: true,
      });
      expect(updated.email).toBe(false);
      expect(updated.payrollAlerts).toBe(false);
      expect(updated.marketing).toBe(true);
      expect(updated.sms).toBe(true); // unchanged default
    });

    it('should persist updated preferences', async () => {
      await NotificationService.updatePreferences('user-2', { push: false });
      const prefs = await NotificationService.getPreferences('user-2');
      expect(prefs.push).toBe(false);
    });

    it('should always keep the userId field correct', async () => {
      const updated = await NotificationService.updatePreferences('user-3', { sms: false });
      expect(updated.userId).toBe('user-3');
    });
  });

  // -------------------------------------------------------------------------
  // notify
  // -------------------------------------------------------------------------
  describe('notify', () => {
    it('should record a notification in the store', async () => {
      await NotificationService.notify('user-100', 'kyc-approved', {
        email: 'alice@test.com',
        firstName: 'Alice',
      });
      const notifs = await NotificationService.getNotifications('user-100');
      expect(notifs.length).toBeGreaterThan(0);
      expect(notifs[0].userId).toBe('user-100');
      expect(notifs[0].template).toBe('kyc-approved');
    });

    it('should not send transaction alerts when disabled in preferences', async () => {
      await NotificationService.updatePreferences('user-200', { transactionAlerts: false });
      await NotificationService.notify('user-200', 'transaction-completed', {
        amount: '50',
        currency: 'USD',
        transactionId: 'tx-abc',
        email: 'bob@test.com',
      });
      const notifs = await NotificationService.getNotifications('user-200');
      expect(notifs).toHaveLength(0);
    });

    it('should not send security alerts when disabled in preferences', async () => {
      await NotificationService.updatePreferences('user-300', { securityAlerts: false });
      await NotificationService.notify('user-300', 'security-alert', {
        activity: 'login from new device',
        email: 'carol@test.com',
      });
      const notifs = await NotificationService.getNotifications('user-300');
      expect(notifs).toHaveLength(0);
    });

    it('should not send payroll alerts when disabled in preferences', async () => {
      await NotificationService.updatePreferences('user-350', { payrollAlerts: false });
      await NotificationService.notify('user-350', 'payroll-processed', {
        batchName: 'July Salary',
        count: '10',
        total: '5000',
        currency: 'USD',
        email: 'payroll@test.com',
      });
      const notifs = await NotificationService.getNotifications('user-350');
      expect(notifs).toHaveLength(0);
    });

    it('should not send email notifications when email is disabled', async () => {
      process.env.SENDGRID_API_KEY = 'SG.test-key';
      await NotificationService.updatePreferences('user-400', {
        email: false,
        sms: false,
        push: false,
      });
      await NotificationService.notify('user-400', 'transaction-completed', {
        amount: '20',
        currency: 'USD',
        transactionId: 'tx-xyz',
        email: 'dave@test.com',
      });
      const notifs = await NotificationService.getNotifications('user-400');
      expect(notifs).toHaveLength(0);
      delete process.env.SENDGRID_API_KEY;
    });

    it('should mark notification as failed when recipient info is missing', async () => {
      await NotificationService.updatePreferences('user-500', { sms: false, push: false });
      // No email key in data -> channel will fail
      await NotificationService.notify('user-500', 'kyc-approved', { firstName: 'Eve' });
      const notifs = await NotificationService.getNotifications('user-500');
      expect(notifs.some((n) => n.status === 'failed')).toBe(true);
    });

    it('should return early for an unknown notification type', async () => {
      // Cast to bypass TS type check for test
      await expect(
        NotificationService.notify('user-600', 'unknown-type' as any, {})
      ).resolves.toBeUndefined();
      const notifs = await NotificationService.getNotifications('user-600');
      expect(notifs).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getNotifications (delivery tracking)
  // -------------------------------------------------------------------------
  describe('getNotifications', () => {
    it('should return empty array for user with no notifications', async () => {
      const notifs = await NotificationService.getNotifications('user-no-notifs');
      expect(notifs).toEqual([]);
    });

    it('should only return notifications for the specified user', async () => {
      await NotificationService.notify('user-A', 'kyc-approved', {
        email: 'a@test.com',
        firstName: 'A',
      });
      await NotificationService.notify('user-B', 'kyc-approved', {
        email: 'b@test.com',
        firstName: 'B',
      });

      const notifsA = await NotificationService.getNotifications('user-A');
      expect(notifsA.every((n) => n.userId === 'user-A')).toBe(true);
    });
  });
});
