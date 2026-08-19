// ──────────────────────────────────────────────────────────────────────────────
// Compliance & KYC Service
// Orchestrates KYC submissions, AML screening, sanctions checks, and alert
// resolution. Delegates provider interactions to the pluggable KYCProvider.
// ──────────────────────────────────────────────────────────────────────────────

import type { Prisma, KYCLevel as PrismaKYCLevel } from '@prisma/client';

import prisma from '../config/database';
import {
  ComplianceError,
  type AMLCheckInput,
  type AMLCheckResult,
  type AMLMatch,
  type AMLScreeningType,
  type KYCStatusResponse,
  type SanctionScreeningInput,
  type SanctionScreeningResult,
  type SubmitKYCOptions,
} from '../types/compliance.types';

import { AuditService } from './audit.service';
import { getKYCProvider } from './providers/sumsub.provider';

// ── Known sanctions list (OFAC / UN / EU simplified) ────────────────────────
const SANCTIONS_COUNTRIES = new Set([
  'KP', // North Korea
  'IR', // Iran
  'SY', // Syria
  'CU', // Cuba
  'RU', // Russia (expanded sanctions)
  'BY', // Belarus
  'VE', // Venezuela
  'MM', // Myanmar
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapPrismaLevel(level: PrismaKYCLevel): 'BASIC' | 'STANDARD' | 'ENHANCED' {
  return level;
}

// ── Service ─────────────────────────────────────────────────────────────────

export const ComplianceService = {
  // ── KYC Submission ──────────────────────────────────────────────────────

  /**
   * Validates required fields, creates or updates a KYC record, and kicks off
   * provider verification via the configured KYCProvider.
   */
  async submitKYC(options: SubmitKYCOptions): Promise<KYCStatusResponse> {
    // 1. Validate required fields
    const requiredFields = [
      'firstName',
      'lastName',
      'dateOfBirth',
      'nationality',
      'documentType',
      'documentNumber',
    ] as const;

    for (const field of requiredFields) {
      if (!options[field] || String(options[field]).trim() === '') {
        throw new ComplianceError(`Missing required field: ${field}`, 'KYC_FIELD_MISSING', 400);
      }
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.dateOfBirth)) {
      throw new ComplianceError(
        'Invalid dateOfBirth format. Expected YYYY-MM-DD',
        'KYC_INVALID_DATE',
        400
      );
    }

    const kycLevel = options.level ?? 'BASIC';

    // 2. Check for existing pending/approved KYC record at same level
    const existing = await prisma.kYCRecord.findFirst({
      where: {
        userId: options.userId,
        level: kycLevel,
        status: { in: ['pending', 'approved'] },
      },
    });

    let kycRecord;

    if (existing) {
      // Update the existing record
      kycRecord = await prisma.kYCRecord.update({
        where: { id: existing.id },
        data: {
          documentType: options.documentType,
          documentNumber: options.documentNumber,
          status: 'pending',
          metadata: {
            updatedFields: Object.keys(options),
            submittedAt: new Date().toISOString(),
          },
        },
      });
    } else {
      // Create a new KYC record
      kycRecord = await prisma.kYCRecord.create({
        data: {
          userId: options.userId,
          level: kycLevel,
          provider: 'sumsub',
          status: 'pending',
          documentType: options.documentType,
          documentNumber: options.documentNumber,
          metadata: {
            firstName: options.firstName,
            lastName: options.lastName,
            nationality: options.nationality,
            submittedAt: new Date().toISOString(),
            // NOTE: document images are NOT persisted — they go only to the provider
          },
        },
      });
    }

    // 3. Kick off provider verification (best-effort — don't fail the submission)
    try {
      const provider = getKYCProvider();

      const applicant = await provider.createApplicant({
        externalUserId: options.userId,
        firstName: options.firstName,
        lastName: options.lastName,
        nationality: options.nationality,
        dateOfBirth: options.dateOfBirth,
      });

      // Update the record with the provider's applicant ID
      kycRecord = await prisma.kYCRecord.update({
        where: { id: kycRecord.id },
        data: {
          providerId: applicant.applicantId,
          providerData: applicant as unknown as Prisma.InputJsonValue,
        },
      });

      // Upload document image if provided (NOT logged)
      if (options.documentImageBase64) {
        await provider.uploadDocument({
          applicantId: applicant.applicantId,
          documentType: options.documentType,
          imageBase64: options.documentImageBase64,
        });
      }
    } catch (error) {
      // Provider failures are logged but don't block the submission
      await AuditService.log({
        action: 'kyc_provider_error',
        resource: 'kyc',
        userId: options.userId,
        resourceId: kycRecord.id,
        success: false,
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    // 4. Audit the submission (no PII logged)
    await AuditService.log({
      action: 'kyc_submitted',
      resource: 'kyc',
      userId: options.userId,
      resourceId: kycRecord.id,
      success: true,
      metadata: {
        level: kycLevel,
        documentType: options.documentType,
      },
    });

    return {
      userId: options.userId,
      kycRecordId: kycRecord.id,
      level: mapPrismaLevel(kycRecord.level),
      status: kycRecord.status as KYCStatusResponse['status'],
      provider: kycRecord.provider,
      documentsUploaded: !!options.documentImageBase64,
      submittedAt: kycRecord.createdAt,
      reviewedAt: kycRecord.reviewedAt ?? undefined,
    };
  },

  // ── KYC Status ──────────────────────────────────────────────────────────

  /**
   * Returns the current KYC level and status for a user. Returns the most
   * recently updated record across all levels.
   */
  async getKYCStatus(userId: string): Promise<KYCStatusResponse> {
    const record = await prisma.kYCRecord.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });

    if (!record) {
      throw new ComplianceError('No KYC record found for user', 'KYC_NOT_FOUND', 404);
    }

    const docCount = await prisma.complianceDocument.count({
      where: { kycRecordId: record.id },
    });

    return {
      userId: record.userId,
      kycRecordId: record.id,
      level: mapPrismaLevel(record.level),
      status: record.status as KYCStatusResponse['status'],
      provider: record.provider,
      rejectionCode: record.rejectionCode ?? undefined,
      documentsUploaded: docCount > 0,
      submittedAt: record.createdAt,
      reviewedAt: record.reviewedAt ?? undefined,
    };
  },

  // ── AML Check ───────────────────────────────────────────────────────────

  /**
   * Combines sanctions list, PEP match, and adverse media checks.
   * Adverse media is behind a real integration hook so it can be swapped later.
   */
  async runAMLCheck(input: AMLCheckInput): Promise<AMLCheckResult> {
    const screeningType: AMLScreeningType = input.screeningType ?? 'combined';
    const matches: AMLMatch[] = [];

    // 1. Sanctions check (always runs)
    const sanctionsResult = this.screenSanctions({
      firstName: input.firstName,
      lastName: input.lastName,
      nationality: input.nationality,
      dateOfBirth: input.dateOfBirth,
    });

    if (sanctionsResult.matchFound) {
      matches.push(...sanctionsResult.matches);
    }

    // 2. PEP (Politically Exposed Person) check — stubbed with hook
    if (screeningType === 'pep' || screeningType === 'combined') {
      const pepMatches = await this.checkPEP(input);
      matches.push(...pepMatches);
    }

    // 3. Adverse media — stubbed behind an integration hook
    if (screeningType === 'adverse_media' || screeningType === 'combined') {
      const adverseMatches = await this.checkAdverseMedia(input);
      matches.push(...adverseMatches);
    }

    // Calculate risk score
    const riskScore = this.calculateRiskScore(matches);
    const riskLevel = this.riskLevelFromScore(riskScore);

    // Find or create a KYC record for this user to link the AML check
    const kycRecord = await prisma.kYCRecord.findFirst({
      where: { userId: input.userId },
      orderBy: { createdAt: 'desc' },
    });

    if (!kycRecord) {
      throw new ComplianceError(
        'No KYC record found — submit KYC before running AML checks',
        'KYC_REQUIRED_FOR_AML',
        400
      );
    }

    // Persist the check
    const amlCheck = await prisma.aMLCheck.create({
      data: {
        kycRecordId: kycRecord.id,
        userId: input.userId,
        screeningType,
        matches: matches as unknown as Prisma.InputJsonValue,
        riskScore,
        riskLevel,
      },
    });

    // If high or critical risk, create a compliance alert
    if (riskLevel === 'high' || riskLevel === 'critical') {
      await prisma.complianceAlert.create({
        data: {
          type: 'aml',
          severity: riskLevel,
          status: 'open',
          title: `AML screening: ${riskLevel} risk`,
          description: `AML screening returned ${riskLevel} risk for user (${matches.length} match(es))`,
          userId: input.userId,
          kycRecordId: kycRecord.id,
          metadata: {
            checkId: amlCheck.id,
            matchCount: matches.length,
            screeningType,
          },
        },
      });
    }

    // Audit — no PII
    await AuditService.log({
      action: 'aml_check_completed',
      resource: 'compliance',
      userId: input.userId,
      resourceId: amlCheck.id,
      success: true,
      metadata: {
        screeningType,
        riskLevel,
        matchCount: matches.length,
      },
    });

    return {
      checkId: amlCheck.id,
      userId: input.userId,
      screeningType,
      matches,
      riskScore,
      riskLevel,
      resolved: false,
      checkedAt: amlCheck.checkedAt,
    };
  },

  // ── Sanctions Screening ─────────────────────────────────────────────────

  /**
   * Sanctions-list-specific check. Triggers a match when the given country is
   * on the sanctions list.
   */
  screenSanctions(input: SanctionScreeningInput): SanctionScreeningResult {
    const country = input.nationality.trim().toUpperCase();

    if (SANCTIONS_COUNTRIES.has(country)) {
      return {
        screened: true,
        matchFound: true,
        matches: [
          {
            listType: 'sanctions',
            matchedName: `${input.firstName} ${input.lastName}`,
            confidence: 0.85,
            country,
            source: 'OFAC/UN/EU Consolidated Sanctions List',
            details: `Nationality '${country}' is on the consolidated sanctions list`,
          },
        ],
        riskScore: 85,
      };
    }

    return {
      screened: true,
      matchFound: false,
      matches: [],
      riskScore: 0,
    };
  },

  // ── Alert Resolution ────────────────────────────────────────────────────

  /**
   * Resolves a compliance alert and writes an audit log entry via AuditService.
   */
  async resolveAlert(
    alertId: string,
    resolution: { resolvedBy: string; resolutionNote: string }
  ): Promise<void> {
    const alert = await prisma.complianceAlert.findUnique({
      where: { id: alertId },
    });

    if (!alert) {
      throw new ComplianceError('Compliance alert not found', 'ALERT_NOT_FOUND', 404);
    }

    if (alert.status === 'resolved') {
      throw new ComplianceError('Alert is already resolved', 'ALERT_ALREADY_RESOLVED', 400);
    }

    await prisma.complianceAlert.update({
      where: { id: alertId },
      data: {
        status: 'resolved',
        resolvedBy: resolution.resolvedBy,
        resolutionNote: resolution.resolutionNote,
        resolvedAt: new Date(),
      },
    });

    // Audit log entry
    await AuditService.log({
      action: 'compliance_alert_resolved',
      resource: 'compliance',
      userId: resolution.resolvedBy,
      resourceId: alertId,
      success: true,
      metadata: {
        originalSeverity: alert.severity,
        originalAlertType: alert.type,
        resolutionNote: resolution.resolutionNote,
      },
    });
  },

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * PEP check stub — replace with a real integration (e.g. Dow Jones, World-Check).
   */
  async checkPEP(_input: AMLCheckInput): Promise<AMLMatch[]> {
    // Integration hook: call PEP database API here
    // For now, returns empty — no false positives in stub
    return [];
  },

  /**
   * Adverse media check stub — behind a real integration hook so it can be
   * swapped later for a provider like LexisNexis or Relativity.
   */
  async checkAdverseMedia(_input: AMLCheckInput): Promise<AMLMatch[]> {
    // Integration hook: call adverse media API here
    // For now, returns empty — no false positives in stub
    return [];
  },

  /**
   * Calculates a composite risk score from all matches (0–100).
   */
  calculateRiskScore(matches: AMLMatch[]): number {
    if (matches.length === 0) return 0;

    // Weight each match by its confidence and boost for sanctions
    let score = 0;
    for (const match of matches) {
      const baseScore = match.confidence * 60;
      const listBoost = match.listType === 'sanctions' ? 25 : match.listType === 'pep' ? 15 : 10;
      score = Math.max(score, baseScore + listBoost);
    }

    return Math.min(100, Math.round(score));
  },

  /**
   * Maps a numeric risk score to a human-readable risk level.
   */
  riskLevelFromScore(score: number): 'low' | 'medium' | 'high' | 'critical' {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    return 'low';
  },
};
