import fs from 'fs';

import { createObjectCsvWriter } from 'csv-writer';

import type { ReportData } from '../../types';

const CSV_INJECTION_PREFIXES = ['=', '+', '-', '@'];

export function sanitizeCSVValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 0 && CSV_INJECTION_PREFIXES.includes(value[0])) {
    return `'${value}`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return value ?? '';
}

export function sanitizeCSVRecord(record: ReportData): ReportData {
  const sanitized: ReportData = {};
  for (const [key, value] of Object.entries(record)) {
    sanitized[key] = sanitizeCSVValue(value);
  }
  return sanitized;
}

export async function generateCSV(data: ReportData[], filePath: string): Promise<void> {
  if (!data || data.length === 0) {
    fs.writeFileSync(filePath, '');
    return;
  }

  const headers = Object.keys(data[0]).map((key) => ({
    id: key,
    title: key,
  }));

  const writer = createObjectCsvWriter({
    path: filePath,
    header: headers,
  });

  const records = data.map(sanitizeCSVRecord);
  await writer.writeRecords(records);
}
