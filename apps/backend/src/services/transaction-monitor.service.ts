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

function parseAmount(amount: string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount.trim() === '') {
    return null;
  }
  const value = parseFloat(amount);
  return Number.isFinite(value) ? value : null;
}

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

export function resetConfigCacheForTests(): void {
  cachedConfig = null;
}

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

const countRecentTransactions = (userId: string, windowMinutes: number): Promise<number> =>
  prisma.transaction.count({
    where: {
      userId,
      createdAt: { gte: new Date(Date.now() - windowMinutes * 60_000) },
    },
  });

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

  async screenPastTransactions(): Promise<ScreenTransactionsResult> {
    const config = await getMonitorConfig();
    const since = new Date(Date.now() - config.structuringWindowHours * 3_600_000);
    return screenWindow(config, since);
  },
};
