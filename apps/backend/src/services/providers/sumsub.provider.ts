// ──────────────────────────────────────────────────────────────────────────────
// Sumsub KYC Provider Adapter
// Pluggable design — any future provider (Onfido, etc.) implements the same
// interface. API keys are read exclusively from env; no PII or document images
// are ever logged.
// ──────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

import { env } from '../../config/env';
import { ComplianceError } from '../../types/compliance.types';

// ── Types ───────────────────────────────────────────────────────────────────

export interface KYCProvider {
  createApplicant(input: CreateApplicantInput): Promise<ApplicantResult>;
  uploadDocument(input: UploadDocumentInput): Promise<DocumentUploadResult>;
  getApplicantStatus(applicantId: string): Promise<ApplicantStatusResult>;
  verifyWebhookSignature(timestamp: string, body: string, signature: string): boolean;
}

export interface CreateApplicantInput {
  externalUserId: string;
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth: string; // YYYY-MM-DD
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface ApplicantResult {
  applicantId: string;
  externalUserId: string;
  status: string;
  reviewStatus: string;
}

export interface UploadDocumentInput {
  applicantId: string;
  documentType: string;
  documentSubType?: string;
  /** Base64-encoded image — used only for the provider request, never logged. */
  imageBase64: string;
  fileName?: string;
  mimeType?: string;
}

export interface DocumentUploadResult {
  documentId: string;
  status: string;
}

export interface ApplicantStatusResult {
  applicantId: string;
  status: string;
  reviewStatus: string;
  reviewResult?: {
    reviewAnswer: string;
    rejectLabels?: string[];
    moderationComment?: string;
  };
  /** Raw provider response — contains no logged PII. */
  rawData?: Record<string, unknown>;
}

// ── Sumsub Provider Implementation ──────────────────────────────────────────

export class SumsubProvider implements KYCProvider {
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = env.SUMSUB_API_KEY;
    this.secretKey = env.SUMSUB_SECRET_KEY;
    this.baseUrl = env.SUMSUB_BASE_URL;
  }

  // ── Webhook HMAC-SHA256 Verification ─────────────────────────────────────

  /**
   * Verifies a Sumsub webhook signature.
   * The signature is HMAC-SHA256(timestamp + body) using the secret key.
   * Rejects on mismatch.
   */
  verifyWebhookSignature(timestamp: string, body: string, signature: string): boolean {
    if (!this.secretKey) {
      throw new ComplianceError(
        'SUMSUB_SECRET_KEY is not configured',
        'PROVIDER_CONFIG_ERROR',
        500
      );
    }

    const payload = timestamp + body;
    const expectedSignature = crypto
      .createHmac('sha256', this.secretKey)
      .update(payload, 'utf8')
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  // ── Applicant Creation ────────────────────────────────────────────────────

  async createApplicant(input: CreateApplicantInput): Promise<ApplicantResult> {
    this.requireConfig();

    const body = {
      externalUserId: input.externalUserId,
      fixedInfo: {
        firstName: input.firstName,
        lastName: input.lastName,
        nationality: input.nationality,
        dateOfBirth: input.dateOfBirth,
      },
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    const response = await this.request('POST', '/resources/applicants?levelName=basic-kyc', body);

    return {
      applicantId: response.id as string,
      externalUserId: input.externalUserId,
      status: (response.status as string) ?? 'pending',
      reviewStatus: (response.reviewStatus as string) ?? 'pending',
    };
  }

  // ── Document Upload ───────────────────────────────────────────────────────

  async uploadDocument(input: UploadDocumentInput): Promise<DocumentUploadResult> {
    this.requireConfig();

    const formData = new FormData();
    formData.append(
      'file',
      this.base64ToBlob(input.imageBase64, input.mimeType ?? 'image/jpeg'),
      input.fileName ?? 'document.jpg'
    );
    formData.append('type', input.documentType);
    if (input.documentSubType) {
      formData.append('subType', input.documentSubType);
    }

    const response = await this.requestRaw(
      'POST',
      `/resources/applicants/${input.applicantId}/info`,
      formData
    );

    return {
      documentId: (response.docId as string) ?? '',
      status: (response.reviewStatus as string) ?? 'pending',
    };
  }

  // ── Status Polling / Sync ─────────────────────────────────────────────────

  async getApplicantStatus(applicantId: string): Promise<ApplicantStatusResult> {
    this.requireConfig();

    const response = await this.request('GET', `/resources/applicants/${applicantId}`);

    return {
      applicantId,
      status: (response.status as string) ?? 'unknown',
      reviewStatus: (response.reviewStatus as string) ?? 'unknown',
      reviewResult: response.reviewResult as ApplicantStatusResult['reviewResult'],
      rawData: response,
    };
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  private requireConfig(): void {
    if (!this.apiKey || !this.secretKey) {
      throw new ComplianceError(
        'Sumsub provider credentials are not configured',
        'PROVIDER_CONFIG_ERROR',
        500
      );
    }
  }

  /**
   * Signs and sends a JSON request to the Sumsub API.
   */
  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Token': this.apiKey,
      'X-App-Access-Tsig': this.createRequestSignature(method, path, timestamp),
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new ComplianceError(
        `Sumsub API error: ${response.status}`,
        'PROVIDER_API_ERROR',
        response.status >= 500 ? 502 : 400
      );
    }

    return data;
  }

  /**
   * Sends a raw request (e.g. multipart/form-data for document upload).
   */
  private async requestRaw(
    method: string,
    path: string,
    body: FormData
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-App-Token': this.apiKey,
      'X-App-Access-Tsig': this.createRequestSignature(method, path, timestamp),
    };

    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new ComplianceError(
        `Sumsub API error: ${response.status}`,
        'PROVIDER_API_ERROR',
        response.status >= 500 ? 502 : 400
      );
    }

    return data;
  }

  /**
   * Creates the HMAC-SHA256 request signature for Sumsub's API.
   * Pattern: HMAC-SHA256(secretKey, method + path + timestamp)
   */
  private createRequestSignature(method: string, path: string, timestamp: string): string {
    const payload = method + path + timestamp;
    return crypto.createHmac('sha256', this.secretKey).update(payload).digest('hex');
  }

  /**
   * Converts a base64 string to a Blob — used for FormData uploads.
   * Document images are never logged.
   */
  private base64ToBlob(base64: string, mimeType: string): Blob {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new Blob([bytes], { type: mimeType });
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

let providerInstance: KYCProvider | null = null;

/**
 * Returns a singleton SumsubProvider. Instantiate your own if you need a
 * different provider for testing.
 */
export function getKYCProvider(): KYCProvider {
  if (!providerInstance) {
    providerInstance = new SumsubProvider();
  }
  return providerInstance;
}

/** Allow tests to swap the provider singleton. */
export function setKYCProvider(provider: KYCProvider): void {
  providerInstance = provider;
}
