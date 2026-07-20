import crypto from 'crypto';

const WEBHOOK_SECRET_LENGTH = 32;

export function generateWebhookSecret(): string {
  return crypto.randomBytes(WEBHOOK_SECRET_LENGTH).toString('hex');
}

export function signWebhookPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = signWebhookPayload(payload, secret);
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
