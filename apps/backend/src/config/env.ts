// ──────────────────────────────────────────────────────────────────────────────
// Centralised environment configuration
// All env vars are read once at import time. Defaults keep KYC gating OFF so
// the feature can be rolled out safely — payments below $1,000 still work
// without KYC when the thresholds are unset.
// ──────────────────────────────────────────────────────────────────────────────

export const env = {
  // ── Sumsub KYC Provider ────────────────────────────────────────────────────
  SUMSUB_API_KEY: process.env.SUMSUB_API_KEY ?? '',
  SUMSUB_SECRET_KEY: process.env.SUMSUB_SECRET_KEY ?? '',
  SUMSUB_BASE_URL: process.env.SUMSUB_BASE_URL ?? 'https://api.sumsub.com',

  // ── KYC / AML Thresholds ──────────────────────────────────────────────────
  // Payments >= KYC_REQUIRED_THRESHOLD_USD require approved KYC level 2.
  // Unset / 0 = gating disabled (safe default for rollout).
  KYC_REQUIRED_THRESHOLD_USD: parseFloat(process.env.KYC_REQUIRED_THRESHOLD_USD ?? '0'),

  // Payments >= AML_THRESHOLD_USD trigger an AML check.
  // Unset / 0 = AML gating disabled.
  AML_THRESHOLD_USD: parseFloat(process.env.AML_THRESHOLD_USD ?? '0'),

  // ── General ────────────────────────────────────────────────────────────────
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '',
  JWT_SECRET: process.env.JWT_SECRET ?? '',
} as const;

export type Env = typeof env;
