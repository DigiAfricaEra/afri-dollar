import { z } from 'zod';

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
