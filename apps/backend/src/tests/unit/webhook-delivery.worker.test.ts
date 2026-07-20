/* eslint-disable */
import prisma from '../../config/database';
import { WebhookService } from '../../services/webhook.service';

jest.mock('../../config/database', () => {
  const client = {
    webhookConfig: {
      findUnique: jest.fn(),
    },
    webhookDelivery: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  return { __esModule: true, default: client };
});

jest.mock('../../utils/webhook', () => ({
  generateWebhookSecret: jest.fn(() => 'test-secret'),
  signWebhookPayload: jest.fn(() => 'sha256=test-signature'),
  verifyWebhookSignature: jest.fn(() => true),
}));

jest.mock('../../utils/crypto', () => ({
  encrypt: jest.fn((val: string) => `encrypted:${val}`),
  decrypt: jest.fn((val: string) => val.replace('encrypted:', '')),
}));

const mockWebhookDeliveryFindUnique = prisma.webhookDelivery.findUnique as jest.Mock;
const mockWebhookDeliveryUpdate = prisma.webhookDelivery.update as jest.Mock;

describe('WebhookService.processDelivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should mark delivery as delivered on 200 response', async () => {
    const mockDelivery = {
      id: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: { txId: 'tx-1' },
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 5,
    };
    mockWebhookDeliveryFindUnique.mockResolvedValue(mockDelivery);
    mockWebhookDeliveryUpdate.mockResolvedValue(mockDelivery);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('OK'),
    });

    await WebhookService.processDelivery({
      deliveryId: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: { txId: 'tx-1' },
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: 'delivered' }),
      })
    );

    jest.restoreAllMocks();
  });

  it('should mark delivery as failed on max retries exceeded', async () => {
    const mockDelivery = {
      id: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      status: 'retrying',
      attemptCount: 5,
      maxAttempts: 5,
    };
    mockWebhookDeliveryFindUnique.mockResolvedValue(mockDelivery);
    mockWebhookDeliveryUpdate.mockResolvedValue(mockDelivery);

    await WebhookService.processDelivery({
      deliveryId: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: 'failed' }),
      })
    );
  });

  it('should skip if delivery already delivered', async () => {
    const mockDelivery = {
      id: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      status: 'delivered',
      attemptCount: 1,
      maxAttempts: 5,
    };
    mockWebhookDeliveryFindUnique.mockResolvedValue(mockDelivery);

    await WebhookService.processDelivery({
      deliveryId: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).not.toHaveBeenCalled();
  });

  it('should skip if delivery not found', async () => {
    mockWebhookDeliveryFindUnique.mockResolvedValue(null);

    await WebhookService.processDelivery({
      deliveryId: 'del-nonexistent',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).not.toHaveBeenCalled();
  });

  it('should mark as failed on network error after max retries', async () => {
    const mockDelivery = {
      id: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      status: 'retrying',
      attemptCount: 4,
      maxAttempts: 5,
    };
    mockWebhookDeliveryFindUnique.mockResolvedValue(mockDelivery);
    mockWebhookDeliveryUpdate.mockResolvedValue(mockDelivery);

    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    await WebhookService.processDelivery({
      deliveryId: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: 'failed', error: 'Network error' }),
      })
    );

    jest.restoreAllMocks();
  });

  it('should schedule retry on 500 error', async () => {
    const mockDelivery = {
      id: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      status: 'retrying',
      attemptCount: 1,
      maxAttempts: 5,
    };
    mockWebhookDeliveryFindUnique.mockResolvedValue(mockDelivery);
    mockWebhookDeliveryUpdate.mockResolvedValue(mockDelivery);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue('Server Error'),
    });

    await WebhookService.processDelivery({
      deliveryId: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: 'retrying' }),
      })
    );

    jest.restoreAllMocks();
  });

  it('should mark as failed on 400 error (non-retryable)', async () => {
    const mockDelivery = {
      id: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      status: 'retrying',
      attemptCount: 1,
      maxAttempts: 5,
    };
    mockWebhookDeliveryFindUnique.mockResolvedValue(mockDelivery);
    mockWebhookDeliveryUpdate.mockResolvedValue(mockDelivery);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('Bad Request'),
    });

    await WebhookService.processDelivery({
      deliveryId: 'del-1',
      webhookId: 'wh-1',
      eventType: 'transaction.completed',
      payload: {},
      url: 'https://example.com/hook',
      secret: 'encrypted:secret123',
    });

    expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: 'failed' }),
      })
    );

    jest.restoreAllMocks();
  });
});
