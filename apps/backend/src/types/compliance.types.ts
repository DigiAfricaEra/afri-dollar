// ──────────────────────────────────────────────────────────────────────────────
// Compliance & KYC Type Definitions
// ──────────────────────────────────────────────────────────────────────────────

/** KYC verification levels — matches the Prisma enum. */
export type KYCLevel = 'BASIC' | 'STANDARD' | 'ENHANCED';

/** Accepted document types for KYC submission. */
export type KYCDocumentType =
  'passport' | 'national_id' | 'drivers_license' | 'utility_bill' | 'bank_statement' | 'selfie';

// ── KYC Submission ──────────────────────────────────────────────────────────

export interface SubmitKYCOptions {
  userId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string; // ISO 8601 date string
  nationality: string;
  documentType: KYCDocumentType;
  documentNumber: string;
  /** Base64-encoded document image (not persisted / logged — forwarded to provider only). */
  documentImageBase64?: string;
  /** Base64-encoded selfie image (not persisted / logged — forwarded to provider only). */
  selfieImageBase64?: string;
  address?: {
    street: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
  /** Target KYC level to apply for. Defaults to BASIC. */
  level?: KYCLevel;
}

// ── KYC Status ──────────────────────────────────────────────────────────────

export interface KYCStatusResponse {
  userId: string;
  kycRecordId: string;
  level: KYCLevel;
  status: 'pending' | 'approved' | 'rejected' | 'review';
  provider: string;
  rejectionCode?: string;
  documentsUploaded: boolean;
  submittedAt: Date;
  reviewedAt?: Date;
}

// ── AML Check ───────────────────────────────────────────────────────────────

export type AMLScreeningType = 'sanctions' | 'pep' | 'adverse_media' | 'combined';

export interface AMLCheckInput {
  userId: string;
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth: string;
  screeningType?: AMLScreeningType;
}

export interface AMLCheckResult {
  checkId: string;
  userId: string;
  screeningType: AMLScreeningType;
  matches: AMLMatch[];
  riskScore: number; // 0–100
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  resolved: boolean;
  resolvedAt?: Date;
  checkedAt: Date;
}

export interface AMLMatch {
  listType: 'sanctions' | 'pep' | 'adverse_media';
  matchedName: string;
  confidence: number; // 0–1
  country?: string;
  source: string;
  details?: string;
}

// ── Sanctions Screening ─────────────────────────────────────────────────────

export interface SanctionScreeningInput {
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth: string;
}

export interface SanctionScreeningResult {
  screened: boolean;
  matchFound: boolean;
  matches: AMLMatch[];
  riskScore: number;
}

// ── Compliance Alert Filter ─────────────────────────────────────────────────

export interface ComplianceAlertFilter {
  status?: 'open' | 'in_review' | 'resolved';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  userId?: string;
  page?: number;
  limit?: number;
}

// ── Provider Webhook ────────────────────────────────────────────────────────

export interface ProviderWebhookEvent {
  provider: string;
  eventType: string;
  applicantId: string;
  externalUserId: string;
  status: string;
  /** Raw body for signature verification — not persisted. */
  rawBody?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// ── Compliance Error ────────────────────────────────────────────────────────

export class ComplianceError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = 'ComplianceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
