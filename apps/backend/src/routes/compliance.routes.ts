// ──────────────────────────────────────────────────────────────────────────────
// Compliance Routes
// KYC submission/status, document upload, AML checks, Sumsub webhook, and
// admin alert resolution.
// Note: Admin alert listing is handled by admin.routes.ts
// (/api/v1/admin/compliance/alerts).
// ──────────────────────────────────────────────────────────────────────────────

import { Router } from 'express';

import { ComplianceController } from '../controllers/compliance.controller';
import { adminMiddleware, authMiddleware } from '../middleware/auth.middleware';

const complianceRouter = Router();

// ── User-facing compliance routes ───────────────────────────────────────────

// POST /api/v1/compliance/kyc — Submit KYC information
complianceRouter.post('/kyc', authMiddleware, (req, res, next) => {
  ComplianceController.submitKYC(req, res).catch(next);
});

// GET /api/v1/compliance/kyc — Get current KYC status
complianceRouter.get('/kyc', authMiddleware, (req, res, next) => {
  ComplianceController.getKYCStatus(req, res).catch(next);
});

// POST /api/v1/compliance/kyc/documents — Upload KYC documents
complianceRouter.post('/kyc/documents', authMiddleware, (req, res, next) => {
  ComplianceController.uploadDocument(req, res).catch(next);
});

// POST /api/v1/compliance/aml-check — Run AML screening
complianceRouter.post('/aml-check', authMiddleware, (req, res, next) => {
  ComplianceController.runAMLCheck(req, res).catch(next);
});

// POST /api/v1/compliance/webhooks/sumsub — Sumsub webhook (public, HMAC verified)
// No auth middleware — signature verification happens inside the controller
complianceRouter.post('/webhooks/sumsub', (req, res, next) => {
  ComplianceController.handleWebhook(req, res).catch(next);
});

// ── Admin compliance routes ─────────────────────────────────────────────────

// POST /api/v1/admin/compliance/alerts/:id/resolve — Resolve a compliance alert
// Note: GET /api/v1/admin/compliance/alerts is handled by admin.routes.ts
const adminComplianceRouter = Router();
adminComplianceRouter.use(authMiddleware, adminMiddleware);

adminComplianceRouter.post('/alerts/:id/resolve', (req, res, next) => {
  ComplianceController.resolveAlert(req, res).catch(next);
});

export { complianceRouter, adminComplianceRouter };
export default complianceRouter;
