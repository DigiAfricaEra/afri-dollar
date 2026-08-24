import { Prisma, type Transaction as DbTransaction } from '@afri-dollar/database';
import {
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  Account,
  Asset,
  Memo,
  Keypair,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { env } from '../config/env';
import { AppError } from '../types';
import {
  OP_RESULT_CODE_MAP,
  STELLAR_ERROR_CODES,
  TX_RESULT_CODE_MAP,
  type BatchPayoutItemResult,
  type BatchPayoutOptions,
  type BatchPayoutResult,
  type BuiltPaymentTransaction,
  type BuildPaymentOptions,
  type PaymentRecord,
  type SignedTransactionResult,
  type StellarTxStatus,
} from '../types/transaction.types';
import { decrypt } from '../utils/crypto';

import { NotificationService } from './notification.service';
import { StellarService } from './stellar.service';
import { WebhookService } from './webhook.service';

// ──────────────────────────────────────────────────────────────────────────────
// Constants & low-level helpers
// ──────────────────────────────────────────────────────────────────────────────

const DEFAULT_BASE_FEE_STROOPS = 100;
/** Max fee headroom multiplier to avoid fee-bump failures during congestion. */
const MAX_FEE_MULTIPLIER = 2;
/** Default time bounds window (seconds) to prevent replay attacks. */
export const DEFAULT_TIMEBOUND_SECONDS = 300;

/** Stellar amounts carry at most 7 decimal places (stroops). */
export const AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/;
export const MAX_MEMO_LENGTH = 28;

const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

function getNetworkPassphrase(): string {
  return process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

/**
 * Thrown internally when a Horizon submission fails with a deterministic
 * result code. Carries the mapped structured AppError.
 */
class SubmissionError extends Error {
  readonly appError: AppError;
  readonly txResultCode?: string;
  readonly opResultCodes: string[];

  constructor(appError: AppError, txResultCode?: string, opResultCodes: string[] = []) {
    super(appError.message);
    this.appError = appError;
    this.txResultCode = txResultCode;
    this.opResultCodes = opResultCodes;
  }
}

/** Extracts Horizon `result_codes` extras from an SDK NetworkError, if present. */
function extractHorizonResultCodes(error: unknown):
  | {
      transaction?: string;
      operations?: string[];
    }
  | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  const data = response?.data as Record<string, unknown> | undefined;
  const extras = data?.extras as Record<string, unknown> | undefined;
  const resultCodes = extras?.result_codes as Record<string, unknown> | undefined;
  if (!resultCodes) return undefined;

  return {
    transaction: typeof resultCodes.transaction === 'string' ? resultCodes.transaction : undefined,
    operations: Array.isArray(resultCodes.operations)
      ? resultCodes.operations.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

function isTimeoutError(error: unknown): boolean {
  if (
    error instanceof DOMException ||
    (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError')
  ) {
    return true;
  }
  const err = error as Record<string, unknown> | undefined;
  const code = err?.code;
  return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED';
}

/** True when the error looks transient (network outage, timeout, 5xx). */
function isTransientSubmissionError(error: unknown): boolean {
  if (extractHorizonResultCodes(error)) return false;
  if (isTimeoutError(error)) return true;

  const err = error as Record<string, unknown> | undefined;
  const status =
    err && typeof err.status === 'number'
      ? err.status
      : ((err?.response as Record<string, unknown> | undefined)?.status as number | undefined);
  if (typeof status === 'number') return status >= 500 || status === 429;
  // No structured response at all — assume network-level failure.
  return true;
}

/** Maps a Horizon submission error to a structured AppError. */
function mapSubmissionError(error: unknown): SubmissionError {
  const codes = extractHorizonResultCodes(error);

  if (codes) {
    const txMapping = codes.transaction ? TX_RESULT_CODE_MAP[codes.transaction] : undefined;
    const opMapping = (codes.operations ?? [])
      .map((opCode) => OP_RESULT_CODE_MAP[opCode])
      .find((m) => m !== undefined);

    const mapping = opMapping ?? txMapping;
    if (mapping) {
      return new SubmissionError(
        new AppError(mapping.status, mapping.code, mapping.code),
        codes.transaction,
        codes.operations ?? []
      );
    }

    const detail = [
      codes.transaction ? `transaction=${codes.transaction}` : undefined,
      codes.operations?.length ? `operations=[${codes.operations.join(', ')}]` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return new SubmissionError(
      new AppError(502, `Stellar transaction failed${detail ? `: ${detail}` : ''}`),
      codes.transaction,
      codes.operations ?? []
    );
  }

  if (isTimeoutError(error)) {
    return new SubmissionError(
      new AppError(
        504,
        STELLAR_ERROR_CODES.SUBMISSION_TIMEOUT,
        STELLAR_ERROR_CODES.SUBMISSION_TIMEOUT
      )
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new SubmissionError(new AppError(502, `Stellar submission failed: ${message}`));
}

// ──────────────────────────────────────────────────────────────────────────────
// Input validation
// ──────────────────────────────────────────────────────────────────────────────

/** Validates a destination address, amount and memo; throws structured AppErrors. */
export function assertValidPaymentInputs(options: {
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
}): void {
  if (!StrKey.isValidEd25519PublicKey(options.destination)) {
    throw new AppError(
      400,
      STELLAR_ERROR_CODES.INVALID_DESTINATION,
      STELLAR_ERROR_CODES.INVALID_DESTINATION
    );
  }

  if (
    typeof options.amount !== 'string' ||
    !AMOUNT_REGEX.test(options.amount) ||
    parseFloat(options.amount) <= 0
  ) {
    throw new AppError(400, STELLAR_ERROR_CODES.INVALID_AMOUNT, STELLAR_ERROR_CODES.INVALID_AMOUNT);
  }

  if (!options.assetCode || !/^[a-zA-Z0-9]{1,12}$/.test(options.assetCode)) {
    throw new AppError(400, 'Asset code must be 1-12 alphanumeric characters');
  }

  if (options.assetCode === 'XLM' && options.assetIssuer) {
    throw new AppError(400, 'Asset issuer must not be provided for XLM (native asset)');
  }

  if (options.assetCode !== 'XLM') {
    if (!options.assetIssuer) {
      throw new AppError(400, 'Asset issuer is required for non-XLM assets');
    }
    if (!StrKey.isValidEd25519PublicKey(options.assetIssuer)) {
      throw new AppError(
        400,
        STELLAR_ERROR_CODES.INVALID_DESTINATION,
        STELLAR_ERROR_CODES.INVALID_DESTINATION
      );
    }
  }

  if (options.memo !== undefined && Buffer.byteLength(options.memo, 'utf8') > MAX_MEMO_LENGTH) {
    throw new AppError(400, `Memo must be at most ${MAX_MEMO_LENGTH} bytes`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Result XDR decoding
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal structural typings over the generated js-xdr union classes. */
interface XdrSwitchName {
  name: string;
}
interface XdrOperationResultLike {
  switch(): XdrSwitchName;
  value(): unknown;
}
interface XdrOperationResultTrLike extends XdrOperationResultLike {
  arm?(): string;
}
interface XdrTransactionResultLike {
  result(): {
    switch(): XdrSwitchName;
    results?(): XdrOperationResultLike[];
  };
}

/**
 * SDK XDR transaction result names use camelCase while Horizon's
 * `result_codes.transaction` uses snake_case — normalize so the downstream
 * TX_RESULT_CODE_MAP lookups work uniformly.
 */
const TX_XDR_NAME_TO_HORIZON: Record<string, string> = {
  txFeeBumpInnerSuccess: 'tx_fee_bump_inner_success',
  txSuccess: 'tx_success',
  txFailed: 'tx_failed',
  txTooEarly: 'tx_too_early',
  txTooLate: 'tx_too_late',
  txMissingOperation: 'tx_missing_operation',
  txBadSeq: 'tx_bad_seq',
  txBadAuth: 'tx_bad_auth',
  txInsufficientBalance: 'tx_insufficient_balance',
  txNoAccount: 'tx_no_account',
  txInsufficientFee: 'tx_insufficient_fee',
  txBadAuthExtra: 'tx_bad_auth_extra',
  txInternalError: 'tx_internal_error',
  txNotSupported: 'tx_not_supported',
  txFeeBumpInnerFailed: 'tx_fee_bump_inner_failed',
  txBadSponsorship: 'tx_bad_sponsorship',
  txBadMinSeqAgeOrGap: 'tx_bad_min_seq_age_or_gap',
  txMalformed: 'tx_malformed',
  txSorobanInvalid: 'tx_soroban_invalid',
};

/**
 * Explicit mapping from SDK XDR operation-result code names (e.g.
 * `paymentUnderfunded` nested inside `opInner`) to the Horizon
 * `result_codes.operations` strings consumed by OP_RESULT_CODE_MAP.
 * A generic camel-to-snake conversion is not sufficient (e.g.
 * paymentSrcNoTrust → op_src_no_trust, not op_payment_src_no_trust).
 */
const OP_XDR_NAME_TO_HORIZON: Record<string, string> = {
  // Generic OperationResultCode values (non-opInner switches)
  opBadAuth: 'op_bad_auth',
  opNoAccount: 'op_no_account',
  opNotSupported: 'op_not_supported',
  opTooManySubentries: 'op_too_many_subentries',
  opExceededWorkLimit: 'op_exceeded_work_limit',
  opTooManySponsoring: 'op_too_many_sponsoring',
  // CreateAccountResultCode
  createAccountMalformed: 'op_malformed',
  createAccountUnderfunded: 'op_underfunded',
  createAccountLowReserve: 'op_low_reserve',
  createAccountAlreadyExist: 'op_already_exists',
  createAccountNeedFlag: 'op_need_flag',
  // PaymentResultCode
  paymentMalformed: 'op_malformed',
  paymentUnderfunded: 'op_underfunded',
  paymentSrcNoTrust: 'op_src_no_trust',
  paymentSrcNotAuthorized: 'op_src_not_authorized',
  paymentNoDestination: 'op_no_destination',
  paymentNoTrust: 'op_no_trust',
  paymentNotAuthorized: 'op_not_authorized',
  paymentLineFull: 'op_line_full',
  paymentNoIssuer: 'op_no_issuer',
  // PathPaymentStrictReceiveResultCode / PathPaymentStrictSendResultCode
  pathPaymentMalformed: 'op_malformed',
  pathPaymentUnderfunded: 'op_underfunded',
  pathPaymentSourceNoTrust: 'op_src_no_trust',
  pathPaymentSourceNotAuthorized: 'op_src_not_authorized',
  pathPaymentNoTrust: 'op_no_trust',
  pathPaymentNotAuthorized: 'op_not_authorized',
  pathPaymentLineFull: 'op_line_full',
  pathPaymentNoIssuer: 'op_no_issuer',
  pathPaymentNoDestination: 'op_no_destination',
  pathPaymentOverSendmax: 'op_over_sendmax',
  pathPaymentOverSourceMax: 'op_over_source_max',
  pathPaymentTooFewOffers: 'op_too_few_offers',
};

function mapOpXdrName(name: string): string {
  return OP_XDR_NAME_TO_HORIZON[name] ?? name;
}

/** Extracts the Horizon-style operation result code from one OperationResult. */
function parseOpResultCode(op: XdrOperationResultLike): string {
  const outerName = op.switch().name;
  if (outerName !== 'opInner') {
    return mapOpXdrName(outerName);
  }
  // opInner wraps an OperationResultTr union: arm() is the operation type,
  // value() is the per-type result union whose switch name is the final code.
  const inner = op.value() as XdrOperationResultTrLike | null;
  if (!inner || typeof inner.switch !== 'function') {
    return outerName;
  }
  const trName = inner.switch().name;
  if (typeof inner.value !== 'function') {
    return mapOpXdrName(trName);
  }
  const code = inner.value() as XdrOperationResultLike | null;
  const finalName = code && typeof code.switch === 'function' ? code.switch().name : trName;
  return mapOpXdrName(finalName);
}

/**
 * Decodes a base64 `result_xdr` into normalized (Horizon-style) transaction +
 * per-operation result codes. Handles both `txSuccess` and `txFailed` outer
 * switches; unknown/malformed input degrades to `{ resultCode: 'unknown' }`.
 */
export function parseResultXdr(resultXdr: string): {
  resultCode: string;
  opResultCodes: string[];
} {
  try {
    const parsed = xdr.TransactionResult.fromXDR(
      resultXdr,
      'base64'
    ) as unknown as XdrTransactionResultLike;
    const outer = parsed.result();
    const rawTxName = outer.switch().name;
    const resultCode = TX_XDR_NAME_TO_HORIZON[rawTxName] ?? rawTxName;

    const opResultCodes: string[] = [];
    if ((rawTxName === 'txSuccess' || rawTxName === 'txFailed') && outer.results) {
      for (const op of outer.results()) {
        opResultCodes.push(parseOpResultCode(op));
      }
    }
    return { resultCode, opResultCodes };
  } catch {
    return { resultCode: 'unknown', opResultCodes: [] };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Audit / notification helpers (never include secret material)
// ──────────────────────────────────────────────────────────────────────────────

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
        resource: 'transaction',
        resourceId,
        success,
        metadata: metadata || undefined,
      },
    });
  } catch (error) {
    console.error('[TransactionService] Failed to write audit log:', error);
  }
}

function safeNotify(
  userId: string,
  type: 'transaction-completed' | 'transaction-failed',
  data: Record<string, unknown>
): void {
  void NotificationService.notify(userId, type, data).catch((err: unknown) => {
    console.error('[TransactionService] Failed to send notification:', err);
  });
}

function safeEmitWebhook(
  eventType: 'transaction.completed' | 'transaction.failed',
  payload: Record<string, unknown>,
  userId?: string
): void {
  void WebhookService.emitEvent({ eventType, payload, userId }).catch((err: unknown) => {
    console.error('[TransactionService] Failed to emit webhook event:', err);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// DB mappers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Explicit mapping from persisted Transaction.status values onto the public
 * PaymentRecord status contract. The compiler rejects any unmapped value,
 * so legacy statuses can never leak through to API clients.
 */
const DB_STATUS_TO_PAYMENT_STATUS: Record<string, PaymentRecord['status']> = {
  created: 'created',
  pending: 'created',
  submitted: 'submitted',
  processing: 'processing',
  successful: 'successful',
  completed: 'successful',
  failed: 'failed',
  cancelled: 'failed',
};

/** Maps a Prisma Transaction row onto the public PaymentRecord shape. */
export function mapToPaymentRecord(tx: DbTransaction): PaymentRecord {
  return {
    id: tx.id,
    userId: tx.userId,
    sourceWalletId: tx.walletId,
    destination: tx.toAddress ?? '',
    assetCode: tx.assetCode,
    ...(tx.assetIssuer ? { assetIssuer: tx.assetIssuer } : {}),
    amount: tx.amount.toString(),
    ...(tx.memo ? { memo: tx.memo } : {}),
    status: DB_STATUS_TO_PAYMENT_STATUS[tx.status] ?? 'failed',
    ...(tx.stellarTxId ? { stellarTxId: tx.stellarTxId } : {}),
    ...(tx.errorCode ? { errorCode: tx.errorCode } : {}),
    ...(tx.errorMessage ? { errorMessage: tx.errorMessage } : {}),
    ...(tx.submittedAt ? { submittedAt: tx.submittedAt } : {}),
    ...(tx.completedAt ? { completedAt: tx.completedAt } : {}),
    createdAt: tx.createdAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Core execution pipeline (shared by user payments, batch payouts, rebuilds)
// ──────────────────────────────────────────────────────────────────────────────

interface RunPaymentParams {
  /** Source wallet DB id — used to locate the encrypted signing key. */
  sourceWalletId: string;
  /** Source wallet row (must include publicKey). */
  sourcePublicKey: string;
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
  /**
   * Called with the signed transaction hash AFTER signing but BEFORE
   * submission, so callers can associate the hash with their payment row
   * and safely reconcile indeterminate (timeout) outcomes later.
   */
  onSignedHash?: (hash: string) => Promise<void> | void;
  /** Called immediately before the envelope is handed to Horizon. */
  onSubmitAttempted?: () => void;
}

/**
 * Builds, signs and submits a single payment transaction.
 * Returns the Horizon submission response (hash, ledger, ...).
 */
async function runPaymentCycle(params: RunPaymentParams): Promise<HorizonApiSubmitResponse> {
  const built = await TransactionService.buildRawPaymentTransaction({
    sourcePublicKey: params.sourcePublicKey,
    destination: params.destination,
    amount: params.amount,
    assetCode: params.assetCode,
    assetIssuer: params.assetIssuer,
    memo: params.memo,
  });

  const signed = await TransactionService.signTransaction(built.xdr, params.sourceWalletId);
  if (params.onSignedHash) {
    await params.onSignedHash(signed.hash);
  }

  params.onSubmitAttempted?.();
  return TransactionService.submitSignedTransaction(signed.signedXdr);
}

/** Minimal shape of the Horizon submit response we rely on. */
interface HorizonApiSubmitResponse {
  hash: string;
  ledger: number;
  successful: boolean;
  envelope_xdr: string;
  result_xdr: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

export const TransactionService = {
  /**
   * Builds an unsigned Stellar payment transaction for the given options.
   * Loads the source account from Horizon (handles sequence numbers), fetches
   * the current base fee (fallback 100 stroops) and applies a 5-minute
   * time bound to prevent replay attacks.
   */
  async buildRawPaymentTransaction(params: {
    sourcePublicKey: string;
    destination: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string;
    memo?: string;
  }): Promise<BuiltPaymentTransaction> {
    assertValidPaymentInputs({
      destination: params.destination,
      amount: params.amount,
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
      memo: params.memo,
    });

    const server = StellarService.getHorizonServer();

    let baseFee = DEFAULT_BASE_FEE_STROOPS;
    try {
      const fetched = await server.fetchBaseFee();
      if (typeof fetched === 'number' && fetched > 0) baseFee = fetched;
    } catch {
      // Fall back to the default base fee on any lookup failure.
    }
    const maxFee = baseFee * MAX_FEE_MULTIPLIER;

    let sourceAccount: Account;
    try {
      sourceAccount = await server.loadAccount(params.sourcePublicKey);
    } catch (error) {
      const errStatus = (
        (error as Record<string, unknown> | undefined)?.response as
          Record<string, unknown> | undefined
      )?.status;
      if (errStatus === 404) {
        throw new AppError(
          400,
          STELLAR_ERROR_CODES.WALLET_NOT_FUNDED,
          STELLAR_ERROR_CODES.WALLET_NOT_FUNDED
        );
      }
      throw new AppError(502, 'Failed to load source account from Horizon');
    }

    const asset = params.assetIssuer
      ? new Asset(params.assetCode, params.assetIssuer)
      : Asset.native();

    const builder = new TransactionBuilder(sourceAccount, {
      fee: String(maxFee),
      networkPassphrase: getNetworkPassphrase(),
    });

    // Capture the sequence BEFORE build() — the builder increments the
    // account's in-memory sequence as a side effect.
    const sourceSequence = sourceAccount.sequenceNumber();

    if (params.memo && params.memo.length > 0) {
      builder.addMemo(Memo.text(params.memo));
    }

    builder.addOperation(
      Operation.payment({
        destination: params.destination,
        asset,
        amount: params.amount,
      })
    );

    builder.setTimeout(DEFAULT_TIMEBOUND_SECONDS);

    const transaction = builder.build();
    const hash = transaction.hash().toString('hex');

    return {
      xdr: transaction.toXDR(),
      hash,
      networkPassphrase: getNetworkPassphrase(),
      baseFeeStroops: baseFee,
      maxFeeStroops: maxFee,
      sourceAccount: params.sourcePublicKey,
      sequence: sourceSequence,
    };
  },

  /**
   * Public wrapper matching the ticket signature: builds a payment
   * transaction for a wallet identified by its DB id.
   */
  async buildPaymentTransaction(options: BuildPaymentOptions): Promise<BuiltPaymentTransaction> {
    const wallet = await prisma.wallet.findUnique({ where: { id: options.sourceWalletId } });
    if (!wallet) {
      throw new AppError(404, 'Wallet not found');
    }
    if (options.userId && wallet.userId !== options.userId) {
      throw new AppError(403, 'Wallet does not belong to user');
    }

    return TransactionService.buildRawPaymentTransaction({
      sourcePublicKey: wallet.publicKey,
      destination: options.destination,
      amount: options.amount,
      assetCode: options.assetCode,
      assetIssuer: options.assetIssuer,
      memo: options.memo,
    });
  },

  /**
   * Signs an unsigned transaction envelope XDR with the secret key stored
   * (encrypted) for the given wallet. The secret is held in a scoped
   * variable, zeroed out immediately after signing, and never logged.
   */
  async signTransaction(
    transactionXdr: string,
    walletId: string
  ): Promise<SignedTransactionResult> {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      select: { id: true, secretKeyEncrypted: true, isActive: true },
    });

    if (!wallet?.isActive) {
      throw new AppError(404, 'Wallet not found');
    }

    let secretKey = '';
    try {
      secretKey = decrypt(wallet.secretKeyEncrypted);
      const keypair = Keypair.fromSecret(secretKey);

      const networkPassphrase = getNetworkPassphrase();
      const parsed = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
      if (!(parsed instanceof Transaction)) {
        throw new AppError(400, 'Only plain transactions can be signed');
      }

      parsed.sign(keypair);
      const hash = parsed.hash().toString('hex');

      return { signedXdr: parsed.toXDR(), hash };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'Wallet decryption failure');
    } finally {
      // Clear the sensitive material from memory as soon as signing completes.
      secretKey = '';
    }
  },

  /**
   * Submits a signed transaction envelope to Horizon. Deterministic failures
   * (result codes) are mapped to structured AppErrors; transient network
   * failures are retried exactly once before surfacing SUBMISSION_TIMEOUT /
   * 502 errors.
   */
  async submitSignedTransaction(signedXdr: string): Promise<HorizonApiSubmitResponse> {
    const server = StellarService.getHorizonServer();
    const parsed = TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase());

    const MAX_ATTEMPTS = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = (await server.submitTransaction(parsed)) as HorizonApiSubmitResponse;
        // Real Horizon responses always carry `successful`; mocks may omit it.
        if (response.successful === false) {
          const decoded = parseResultXdr(response.result_xdr);
          throw new SubmissionError(
            new AppError(400, `Stellar transaction failed: ${decoded.resultCode}`),
            decoded.resultCode,
            decoded.opResultCodes
          );
        }
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof SubmissionError) throw error.appError;
        // Deterministic Horizon failures must not be retried.
        if (extractHorizonResultCodes(error)) {
          throw mapSubmissionError(error).appError;
        }
        if (attempt < MAX_ATTEMPTS && isTransientSubmissionError(error)) {
          continue;
        }
        break;
      }
    }

    throw mapSubmissionError(lastError).appError;
  },

  /**
   * Polls Horizon for a transaction by hash and returns its status. When a
   * matching local Transaction row exists, its status is kept in sync and
   * completion triggers audit logging, notifications and webhooks.
   */
  async getTransactionStatus(txId: string): Promise<StellarTxStatus> {
    const server = StellarService.getHorizonServer();

    let record: HorizonApiTxRecord;
    try {
      record = (await server
        .transactions()
        .transaction(txId)
        .call()) as unknown as HorizonApiTxRecord;
    } catch (error) {
      const errStatus = (
        (error as Record<string, unknown> | undefined)?.response as
          Record<string, unknown> | undefined
      )?.status;
      if (errStatus === 404) {
        // Not yet in a ledger (or unknown hash) — treat as pending.
        return { id: txId, status: 'pending' };
      }
      throw new AppError(502, 'Failed to query transaction status from Horizon');
    }

    const decoded = parseResultXdr(record.result_xdr);
    const horizonStatus: StellarTxStatus = {
      id: record.id,
      status: record.successful ? 'successful' : 'failed',
      ledger: record.ledger_attr ?? record.ledger,
      createdAt: record.created_at ? new Date(record.created_at) : undefined,
      resultXdr: record.result_xdr,
      resultCode: decoded.resultCode,
      opResultCodes: decoded.opResultCodes,
      horizonUrl: `${HORIZON_URL}/transactions/${record.id}`,
      feeChargedStroops: record.fee_charged !== undefined ? String(record.fee_charged) : undefined,
    };

    await TransactionService.syncLocalTransaction(horizonStatus);
    return horizonStatus;
  },

  /**
   * Writes/updates the local Transaction row for a Horizon outcome and
   * triggers audit + notification + webhook side-effects.
   */
  async syncLocalTransaction(status: StellarTxStatus): Promise<void> {
    const row = await prisma.transaction.findUnique({
      where: { stellarTxId: status.id },
    });
    if (!row) return;

    // Conditional transition: only one concurrent caller (inline confirmation,
    // reconcile poller, ...) can win the claim, preventing duplicate
    // notifications and webhook deliveries.
    const TERMINAL_STATUSES = ['successful', 'completed', 'failed', 'cancelled'];

    if (status.status === 'successful') {
      const claim = await prisma.transaction.updateMany({
        where: { id: row.id, status: { notIn: TERMINAL_STATUSES } },
        data: {
          status: 'successful',
          completedAt: status.createdAt ?? new Date(),
          errorMessage: null,
        },
      });
      if (claim.count === 0) return;
      const updated = (await prisma.transaction.findUnique({
        where: { id: row.id },
      })) as DbTransaction;

      await logAudit(row.userId, 'transaction_confirmed', row.id, true, {
        stellarTxId: status.id,
        ledger: status.ledger,
        resultCode: status.resultCode,
      });
      safeNotify(row.userId, 'transaction-completed', {
        transactionId: row.id,
        amount: updated.amount.toString(),
        currency: updated.assetCode,
        stellarTxId: status.id,
      });
      safeEmitWebhook(
        'transaction.completed',
        {
          transactionId: row.id,
          stellarTxId: status.id,
          amount: updated.amount.toString(),
          assetCode: updated.assetCode,
        },
        row.userId
      );
      return;
    }

    if (status.status === 'failed') {
      const errorCode = mapFailureCode(status);
      const claim = await prisma.transaction.updateMany({
        where: { id: row.id, status: { notIn: TERMINAL_STATUSES } },
        data: {
          status: 'failed',
          errorCode,
          errorMessage: `Stellar transaction failed: ${status.resultCode ?? 'unknown'}`,
          completedAt: status.createdAt ?? new Date(),
        },
      });
      if (claim.count === 0) return;
      const updated = (await prisma.transaction.findUnique({
        where: { id: row.id },
      })) as DbTransaction;

      await logAudit(row.userId, 'transaction_failed_on_chain', row.id, false, {
        stellarTxId: status.id,
        resultCode: status.resultCode,
      });
      safeNotify(row.userId, 'transaction-failed', {
        transactionId: row.id,
        amount: updated.amount.toString(),
        currency: updated.assetCode,
        reason: errorCode,
      });
      safeEmitWebhook(
        'transaction.failed',
        {
          transactionId: row.id,
          stellarTxId: status.id,
          errorCode,
        },
        row.userId
      );
    }
  },

  /**
   * High-level orchestration: validates input, creates/updates the local
   * payment row, then runs build → sign → submit and records every state
   * transition along the way. Used by PaymentService, PayrollService and the
   * admin batch payout endpoint.
   */
  async buildAndSubmitPayment(options: BuildPaymentOptions): Promise<PaymentRecord> {
    assertValidPaymentInputs({
      destination: options.destination,
      amount: options.amount,
      assetCode: options.assetCode,
      assetIssuer: options.assetIssuer,
      memo: options.memo,
    });

    const wallet = await prisma.wallet.findUnique({ where: { id: options.sourceWalletId } });
    if (!wallet) {
      throw new AppError(404, 'Wallet not found');
    }
    if (wallet.userId !== options.userId) {
      throw new AppError(403, 'Wallet does not belong to user');
    }

    // Resolve or create the local payment row, recording the honest
    // created → submitted transition before touching the network.
    let row: DbTransaction;
    if (options.paymentId) {
      // Conditional re-claim: only a row still in `failed` may transition to
      // `submitted`, so two concurrent rebuilds can never both submit.
      const claimed = await prisma.transaction.updateMany({
        where: { id: options.paymentId, status: 'failed' },
        data: {
          status: 'submitted',
          errorCode: null,
          errorMessage: null,
          // Reset timestamps from the failed attempt so a rebuilt payment
          // never exposes the old completion/submission times.
          submittedAt: null,
          completedAt: null,
        },
      });
      if (claimed.count === 0) {
        throw new AppError(409, 'Payment cannot be rebuilt in its current state');
      }
      row = (await prisma.transaction.findUnique({
        where: { id: options.paymentId },
      })) as DbTransaction;
    } else {
      const created = await prisma.transaction.create({
        data: {
          userId: options.userId,
          walletId: options.sourceWalletId,
          type: 'transfer',
          status: 'created',
          amount: options.amount,
          assetCode: options.assetCode,
          assetIssuer: options.assetIssuer || null,
          memo: options.memo || null,
          fromAddress: wallet.publicKey,
          toAddress: options.destination,
          metadata: { paymentType: 'stellar_payment', ...(options.metadata ?? {}) },
        },
      });
      row = await prisma.transaction.update({
        where: { id: created.id },
        data: { status: 'submitted' },
      });
    }

    let submitAttempted = false;
    try {
      const response = await runPaymentCycle({
        sourceWalletId: wallet.id,
        sourcePublicKey: wallet.publicKey,
        destination: options.destination,
        amount: options.amount,
        assetCode: options.assetCode,
        assetIssuer: options.assetIssuer,
        memo: options.memo,
        // Associate the hash with the payment row BEFORE submission so that
        // indeterminate outcomes (timeouts) can be reconciled on-chain later
        // instead of blindly re-paid.
        onSignedHash: async (hash) => {
          await prisma.transaction.update({
            where: { id: row.id },
            data: { stellarTxId: hash },
          });
        },
        onSubmitAttempted: () => {
          submitAttempted = true;
        },
      });

      row = await prisma.transaction.update({
        where: { id: row.id },
        data: {
          status: 'processing',
          stellarTxId: response.hash,
          submittedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });

      await logAudit(options.userId, 'payment_submitted', row.id, true, {
        stellarTxId: response.hash,
        amount: options.amount,
        assetCode: options.assetCode,
        destination: options.destination,
      });

      // Best-effort immediate confirmation; pending is fine — clients and the
      // reconcile job poll getTransactionStatus afterwards.
      try {
        const confirmed = await TransactionService.getTransactionStatus(response.hash);
        if (confirmed.status !== 'pending') {
          row = (await prisma.transaction.findUnique({ where: { id: row.id } })) as DbTransaction;
        }
      } catch {
        // Ignore confirmation polling failures — status stays 'processing'.
      }

      return mapToPaymentRecord(row);
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(500, error instanceof Error ? error.message : 'Unknown payment failure');

      await prisma.transaction.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          errorCode: appError.code ?? 'PAYMENT_FAILED',
          errorMessage: appError.message.slice(0, 500),
          // Only record a submission time when the envelope actually reached
          // Horizon — build/sign failures never got that far.
          ...(submitAttempted ? { submittedAt: new Date() } : {}),
        },
      });

      await logAudit(options.userId, 'payment_failed', row.id, false, {
        errorCode: appError.code,
        message: appError.message,
        amount: options.amount,
        assetCode: options.assetCode,
      });
      safeNotify(options.userId, 'transaction-failed', {
        transactionId: row.id,
        amount: options.amount,
        currency: options.assetCode,
        reason: appError.code ?? appError.message,
      });
      safeEmitWebhook(
        'transaction.failed',
        {
          transactionId: row.id,
          amount: options.amount,
          assetCode: options.assetCode,
          errorCode: appError.code,
        },
        options.userId
      );

      throw appError;
    }
  },

  /**
   * Treasury → hot-wallet batched payouts. Each payout is an independent
   * transaction (own sequence number via a fresh Horizon loadAccount per
   * op); a failing payout does not stop the rest — partial success allowed.
   */
  async executeBatchPayouts(options: BatchPayoutOptions): Promise<BatchPayoutResult> {
    if (!options.sourceWalletId) {
      throw new AppError(400, 'Source wallet ID is required');
    }

    const wallet = await prisma.wallet.findUnique({ where: { id: options.sourceWalletId } });
    if (!wallet) {
      throw new AppError(404, 'Treasury wallet not found');
    }
    // Batch payouts may only be funded from the configured treasury wallet —
    // signing with an arbitrary wallet id would let an admin move user funds.
    if (!env.TREASURY_WALLET_ID || wallet.id !== env.TREASURY_WALLET_ID) {
      throw new AppError(403, 'Batch payouts must originate from the configured treasury wallet');
    }

    const results: BatchPayoutItemResult[] = [];

    for (const payout of options.payouts) {
      try {
        assertValidPaymentInputs({
          destination: payout.destination,
          amount: payout.amount,
          assetCode: payout.assetCode,
          assetIssuer: payout.assetIssuer,
          memo: payout.memo,
        });

        const row = await prisma.transaction.create({
          data: {
            userId: wallet.userId,
            walletId: wallet.id,
            type: 'transfer',
            status: 'submitted',
            amount: payout.amount,
            assetCode: payout.assetCode,
            assetIssuer: payout.assetIssuer || null,
            memo: payout.memo || null,
            fromAddress: wallet.publicKey,
            toAddress: payout.destination,
            metadata: {
              paymentType: 'treasury_batch_payout',
              reference: payout.reference || null,
              initiatedByAdminId: options.adminUserId,
            },
          },
        });

        let submitAttempted = false;
        try {
          const response = await runPaymentCycle({
            sourceWalletId: wallet.id,
            sourcePublicKey: wallet.publicKey,
            destination: payout.destination,
            amount: payout.amount,
            assetCode: payout.assetCode,
            assetIssuer: payout.assetIssuer,
            memo: payout.memo,
            onSignedHash: async (hash) => {
              await prisma.transaction.update({
                where: { id: row.id },
                data: { stellarTxId: hash },
              });
            },
            onSubmitAttempted: () => {
              submitAttempted = true;
            },
          });

          await prisma.transaction.update({
            where: { id: row.id },
            data: {
              status: 'processing',
              stellarTxId: response.hash,
              submittedAt: new Date(),
            },
          });

          await logAudit(options.adminUserId, 'admin_batch_payout_submitted', row.id, true, {
            stellarTxId: response.hash,
            destination: payout.destination,
            amount: payout.amount,
          });

          results.push({
            destination: payout.destination,
            amount: payout.amount,
            assetCode: payout.assetCode,
            success: true,
            paymentId: row.id,
            stellarTxId: response.hash,
          });
        } catch (payoutError) {
          const appError =
            payoutError instanceof AppError
              ? payoutError
              : new AppError(500, 'Unknown batch payout failure');

          await prisma.transaction.update({
            where: { id: row.id },
            data: {
              status: 'failed',
              errorCode: appError.code ?? 'PAYMENT_FAILED',
              errorMessage: appError.message.slice(0, 500),
              ...(submitAttempted ? { submittedAt: new Date() } : {}),
            },
          });

          await logAudit(options.adminUserId, 'admin_batch_payout_failed', row.id, false, {
            errorCode: appError.code,
            destination: payout.destination,
            amount: payout.amount,
          });

          results.push({
            destination: payout.destination,
            amount: payout.amount,
            assetCode: payout.assetCode,
            success: false,
            paymentId: row.id,
            errorCode: appError.code,
            errorMessage: appError.message,
          });
        }
      } catch (validationError) {
        const appError =
          validationError instanceof AppError
            ? validationError
            : new AppError(400, 'Invalid batch payout item');

        await logAudit(options.adminUserId, 'admin_batch_payout_invalid', null, false, {
          errorCode: appError.code,
          destination: payout.destination,
          amount: payout.amount,
        });

        results.push({
          destination: payout.destination,
          amount: payout.amount,
          assetCode: payout.assetCode,
          success: false,
          errorCode: appError.code,
          errorMessage: appError.message,
        });
      }
    }

    return {
      total: results.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      results,
    };
  },

  /**
   * Admin override: force-rebuild and re-execute a failed payment using the
   * parameters persisted on its original row.
   */
  async rebuildFailedTransaction(paymentId: string, adminUserId: string): Promise<PaymentRecord> {
    const existing = await prisma.transaction.findUnique({
      where: { id: paymentId },
      include: { wallet: true },
    });

    if (!existing) {
      throw new AppError(404, 'Payment not found');
    }
    if (existing.status !== 'failed') {
      throw new AppError(400, 'Only failed payments can be rebuilt');
    }
    if (!existing.toAddress) {
      throw new AppError(400, 'Payment has no destination address');
    }

    // A SUBMISSION_TIMEOUT (or similar indeterminate failure) can leave a
    // transaction marked failed even though Horizon accepted it. Verify the
    // original never landed before spending funds again.
    if (existing.stellarTxId) {
      const server = StellarService.getHorizonServer();
      try {
        const record = (await server
          .transactions()
          .transaction(existing.stellarTxId)
          .call()) as unknown as HorizonApiTxRecord;
        if (record.successful) {
          throw new AppError(
            409,
            'Payment already settled on-chain; refusing to rebuild to avoid double payment'
          );
        }
        // Found but explicitly failed on-chain → safe to rebuild.
      } catch (error) {
        if (error instanceof AppError) throw error;
        const errStatus = (
          (error as Record<string, unknown> | undefined)?.response as
            Record<string, unknown> | undefined
        )?.status;
        if (errStatus !== 404) {
          throw new AppError(502, 'Failed to verify original payment on Horizon before rebuild');
        }
        // 404: never landed in any ledger → safe to rebuild.
      }
    }

    await logAudit(adminUserId, 'admin_transaction_rebuild_started', existing.id, true, {
      previousErrorCode: existing.errorCode,
    });

    return TransactionService.buildAndSubmitPayment({
      sourceWalletId: existing.walletId,
      userId: existing.userId,
      destination: existing.toAddress,
      amount: existing.amount.toString(),
      assetCode: existing.assetCode,
      assetIssuer: existing.assetIssuer || undefined,
      memo: existing.memo || undefined,
      paymentId: existing.id,
    });
  },
};

/** Maps a failed Horizon status to the most specific structured error code. */
function mapFailureCode(status: StellarTxStatus): string {
  const txCode = status.resultCode ?? '';
  if (TX_RESULT_CODE_MAP[txCode]) return TX_RESULT_CODE_MAP[txCode].code;
  const opMatch = (status.opResultCodes ?? []).map((c) => OP_RESULT_CODE_MAP[c]).find(Boolean);
  if (opMatch) return opMatch.code;
  return 'TRANSACTION_FAILED_ON_CHAIN';
}

/** Structural subset of the Horizon TransactionRecord used for status reads. */
interface HorizonApiTxRecord {
  id: string;
  successful: boolean;
  ledger?: number;
  ledger_attr?: number;
  created_at?: string;
  result_xdr: string;
  fee_charged?: number | string;
}
