import { PayrollBatch, PayrollItem as DbPayrollItem, Prisma } from '@afri-dollar/database';
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
import { decrypt } from '../utils/crypto';

import { NotificationService } from './notification.service';
import { StellarService } from './stellar.service';
import { TransactionService } from './transaction.service';
import { WebhookService } from './webhook.service';

export interface CreatePayrollBatchOptions {
  name: string;
  description?: string;
  walletId: string;
}

export interface PayrollItem {
  id: string;
  payrollBatchId: string;
  recipientAddress: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  stellarTxId?: string;
  errorMessage?: string;
}

export interface ProcessPayrollResult {
  total: number;
  successful: number;
  failed: number;
  items: PayrollItem[];
}

const server = StellarService.getHorizonServer();

// Stellar amounts carry 7 decimal places of precision. We sum payroll totals
// in integer "stroop" units (scaled by 10^7) using BigInt to avoid the
// floating-point drift that would occur when adding decimal strings.
const ASSET_DECIMALS = 7;
const ASSET_SCALE = 10n ** BigInt(ASSET_DECIMALS);

/**
 * Parse a decimal amount string into integer stroops (scaled by 10^7).
 */
function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const paddedFraction = (fraction + '0'.repeat(ASSET_DECIMALS)).slice(0, ASSET_DECIMALS);
  return BigInt(whole) * ASSET_SCALE + BigInt(paddedFraction || '0');
}

/**
 * Format integer stroops (scaled by 10^7) back into a decimal amount string,
 * trimming insignificant trailing zeros while always keeping at least one
 * decimal place.
 */
function fromStroops(stroops: bigint): string {
  const whole = stroops / ASSET_SCALE;
  const fraction = (stroops % ASSET_SCALE).toString().padStart(ASSET_DECIMALS, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : `${whole}.0`;
}

/**
 * Safely extracts error messages from a Stellar Horizon response.
 */
function getHorizonErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    const message =
      typeof errObj.message === 'string' ? errObj.message : 'Unknown Stellar Horizon error';

    // Check if there is a response with result codes
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

/**
 * Map database payroll item model to defined frontend/service PayrollItem interface
 */
function mapToPayrollItem(item: DbPayrollItem): PayrollItem {
  return {
    id: item.id,
    payrollBatchId: item.payrollBatchId,
    recipientAddress: item.recipientAddress,
    amount: item.amount,
    assetCode: item.assetCode,
    assetIssuer: item.assetIssuer || undefined,
    memo: item.memo || undefined,
    status: item.status as 'pending' | 'processing' | 'completed' | 'failed',
    stellarTxId: item.stellarTxId || undefined,
    errorMessage: item.errorMessage || undefined,
  };
}

type PayrollBatchWithWallet = PayrollBatch & { wallet: { userId: string } };

/**
 * Verify the batch exists and belongs to the authenticated user.
 * Returns a generic not-found error to avoid leaking batch existence.
 */
async function assertBatchOwnedByUser(
  batchId: string,
  userId: string
): Promise<PayrollBatchWithWallet> {
  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId },
    include: { wallet: { select: { userId: true } } },
  });

  if (batch?.wallet.userId !== userId) {
    throw new Error('Payroll batch not found');
  }

  return batch;
}

/**
 * Audit log helper
 */
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
        resource: 'payroll_batch',
        resourceId,
        success,
        metadata: metadata || undefined,
      },
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}

export const PayrollService = {
  /**
   * Create a new payroll batch
   */
  async createPayrollBatch(
    options: CreatePayrollBatchOptions,
    userId: string
  ): Promise<PayrollBatch> {
    // Verify wallet exists and belongs to the user
    const wallet = await prisma.wallet.findUnique({
      where: { id: options.walletId },
    });
    if (!wallet) {
      await logAudit(userId, 'payroll_batch_create_failed', null, false, {
        error: 'Wallet not found',
        walletId: options.walletId,
      });
      throw new Error('Wallet not found');
    }
    if (wallet.userId !== userId) {
      await logAudit(userId, 'payroll_batch_create_failed', null, false, {
        error: 'Wallet does not belong to user',
        walletId: options.walletId,
      });
      throw new Error('Wallet does not belong to user');
    }

    const batch = await prisma.payrollBatch.create({
      data: {
        name: options.name,
        description: options.description,
        walletId: options.walletId,
        status: 'pending',
      },
    });

    await logAudit(userId, 'payroll_batch_create', batch.id, true, {
      name: options.name,
      walletId: options.walletId,
    });
    return batch;
  },

  /**
   * Add a payroll item to a batch
   */
  async addPayrollItem(
    batchId: string,
    itemData: Omit<
      PayrollItem,
      'id' | 'payrollBatchId' | 'status' | 'stellarTxId' | 'errorMessage'
    >,
    userId: string
  ): Promise<PayrollItem> {
    const batch = await assertBatchOwnedByUser(batchId, userId);
    if (batch.status !== 'pending') {
      throw new Error('Cannot add items to a batch that is not pending approval');
    }

    // Validate recipientAddress is a valid Stellar address format
    if (!itemData.recipientAddress || !StrKey.isValidEd25519PublicKey(itemData.recipientAddress)) {
      throw new Error('Invalid Stellar recipient address');
    }

    // Validate amount is a positive numeric string
    const amountNum = parseFloat(itemData.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw new Error('Amount must be a positive number');
    }

    // Validate assetCode is a non-empty alphanumeric string of 1 to 12 characters
    if (!itemData.assetCode || !/^[a-zA-Z0-9]{1,12}$/.test(itemData.assetCode)) {
      throw new Error('Asset code must be a non-empty alphanumeric string of 1 to 12 characters');
    }

    // Validate assetIssuer rules based on whether the asset is XLM (native) or not
    if (itemData.assetCode !== 'XLM') {
      if (!itemData.assetIssuer) {
        throw new Error('Asset issuer is required for non-XLM assets');
      }
      if (!StrKey.isValidEd25519PublicKey(itemData.assetIssuer)) {
        throw new Error('Invalid Stellar asset issuer address');
      }
    } else {
      if (itemData.assetIssuer) {
        throw new Error('Asset issuer must not be provided for XLM (native asset)');
      }
    }

    const item = await prisma.payrollItem.create({
      data: {
        payrollBatchId: batchId,
        recipientAddress: itemData.recipientAddress,
        amount: itemData.amount,
        assetCode: itemData.assetCode,
        assetIssuer: itemData.assetIssuer || null,
        memo: itemData.memo || null,
        status: 'pending',
      },
    });

    await logAudit(userId, 'payroll_item_add', batchId, true, { itemId: item.id });
    return mapToPayrollItem(item);
  },

  /**
   * Executes a single approved payroll item on Stellar via
   * TransactionService (build → sign → submit → track). The batch must be
   * approved or already processing; an approved batch is atomically advanced
   * to `processing` so processPayrollBatch cannot claim it concurrently.
   * The item is atomically claimed before funds move so concurrent workers
   * cannot double-pay, and a failed item is only re-paid after Horizon
   * confirms its previous attempt did not land.
   */
  async payPayrollItem(batchId: string, itemId: string, userId: string): Promise<PayrollItem> {
    const batch = await assertBatchOwnedByUser(batchId, userId);
    if (batch.status !== 'approved' && batch.status !== 'processing') {
      throw new Error('Payroll batch must be approved before items can be paid');
    }

    // Advance an approved batch to processing (atomic no-op if another
    // worker already did) so the batch processor cannot double-claim it.
    await prisma.payrollBatch.updateMany({
      where: { id: batchId, status: 'approved' },
      data: { status: 'processing' },
    });

    const item = await prisma.payrollItem.findFirst({
      where: { id: itemId, payrollBatchId: batchId },
    });
    if (!item) {
      throw new Error('Payroll item not found');
    }

    // A previously failed item may have settled after a submission timeout.
    // Reconcile any indeterminate prior attempt with Horizon before paying
    // again — only deterministic failures prove the ledger never changed.
    let priorFailedRowId: string | undefined;
    if (item.status === 'failed') {
      const priorRow = await prisma.transaction.findFirst({
        where: {
          metadata: { path: ['payrollItemId'], equals: itemId },
          status: 'failed',
        },
        orderBy: { createdAt: 'desc' },
      });
      priorFailedRowId = priorRow?.id;

      // Reconciles an attempted payment hash with Horizon:
      //  - 'recover' → it actually landed; caller should mark complete
      //  - 'wait'    → still unresolved on-chain; retry later
      //  - 'safe'    → confirmed failed / never landed; safe to re-pay
      const reconcileAttempt = async (
        attemptHash: string
      ): Promise<'recover' | 'wait' | 'safe'> => {
        const chain = await TransactionService.getTransactionStatus(attemptHash);
        if (chain.status === 'successful') return 'recover';
        if (chain.status === 'pending') return 'wait';
        return 'safe';
      };

      // Attempt hash recorded directly on the item by the batch processor.
      if (item.stellarTxId && item.errorMessage?.startsWith('SUBMISSION_TIMEOUT')) {
        const outcome = await reconcileAttempt(item.stellarTxId);
        if (outcome === 'recover') {
          const recovered = await prisma.payrollItem.update({
            where: { id: itemId },
            data: { status: 'completed', stellarTxId: item.stellarTxId, errorMessage: null },
          });
          await logAudit(userId, 'payroll_item_recovered_on_chain', batchId, true, {
            itemId,
            stellarTxId: item.stellarTxId,
          });
          return mapToPayrollItem(recovered);
        }
        if (outcome === 'wait') {
          throw new Error(
            'Previous payment attempt is still unresolved on-chain; retry after reconciliation'
          );
        }
      }

      const indeterminate = await prisma.transaction.findFirst({
        where: {
          metadata: { path: ['payrollItemId'], equals: itemId },
          status: 'failed',
          errorCode: { in: ['SUBMISSION_TIMEOUT'] },
          stellarTxId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (indeterminate?.stellarTxId) {
        const outcome = await reconcileAttempt(indeterminate.stellarTxId);
        if (outcome === 'recover') {
          // The original payment actually landed — mark the item complete
          // instead of creating a second payment.
          const recovered = await prisma.payrollItem.update({
            where: { id: itemId },
            data: {
              status: 'completed',
              stellarTxId: indeterminate.stellarTxId,
              errorMessage: null,
            },
          });
          await logAudit(userId, 'payroll_item_recovered_on_chain', batchId, true, {
            itemId,
            stellarTxId: indeterminate.stellarTxId,
          });
          return mapToPayrollItem(recovered);
        }
        if (outcome === 'wait') {
          throw new Error(
            'Previous payment attempt is still unresolved on-chain; retry after reconciliation'
          );
        }
        // outcome === 'safe' → deterministically never landed; retry below.
      }
    }

    // Atomic claim — only pending/failed items can be paid.
    const claim = await prisma.payrollItem.updateMany({
      where: { id: itemId, status: { in: ['pending', 'failed'] } },
      data: { status: 'processing' },
    });
    if (claim.count === 0) {
      throw new Error('Payroll item cannot be paid in its current state');
    }

    try {
      const payment = await TransactionService.buildAndSubmitPayment({
        sourceWalletId: batch.walletId,
        userId,
        destination: item.recipientAddress,
        amount: item.amount,
        assetCode: item.assetCode,
        assetIssuer: item.assetIssuer || undefined,
        memo: item.memo || undefined,
        metadata: { payrollItemId: itemId, payrollBatchId: batchId },
        // Re-execution of a failed payment reuses the SAME transaction row
        // (and its atomic failed→submitted claim) as the admin rebuild path,
        // so payroll retries and admin rebuilds are mutually exclusive and
        // can never both submit.
        ...(priorFailedRowId ? { paymentId: priorFailedRowId } : {}),
      });

      const updated = await prisma.payrollItem.update({
        where: { id: itemId },
        data: {
          status: 'completed',
          stellarTxId: payment.stellarTxId ?? null,
          errorMessage: null,
        },
      });

      await logAudit(userId, 'payroll_item_paid', batchId, true, {
        itemId,
        stellarTxId: payment.stellarTxId,
        amount: item.amount,
        assetCode: item.assetCode,
      });

      return mapToPayrollItem(updated);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Persist the failure, but never swallow the payment error: the caller
      // must learn the payment failed even if this write itself breaks.
      // Retry once — if both writes fail, the item would stay wedged in
      // `processing` (the claim guard only accepts pending/failed), so a
      // second attempt is made before giving up and surfacing the error.
      const persistItemFailure = async (): Promise<void> => {
        try {
          await prisma.payrollItem.update({
            where: { id: itemId },
            data: { status: 'failed', errorMessage: errorMsg.slice(0, 500) },
          });
        } catch (persistError) {
          console.error('[PayrollService] Failed to persist payroll item failure:', persistError);
          try {
            await prisma.payrollItem.update({
              where: { id: itemId },
              data: { status: 'failed', errorMessage: errorMsg.slice(0, 500) },
            });
          } catch (retryError) {
            console.error(
              '[PayrollService] Payroll item remains in processing after failed persistence:',
              retryError
            );
          }
        }
      };
      await persistItemFailure();

      await logAudit(userId, 'payroll_item_payment_failed', batchId, false, {
        itemId,
        error: errorMsg,
      }).catch(() => undefined);

      throw error;
    }
  },

  /**
   * Approve a payroll batch
   */
  async approvePayrollBatch(batchId: string, userId: string): Promise<PayrollBatch> {
    let batch: PayrollBatchWithWallet;
    try {
      batch = await assertBatchOwnedByUser(batchId, userId);
    } catch (error) {
      if (error instanceof Error && error.message === 'Payroll batch not found') {
        await logAudit(userId, 'payroll_batch_approve_failed', batchId, false, {
          error: 'Batch not found',
        });
      }
      throw error;
    }
    if (batch.status !== 'pending') {
      await logAudit(userId, 'payroll_batch_approve_failed', batchId, false, {
        error: 'Batch status not pending',
        currentStatus: batch.status,
      });
      throw new Error('Only pending batches can be approved');
    }

    const updatedBatch = await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: 'approved' },
    });

    await logAudit(userId, 'payroll_batch_approve', batchId, true);
    return updatedBatch;
  },

  /**
   * Retrieve a payroll batch by ID with its items
   */
  async getPayrollBatch(
    batchId: string,
    userId: string
  ): Promise<PayrollBatch & { items: PayrollItem[] }> {
    const batch = await prisma.payrollBatch.findUnique({
      where: { id: batchId },
      include: {
        items: true,
        wallet: { select: { userId: true } },
      },
    });

    if (batch?.wallet.userId !== userId) {
      throw new Error('Payroll batch not found');
    }

    return {
      ...batch,
      items: batch.items.map(mapToPayrollItem),
    };
  },

  /**
   * Retrieve all payroll batches for a user (optionally filtered by wallet)
   */
  async getPayrollBatches(userId: string, walletId?: string): Promise<PayrollBatch[]> {
    return prisma.payrollBatch.findMany({
      where: {
        wallet: { userId },
        ...(walletId ? { walletId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Retrieve complete payroll history for a user
   */
  async getPayrollHistory(userId: string): Promise<(PayrollBatch & { items: PayrollItem[] })[]> {
    const batches = await prisma.payrollBatch.findMany({
      where: { wallet: { userId } },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return batches.map((batch) => ({
      ...batch,
      items: batch.items.map(mapToPayrollItem),
    }));
  },

  /**
   * Process payroll payments via batch Stellar transactions
   */
  async processPayrollBatch(batchId: string, userId: string): Promise<ProcessPayrollResult> {
    const batch = await prisma.payrollBatch.findUnique({
      where: { id: batchId },
      include: {
        items: true,
        wallet: true,
      },
    });

    if (batch?.wallet.userId !== userId) {
      await logAudit(userId, 'payroll_batch_process_failed', batchId, false, {
        error: 'Batch not found',
      });
      throw new Error('Payroll batch not found');
    }

    if (batch.status !== 'approved') {
      await logAudit(userId, 'payroll_batch_process_failed', batchId, false, {
        error: 'Batch is not approved',
        currentStatus: batch.status,
      });
      throw new Error('Only approved batches can be processed');
    }

    // Atomically transition status to processing to prevent double-processing
    const updateCount = await prisma.payrollBatch.updateMany({
      where: { id: batchId, status: 'approved' },
      data: { status: 'processing' },
    });

    if (updateCount.count === 0) {
      throw new Error('Batch is already being processed');
    }

    // Filter items that are pending or failed to process
    const itemsToProcess = batch.items.filter(
      (item) => item.status === 'pending' || item.status === 'failed'
    );

    if (itemsToProcess.length === 0) {
      await prisma.payrollBatch.update({
        where: { id: batchId },
        data: { status: 'completed' },
      });
      await logAudit(userId, 'payroll_batch_process_completed', batchId, true, {
        successful: 0,
        failed: 0,
        total: 0,
      });
      return { total: 0, successful: 0, failed: 0, items: [] };
    }

    // Decrypt the private key to sign transactions
    let decryptedSecretKey: string;
    try {
      decryptedSecretKey = decrypt(batch.wallet.secretKeyEncrypted);
    } catch (decryptError: unknown) {
      const errMsg = decryptError instanceof Error ? decryptError.message : String(decryptError);
      await prisma.payrollBatch.update({
        where: { id: batchId },
        data: { status: 'approved' }, // Roll back status to approved
      });
      await logAudit(userId, 'payroll_batch_process_failed', batchId, false, {
        error: 'Failed to decrypt wallet secret key',
        details: errMsg,
      });
      throw new Error('Wallet decryption failure');
    }

    const sourceKeypair = Keypair.fromSecret(decryptedSecretKey);
    const networkPassphrase =
      process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    // Claim the snapshot's still-payable items atomically. The status guard
    // ensures an item completed concurrently by payPayrollItem is never
    // reset to `processing` and paid a second time.
    await prisma.payrollItem.updateMany({
      where: {
        id: { in: itemsToProcess.map((i) => i.id) },
        status: { in: ['pending', 'failed'] },
      },
      data: { status: 'processing' },
    });

    // Re-read the claimed rows so items that were paid concurrently between
    // the batch snapshot and the claim drop out of execution entirely.
    const claimedItems = await prisma.payrollItem.findMany({
      where: { id: { in: itemsToProcess.map((i) => i.id) }, status: 'processing' },
    });

    if (claimedItems.length === 0) {
      const updatedBatch = await prisma.payrollBatch.update({
        where: { id: batchId },
        data: { status: 'completed' },
        include: { items: true },
      });
      await logAudit(userId, 'payroll_batch_process', batchId, true, {
        total: 0,
        successful: 0,
        failed: 0,
      });
      return {
        total: 0,
        successful: 0,
        failed: 0,
        items: updatedBatch.items.map(mapToPayrollItem),
      };
    }

    // Group items by Asset (assetCode + assetIssuer) and Memo, as Stellar transaction has 1 memo and 100 operation limits
    const groups: { [key: string]: DbPayrollItem[] } = {};
    for (const item of claimedItems) {
      const assetKey = `${item.assetCode}:${item.assetIssuer || ''}`;
      const memoKey = item.memo || '';
      const groupKey = `${assetKey}::${memoKey}`;
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(item);
    }

    const successfulItems: DbPayrollItem[] = [];
    const failedItems: DbPayrollItem[] = [];

    // Process each group
    for (const groupKey of Object.keys(groups)) {
      const groupItems = groups[groupKey];

      // Chunk items into sub-batches of maximum 100 operations (Stellar Tx limit)
      const chunkSize = 100;
      for (let i = 0; i < groupItems.length; i += chunkSize) {
        const chunk = groupItems.slice(i, i + chunkSize);
        // Hash is computed before submission so an indeterminate failure can
        // be reconciled later instead of blindly re-paid.
        let txHash: string | undefined;

        try {
          // Fetch the source account to get the latest sequence number
          const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());

          // Build batch transaction
          const txBuilder = new TransactionBuilder(sourceAccount, {
            fee: '100', // Base fee (100 stroops)
            networkPassphrase,
          });

          // Add memo if available
          if (chunk[0].memo) {
            txBuilder.addMemo(Memo.text(chunk[0].memo));
          }

          // Add payment operations
          for (const item of chunk) {
            const asset = item.assetIssuer
              ? new Asset(item.assetCode, item.assetIssuer)
              : Asset.native();
            txBuilder.addOperation(
              Operation.payment({
                destination: item.recipientAddress,
                asset,
                amount: item.amount,
              })
            );
          }

          // Set short timeout bounds
          txBuilder.setTimeout(60);

          const transaction = txBuilder.build();
          transaction.sign(sourceKeypair);
          txHash = transaction.hash().toString('hex');

          // Submit to Horizon network
          const response = await server.submitTransaction(transaction);
          const stellarTxId = response.hash;

          // Update items on success
          for (const item of chunk) {
            const updated = await prisma.payrollItem.update({
              where: { id: item.id },
              data: {
                status: 'completed',
                stellarTxId,
                errorMessage: null,
              },
            });
            successfulItems.push(updated);
          }
        } catch (batchError: unknown) {
          const batchErrMsg = batchError instanceof Error ? batchError.message : String(batchError);

          // An indeterminate failure (timeout / network drop / Horizon 5xx)
          // may have actually landed on-chain. Re-submitting the chunk would
          // risk double-paying every recipient, so record the attempted hash
          // and fail the items safely — they remain retryable through
          // payPayrollItem, which reconciles the hash with Horizon first.
          const responseStatus = (batchError as { response?: { status?: number } } | undefined)
            ?.response?.status;
          // Any network-level failure or 5xx (including 504 gateway timeouts)
          // leaves the on-chain outcome unknown — treat it as indeterminate.
          const isIndeterminate = responseStatus === undefined || responseStatus >= 500;

          if (isIndeterminate && txHash) {
            for (const item of chunk) {
              const updated = await prisma.payrollItem.update({
                where: { id: item.id },
                data: {
                  status: 'failed',
                  stellarTxId: txHash,
                  errorMessage: `SUBMISSION_TIMEOUT:${txHash} — ${batchErrMsg}`.slice(0, 500),
                },
              });
              failedItems.push(updated);
            }
            continue;
          }

          // Log batch failure and fallback to sequential processing
          console.warn(
            `Batch processing failed for chunk. Retrying items individually. Error: ${batchErrMsg}`
          );

          // Process each item individually
          for (const item of chunk) {
            try {
              const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
              const txBuilder = new TransactionBuilder(sourceAccount, {
                fee: '100',
                networkPassphrase,
              });

              if (item.memo) {
                txBuilder.addMemo(Memo.text(item.memo));
              }

              const asset = item.assetIssuer
                ? new Asset(item.assetCode, item.assetIssuer)
                : Asset.native();
              txBuilder.addOperation(
                Operation.payment({
                  destination: item.recipientAddress,
                  asset,
                  amount: item.amount,
                })
              );

              txBuilder.setTimeout(60);

              const transaction = txBuilder.build();
              transaction.sign(sourceKeypair);

              const response = await server.submitTransaction(transaction);

              const updated = await prisma.payrollItem.update({
                where: { id: item.id },
                data: {
                  status: 'completed',
                  stellarTxId: response.hash,
                  errorMessage: null,
                },
              });
              successfulItems.push(updated);
            } catch (singleError: unknown) {
              // Extract structured error codes from Horizon response if available
              const errorMsg = getHorizonErrorMessage(singleError);

              const updated = await prisma.payrollItem.update({
                where: { id: item.id },
                data: {
                  status: 'failed',
                  errorMessage: errorMsg,
                },
              });
              failedItems.push(updated);
            }
          }
        }
      }
    }

    // Determine overall batch status
    let finalStatus: 'completed' | 'failed' = 'completed';
    if (successfulItems.length === 0 && failedItems.length > 0) {
      finalStatus = 'failed';
    }

    const updatedBatch = await prisma.payrollBatch.update({
      where: { id: batchId },
      data: { status: finalStatus },
      include: { items: true },
    });

    const result: ProcessPayrollResult = {
      total: claimedItems.length,
      successful: successfulItems.length,
      failed: failedItems.length,
      items: updatedBatch.items.map(mapToPayrollItem),
    };

    await logAudit(userId, 'payroll_batch_process', batchId, finalStatus === 'completed', {
      total: result.total,
      successful: result.successful,
      failed: result.failed,
    });

    await WebhookService.emitEvent({
      eventType: 'payroll.processed',
      payload: {
        batchId,
        total: result.total,
        successful: result.successful,
        failed: result.failed,
      },
      userId,
    });

    const totalsByAsset = new Map<string, { count: number; total: bigint }>();
    for (const item of successfulItems) {
      const entry = totalsByAsset.get(item.assetCode) ?? { count: 0, total: 0n };
      entry.count += 1;
      entry.total += toStroops(item.amount);
      totalsByAsset.set(item.assetCode, entry);
    }

    for (const [assetCode, { count, total }] of totalsByAsset) {
      void NotificationService.notify(userId, 'payroll-processed', {
        batchName: batch.name,
        count,
        total: fromStroops(total),
        currency: assetCode,
      }).catch((err: unknown) => {
        console.error('[PayrollService] Failed to send payroll notification:', err);
      });
    }

    return result;
  },
};
