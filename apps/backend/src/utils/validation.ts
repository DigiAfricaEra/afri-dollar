import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { WEBHOOK_EVENTS } from '../types/webhook.types';

/** Parse query-string booleans safely (`"false"` must not become `true`). */
export const queryBooleanSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const registerSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phoneNumber: z.string().optional(),
});

export const createWalletSchema = z.object({
  walletType: z.enum(['business', 'treasury', 'payroll']),
  network: z.enum(['testnet', 'mainnet']).optional().default('testnet'),
});

export const createPaymentSchema = z.object({
  toAddress: z.string().length(56, 'Invalid Stellar address'),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount format'),
  assetCode: z.string().min(1).max(12),
  assetIssuer: z.string().length(56).optional(),
  memo: z.string().max(28).optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const createBatchSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  walletId: z.string().min(1, 'Wallet ID is required'),
});

export const addItemSchema = z.object({
  recipientAddress: z.string().min(1, 'Recipient address is required'),
  amount: z.string().min(1, 'Amount is required'),
  assetCode: z.string().min(1, 'Asset code is required'),
  assetIssuer: z.string().optional(),
  memo: z.string().optional(),
});

export const batchIdParamSchema = z.object({
  id: z.string().min(1, 'Batch ID is required'),
});

export const createCrossBorderPaymentSchema = z.object({
  sourceWalletId: z.string().min(1, 'Source wallet ID is required'),
  destinationAddress: z.string().length(56, 'Invalid Stellar address'),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Invalid amount format'),
  assetCode: z.string().min(1).max(12),
  assetIssuer: z.string().length(56).optional(),
  memo: z.string().max(28).optional(),
  purpose: z.string().min(1, 'Payment purpose is required'),
  beneficiaryInfo: z
    .object({
      name: z.string().min(1, 'Beneficiary name is required'),
      country: z.string().regex(/^[A-Z]{2,3}$/, 'Country must be a 2 or 3 letter ISO code'),
    })
    .optional(),
});

export const paymentIdParamSchema = z.object({
  id: z.string().min(1, 'Payment ID is required'),
});

/** Valid Stellar ed25519 public key (G... address). */
const stellarAddressSchema = z.string().refine((val) => StrKey.isValidEd25519PublicKey(val), {
  message: 'Invalid Stellar address',
});

/** Stellar-compatible amount: up to 7 decimal places (stroop precision). */
export const stellarAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, 'Invalid amount format: up to 7 decimal places allowed');

/** Stellar MEMO_TEXT is limited to 28 bytes, not 28 characters. */
export const stellarMemoSchema = z.string().refine((val) => Buffer.byteLength(val, 'utf8') <= 28, {
  message: 'Memo must be at most 28 bytes',
});

export const createInstantPaymentSchema = z.object({
  sourceWalletId: z.string().min(1, 'Source wallet ID is required'),
  destination: stellarAddressSchema,
  amount: stellarAmountSchema,
  assetCode: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z0-9]+$/, 'Invalid asset code'),
  assetIssuer: stellarAddressSchema.optional(),
  memo: stellarMemoSchema.optional(),
});

/**
 * Accepts both the instant-payment body (`destination`) and the legacy
 * cross-border body (`destinationAddress` + `purpose`) on POST /payments.
 */
export const createUnifiedPaymentSchema = z.union([
  createInstantPaymentSchema,
  createCrossBorderPaymentSchema,
]);

export const transactionStatusFilter = z.enum([
  'created',
  'pending',
  'submitted',
  'processing',
  'successful',
  'completed',
  'failed',
  'cancelled',
]);

const dateRangeFields = {
  startDate: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'startDate must be a valid date string',
    })
    .optional(),
  endDate: z
    .string()
    .refine((val) => !isNaN(Date.parse(val)), {
      message: 'endDate must be a valid date string',
    })
    .optional(),
};

const dateRangeRefinement = {
  message: 'startDate must be less than or equal to endDate',
  path: ['startDate'] as [string],
};

function datesAreOrdered(startDate?: string, endDate?: string): boolean {
  if (startDate == null || endDate == null) return true;
  return new Date(startDate) <= new Date(endDate);
}

export const listPaymentsQuerySchema = z
  .object({
    status: transactionStatusFilter.optional(),
    walletId: z.string().min(1).optional(),
    ...dateRangeFields,
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .refine(({ startDate, endDate }) => datesAreOrdered(startDate, endDate), dateRangeRefinement);

export const adminBatchPayoutSchema = z.object({
  sourceWalletId: z.string().min(1, 'Source wallet ID is required').optional(),
  payouts: z
    .array(
      z.object({
        destination: stellarAddressSchema,
        amount: stellarAmountSchema,
        assetCode: z
          .string()
          .min(1)
          .max(12)
          .regex(/^[A-Za-z0-9]+$/, 'Invalid asset code'),
        assetIssuer: stellarAddressSchema.optional(),
        memo: stellarMemoSchema.optional(),
        reference: z.string().max(64).optional(),
      })
    )
    .min(1, 'At least one payout is required')
    .max(100, 'Maximum 100 payouts per batch'),
});

const reportParametersSchema = z
  .object({
    startDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), {
        message: 'startDate must be a valid date string',
      })
      .optional(),
    endDate: z
      .string()
      .refine((val) => !isNaN(Date.parse(val)), {
        message: 'endDate must be a valid date string',
      })
      .optional(),
    assetCode: z.string().optional(),
    status: z.string().optional(),
  })
  .refine(
    ({ startDate, endDate }) => {
      if (startDate == null || endDate == null) return true;
      return new Date(startDate) <= new Date(endDate);
    },
    {
      message: 'startDate must be less than or equal to endDate',
      path: ['startDate'],
    }
  )
  .optional();

export const generateReportSchema = z.object({
  reportType: z.enum([
    'transaction-history',
    'compliance-report',
    'financial-statement',
    'payroll-report',
    'treasury-report',
    'audit-log',
  ]),
  format: z.enum(['csv', 'pdf', 'xlsx']),
  parameters: reportParametersSchema,
});

export const generateAdminReportSchema = z.object({
  reportType: z.enum([
    'transaction-history',
    'compliance-report',
    'financial-statement',
    'payroll-report',
    'treasury-report',
    'audit-log',
  ]),
  format: z.enum(['csv', 'pdf', 'xlsx']),
  targetUserId: z.string().optional(),
  parameters: reportParametersSchema,
});

export const reportIdParamSchema = z.object({
  id: z.string().min(1, 'Report ID is required'),
});

function isValidCronExpression(val: string): boolean {
  const parts = val.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const patterns = [
    /^(\*|[0-5]?\d)$/,
    /^(\*|[01]?\d|2[0-3])$/,
    /^(\*|[12]?\d|3[01])$/,
    /^(\*|1[012]|[1-9])$/,
    /^(\*|[0-6])$/,
  ];
  return parts.every((part, i) => patterns[i].test(part));
}

export const createReportTemplateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  reportType: z.enum([
    'transaction-history',
    'compliance-report',
    'financial-statement',
    'payroll-report',
    'treasury-report',
    'audit-log',
  ]),
  format: z.enum(['csv', 'pdf', 'xlsx']),
  query: z.string().optional(),
  schedule: z
    .string()
    .optional()
    .refine((val) => val === undefined || isValidCronExpression(val), {
      message:
        'Invalid cron expression. Must be 5-field cron syntax (minute hour day-of-month month day-of-week)',
    }),
});

export const updateReportTemplateSchema = createReportTemplateSchema.partial();

export const reportTemplateIdParamSchema = z.object({
  templateId: z.string().min(1, 'Template ID is required'),
});

export const createWebhookSchema = z.object({
  url: z.string().url('Invalid webhook URL'),
  events: z
    .array(z.enum(WEBHOOK_EVENTS as [string, ...string[]]))
    .min(1, 'At least one event is required'),
  headers: z.record(z.string()).optional(),
});

export const webhookIdParamSchema = z.object({
  id: z.string().min(1, 'Webhook ID is required'),
});

export const webhookDeliveryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});
