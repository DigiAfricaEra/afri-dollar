/**
 * Treasury Type Definitions
 * Shared types for managing the platform treasury reserves.
 */

export type TreasuryOperationType = 'deposit' | 'withdrawal' | 'rebalance' | 'transfer';

export type TreasuryOperationStatus = 'pending' | 'completed' | 'failed';

/**
 * A single asset position held within the platform treasury.
 */
export interface TreasuryPosition {
  assetCode: string;
  assetIssuer?: string;
  balance: string;
  valueUsd: string;
  allocation: number; // percentage of total treasury value (0-100)
}

/**
 * A recorded treasury operation (deposit, withdrawal, rebalance or transfer).
 */
export interface TreasuryOperation {
  id: string;
  type: TreasuryOperationType;
  amount: string;
  assetCode: string;
  status: TreasuryOperationStatus;
  createdAt: Date;
}

/**
 * Aggregated view of the platform treasury balance.
 */
export interface TreasuryBalanceSummary {
  totalValueUsd: string;
  assetCount: number;
  walletCount: number;
  positions: TreasuryPosition[];
}

/**
 * A desired allocation for a single asset, used when requesting a rebalance.
 */
export interface RebalanceTarget {
  assetCode: string;
  assetIssuer?: string;
  targetAllocation: number; // desired percentage of total treasury value (0-100)
}

/**
 * Optional filters for querying treasury operation history.
 */
export interface TreasuryHistoryFilters {
  type?: TreasuryOperationType;
  limit?: number;
}
