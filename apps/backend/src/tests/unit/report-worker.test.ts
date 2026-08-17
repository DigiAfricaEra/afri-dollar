/* eslint-disable @typescript-eslint/unbound-method */
import prisma from '../../config/database';
import { processReport, reportWorker } from '../../services/report-worker.service';
import { ReportService } from '../../services/report.service';

jest.mock('../../config/database', () => {
  const client: Record<string, unknown> = {
    user: {
      create: jest.fn(),
      delete: jest.fn(),
    },
    reportRequest: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    transaction: {
      findMany: jest.fn(),
    },
    kYCRecord: {
      findMany: jest.fn(),
    },
    complianceAlert: {
      findMany: jest.fn(),
    },
    payrollBatch: {
      findMany: jest.fn(),
    },
    wallet: {
      findMany: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn(),
    },
  };

  return {
    __esModule: true,
    default: client,
  };
});

describe('ReportWorkerService & Processor Unit Tests', () => {
  const mockReportRequestCreate = prisma.reportRequest.create as jest.Mock;
  const mockReportRequestUpdateMany = prisma.reportRequest.updateMany as jest.Mock;
  const mockReportRequestFindUnique = prisma.reportRequest.findUnique as jest.Mock;
  const mockReportRequestUpdate = prisma.reportRequest.update as jest.Mock;
  const mockTransactionFindMany = prisma.transaction.findMany as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process pending report request and update status to completed with metadata', async () => {
    const reportReq = {
      id: 'req_123',
      userId: 'user_1',
      reportType: 'transaction_history',
      format: 'csv',
      parameters: {},
      status: 'pending',
    };

    mockReportRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockReportRequestFindUnique.mockResolvedValue(reportReq);
    mockTransactionFindMany.mockResolvedValue([
      {
        id: 'tx_1',
        userId: 'user_1',
        type: 'transfer',
        status: 'completed',
        amount: '100.00',
        assetCode: 'USDC',
        assetIssuer: null,
        fromAddress: null,
        toAddress: null,
        stellarTxId: null,
        createdAt: new Date(),
        completedAt: new Date(),
      },
    ]);

    mockReportRequestUpdate.mockResolvedValue({
      ...reportReq,
      status: 'completed',
      completedAt: new Date(),
      storageKey: 'reports/req_123.csv',
      mimeType: 'text/csv',
    });

    await processReport('req_123');

    expect(mockReportRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: 'req_123', status: { in: ['pending', 'failed'] } },
      data: { status: 'generating' },
    });
    expect(mockReportRequestUpdate).toHaveBeenCalledWith({
      where: { id: 'req_123' },
      data: expect.objectContaining({
        status: 'completed',
        storageKey: 'reports/req_123.csv',
        mimeType: 'text/csv',
        downloadUrl: '/api/v1/reports/req_123/download',
      }),
    });
  });

  it('should enqueue job or process inline in test environment', async () => {
    expect(reportWorker.getStatus()).toBeDefined();

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    mockReportRequestCreate.mockResolvedValue({
      id: 'req_456',
      userId: 'user_1',
      reportType: 'compliance_report',
      format: 'pdf',
      parameters: {},
      status: 'pending',
    });
    mockReportRequestUpdateMany.mockResolvedValue({ count: 1 });
    mockReportRequestFindUnique.mockResolvedValue({
      id: 'req_456',
      userId: 'user_1',
      reportType: 'compliance_report',
      format: 'pdf',
      parameters: {},
      status: 'pending',
    });
    mockReportRequestUpdate.mockResolvedValue({
      id: 'req_456',
      status: 'completed',
    });

    const report = await ReportService.generate('user_1', 'compliance-report', 'pdf');
    expect(report).toBeDefined();

    process.env.NODE_ENV = originalEnv;
  });
});
