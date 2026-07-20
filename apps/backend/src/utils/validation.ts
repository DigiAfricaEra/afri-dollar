import { z } from 'zod';

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
  events: z.array(z.string().min(1)).min(1, 'At least one event is required'),
  headers: z.record(z.string()).optional(),
});

export const webhookIdParamSchema = z.object({
  id: z.string().min(1, 'Webhook ID is required'),
});

export const webhookDeliveryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  cursor: z.string().optional(),
});
