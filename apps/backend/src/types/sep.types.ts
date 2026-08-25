import type { UserRole } from '@prisma/client';

export type SEPSessionType = 'deposit' | 'withdraw';

export type SEPTransactionStatus =
  | 'incomplete'
  | 'pending_user'
  | 'pending_anchor'
  | 'pending_stellar'
  | 'pending_stellar_unknown'
  | 'pending_user_transfer_start'
  | 'pending_external'
  | 'completed'
  | 'error'
  | 'expired';

export interface SepJwtPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  home_domain: string;
  client_domain?: string;
  userId?: string;
  role?: UserRole;
}

export interface Sep10ChallengeResponse {
  transaction: string;
  network_passphrase: string;
}

export interface Sep10TokenResponse {
  token: string;
}

export interface Sep24AssetInfo {
  enabled: boolean;
  min_amount: number;
  max_amount: number;
  fee_fixed: number;
  fee_percent: number;
  authentication_required?: boolean;
}

export interface Sep24InfoResponse {
  deposit: Record<string, Sep24AssetInfo>;
  withdraw: Record<string, Sep24AssetInfo>;
  fee: { enabled: boolean };
  features: {
    account_creation: boolean;
    claimable_balances: boolean;
  };
}

export interface Sep24InteractiveRequest {
  asset_code: string;
  asset_issuer?: string;
  amount?: string;
  type?: string;
  account?: string;
  memo?: string;
  memo_type?: string;
  lang?: string;
}

export interface Sep24InteractiveResponse {
  type: 'interactive_customer_info_needed';
  url: string;
  id: string;
}

export interface Sep24InteractiveStartResult extends Sep24InteractiveResponse {
  sessionId: string;
  cookieValue: string;
}

export interface Sep24TransactionRecord {
  id: string;
  kind: SEPSessionType;
  status: SEPTransactionStatus;
  status_eta?: number;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  started_at: string;
  completed_at?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
  more_info_url?: string;
  to?: string;
  from?: string;
  memo?: string;
  memo_type?: string;
}

export interface Sep24TransactionResponse {
  transaction: Sep24TransactionRecord;
}

export interface Sep24TransactionsResponse {
  transactions: Sep24TransactionRecord[];
}

export interface Sep24TransactionFilters {
  asset_code?: string;
  kind?: SEPSessionType;
  no_older_than?: string;
  limit?: number;
  paging_id?: string;
}

export interface Sep24CompleteInteractiveRequest {
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  routingNumber?: string;
  amount?: string;
}

export interface Sep24CompleteInteractiveResult {
  id: string;
  status: SEPTransactionStatus;
  kind: SEPSessionType;
  sendTo?: string;
  memo?: string;
  stellarTxId?: string;
}

export interface Sep24AssetConfig {
  code: string;
  issuer?: string;
  minAmount: number;
  maxAmount: number;
  feeFixed: number;
  feePercent: number;
}

export const SEP24_STATE_COOKIE = 'sep24_state';
export const SEP10_CHALLENGE_TTL_SECONDS = 5 * 60;
export const SEP24_JWT_TTL_SECONDS = 24 * 60 * 60;
export const SEP24_ALLOWED_ROLES: UserRole[] = ['USER', 'BUSINESS', 'ADMIN'];
