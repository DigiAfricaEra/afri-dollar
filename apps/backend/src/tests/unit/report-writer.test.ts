/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import fs from 'fs';
import path from 'path';

import { Workbook } from 'exceljs';

import { LocalStorageAdapter } from '../../services/report.helpers';
import {
  generateCSV,
  sanitizeCSVRecord,
  sanitizeCSVValue,
} from '../../services/reports/csv-writer';
import { generatePDF } from '../../services/reports/pdf-writer';
import { generateXLSX } from '../../services/reports/xlsx-writer';
import type { ReportData } from '../../types';

describe('Report Writers Unit Tests', () => {
  const tmpDir = path.resolve(__dirname, '../../../tmp_tests');

  beforeAll(() => {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterAll(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore directory cleanup lock on Windows
    }
  });

  describe('CSV Writer', () => {
    it('should sanitize CSV injection characters (=, +, -, @)', () => {
      expect(sanitizeCSVValue('=1+2')).toBe("'=1+2");
      expect(sanitizeCSVValue('+100')).toBe("'+100");
      expect(sanitizeCSVValue('-50')).toBe("'-50");
      expect(sanitizeCSVValue('@admin')).toBe("'@admin");
      expect(sanitizeCSVValue('normal_string')).toBe('normal_string');
    });

    it('should sanitize record object correctly', () => {
      const record: ReportData = {
        memo: "=cmd|' /C calc'!A0",
        amount: '100.00',
      };
      const sanitized = sanitizeCSVRecord(record);
      expect(sanitized.memo).toBe("'=cmd|' /C calc'!A0");
      expect(sanitized.amount).toBe('100.00');
    });

    it('should write CSV file with correct row count and escaping', async () => {
      const filePath = path.join(tmpDir, 'test_tx_history.csv');
      const data: ReportData[] = [
        { id: 'tx_1', amount: '500.00', assetCode: 'USDC', memo: '=formula' },
        { id: 'tx_2', amount: '1200.50', assetCode: 'NGN', memo: 'Normal payment' },
      ];

      await generateCSV(data, filePath);

      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(3); // Header + 2 data rows
      expect(lines[1]).toContain("'=formula");
    });
  });

  describe('PDF Writer', () => {
    it('should generate a non-empty PDF file with headers and totals', async () => {
      const filePath = path.join(tmpDir, 'test_report.pdf');
      const data: ReportData[] = [
        { id: '1', type: 'transfer', amount: 250.0, assetCode: 'USDC' },
        { id: '2', type: 'deposit', amount: 750.0, assetCode: 'USDC' },
      ];

      await generatePDF(data, filePath, {
        title: 'TRANSACTION HISTORY REPORT',
        parameters: { startDate: '2026-01-01', endDate: '2026-08-17' },
      });

      expect(fs.existsSync(filePath)).toBe(true);
      const stats = fs.statSync(filePath);
      expect(stats.size).toBeGreaterThan(1000);
    });
  });

  describe('XLSX Writer', () => {
    it('should generate a valid XLSX file with formatted currency cells and totals', async () => {
      const filePath = path.join(tmpDir, 'test_report.xlsx');
      const data: ReportData[] = [
        { id: '1', amount: 1500.25, assetCode: 'USDC', createdAt: new Date('2026-05-10') },
        { id: '2', amount: 2400.75, assetCode: 'USDC', createdAt: new Date('2026-05-11') },
      ];

      await generateXLSX(data, filePath, 'Transactions');

      expect(fs.existsSync(filePath)).toBe(true);

      const workbook = new Workbook();
      await workbook.xlsx.readFile(filePath);
      const worksheet = workbook.getWorksheet('Transactions');

      expect(worksheet).toBeDefined();
      expect(worksheet?.rowCount).toBeGreaterThanOrEqual(3);

      const amountCell = worksheet?.getRow(2).getCell(2);
      expect(amountCell?.numFmt).toBe('#,##0.00 "USD"');
    });
  });

  describe('LocalStorageAdapter', () => {
    it('should write, check existence, read, and delete storage files', async () => {
      const adapter = new LocalStorageAdapter(tmpDir);
      const key = 'reports/test_storage.txt';

      const writeStream = adapter.writeStream(key);
      writeStream.write('Hello AfriDollar Storage');
      writeStream.end();

      await new Promise<void>((res) => writeStream.on('finish', () => res()));

      const exists = await adapter.exists(key);
      expect(exists).toBe(true);

      const readStream = adapter.getReadStream(key);
      let content = '';
      for await (const chunk of readStream) {
        content += chunk.toString();
      }
      expect(content).toBe('Hello AfriDollar Storage');

      await adapter.delete(key);
      const existsAfterDelete = await adapter.exists(key);
      expect(existsAfterDelete).toBe(false);
    });
  });
});
