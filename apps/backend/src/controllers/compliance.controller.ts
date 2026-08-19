// ──────────────────────────────────────────────────────────────────────────────
// Compliance Controller
// Request/response handling for KYC submit, KYC status, provider webhook,
// alert list/resolve, and AML check endpoints.
// ──────────────────────────────────────────────────────────────────────────────

import type { Response } from 'express';
import { z } from 'zod';

import type { AuthRequest } from '../middleware/auth.middleware';
import { ComplianceService } from '../services/compliance.service';
import { getKYCProvider } from '../services/providers/sumsub.provider';
import { ComplianceError } from '../types/compliance.types';

// ── Zod Schemas ─────────────────────────────────────────────────────────────

const submitKYCSchema = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD'),
  nationality: z.string().min(2, 'Nationality is required'),
  documentType: z.enum([
    'passport',
    'national_id',
    'drivers_license',
    'utility_bill',
    'bank_statement',
    'selfie',
  ]),
  documentNumber: z.string().min(1, 'Document number is required'),
  documentImageBase64: z.string().optional(),
  selfieImageBase64: z.string().optional(),
  address: z
    .object({
      street: z.string(),
      city: z.string(),
      state: z.string().optional(),
      postalCode: z.string(),
      country: z.string(),
    })
    .optional(),
  level: z.enum(['BASIC', 'STANDARD', 'ENHANCED']).optional(),
});

const amlCheckSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  nationality: z.string().min(2),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  screeningType: z.enum(['sanctions', 'pep', 'adverse_media', 'combined']).optional(),
});

const resolveAlertSchema = z.object({
  resolutionNote: z.string().min(1, 'Resolution note is required'),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function requireUser(req: AuthRequest, res: Response): string | null {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Access token is required' });
    return null;
  }
  return req.user.userId;
}

function handleError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      success: false,
      error: 'Validation error',
      details: error.errors,
    });
    return;
  }

  if (error instanceof ComplianceError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }

  if (error instanceof Error) {
    const errorMap: Record<string, number> = {
      'No KYC record found for user': 404,
      'No KYC record found — submit KYC before running AML checks': 400,
      'Compliance alert not found': 404,
      'Alert is already resolved': 400,
    };
    const status = errorMap[error.message] || 500;
    const clientMessage = status === 500 ? 'Internal server error' : error.message;

    res.status(status).json({ success: false, error: clientMessage });
    return;
  }

  res.status(500).json({ success: false, error: 'Internal server error' });
}

// ── Controller ──────────────────────────────────────────────────────────────

export const ComplianceController = {
  // ── POST /api/v1/compliance/kyc ──────────────────────────────────────────

  async submitKYC(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const body = submitKYCSchema.parse(req.body);
      const result = await ComplianceService.submitKYC({
        userId,
        ...body,
      });

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(res, error);
    }
  },

  // ── GET /api/v1/compliance/kyc ──────────────────────────────────────────

  async getKYCStatus(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const result = await ComplianceService.getKYCStatus(userId);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      handleError(res, error);
    }
  },

  // ── POST /api/v1/compliance/kyc/documents ───────────────────────────────

  async uploadDocument(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const { documentType, documentImageBase64, kycRecordId } = req.body as {
        documentType?: string;
        documentImageBase64?: string;
        kycRecordId?: string;
      };

      if (!documentType || !documentImageBase64) {
        res.status(400).json({
          success: false,
          error: 'documentType and documentImageBase64 are required',
        });
        return;
      }

      // Find the KYC record to get the provider applicant ID
      const prisma = (await import('../config/database')).default;
      const kycRecord = kycRecordId
        ? await prisma.kYCRecord.findFirst({
            where: { id: kycRecordId, userId },
          })
        : await prisma.kYCRecord.findFirst({
            where: { userId },
            orderBy: { updatedAt: 'desc' },
          });

      if (!kycRecord) {
        res.status(404).json({ success: false, error: 'No KYC record found' });
        return;
      }

      if (!kycRecord.providerId) {
        res.status(400).json({
          success: false,
          error: 'KYC record has no provider applicant ID — resubmit KYC first',
        });
        return;
      }

      const provider = getKYCProvider();
      const uploadResult = await provider.uploadDocument({
        applicantId: kycRecord.providerId,
        documentType,
        imageBase64: documentImageBase64,
      });

      res.status(201).json({ success: true, data: uploadResult });
    } catch (error) {
      handleError(res, error);
    }
  },

  // ── POST /api/v1/compliance/aml-check ───────────────────────────────────

  async runAMLCheck(req: AuthRequest, res: Response): Promise<void> {
    try {
      const userId = requireUser(req, res);
      if (!userId) return;

      const body = amlCheckSchema.parse(req.body);
      const result = await ComplianceService.runAMLCheck({
        userId,
        ...body,
      });

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(res, error);
    }
  },

  // ── POST /api/v1/compliance/webhooks/sumsub ─────────────────────────────
  // Public endpoint — HMAC verified, no auth middleware

  async handleWebhook(req: AuthRequest, res: Response): Promise<void> {
    try {
      const signature = req.headers['x-payload-signature'] as string | undefined;
      const timestamp = req.headers['x-payload-date'] as string | undefined;

      if (!signature || !timestamp) {
        res.status(401).json({ success: false, error: 'Missing webhook signature headers' });
        return;
      }

      const rawBody = JSON.stringify(req.body);
      const provider = getKYCProvider();

      if (!provider.verifyWebhookSignature(timestamp, rawBody, signature)) {
        res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        return;
      }

      const { type, applicantId, status } = req.body as {
        type?: string;
        applicantId?: string;
        status?: string;
      };

      if (!type || !applicantId) {
        res.status(400).json({ success: false, error: 'Invalid webhook payload' });
        return;
      }

      // Process the webhook event
      const prisma = (await import('../config/database')).default;
      const { AuditService } = await import('../services/audit.service');

      // Find the KYC record by provider applicant ID
      const kycRecord = await prisma.kYCRecord.findFirst({
        where: { providerId: applicantId },
      });

      if (kycRecord) {
        // Map Sumsub status to our status
        let newStatus = 'pending';
        if (type === 'applicantReview' || type === 'onboardingCompleted') {
          if (status === 'completed' || status === 'verified') {
            newStatus = 'approved';
          } else if (status === 'rejected') {
            newStatus = 'rejected';
          } else if (status === 'pending' || status === 'init') {
            newStatus = 'review';
          }
        }

        await prisma.kYCRecord.update({
          where: { id: kycRecord.id },
          data: {
            status: newStatus,
            providerData: req.body,
            ...(newStatus === 'approved' || newStatus === 'rejected'
              ? { reviewedAt: new Date() }
              : {}),
          },
        });

        await AuditService.log({
          action: 'kyc_webhook_processed',
          resource: 'kyc',
          userId: kycRecord.userId,
          resourceId: kycRecord.id,
          success: true,
          metadata: {
            eventType: type,
            newStatus,
          },
        });
      }

      res.status(200).json({ success: true });
    } catch (error) {
      handleError(res, error);
    }
  },

  // ── POST /api/v1/admin/compliance/alerts/:id/resolve ────────────────────
  // Admin-only — used by the compliance routes (admin alert list is in admin.routes.ts)

  async resolveAlert(req: AuthRequest, res: Response): Promise<void> {
    try {
      const resolvedBy = requireUser(req, res);
      if (!resolvedBy) return;

      const { id } = req.params;
      if (!id) {
        res.status(400).json({ success: false, error: 'Alert ID is required' });
        return;
      }

      const body = resolveAlertSchema.parse(req.body);
      await ComplianceService.resolveAlert(id, {
        resolvedBy,
        resolutionNote: body.resolutionNote,
      });

      res.status(200).json({ success: true, message: 'Alert resolved successfully' });
    } catch (error) {
      handleError(res, error);
    }
  },
};
