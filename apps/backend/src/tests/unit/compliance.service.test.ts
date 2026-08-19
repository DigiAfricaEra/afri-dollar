/* eslint-disable */
import { ComplianceService } from '../../services/compliance.service';
import { AuditService } from '../../services/audit.service';

// ── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    kYCRecord: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    complianceDocument: {
      count: jest.fn(),
    },
    aMLCheck: {
      create: jest.fn(),
    },
    complianceAlert: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../services/audit.service', () => ({
  AuditService: {
    log: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../services/providers/sumsub.provider', () => ({
  getKYCProvider: jest.fn(() => ({
    createApplicant: jest.fn().mockResolvedValue({
      applicantId: 'sumsub-applicant-123',
      externalUserId: 'user-1',
      status: 'pending',
      reviewStatus: 'pending',
    }),
    uploadDocument: jest.fn().mockResolvedValue({
      documentId: 'doc-1',
      status: 'pending',
    }),
    verifyWebhookSignature: jest.fn(),
    getApplicantStatus: jest.fn(),
  })),
}));

import prisma from '../../config/database';

const mockPrisma = jest.mocked(prisma);
const mockAuditLog = AuditService.log as jest.Mock;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ComplianceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── submitKYC ──────────────────────────────────────────────────────────

  describe('submitKYC', () => {
    const validOptions = {
      userId: 'user-1',
      firstName: 'John',
      lastName: 'Doe',
      dateOfBirth: '1990-01-15',
      nationality: 'NG',
      documentType: 'passport' as const,
      documentNumber: 'A12345678',
    };

    it('should create a KYC record and return status', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue(null);
      mockPrisma.kYCRecord.create.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        level: 'BASIC',
        provider: 'sumsub',
        status: 'pending',
        documentType: 'passport',
        documentNumber: 'A12345678',
        providerId: 'sumsub-app-123',
        providerData: null,
        rejectionCode: null,
        reviewerId: null,
        metadata: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.kYCRecord.update.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        level: 'BASIC',
        provider: 'sumsub',
        status: 'pending',
        documentType: 'passport',
        documentNumber: 'A12345678',
        providerId: 'sumsub-app-123',
        providerData: null,
        rejectionCode: null,
        reviewerId: null,
        metadata: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await ComplianceService.submitKYC(validOptions);

      expect(result.userId).toBe('user-1');
      expect(result.level).toBe('BASIC');
      expect(result.status).toBe('pending');
      expect(result.kycRecordId).toBe('kyc-1');
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'kyc_submitted' })
      );
    });

    it('should throw on missing firstName', async () => {
      await expect(ComplianceService.submitKYC({ ...validOptions, firstName: '' })).rejects.toThrow(
        'Missing required field: firstName'
      );
    });

    it('should throw on missing lastName', async () => {
      await expect(ComplianceService.submitKYC({ ...validOptions, lastName: '' })).rejects.toThrow(
        'Missing required field: lastName'
      );
    });

    it('should throw on missing documentNumber', async () => {
      await expect(
        ComplianceService.submitKYC({ ...validOptions, documentNumber: '' })
      ).rejects.toThrow('Missing required field: documentNumber');
    });

    it('should throw on invalid dateOfBirth format', async () => {
      await expect(
        ComplianceService.submitKYC({ ...validOptions, dateOfBirth: '15-01-1990' })
      ).rejects.toThrow('Invalid dateOfBirth format');
    });

    it('should update existing pending record instead of creating new', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue({
        id: 'kyc-existing',
        userId: 'user-1',
        level: 'BASIC',
        status: 'pending',
        provider: 'sumsub',
        providerId: null,
        providerData: null,
        documentType: 'passport',
        documentNumber: 'A12345678',
        rejectionCode: null,
        reviewerId: null,
        metadata: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      mockPrisma.kYCRecord.update.mockResolvedValue({
        id: 'kyc-existing',
        userId: 'user-1',
        level: 'BASIC',
        provider: 'sumsub',
        status: 'pending',
        documentType: 'passport',
        documentNumber: 'A12345678',
        providerId: 'sumsub-app-123',
        providerData: null,
        rejectionCode: null,
        reviewerId: null,
        metadata: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await ComplianceService.submitKYC(validOptions);
      expect(result.kycRecordId).toBe('kyc-existing');
      expect(mockPrisma.kYCRecord.create).not.toHaveBeenCalled();
    });

    it('should handle provider errors gracefully without blocking submission', async () => {
      const { getKYCProvider } = require('../../services/providers/sumsub.provider');
      getKYCProvider.mockReturnValue({
        createApplicant: jest.fn().mockRejectedValue(new Error('Provider down')),
        uploadDocument: jest.fn(),
        verifyWebhookSignature: jest.fn(),
        getApplicantStatus: jest.fn(),
      });

      mockPrisma.kYCRecord.findFirst.mockResolvedValue(null);
      mockPrisma.kYCRecord.create.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        level: 'BASIC',
        provider: 'sumsub',
        status: 'pending',
        documentType: 'passport',
        documentNumber: 'A12345678',
        providerId: null,
        providerData: null,
        rejectionCode: null,
        reviewerId: null,
        metadata: null,
        reviewedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await ComplianceService.submitKYC(validOptions);
      expect(result.status).toBe('pending');
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'kyc_provider_error', success: false })
      );
    });
  });

  // ── getKYCStatus ───────────────────────────────────────────────────────

  describe('getKYCStatus', () => {
    it('should return KYC status for a user', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
        level: 'STANDARD',
        status: 'approved',
        provider: 'sumsub',
        rejectionCode: null,
        reviewedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      mockPrisma.complianceDocument.count.mockResolvedValue(2);

      const result = await ComplianceService.getKYCStatus('user-1');
      expect(result.level).toBe('STANDARD');
      expect(result.status).toBe('approved');
      expect(result.documentsUploaded).toBe(true);
    });

    it('should throw when no KYC record exists', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue(null);

      await expect(ComplianceService.getKYCStatus('user-999')).rejects.toThrow(
        'No KYC record found for user'
      );
    });
  });

  // ── screenSanctions ────────────────────────────────────────────────────

  describe('screenSanctions', () => {
    it('should return a match for a sanctioned country (KP)', () => {
      const result = ComplianceService.screenSanctions({
        firstName: 'John',
        lastName: 'Doe',
        nationality: 'KP',
        dateOfBirth: '1990-01-15',
      });

      expect(result.matchFound).toBe(true);
      expect(result.screened).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].listType).toBe('sanctions');
      expect(result.matches[0].country).toBe('KP');
      expect(result.riskScore).toBe(85);
    });

    it('should return a match for Iran (IR)', () => {
      const result = ComplianceService.screenSanctions({
        firstName: 'Ali',
        lastName: 'Reza',
        nationality: 'IR',
        dateOfBirth: '1985-06-20',
      });
      expect(result.matchFound).toBe(true);
      expect(result.matches[0].country).toBe('IR');
    });

    it('should return no match for a non-sanctioned country', () => {
      const result = ComplianceService.screenSanctions({
        firstName: 'Jane',
        lastName: 'Smith',
        nationality: 'US',
        dateOfBirth: '1992-03-10',
      });
      expect(result.matchFound).toBe(false);
      expect(result.matches).toHaveLength(0);
      expect(result.riskScore).toBe(0);
    });

    it('should handle whitespace-padded country code', () => {
      const result = ComplianceService.screenSanctions({
        firstName: 'Test',
        lastName: 'User',
        nationality: ' KP ',
        dateOfBirth: '1990-01-01',
      });
      expect(result.matchFound).toBe(true);
    });

    it('should handle lowercase country code', () => {
      const result = ComplianceService.screenSanctions({
        firstName: 'Test',
        lastName: 'User',
        nationality: 'sy',
        dateOfBirth: '1990-01-01',
      });
      expect(result.matchFound).toBe(true);
      expect(result.matches[0].country).toBe('SY');
    });
  });

  // ── runAMLCheck ────────────────────────────────────────────────────────

  describe('runAMLCheck', () => {
    const validInput = {
      userId: 'user-1',
      firstName: 'Test',
      lastName: 'User',
      nationality: 'NG',
      dateOfBirth: '1990-01-15',
    };

    it('should create an AML check record with low risk for clean input', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
      } as any);
      mockPrisma.aMLCheck.create.mockResolvedValue({
        id: 'aml-1',
        checkedAt: new Date(),
        createdAt: new Date(),
        userId: 'user-1',
        kycRecordId: 'kyc-1',
        screeningType: 'combined',
        matches: [],
        riskScore: 0,
        riskLevel: 'low',
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
      } as any);

      const result = await ComplianceService.runAMLCheck(validInput);

      expect(result.checkId).toBe('aml-1');
      expect(result.riskLevel).toBe('low');
      expect(result.riskScore).toBe(0);
      expect(result.matches).toHaveLength(0);
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'aml_check_completed' })
      );
    });

    it('should trigger a sanctions match for a sanctioned country', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
      } as any);
      mockPrisma.aMLCheck.create.mockResolvedValue({
        id: 'aml-2',
        checkedAt: new Date(),
        createdAt: new Date(),
        userId: 'user-1',
        kycRecordId: 'kyc-1',
        screeningType: 'combined',
        matches: [],
        riskScore: 0,
        riskLevel: 'low',
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
      } as any);

      const result = await ComplianceService.runAMLCheck({
        ...validInput,
        nationality: 'KP',
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].listType).toBe('sanctions');
      expect(result.riskScore).toBeGreaterThan(0);
    });

    it('should create an alert for high-risk AML results', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue({
        id: 'kyc-1',
        userId: 'user-1',
      } as any);
      mockPrisma.aMLCheck.create.mockResolvedValue({
        id: 'aml-3',
        checkedAt: new Date(),
        createdAt: new Date(),
        userId: 'user-1',
        kycRecordId: 'kyc-1',
        screeningType: 'combined',
        matches: [],
        riskScore: 0,
        riskLevel: 'low',
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        resolutionNote: null,
      } as any);
      mockPrisma.complianceAlert.create.mockResolvedValue({} as any);

      await ComplianceService.runAMLCheck({
        ...validInput,
        nationality: 'KP',
      });

      expect(mockPrisma.complianceAlert.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'aml',
            severity: expect.stringMatching(/high|critical/),
          }),
        })
      );
    });

    it('should throw when no KYC record exists', async () => {
      mockPrisma.kYCRecord.findFirst.mockResolvedValue(null);

      await expect(ComplianceService.runAMLCheck(validInput)).rejects.toThrow(
        'No KYC record found — submit KYC before running AML checks'
      );
    });
  });

  // ── resolveAlert ───────────────────────────────────────────────────────

  describe('resolveAlert', () => {
    it('should resolve an open alert and write an audit log', async () => {
      mockPrisma.complianceAlert.findUnique.mockResolvedValue({
        id: 'alert-1',
        severity: 'high',
        type: 'aml',
        status: 'open',
        userId: 'user-1',
        kycRecordId: null,
        title: 'AML alert',
        description: 'High risk',
        transactionId: null,
        ruleId: null,
        metadata: null,
        resolvedBy: null,
        resolutionNote: null,
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      mockPrisma.complianceAlert.update.mockResolvedValue({} as any);

      await ComplianceService.resolveAlert('alert-1', {
        resolvedBy: 'admin-1',
        resolutionNote: 'False positive after manual review',
      });

      expect(mockPrisma.complianceAlert.update).toHaveBeenCalledWith({
        where: { id: 'alert-1' },
        data: expect.objectContaining({
          status: 'resolved',
          resolvedBy: 'admin-1',
          resolutionNote: 'False positive after manual review',
          resolvedAt: expect.any(Date),
        }),
      });

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'compliance_alert_resolved',
          resourceId: 'alert-1',
          userId: 'admin-1',
        })
      );
    });

    it('should throw when alert not found', async () => {
      mockPrisma.complianceAlert.findUnique.mockResolvedValue(null);

      await expect(
        ComplianceService.resolveAlert('nonexistent', {
          resolvedBy: 'admin-1',
          resolutionNote: 'note',
        })
      ).rejects.toThrow('Compliance alert not found');
    });

    it('should throw when alert is already resolved', async () => {
      mockPrisma.complianceAlert.findUnique.mockResolvedValue({
        id: 'alert-1',
        status: 'resolved',
      } as any);

      await expect(
        ComplianceService.resolveAlert('alert-1', {
          resolvedBy: 'admin-1',
          resolutionNote: 'note',
        })
      ).rejects.toThrow('Alert is already resolved');
    });
  });
});
