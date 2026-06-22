'use client';

import React, { useEffect, useState } from 'react';

import api from '../../../lib/api';
import type { FailedAttemptRecord, SecurityMetrics } from '../../../types';

type SecurityMetricsApiRecord = Omit<FailedAttemptRecord, 'lastAttemptAt'> & {
  lastAttemptAt: string;
};

type SecurityMetricsApiResponse = {
  success: boolean;
  data: {
    blockedIps: SecurityMetricsApiRecord[];
    flaggedIps: SecurityMetricsApiRecord[];
    totalBlockedIps: number;
    totalFlaggedIps: number;
    totalFailedAttempts: number;
  };
};

const COMMUNITY_URL = 'https://t.me/DigiAfrcaEra/1';

function normalizeRecord(record: SecurityMetricsApiRecord): FailedAttemptRecord {
  return {
    ...record,
    lastAttemptAt: new Date(record.lastAttemptAt),
  };
}

function normalizeMetrics(data: SecurityMetricsApiResponse['data']): SecurityMetrics {
  return {
    blockedIps: data.blockedIps.map(normalizeRecord),
    flaggedIps: data.flaggedIps.map(normalizeRecord),
    totalBlockedIps: data.totalBlockedIps,
    totalFlaggedIps: data.totalFlaggedIps,
    totalFailedAttempts: data.totalFailedAttempts,
  };
}

function formatDate(value: Date): string {
  return value.toLocaleString();
}

function formatAttempts(attempts: number): string {
  return `${attempts} attempt${attempts === 1 ? '' : 's'}`;
}

function renderIpList(records: FailedAttemptRecord[], emptyLabel: string): JSX.Element {
  if (records.length === 0) {
    return <p className="text-sm text-gray-500">{emptyLabel}</p>;
  }

  return (
    <ul className="space-y-3">
      {records.map((record) => (
        <li
          key={`${record.ip}-${record.lastAttemptAt.toISOString()}`}
          className="rounded border p-3"
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-gray-900">{record.ip}</p>
              <p className="text-xs text-gray-500">
                {record.userId ? `User ${record.userId}` : 'No user linked'}
              </p>
            </div>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700">
              {formatAttempts(record.attempts)}
            </span>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Last attempt {formatDate(record.lastAttemptAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

export default function DashboardPage(): JSX.Element {
  const [metrics, setMetrics] = useState<SecurityMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect((): (() => void) => {
    let active = true;

    void (async (): Promise<void> => {
      try {
        const response = await api.get<SecurityMetricsApiResponse>('/api/v1/security/metrics');
        if (active) {
          setMetrics(normalizeMetrics(response.data.data));
          setError(null);
        }
      } catch (requestError) {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Unable to load security metrics.'
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const blockedIps = metrics?.blockedIps ?? [];
  const flaggedIps = metrics?.flaggedIps ?? [];

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Business Dashboard</h1>
        <p className="text-sm text-gray-600">
          Operational overview plus security telemetry for blocked and flagged login sources.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        <div className="p-6 border rounded-lg shadow-sm">
          <h2 className="text-sm font-medium text-gray-500">Blocked IPs</h2>
          <p className="text-3xl font-semibold mt-2">
            {loading ? '...' : (metrics?.totalBlockedIps ?? 0)}
          </p>
        </div>
        <div className="p-6 border rounded-lg shadow-sm">
          <h2 className="text-sm font-medium text-gray-500">Flagged IPs</h2>
          <p className="text-3xl font-semibold mt-2">
            {loading ? '...' : (metrics?.totalFlaggedIps ?? 0)}
          </p>
        </div>
        <div className="p-6 border rounded-lg shadow-sm">
          <h2 className="text-sm font-medium text-gray-500">Failed Attempts</h2>
          <p className="text-3xl font-semibold mt-2">
            {loading ? '...' : (metrics?.totalFailedAttempts ?? 0)}
          </p>
        </div>
        <div className="p-6 border rounded-lg shadow-sm">
          <h2 className="text-sm font-medium text-gray-500">Security Status</h2>
          <p className="text-lg font-semibold mt-2 text-gray-900">
            {error ? 'Needs attention' : 'Protected'}
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="rounded-lg border p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-4">Blocked IPs</h2>
          {renderIpList(blockedIps, 'No IPs are currently blocked.')}
        </section>

        <section className="rounded-lg border p-6 shadow-sm">
          <h2 className="text-lg font-semibold mb-4">Flagged IPs</h2>
          {renderIpList(flaggedIps, 'No IPs are currently flagged.')}
        </section>
      </div>

      <div className="rounded-lg border p-6 shadow-sm bg-gray-50">
        <h2 className="text-lg font-semibold mb-2">Community</h2>
        <p className="text-sm text-gray-600 mb-4">
          Join the project community for updates, discussion, and support.
        </p>
        <a
          href={COMMUNITY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 font-medium hover:underline"
        >
          https://t.me/DigiAfrcaEra/1
        </a>
      </div>
    </div>
  );
}
