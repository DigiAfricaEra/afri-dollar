import { Prisma, Transaction } from '@afri-dollar/database';

import prisma from '../config/database';
import type {
  RebalanceTarget,
  TreasuryBalanceSummary,
  TreasuryHistoryFilters,
  TreasuryOperation,
  TreasuryOperationType,
  TreasuryPosition,
} from '../types/treasury.types';

/**
 * Treasury Service
 *
 * Manages the platform's own treasury reserves. The platform treasury is
 * composed of every wallet flagged with `walletType === 'treasury'`. Asset
 * positions are derived from the per-asset {@link WalletBalance} rows of those
 * wallets, valued in USD using the active {@link ExchangeRate} entries.
 *
 * Treasury operations (deposits, withdrawals, rebalances and transfers) are
 * persisted as {@link Transaction} rows tied to a treasury wallet so that a
 * complete, auditable history is always available.
 */

// Stellar amounts carry 7 decimal places of precision. We do all balance maths
// in integer "stroop" units (scaled by 10^7) using BigInt to avoid the
// floating-point drift that would occur when summing decimal strings.
const ASSET_DECIMALS = 7;
const ASSET_SCALE = 10n ** BigInt(ASSET_DECIMALS);

// Assets that are by definition worth one US dollar each.
const USD_PEGGED_ASSETS = new Set(['USD', 'USDC']);

/**
 * Parse a decimal amount string into integer stroops (scaled by 10^7).
 * Throws if the input is not a valid non-negative decimal number.
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
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / ASSET_SCALE;
  const fraction = (abs % ASSET_SCALE).toString().padStart(ASSET_DECIMALS, '0');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const body = trimmedFraction.length > 0 ? `${whole}.${trimmedFraction}` : `${whole}.0`;
  return negative ? `-${body}` : body;
}

/**
 * Format a numeric USD value to a fixed 2-decimal string.
 */
function toUsdString(value: number): string {
  return value.toFixed(2);
}

/**
 * Resolve the active treasury wallet ids. The platform treasury is the set of
 * active wallets whose `walletType` is `treasury`.
 */
async function getTreasuryWalletIds(): Promise<string[]> {
  const wallets = await prisma.wallet.findMany({
    where: { walletType: 'treasury', isActive: true },
    select: { id: true },
  });
  return wallets.map((w) => w.id);
}

/**
 * Look up the USD conversion rate for an asset. USD-pegged assets resolve to 1.
 * Otherwise we use the most recent active exchange rate for `assetCode -> USD`,
 * falling back to `assetCode -> USDC`. Returns null if no rate is available.
 */
async function getUsdRate(assetCode: string): Promise<number | null> {
  if (USD_PEGGED_ASSETS.has(assetCode)) {
    return 1;
  }

  const now = new Date();
  const rate = await prisma.exchangeRate.findFirst({
    where: {
      fromAsset: assetCode,
      toAsset: { in: ['USD', 'USDC'] },
      isActive: true,
      validFrom: { lte: now },
      OR: [{ validUntil: null }, { validUntil: { gte: now } }],
    },
    orderBy: { validFrom: 'desc' },
  });

  if (!rate) {
    return null;
  }

  const parsed = Number(rate.rate);
  return Number.isFinite(parsed) ? parsed : null;
}

interface AggregatedPosition {
  assetCode: string;
  assetIssuer?: string;
  stroops: bigint;
}

/**
 * Aggregate balances across all treasury wallets, grouped by asset.
 */
async function aggregatePositions(walletIds: string[]): Promise<AggregatedPosition[]> {
  if (walletIds.length === 0) {
    return [];
  }

  const balances = await prisma.walletBalance.findMany({
    where: { walletId: { in: walletIds } },
  });

  const grouped = new Map<string, AggregatedPosition>();
  for (const balance of balances) {
    const key = `${balance.assetCode}:${balance.assetIssuer ?? ''}`;
    const existing = grouped.get(key);
    let amount: bigint;
    try {
      amount = toStroops(balance.balance);
    } catch {
      // Skip malformed balances rather than breaking the whole aggregation.
      continue;
    }
    if (existing) {
      existing.stroops += amount;
    } else {
      grouped.set(key, {
        assetCode: balance.assetCode,
        assetIssuer: balance.assetIssuer ?? undefined,
        stroops: amount,
      });
    }
  }

  return Array.from(grouped.values());
}

/**
 * Build fully-valued treasury positions (balance, USD value and allocation %)
 * from aggregated per-asset balances.
 */
async function buildPositions(aggregated: AggregatedPosition[]): Promise<{
  positions: TreasuryPosition[];
  totalValueUsd: number;
}> {
  const valued = await Promise.all(
    aggregated.map(async (entry) => {
      const rate = await getUsdRate(entry.assetCode);
      const balanceNumber = Number(fromStroops(entry.stroops));
      const valueUsd = rate === null ? 0 : balanceNumber * rate;
      return { ...entry, valueUsd };
    })
  );

  const totalValueUsd = valued.reduce((sum, entry) => sum + entry.valueUsd, 0);

  const positions: TreasuryPosition[] = valued
    .map((entry) => ({
      assetCode: entry.assetCode,
      assetIssuer: entry.assetIssuer,
      balance: fromStroops(entry.stroops),
      valueUsd: toUsdString(entry.valueUsd),
      allocation:
        totalValueUsd > 0 ? Math.round((entry.valueUsd / totalValueUsd) * 10000) / 100 : 0,
    }))
    // Surface the largest holdings first.
    .sort((a, b) => Number(b.valueUsd) - Number(a.valueUsd));

  return { positions, totalValueUsd };
}

/**
 * Map a persisted Transaction row to the public TreasuryOperation shape.
 */
function mapToOperation(tx: Transaction): TreasuryOperation {
  return {
    id: tx.id,
    type: tx.type as TreasuryOperationType,
    amount: tx.amount,
    assetCode: tx.assetCode,
    status: tx.status as TreasuryOperation['status'],
    createdAt: tx.createdAt,
  };
}

/**
 * Audit log helper for treasury actions.
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
        resource: 'treasury',
        resourceId,
        success,
        metadata: metadata || undefined,
      },
    });
  } catch (error) {
    console.error('Failed to log audit:', error);
  }
}

export const TreasuryService = {
  /**
   * Return the aggregated treasury balance summary, including total USD value
   * and per-asset positions.
   */
  async getTreasuryBalance(): Promise<TreasuryBalanceSummary> {
    const walletIds = await getTreasuryWalletIds();
    const aggregated = await aggregatePositions(walletIds);
    const { positions, totalValueUsd } = await buildPositions(aggregated);

    return {
      totalValueUsd: toUsdString(totalValueUsd),
      assetCount: positions.length,
      walletCount: walletIds.length,
      positions,
    };
  },

  /**
   * Return the treasury positions with their USD value and allocation %.
   */
  async getTreasuryPositions(): Promise<TreasuryPosition[]> {
    const walletIds = await getTreasuryWalletIds();
    const aggregated = await aggregatePositions(walletIds);
    const { positions } = await buildPositions(aggregated);
    return positions;
  },

  /**
   * Compute and record the operations required to move the treasury towards the
   * requested target allocations.
   *
   * For each asset the desired USD value is `totalValue * targetAllocation%`.
   * The difference against the current value determines the rebalance amount
   * (converted back into asset units via the asset's USD rate). Each non-trivial
   * adjustment is persisted as a `rebalance` Transaction so the action is fully
   * auditable.
   */
  async rebalance(targets: RebalanceTarget[], adminUserId: string): Promise<TreasuryOperation[]> {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('At least one rebalance target is required');
    }

    // Validate individual allocations and detect duplicates.
    const seen = new Set<string>();
    let totalAllocation = 0;
    for (const target of targets) {
      if (
        typeof target.targetAllocation !== 'number' ||
        Number.isNaN(target.targetAllocation) ||
        target.targetAllocation < 0 ||
        target.targetAllocation > 100
      ) {
        throw new Error('Allocation must be between 0 and 100');
      }
      const key = `${target.assetCode}:${target.assetIssuer ?? ''}`;
      if (seen.has(key)) {
        throw new Error('Duplicate asset in rebalance targets');
      }
      seen.add(key);
      totalAllocation += target.targetAllocation;
    }

    // Allow a small tolerance for floating-point representation of percentages.
    if (Math.abs(totalAllocation - 100) > 0.01) {
      throw new Error('Target allocations must sum to 100 percent');
    }

    const walletIds = await getTreasuryWalletIds();
    if (walletIds.length === 0) {
      await logAudit(adminUserId, 'treasury_rebalance_failed', null, false, {
        error: 'No treasury wallet found',
      });
      throw new Error('No treasury wallet found');
    }

    const aggregated = await aggregatePositions(walletIds);
    const { positions, totalValueUsd } = await buildPositions(aggregated);

    if (totalValueUsd <= 0) {
      await logAudit(adminUserId, 'treasury_rebalance_failed', null, false, {
        error: 'Treasury has no value to rebalance',
      });
      throw new Error('Treasury has no value to rebalance');
    }

    const currentByKey = new Map(
      positions.map((p) => [`${p.assetCode}:${p.assetIssuer ?? ''}`, p])
    );

    // The first treasury wallet anchors the recorded operations.
    const primaryWalletId = walletIds[0];

    const operations: TreasuryOperation[] = [];
    for (const target of targets) {
      const key = `${target.assetCode}:${target.assetIssuer ?? ''}`;
      const current = currentByKey.get(key);
      const currentValueUsd = current ? Number(current.valueUsd) : 0;
      const desiredValueUsd = (totalValueUsd * target.targetAllocation) / 100;
      const deltaUsd = desiredValueUsd - currentValueUsd;

      // Skip negligible adjustments (less than one cent).
      if (Math.abs(deltaUsd) < 0.01) {
        continue;
      }

      const rate = await getUsdRate(target.assetCode);
      if (rate === null || rate <= 0) {
        // Without a price we cannot translate a USD delta into asset units.
        throw new Error(`No USD exchange rate available for asset ${target.assetCode}`);
      }

      const deltaAmount = Math.abs(deltaUsd) / rate;
      const amountString = fromStroops(toStroops(deltaAmount.toFixed(ASSET_DECIMALS)));
      const direction = deltaUsd > 0 ? 'increase' : 'decrease';

      const tx = await prisma.transaction.create({
        data: {
          userId: adminUserId,
          walletId: primaryWalletId,
          type: 'rebalance',
          status: 'completed',
          amount: amountString,
          assetCode: target.assetCode,
          assetIssuer: target.assetIssuer || null,
          metadata: {
            direction,
            targetAllocation: target.targetAllocation,
            currentValueUsd: toUsdString(currentValueUsd),
            desiredValueUsd: toUsdString(desiredValueUsd),
            deltaUsd: toUsdString(deltaUsd),
          },
          completedAt: new Date(),
        },
      });

      operations.push(mapToOperation(tx));
    }

    await logAudit(adminUserId, 'treasury_rebalance', primaryWalletId, true, {
      totalValueUsd: toUsdString(totalValueUsd),
      operationCount: operations.length,
      targets: targets.map((t) => ({
        assetCode: t.assetCode,
        targetAllocation: t.targetAllocation,
      })),
    });

    return operations;
  },

  /**
   * Return the treasury operation history, most recent first. Operations are the
   * transactions recorded against treasury wallets.
   */
  async getTreasuryHistory(filters: TreasuryHistoryFilters = {}): Promise<TreasuryOperation[]> {
    const walletIds = await getTreasuryWalletIds();
    if (walletIds.length === 0) {
      return [];
    }

    const take = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 200) : 100;

    const transactions = await prisma.transaction.findMany({
      where: {
        walletId: { in: walletIds },
        ...(filters.type ? { type: filters.type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return transactions.map(mapToOperation);
  },
};
