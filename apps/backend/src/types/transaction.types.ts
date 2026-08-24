/**
 * Types for the Stellar Transaction Processing service.
 */

/** Options for building / executing a Stellar payment transaction. */
export interface BuildPaymentOptions {
  sourceWalletId: string;
  userId: string;
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
  /**
   * When provided, an existing Transaction (payment) DB row is updated in
   * place instead of creating a new one (used by process/rebuild flows).
   */
  paymentId?: string;
  /**
   * Extra key/value pairs merged into the created row's metadata (used to
   * associate payments with domain entities, e.g. payroll items).
   */
  metadata?: Record<string, string>;
}

/** Status of a transaction as reported by the Stellar Horizon API. */
export interface StellarTxStatus {
  id: string;
  status: 'pending' | 'successful' | 'failed';
  ledger?: number;
  createdAt?: Date;
  /** Raw base64 XDR of the transaction result from Horizon. */
  resultXdr?: string;
  resultCode?: string;
  opResultCodes?: string[];
  horizonUrl?: string;
  feeChargedStroops?: string;
}

/** A payment record as stored in the Transaction table and returned by APIs. */
export interface PaymentRecord {
  id: string;
  userId: string;
  sourceWalletId: string;
  destination: string;
  assetCode: string;
  assetIssuer?: string;
  amount: string;
  memo?: string;
  status: 'created' | 'submitted' | 'processing' | 'successful' | 'failed';
  stellarTxId?: string;
  errorCode?: string;
  errorMessage?: string;
  submittedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

/** Result of building (but not yet signing) a payment transaction. */
export interface BuiltPaymentTransaction {
  /** Unsigned transaction envelope XDR (base64). */
  xdr: string;
  /** Transaction hash (hex). */
  hash: string;
  networkPassphrase: string;
  baseFeeStroops: number;
  maxFeeStroops: number;
  sourceAccount: string;
  sequence: string;
}

/** Result of signing a transaction. */
export interface SignedTransactionResult {
  signedXdr: string;
  hash: string;
}

/** A single payout inside an admin treasury batch. */
export interface BatchPayoutItem {
  destination: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
  reference?: string;
}

/** Options for the admin treasury → hot-wallet batch payout endpoint. */
export interface BatchPayoutOptions {
  /** Treasury wallet funding source. Falls back to env.TREASURY_WALLET_ID at the controller layer. */
  sourceWalletId?: string;
  adminUserId: string;
  payouts: BatchPayoutItem[];
}

/** Per-item outcome of a batch payout run. */
export interface BatchPayoutItemResult {
  destination: string;
  amount: string;
  assetCode: string;
  success: boolean;
  paymentId?: string;
  stellarTxId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Aggregate result of a batch payout run (partial success is allowed). */
export interface BatchPayoutResult {
  total: number;
  successful: number;
  failed: number;
  results: BatchPayoutItemResult[];
}

/**
 * Structured error codes produced when Stellar operations fail.
 * These are persisted on the Transaction row (`errorCode`) and returned
 * to clients so failures can be handled programmatically.
 */
export const STELLAR_ERROR_CODES = {
  WALLET_NOT_FUNDED: 'WALLET_NOT_FUNDED',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  LOW_BASE_RESERVE: 'LOW_BASE_RESERVE',
  TRANSACTION_EXPIRED: 'TRANSACTION_EXPIRED',
  BAD_SEQUENCE_NUMBER: 'BAD_SEQUENCE_NUMBER',
  INVALID_DESTINATION: 'INVALID_DESTINATION',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  SUBMISSION_TIMEOUT: 'SUBMISSION_TIMEOUT',
} as const;

export type StellarErrorCode = (typeof STELLAR_ERROR_CODES)[keyof typeof STELLAR_ERROR_CODES];

/**
 * Maps Horizon transaction-level result codes to structured error codes.
 * See https://developers.stellar.org/api/errors/result-code-transactions
 */
export const TX_RESULT_CODE_MAP: Record<string, { code: StellarErrorCode; status: number }> = {
  tx_too_late: { code: STELLAR_ERROR_CODES.TRANSACTION_EXPIRED, status: 408 },
  tx_bad_seq: { code: STELLAR_ERROR_CODES.BAD_SEQUENCE_NUMBER, status: 409 },
  tx_no_source_account: { code: STELLAR_ERROR_CODES.WALLET_NOT_FUNDED, status: 400 },
  tx_insufficient_balance: { code: STELLAR_ERROR_CODES.INSUFFICIENT_BALANCE, status: 400 },
};

/**
 * Maps Horizon operation-level result codes to structured error codes.
 * See https://developers.stellar.org/api/errors/result-code-operations
 */
export const OP_RESULT_CODE_MAP: Record<string, { code: StellarErrorCode; status: number }> = {
  op_underfunded: { code: STELLAR_ERROR_CODES.INSUFFICIENT_BALANCE, status: 400 },
  op_low_reserve: { code: STELLAR_ERROR_CODES.LOW_BASE_RESERVE, status: 400 },
  op_no_source_account: { code: STELLAR_ERROR_CODES.WALLET_NOT_FUNDED, status: 400 },
  op_no_destination: { code: STELLAR_ERROR_CODES.INVALID_DESTINATION, status: 400 },
  op_no_trust: { code: STELLAR_ERROR_CODES.INVALID_DESTINATION, status: 400 },
};
