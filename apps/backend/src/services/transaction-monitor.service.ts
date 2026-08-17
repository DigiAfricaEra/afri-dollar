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
  metadata?: unknown;
}

interface WindowedTransaction {
  id: string;
  userId: string;
  amount: string;
  assetCode: string;
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
  VELOCITY_1H: 'medium',
  STRUCTURING: 'medium',
  HIGH_RISK_COUNTRY: 'high',
  ROUND_AMOUNT: 'low',
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

function parseAmount(amount: string | null | undefined): number {
  const value = parseFloat(amount ?? '');
  return Number.isFinite(value) ? value : 0;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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

async function getMonitorConfig(): Promise<MonitorConfig> {
  try {
    const rows = await prisma.systemConfig.findMany({
      where: { key: { startsWith: 'monitor.' } },
    });
    const values = new Map(rows.map((row) => [row.key, row.value]));

    const severityByRule: Record<MonitorRuleId, MonitorSeverity> = { ...DEFAULT_SEVERITY_BY_RULE };
    for (const ruleId of Object.keys(DEFAULT_SEVERITY_BY_RULE) as MonitorRuleId[]) {
      const configured = values.get(`monitor.severity.${ruleId}`);
      if (typeof configured === 'string' && SEVERITIES.includes(configured as MonitorSeverity)) {
        severityByRule[ruleId] = configured as MonitorSeverity;
      }
    }

    const configuredCountries = values.get('monitor.highRiskCountries');

    return {
      largeTxThresholdUsd: readNumber(
        values.get('monitor.largeTxThresholdUsd'),
        DEFAULT_CONFIG.largeTxThresholdUsd
      ),
      velocityWindowMinutes: readNumber(
        values.get('monitor.velocityWindowMinutes'),
        DEFAULT_CONFIG.velocityWindowMinutes
      ),
      velocityTxLimit: readNumber(
        values.get('monitor.velocityTxLimit'),
        DEFAULT_CONFIG.velocityTxLimit
      ),
      structuringWindowHours: readNumber(
        values.get('monitor.structuringWindowHours'),
        DEFAULT_CONFIG.structuringWindowHours
      ),
      structuringTxCount: readNumber(
        values.get('monitor.structuringTxCount'),
        DEFAULT_CONFIG.structuringTxCount
      ),
      structuringRatio: readNumber(
        values.get('monitor.structuringRatio'),
        DEFAULT_CONFIG.structuringRatio
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
        DEFAULT_CONFIG.roundAmountModulus
      ),
      severityByRule,
    };
  } catch (error) {
    console.error('Failed to load monitoring config, using defaults:', error);
    return DEFAULT_CONFIG;
  }
}

async function countRecentTransactions(userId: string, windowMinutes: number): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60_000);
  return prisma.transaction.count({
    where: { userId, createdAt: { gte: since } },
  });
}

async function collectStructuringCandidates(
  transaction: WindowedTransaction,
  since: Date,
  config: MonitorConfig
): Promise<Array<{ id: string }>> {
  const windowRows = await prisma.transaction.findMany({
    where: {
      userId: transaction.userId,
      createdAt: { gte: since },
      status: { in: ['created', 'pending'] },
    },
    select: { id: true, amount: true, createdAt: true },
  });

  const bandMin = config.largeTxThresholdUsd * config.structuringRatio;

  return windowRows.filter((candidate) => {
    const amount = parseAmount(candidate.amount);
    if (amount <= bandMin || amount > config.largeTxThresholdUsd) {
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

async function applyFlag(
  transaction: WindowedTransaction,
  ruleId: MonitorRuleId,
  severity: MonitorSeverity,
  metadata: Record<string, unknown>
): Promise<void> {
  const message = `Transaction flagged by ${ruleId}`;
  await prisma.$transaction(async (client) => {
    await client.transaction.update({
      where: { id: transaction.id },
      data: {
        isFlagged: true,
        flagReason: message,
        flaggedAt: new Date(),
        flaggedBy: 'monitoring',
      },
    });
    await client.complianceAlert.create({
      data: {
        type: 'transaction_flag',
        severity,
        ruleId,
        title: message,
        description: message,
        userId: transaction.userId,
        transactionId: transaction.id,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  });
}

export const TransactionMonitorService = {
  getMonitorConfig,

  async evaluate(transaction: MonitorableTransaction): Promise<TransactionMonitorResult> {
    const config = await getMonitorConfig();
    const amount = parseAmount(transaction.amount);
    const alerts: MonitorRuleResult[] = [];

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

    const country = getBeneficiaryCountry(transaction.metadata);
    if (country !== null && config.highRiskCountries.includes(country)) {
      alerts.push({
        ruleId: 'HIGH_RISK_COUNTRY',
        severity: config.severityByRule.HIGH_RISK_COUNTRY,
        message: `Destination country ${country} is high risk`,
      });
    }

    const recentCount = await countRecentTransactions(
      transaction.userId,
      config.velocityWindowMinutes
    );
    if (recentCount > config.velocityTxLimit) {
      alerts.push({
        ruleId: 'VELOCITY_1H',
        severity: config.severityByRule.VELOCITY_1H,
        message: `${recentCount} transactions from the same user within ${config.velocityWindowMinutes} minutes`,
      });
    }

    return { flagged: alerts.length > 0, alerts };
  },

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

    await prisma.$transaction(async (client) => {
      await client.transaction.update({
        where: { id: transaction.id },
        data: {
          isFlagged: true,
          flagReason: top.message,
          flaggedAt: new Date(),
          flaggedBy: 'monitoring',
        },
      });
      await client.complianceAlert.create({
        data: {
          type: 'transaction_flag',
          severity: top.severity,
          ruleId: top.ruleId,
          title: `Transaction flagged by ${top.ruleId}`,
          description: top.message,
          userId: transaction.userId,
          transactionId: transaction.id,
          metadata: { matchedRules: result.alerts } as unknown as Prisma.InputJsonValue,
        },
      });
    });
  },

  async screenPastTransactions(): Promise<ScreenTransactionsResult> {
    const config = await getMonitorConfig();
    const since = new Date(Date.now() - config.structuringWindowHours * 3_600_000);
    let scanned = 0;
    let flagged = 0;
    let cursor: string | undefined;

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
          amount: true,
          assetCode: true,
          metadata: true,
          createdAt: true,
        },
      });

      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        scanned += 1;
        const candidates = await collectStructuringCandidates(row, since, config);
        if (candidates.length >= config.structuringTxCount) {
          await applyFlag(row, 'STRUCTURING', config.severityByRule.STRUCTURING, {
            ruleId: 'STRUCTURING',
            matchCount: candidates.length,
            windowHours: config.structuringWindowHours,
          });
          flagged += 1;
        }
      }

      cursor = rows[rows.length - 1].id;
    }

    return { scanned, flagged };
  },
};
