import { Prisma, Transaction } from '@afri-dollar/database';
import {
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Asset,
  Memo,
  StrKey,
} from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { env } from '../config/env';
import { ComplianceError } from '../types/compliance.types';
import type {
  CreateCrossBorderPaymentOptions,
  PaymentStatus,
  CrossBorderPaymentResult,
  ComplianceCheckResult,
} from '../types/payment.types';
import { decrypt } from '../utils/crypto';

import { NotificationService } from './notification.service';
import { StellarService } from './stellar.service';
import { TransactionMonitorService } from './transaction-monitor.service';
import { WebhookService } from './webhook.service';

const server = StellarService.getHorizonServer();

/** Extracts a human-readable error message from a Stellar Horizon API error response. */
function getHorizonErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    const message =
      typeof errObj.message === 'string' ? errObj.message : 'Unknown Stellar Horizon error';

    const response = errObj.response as Record<string, unknown> | undefined;
    const data = response?.data as Record<string, unknown> | undefined;
    const extras = data?.extras as Record<string, unknown> | undefined;
    const resultCodes = extras?.result_codes as Record<string, unknown> | undefined;

    if (resultCodes) {
      const txCode =
        typeof resultCodes.transaction === 'string' ? resultCodes.transaction : 'unknown';
      const opCodes = Array.isArray(resultCodes.operations)
        ? resultCodes.operations.join(', ')
        : '';
      return `Stellar payment failed. Transaction Code: ${txCode}. Operations Codes: [${opCodes}]`;
    }
    return message;
  }
  return String(error);
}

/** Maps a Prisma Transaction record to the PaymentStatus response shape. */
function mapToPaymentStatus(tx: Transaction): PaymentStatus {
  return {
    id: tx.id,
    status: tx.status as PaymentStatus['status'],
    stellarTxId: tx.stellarTxId || undefined,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    completedAt: tx.completedAt || undefined,
    errorMessage: tx.errorMessage || undefined,
  };
}

/** Writes an audit log entry for payment operations, silently swallowing write failures. */
async function logAudit(
  userId: string | undefined,
  action: string,
  resourceId: string | null,
  success: boolean,
  metadata?: Prisma.InputJsonValue
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
        action,
        resource: 'payment',
        resourceId,
        success,
        metadata: metadata || undefined,
      },
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}

/**
 * Rejects processing when the payment is flagged and not released, auditing
 * the compliance block before throwing.
 */
async function assertPaymentNotComplianceBlocked(
  userId: string,
  paymentId: string,
  transaction: Transaction
): Promise<void> {
  if (!transaction.isFlagged || transaction.flagReviewAction === 'release') {
    return;
  }

  const blocked = transaction.flagReviewAction === 'block';
  await logAudit(userId, 'payment_process_blocked', paymentId, false, {
    reason: blocked ? 'blocked_by_compliance_review' : 'flagged_for_compliance_review',
    flagReviewAction: transaction.flagReviewAction,
  });
  throw new Error(
    blocked ? 'Payment is blocked by compliance review' : 'Payment is flagged for compliance review'
  );
}

const SANCTIONED_COUNTRIES = ['KP', 'IR', 'SY', 'CU'];

/**
 * KYC gating helper. Checks whether the user's highest approved KYC level
 * satisfies the requirements for the given payment amount. Throws
 * ComplianceError on failure. Payments below the configured threshold always
 * succeed regardless of KYC status.
 */
async function requireKYC(userId: string, amount: string): Promise<void> {
  const amountNum = parseFloat(amount);

  // Below the threshold — no KYC required
  if (env.KYC_REQUIRED_THRESHOLD_USD > 0 && amountNum < env.KYC_REQUIRED_THRESHOLD_USD) {
    return;
  }

  // No threshold configured — KYC gating disabled
  if (!env.KYC_REQUIRED_THRESHOLD_USD) {
    return;
  }

  // Select the highest-level *approved* KYC record for this user rather than
  // the most recently updated one. This prevents a stale BASIC record from
  // overriding a valid ENHANCED approval.
  const LEVEL_PRIORITY: Record<string, number> = { ENHANCED: 3, STANDARD: 2, BASIC: 1 };

  const approvedRecords = await prisma.kYCRecord.findMany({
    where: { userId, status: 'approved' },
  });

  const bestRecord =
    approvedRecords.sort(
      (a, b) => (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0)
    )[0] ?? null;

  if (!bestRecord) {
    throw new ComplianceError(
      'KYC verification required for payments >= $' + env.KYC_REQUIRED_THRESHOLD_USD,
      'KYC_REQUIRED',
      403
    );
  }

  // Enhanced due diligence required for payments >= $10,000
  if (amountNum >= 10000) {
    if (bestRecord.level !== 'ENHANCED') {
      throw new ComplianceError(
        'Enhanced due diligence (KYC Level ENHANCED) required for payments >= $10,000',
        'ENHANCED_KYC_REQUIRED',
        403
      );
    }
  }

  // Standard level required for payments >= $1,000 (when threshold is exactly $1,000)
  if (amountNum >= 1000 && bestRecord.level === 'BASIC') {
    throw new ComplianceError(
      'Standard KYC verification (Level 2) required for payments >= $1,000',
      'KYC_LEVEL_2_REQUIRED',
      403
    );
  }
}

/** Checks the beneficiary country against the sanctions list and returns pass/fail. */
async function performSanctionsScreening(
  beneficiaryCountry?: string
): Promise<'passed' | 'failed'> {
  if (
    beneficiaryCountry &&
    SANCTIONED_COUNTRIES.includes(beneficiaryCountry.trim().toUpperCase())
  ) {
    return 'failed';
  }
  return 'passed';
}

/** Validates that beneficiary info is present for amounts >= $1,000 per the Travel Rule. */
async function checkTravelRuleCompliance(
  amount: string,
  beneficiaryInfo?: { name: string; country: string }
): Promise<'passed' | 'failed' | 'not_applicable'> {
  const amountNum = parseFloat(amount);
  if (amountNum < 1000) {
    return 'not_applicable';
  }
  if (!beneficiaryInfo?.name || !beneficiaryInfo.country) {
    return 'failed';
  }
  return 'passed';
}

/** Runs sanctions screening, Travel Rule validation, and KYC verification in one pass. */
async function performComplianceChecks(
  userId: string,
  amount: string,
  beneficiaryInfo?: { name: string; country: string }
): Promise<ComplianceCheckResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { kycRecords: { where: { status: 'approved' }, take: 1 } },
  });

  const kycVerified = (user?.kycRecords?.length ?? 0) > 0 || user?.isVerified === true;

  const sanctionsScreening = await performSanctionsScreening(beneficiaryInfo?.country);
  const travelRule = await checkTravelRuleCompliance(amount, beneficiaryInfo);

  return {
    sanctionsScreening,
    travelRule,
    kycVerified,
    checkedAt: new Date(),
  };
}

export const PaymentService = {
  /**
   * Creates a cross-border payment, running AML screening and transaction
   * monitoring, and flagging the payment for manual review when monitoring
   * fails.
   */
  async createCrossBorderPayment(
    options: CreateCrossBorderPaymentOptions,
    userId: string
  ): Promise<CrossBorderPaymentResult> {
    if (!StrKey.isValidEd25519PublicKey(options.destinationAddress)) {
      throw new Error('Invalid Stellar destination address');
    }

    const amountNum = parseFloat(options.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new Error('Amount must be a positive number');
    }

    if (!options.assetCode || !/^[a-zA-Z0-9]{1,12}$/.test(options.assetCode)) {
      throw new Error('Asset code must be a non-empty alphanumeric string of 1 to 12 characters');
    }

    if (options.assetCode !== 'XLM') {
      if (!options.assetIssuer) {
        throw new Error('Asset issuer is required for non-XLM assets');
      }
      if (!StrKey.isValidEd25519PublicKey(options.assetIssuer)) {
        throw new Error('Invalid Stellar asset issuer address');
      }
    } else if (options.assetIssuer) {
      throw new Error('Asset issuer must not be provided for XLM (native asset)');
    }

    const wallet = await prisma.wallet.findUnique({
      where: { id: options.sourceWalletId },
    });

    if (!wallet) {
      throw new Error('Wallet not found');
    }
    if (wallet.userId !== userId) {
      throw new Error('Wallet does not belong to user');
    }

    // KYC gating — checks threshold-based requirements
    await requireKYC(userId, options.amount);

    const complianceChecks = await performComplianceChecks(
      userId,
      options.amount,
      options.beneficiaryInfo
    );

    if (complianceChecks.sanctionsScreening === 'failed') {
      await logAudit(userId, 'payment_create_blocked', null, false, {
        reason: 'sanctions_screening_failed',
        destinationAddress: options.destinationAddress,
        beneficiaryCountry: options.beneficiaryInfo?.country,
      });
      throw new Error('Payment blocked: sanctions screening failed');
    }

    if (complianceChecks.travelRule === 'failed') {
      await logAudit(userId, 'payment_create_blocked', null, false, {
        reason: 'travel_rule_failed',
        amount: options.amount,
      });
      throw new Error('Payment blocked: beneficiary information required for amounts >= 1000');
    }

    const transaction = await prisma.transaction.create({
      data: {
        userId,
        walletId: options.sourceWalletId,
        type: 'transfer',
        status: 'created',
        amount: options.amount,
        assetCode: options.assetCode,
        assetIssuer: options.assetIssuer || null,
        fromAddress: wallet.publicKey,
        toAddress: options.destinationAddress,
        metadata: {
          purpose: options.purpose,
          memo: options.memo || null,
          beneficiaryInfo: options.beneficiaryInfo || null,
          complianceChecks: {
            sanctionsScreening: complianceChecks.sanctionsScreening,
            travelRule: complianceChecks.travelRule,
            kycVerified: complianceChecks.kycVerified,
            checkedAt: complianceChecks.checkedAt.toISOString(),
          },
          paymentType: 'cross_border',
        },
      },
    });

    let monitorError: unknown;
    try {
      const monitorResult = await TransactionMonitorService.evaluate(transaction);
      if (monitorResult.flagged) {
        await TransactionMonitorService.applyFlags(transaction, monitorResult);
      }
    } catch (error) {
      monitorError = error;
      console.error('Transaction monitoring failed; flagging payment for manual review:', error);
      try {
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            isFlagged: true,
            flagReason: 'Monitoring error - payment requires manual review',
            flaggedAt: new Date(),
            flaggedBy: 'monitoring',
          },
        });
      } catch (flagError) {
        console.error('Failed to flag payment after monitoring error:', flagError);
      }
    }

    if (monitorError !== undefined) {
      const monitorErrorMessage =
        monitorError instanceof Error ? monitorError.message : JSON.stringify(monitorError);
      await logAudit(userId, 'payment_create_monitor_failed', transaction.id, false, {
        amount: options.amount,
        assetCode: options.assetCode,
        error: monitorErrorMessage,
      });
    } else {
      await logAudit(userId, 'payment_create', transaction.id, true, {
        amount: options.amount,
        assetCode: options.assetCode,
        destinationAddress: options.destinationAddress,
        purpose: options.purpose,
      });
    }

    return {
      payment: mapToPaymentStatus(transaction),
      sourceWalletId: options.sourceWalletId,
      destinationAddress: options.destinationAddress,
      amount: options.amount,
      assetCode: options.assetCode,
      assetIssuer: options.assetIssuer,
      memo: options.memo,
      purpose: options.purpose,
      beneficiaryInfo: options.beneficiaryInfo,
      complianceChecks,
    };
  },

  /**
   * Processes a created cross-border payment, enforcing the compliance
   * review gate before claiming the payment for processing.
   */
  async processPayment(paymentId: string, userId: string): Promise<PaymentStatus> {
    const transaction = await prisma.transaction.findUnique({
      where: { id: paymentId },
      include: { wallet: true },
    });

    if (transaction?.userId !== userId) {
      throw new Error('Payment not found');
    }

    const txMetadata = transaction.metadata as Record<string, unknown> | null;
    if (txMetadata?.paymentType !== 'cross_border') {
      throw new Error('Payment not found');
    }

    if (transaction.status !== 'created') {
      throw new Error('Only created payments can be processed');
    }

    await assertPaymentNotComplianceBlocked(userId, paymentId, transaction);

    const updateCount = await prisma.transaction.updateMany({
      where: { id: paymentId, status: 'created' },
      data: { status: 'processing' },
    });

    if (updateCount.count === 0) {
      throw new Error('Payment is already being processed');
    }

    let decryptedSecretKey: string;
    try {
      decryptedSecretKey = decrypt(transaction.wallet.secretKeyEncrypted);
    } catch (decryptError: unknown) {
      const errMsg = decryptError instanceof Error ? decryptError.message : String(decryptError);
      await prisma.transaction.update({
        where: { id: paymentId },
        data: { status: 'created' },
      });
      await logAudit(userId, 'payment_process_failed', paymentId, false, {
        error: 'Failed to decrypt wallet secret key',
        details: errMsg,
      });
      throw new Error('Wallet decryption failure');
    }

    try {
      const sourceKeypair = Keypair.fromSecret(decryptedSecretKey);
      const networkPassphrase =
        process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

      const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());

      const txBuilder = new TransactionBuilder(sourceAccount, {
        fee: '100',
        networkPassphrase,
      });

      const metadata = transaction.metadata as Record<string, unknown> | null;
      const memo = (metadata?.memo as string) || transaction.toAddress?.slice(0, 28);
      if (memo) {
        txBuilder.addMemo(Memo.text(memo));
      }

      const asset = transaction.assetIssuer
        ? new Asset(transaction.assetCode, transaction.assetIssuer)
        : Asset.native();

      txBuilder.addOperation(
        Operation.payment({
          destination: transaction.toAddress!,
          asset,
          amount: transaction.amount,
        })
      );

      txBuilder.setTimeout(60);

      const stellarTx = txBuilder.build();
      stellarTx.sign(sourceKeypair);

      const response = await server.submitTransaction(stellarTx);

      const updatedTx = await prisma.transaction.update({
        where: { id: paymentId },
        data: {
          status: 'completed',
          stellarTxId: response.hash,
          completedAt: new Date(),
          errorMessage: null,
        },
      });

      await logAudit(userId, 'payment_process_completed', paymentId, true, {
        stellarTxId: response.hash,
      });

      await WebhookService.emitEvent({
        eventType: 'transaction.completed',
        payload: {
          transactionId: updatedTx.id,
          amount: updatedTx.amount,
          assetCode: updatedTx.assetCode,
        },
        userId,
      });

      void NotificationService.notify(userId, 'transaction-completed', {
        amount: updatedTx.amount,
        currency: updatedTx.assetCode,
        transactionId: updatedTx.id,
      }).catch((err: unknown) => {
        console.error('[PaymentService] Failed to send transaction notification:', err);
      });

      return mapToPaymentStatus(updatedTx);
    } catch (stellarError: unknown) {
      const errorMsg = getHorizonErrorMessage(stellarError);

      const updatedTx = await prisma.transaction.update({
        where: { id: paymentId },
        data: {
          status: 'failed',
          errorMessage: errorMsg,
        },
      });

      await logAudit(userId, 'payment_process_failed', paymentId, false, {
        error: errorMsg,
      });

      await WebhookService.emitEvent({
        eventType: 'transaction.failed',
        payload: { transactionId: updatedTx.id, error: errorMsg },
        userId,
      });

      void NotificationService.notify(userId, 'transaction-failed', {
        amount: updatedTx.amount,
        currency: updatedTx.assetCode,
        transactionId: updatedTx.id,
        reason: errorMsg,
      }).catch((err: unknown) => {
        console.error('[PaymentService] Failed to send transaction notification:', err);
      });

      return mapToPaymentStatus(updatedTx);
    }
  },

  async getPaymentStatus(paymentId: string, userId: string): Promise<PaymentStatus> {
    const transaction = await prisma.transaction.findUnique({
      where: { id: paymentId },
    });

    if (transaction?.userId !== userId) {
      throw new Error('Payment not found');
    }

    const metadata = transaction.metadata as Record<string, unknown> | null;
    if (metadata?.paymentType !== 'cross_border') {
      throw new Error('Payment not found');
    }

    return mapToPaymentStatus(transaction);
  },

  async getPaymentHistory(userId: string, walletId?: string): Promise<CrossBorderPaymentResult[]> {
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        ...(walletId ? { walletId } : {}),
        metadata: {
          path: ['paymentType'],
          equals: 'cross_border',
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return transactions.map((tx) => {
      const metadata = tx.metadata as Record<string, unknown> | null;
      const complianceData = metadata?.complianceChecks as Record<string, unknown> | undefined;

      return {
        payment: mapToPaymentStatus(tx),
        sourceWalletId: tx.walletId,
        destinationAddress: tx.toAddress || '',
        amount: tx.amount,
        assetCode: tx.assetCode,
        assetIssuer: tx.assetIssuer || undefined,
        memo: (metadata?.memo as string) || undefined,
        purpose: (metadata?.purpose as string) || '',
        beneficiaryInfo:
          (metadata?.beneficiaryInfo as { name: string; country: string }) || undefined,
        complianceChecks: {
          sanctionsScreening:
            (complianceData?.sanctionsScreening as 'passed' | 'failed' | 'pending') || 'pending',
          travelRule:
            (complianceData?.travelRule as 'passed' | 'failed' | 'not_applicable') ||
            'not_applicable',
          kycVerified: (complianceData?.kycVerified as boolean) || false,
          checkedAt: complianceData?.checkedAt
            ? new Date(complianceData.checkedAt as string)
            : new Date(),
        },
      };
    });
  },

  async cancelPayment(paymentId: string, userId: string): Promise<PaymentStatus> {
    const transaction = await prisma.transaction.findUnique({
      where: { id: paymentId },
    });

    if (transaction?.userId !== userId) {
      throw new Error('Payment not found');
    }

    const metadata = transaction.metadata as Record<string, unknown> | null;
    if (metadata?.paymentType !== 'cross_border') {
      throw new Error('Payment not found');
    }

    const updateResult = await prisma.transaction.updateMany({
      where: {
        id: paymentId,
        userId,
        status: { in: ['created', 'pending'] },
      },
      data: { status: 'cancelled' },
    });

    if (updateResult.count === 0) {
      throw new Error('Only created or pending payments can be cancelled');
    }

    const updatedTx = await prisma.transaction.findUnique({
      where: { id: paymentId },
    });

    await logAudit(userId, 'payment_cancel', paymentId, true);

    return mapToPaymentStatus(updatedTx!);
  },
};
