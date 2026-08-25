import { createHmac, timingSafeEqual } from 'crypto';

import type { CookieOptions } from 'express';

import { getSepConfig } from '../config/sep.config';
import { AppError } from '../types';
import { SEP24_STATE_COOKIE } from '../types/sep.types';

interface Sep24StatePayload {
  sessionId: string;
  clientAccount: string;
  exp: number;
}

export function getSep24CookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

export function signSep24State(sessionId: string, clientAccount: string, exp: number): string {
  const payload = `${sessionId}.${clientAccount}.${exp}`;
  const digest = createHmac('sha256', getSepConfig().stateHmacSecret).update(payload).digest('hex');
  return `${payload}.${digest}`;
}

export function verifySep24State(cookieValue: string): Sep24StatePayload {
  const lastDot = cookieValue.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new AppError(401, 'Invalid interactive session cookie');
  }

  const payload = cookieValue.slice(0, lastDot);
  const digest = cookieValue.slice(lastDot + 1);
  const expected = createHmac('sha256', getSepConfig().stateHmacSecret)
    .update(payload)
    .digest('hex');

  const digestBuffer = Buffer.from(digest, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    digestBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(digestBuffer, expectedBuffer)
  ) {
    throw new AppError(401, 'Invalid interactive session cookie');
  }

  const [sessionId, clientAccount, expRaw] = payload.split('.');
  const exp = Number(expRaw);
  if (!sessionId || !clientAccount || !Number.isFinite(exp)) {
    throw new AppError(401, 'Invalid interactive session cookie');
  }

  if (exp * 1000 < Date.now()) {
    throw new AppError(401, 'Interactive session cookie expired');
  }

  return { sessionId, clientAccount, exp };
}

export function parseCookieHeader(
  header: string | undefined,
  name = SEP24_STATE_COOKIE
): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }

  return undefined;
}
