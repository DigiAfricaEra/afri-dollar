import { Prisma } from '@prisma/client';

import prisma from '../config/database';
import type {
  MonitorConfig,
  MonitorRuleId,
  MonitorRuleResult,
  MonitorSeverity,
  ScreenTransactionsResult,
  TransactionMonitorResult,
} from '../types/transaction-monitor.types';

interface MonitorableTransaction {
  id: string;
  userId: string;
  amount: string;
  assetCode: string;
  createdAt: Date;
  metadata?: unknown;
}

interface StructuringCandidate {
  id: string;
  amount: string;
  createdAt: Date;
}

const SEVERITY_RANK: Record<MonitorSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const SEVERITIES: MonitorSeverity[] = ['low', 'medium', 'high', 'critical'];

const DEFAULT_SEVERITY_BY_RULE: Record<MonitorRuleId, MonitorSeverity> = {
  LARGE_TX: 'high',
  VELOCITY: 'medium',
  STRUCTURING: 'medium',
  HIGH_RISK_COUNTRY: 'high',
  ROUND_AMOUNT: 'low',
  UNPARSEABLE_AMOUNT: 'high',
};

const DEFAULT_CONFIG: MonitorConfig = {
  largeTxThresholdUsd: 10_000,
  velocityWindowMinutes: 60,
  velocityTxLimit: 10,
  structuringWindowHours: 24,
  structuringTxCount: 3,
  structuringRatio: 0.8,
  highRiskCountries: [
    'KP',
    'IR',
    'SY',
    'CU',
    'AF',
    'BY',
    'MM',
    'CF',
    'CD',
    'IQ',
    'LY',
    'ML',
    'NI',
    'SO',
    'SS',
    'SD',
    'VE',
    'YE',
    'ZW',
  ],
  roundAmountFloorUsd: 10_000,
  roundAmountModulus: 1_000,
  severityByRule: DEFAULT_SEVERITY_BY_RULE,
};

const SCREEN_PAGE_SIZE = 100;
const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * Parses a string amount into a finite number, returning null for empty or
 * unparseable values.
 */
function parseAmount(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount.trim() === '') {
    return null;
  }
  const value = parseFloat(amount);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads a numeric config value within [min, max], falling back to the
 * supplied default when the value is invalid or out of range.
 */
function readNumber(
  value: unknown,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (parsed < min || parsed > max) {
    console.warn(
      `Monitoring config value ${parsed} is out of range [${min}, ${max}], using fallback ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

/**
 * Extracts the normalized destination country code from transaction metadata.
 */
function getBeneficiaryCountry(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const beneficiary = record.beneficiaryInfo as Record<string, unknown> | null | undefined;
  const raw = beneficiary?.country ?? record.beneficiaryCountry;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

let cachedConfig: { config: MonitorConfig; expiresAt: number } | null = null;

/**
 * Clears the cached monitoring config so tests start from a fresh state.
 */
export function resetConfigCacheForTests(): void {
  cachedConfig = null;
}

/**
 * Loads the monitor.* SystemConfig entries with a short TTL cache, falling
 * back to DEFAULT_CONFIG when the database is unreachable.
 */
async function getMonitorConfig(): Promise<MonitorConfig> {
  const now = Date.now();
  if (cachedConfig && cachedConfig.expiresAt > now) {
    return cachedConfig.config;
  }

  try {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { startsWith: 'monitor.' } },
    });
    const values = new Map<string, Prisma.JsonValue>();
    for (const row of rows) {
      values.set(row.key, row.value);
    }

    const severityByRule: Record<MonitorRuleId, MonitorSeverity> = { ...DEFAULT_SEVERITY_BY_RULE };
    for (const ruleId of Object.keys(DEFAULT_SEVERITY_BY_RULE) as MonitorRuleId[]) {
      const configured = values.get(`monitor.severity.${ruleId}`);
      if (typeof configured === 'string' && SEVERITIES.includes(configured as MonitorSeverity)) {
        severityByRule[ruleId] = configured as MonitorSeverity;
      }
    }

    const configuredCountries = values.get('monitor.highRiskCountries');

    const config: MonitorConfig = {
      largeTxThresholdUsd: readNumber(
        values.get('monitor.largeTxThresholdUsd'),
        DEFAULT_CONFIG.largeTxThresholdUsd
      ),
      velocityWindowMinutes: readNumber(
        values.get('monitor.velocityWindowMinutes'),
        DEFAULT_CONFIG.velocityWindowMinutes,
        1
      ),
      velocityTxLimit: readNumber(
        values.get('monitor.velocityTxLimit'),
        DEFAULT_CONFIG.velocityTxLimit,
        1
      ),
      structuringWindowHours: readNumber(
        values.get('monitor.structuringWindowHours'),
        DEFAULT_CONFIG.structuringWindowHours,
        1
      ),
      structuringTxCount: readNumber(
        values.get('monitor.structuringTxCount'),
        DEFAULT_CONFIG.structuringTxCount,
        1
      ),
      structuringRatio: readNumber(
        values.get('monitor.structuringRatio'),
        DEFAULT_CONFIG.structuringRatio,
        0,
        1
      ),
      highRiskCountries: Array.isArray(configuredCountries)
        ? configuredCountries
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim().toUpperCase())
        : DEFAULT_CONFIG.highRiskCountries,
      roundAmountFloorUsd: readNumber(
        values.get('monitor.roundAmountFloorUsd'),
        DEFAULT_CONFIG.roundAmountFloorUsd
      ),
      roundAmountModulus: readNumber(
        values.get('monitor.roundAmountModulus'),
        DEFAULT_CONFIG.roundAmountModulus,
        1
      ),
      severityByRule,
    };

    cachedConfig = { config, expiresAt: now + CONFIG_CACHE_TTL_MS };
    return config;
  } catch (error) {
    console.error('Failed to load monitoring config, using defaults:', error);
    return DEFAULT_CONFIG;
  }
}

/**
 * Counts transactions created by the user within the given window.
 */
const countRecentTransactions = (userId: string, windowMinutes: number): Promise<number> =>
  prisma.transaction.count({
    where: {
      userId,
      createdAt: { gte: new Date(Date.now() - windowMinutes * 60_000) },
    },
  });

/**
 * Filters window rows to the structuring band: amounts above the large
 * transaction threshold times the structuring ratio and at or below the
 * threshold, ordered by creation time and id for a stable tie-break.
 */
function filterStructuringCandidates(
  windowRows: StructuringCandidate[],
  transaction: { id: string; createdAt: Date },
  config: MonitorConfig
): StructuringCandidate[] {
  const bandMin = config.largeTxThresholdUsd * config.structuringRatio;

  return windowRows.filter((candidate) => {
    const amount = parseAmount(candidate.amount);
    if (amount === null || amount <= bandMin || amount > config.largeTxThresholdUsd) {
      return false;
    }
    if (candidate.createdAt.getTime() < transaction.createdAt.getTime()) {
      return true;
    }
    if (candidate.createdAt.getTime() > transaction.createdAt.getTime()) {
      return false;
    }
    return candidate.id <= transaction.id;
  });
}

/**
 * Appends a VELOCITY alert when the user exceeds the configured velocity
 * limit within the configured window.
 */
async function applyVelocityRule(
  alerts: MonitorRuleResult[],
  transaction: MonitorableTransaction,
  config: MonitorConfig
): Promise<void> {
  const recentCount = await countRecentTransactions(
    transaction.userId,
    config.velocityWindowMinutes
  );
  if (recentCount > config.velocityTxLimit) {
    alerts.push({
      ruleId: 'VELOCITY',
      severity: config.severityByRule.VELOCITY,
      message: `${recentCount} transactions from the same user within ${config.velocityWindowMinutes} minutes`,
    });
  }
}

/**
 * Loads the user's transactions within the window and filters them into
 * structuring candidates.
 */
async function collectStructuringCandidates(
  transaction: MonitorableTransaction,
  since: Date,
  config: MonitorConfig
): Promise<StructuringCandidate[]> {
  const windowRows = await prisma.transaction.findMany({
    where: {
      userId: transaction.userId,
      createdAt: { gte: since },
      status: { in: ['created', 'pending'] },
    },
    select: { id: true, amount: true, createdAt: true },
  });

  return filterStructuringCandidates(windowRows, transaction, config);
}

/**
 * Conditionally flags an unclaimed transaction and records a compliance
 * alert on a successful claim. Returns true when this call performed the
 * flagging, so concurrent scans cannot create duplicate alerts.
 */
async function claimFlag(
  client: Prisma.TransactionClient,
  transaction: { id: string; userId: string },
  ruleId: MonitorRuleId,
  severity: MonitorSeverity,
  reason: string,
  title: string,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const claimed = await client.transaction.updateMany({
    where: { id: transaction.id, isFlagged: false },
    data: {
      isFlagged: true,
      flagReason: reason,
      flaggedAt: new Date(),
      flaggedBy: 'monitoring',
    },
  });

  if (claimed.count === 0) {
    return false;
  }

  await client.complianceAlert.create({
    data: {
      type: 'transaction_flag',
      severity,
      ruleId,
      title,
      description: reason,
      userId: transaction.userId,
      transactionId: transaction.id,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });

  return true;
}

/**
 * Runs every monitoring rule against a single transaction and returns the
 * collected alerts, evaluating structuring patterns at creation time.
 */
async function evaluateTransaction(
  transaction: MonitorableTransaction
): Promise<TransactionMonitorResult> {
  const config = await getMonitorConfig();
  const alerts: MonitorRuleResult[] = [];

  const amount = parseAmount(transaction.amount);
  if (amount === null) {
    alerts.push({
      ruleId: 'UNPARSEABLE_AMOUNT',
      severity: config.severityByRule.UNPARSEABLE_AMOUNT,
      message: `Amount ${transaction.amount} could not be parsed and requires manual review`,
    });
  } else {
    if (amount > config.largeTxThresholdUsd) {
      alerts.push({
        ruleId: 'LARGE_TX',
        severity: config.severityByRule.LARGE_TX,
        message: `Amount ${transaction.amount} exceeds the large transaction threshold of ${config.largeTxThresholdUsd}`,
      });
    }

    if (amount >= config.roundAmountFloorUsd && amount % config.roundAmountModulus === 0) {
      alerts.push({
        ruleId: 'ROUND_AMOUNT',
        severity: config.severityByRule.ROUND_AMOUNT,
        message: `Amount ${transaction.amount} is a round number`,
      });
    }
  }

  const country = getBeneficiaryCountry(transaction.metadata);
  if (country !== null && config.highRiskCountries.includes(country)) {
    alerts.push({
      ruleId: 'HIGH_RISK_COUNTRY',
      severity: config.severityByRule.HIGH_RISK_COUNTRY,
      message: `Destination country ${country} is high risk`,
    });
  }

  await applyVelocityRule(alerts, transaction, config);

  const structuringSince = new Date(
    transaction.createdAt.getTime() - config.structuringWindowHours * 3_600_000
  );
  const candidates = await collectStructuringCandidates(transaction, structuringSince, config);
  if (candidates.length >= config.structuringTxCount) {
    alerts.push({
      ruleId: 'STRUCTURING',
      severity: config.severityByRule.STRUCTURING,
      message: `${candidates.length} transactions within the structuring band in the last ${config.structuringWindowHours} hours`,
    });
  }

  return { flagged: alerts.length > 0, alerts };
}

/**
 * Screens one transaction row against the structuring band, flagging it via
 * a conditional claim when the threshold is met.
 */
async function screenRow(
  row: { id: string; userId: string; createdAt: Date },
  since: Date,
  config: MonitorConfig,
  windowByUser: Map<string, StructuringCandidate[]>
): Promise<'flagged' | 'not-flagged'> {
  let windowRows = windowByUser.get(row.userId);
  if (!windowRows) {
    windowRows = await prisma.transaction.findMany({
      where: {
        userId: row.userId,
        createdAt: { gte: since },
        status: { in: ['created', 'pending'] },
      },
      select: { id: true, amount: true, createdAt: true },
    });
    windowByUser.set(row.userId, windowRows);
  }

  const candidates = filterStructuringCandidates(windowRows, row, config);
  if (candidates.length < config.structuringTxCount) {
    return 'not-flagged';
  }

  const claimed = await prisma.$transaction((client) =>
    claimFlag(
      client,
      row,
      'STRUCTURING',
      config.severityByRule.STRUCTURING,
      'Transaction flagged by STRUCTURING',
      'Transaction flagged by STRUCTURING',
      {
        ruleId: 'STRUCTURING',
        matchCount: candidates.length,
        windowHours: config.structuringWindowHours,
      }
    )
  );

  return claimed ? 'flagged' : 'not-flagged';
}

/**
 * Paginates the un-flagged transaction window and screens each row,
 * isolating per-row failures and returning scanned, flagged, and failed
 * counts.
 */
async function screenWindow(config: MonitorConfig, since: Date): Promise<ScreenTransactionsResult> {
  let scanned = 0;
  let flagged = 0;
  let failed = 0;
  let cursor: string | undefined;
  const windowByUser = new Map<string, StructuringCandidate[]>();

  for (;;) {
    const rows = await prisma.transaction.findMany({
      where: {
        createdAt: { gte: since },
        status: { in: ['created', 'pending'] },
        isFlagged: false,
      },
      orderBy: { id: 'asc' },
      take: SCREEN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        createdAt: true,
      },
    });

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      scanned += 1;
      try {
        const outcome = await screenRow(row, since, config, windowByUser);
        if (outcome === 'flagged') {
          flagged += 1;
        }
      } catch (error) {
        failed += 1;
        console.error(`Failed to screen transaction ${row.id}:`, error);
      }
    }

    cursor = rows[rows.length - 1].id;
  }

  return { scanned, flagged, failed };
}

export const TransactionMonitorService = {
  getMonitorConfig,

  evaluate: evaluateTransaction,

  /**
   * Persists the highest-severity alert of a flagged transaction via a
   * conditional claim.
   */
  async applyFlags(
    transaction: MonitorableTransaction,
    result: TransactionMonitorResult
  ): Promise<void> {
    if (!result.flagged || result.alerts.length === 0) {
      return;
    }

    const top = result.alerts.reduce((highest, current) =>
      SEVERITY_RANK[current.severity] > SEVERITY_RANK[highest.severity] ? current : highest
    );

    await prisma.$transaction((client) =>
      claimFlag(
        client,
        transaction,
        top.ruleId,
        top.severity,
        top.message,
        `Transaction flagged by ${top.ruleId}`,
        { matchedRules: result.alerts }
      )
    );
  },

  /**
   * Screens recent un-flagged transactions for structuring patterns.
   */
  async screenPastTransactions(): Promise<ScreenTransactionsResult> {
    const config = await getMonitorConfig();
    const since = new Date(Date.now() - config.structuringWindowHours * 3_600_000);
    return screenWindow(config, since);
  },
};
