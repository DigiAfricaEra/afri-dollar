/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, max-lines-per-function, complexity */
import { Workbook } from 'exceljs';

import type { ReportData } from '../../types';

export async function generateXLSX(
  data: ReportData[],
  filePath: string,
  sheetName: string = 'Report'
): Promise<void> {
  const workbook = new Workbook();
  workbook.creator = 'AfriDollar Platform';
  workbook.created = new Date();

  const safeSheetName = sheetName.replace(/[:\\/?*[\]]/g, ' ').substring(0, 31);
  const worksheet = workbook.addWorksheet(safeSheetName, {
    views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }],
  });

  if (!data || data.length === 0) {
    worksheet.addRow(['No data available for this report.']);
    await workbook.xlsx.writeFile(filePath);
    return;
  }

  const headers = Object.keys(data[0]);

  // Set Columns with Initial Metadata
  worksheet.columns = headers.map((header) => {
    const formattedHeader = header.replace(/([A-Z])/g, ' $1').toUpperCase();
    return {
      header: formattedHeader,
      key: header,
      width: Math.max(15, formattedHeader.length + 4),
    };
  });

  // Style Header Row
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 10 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: '1A365D' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 24;

  // Auto-Filter
  const lastColLetter = String.fromCharCode(64 + headers.length);
  worksheet.autoFilter = `A1:${lastColLetter}1`;

  // Track Numeric Columns for Formats & Totals
  const numericColumns = new Set<string>();
  const currencyColumns = new Set<string>();
  const dateColumns = new Set<string>();

  headers.forEach((header) => {
    const lowerHeader = header.toLowerCase();
    if (
      lowerHeader.includes('amount') ||
      lowerHeader.includes('balance') ||
      lowerHeader.includes('total')
    ) {
      currencyColumns.add(header);
      numericColumns.add(header);
    } else if (lowerHeader.includes('date') || lowerHeader.includes('at')) {
      dateColumns.add(header);
    } else {
      const isNumeric = data.every((row) => {
        const val = row[header];
        return val == null || val === '' || !isNaN(Number(val));
      });
      if (isNumeric && data.some((row) => Number(row[header]) !== 0)) {
        numericColumns.add(header);
      }
    }
  });

  // Add Data Rows
  data.forEach((record, index) => {
    const row = worksheet.addRow(record);
    row.height = 20;

    // Alternating Row Fill
    if (index % 2 === 1) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'F8FAFC' },
      };
    }

    headers.forEach((header, colIndex) => {
      const cell = row.getCell(colIndex + 1);
      const val = record[header];

      if (currencyColumns.has(header) && val != null) {
        const num =
          typeof val === 'number'
            ? val
            : Number(typeof val === 'object' ? JSON.stringify(val) : String(val));
        if (!isNaN(num)) {
          cell.value = num;
          cell.numFmt = '#,##0.00 "USD"';
          cell.alignment = { horizontal: 'right' };
        }
      } else if (numericColumns.has(header) && val != null) {
        const num =
          typeof val === 'number'
            ? val
            : Number(typeof val === 'object' ? JSON.stringify(val) : String(val));
        if (!isNaN(num)) {
          cell.value = num;
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right' };
        }
      } else if (dateColumns.has(header) && val != null) {
        const dateVal =
          typeof val === 'number' || typeof val === 'string'
            ? val
            : typeof val === 'object' && !(val instanceof Date)
              ? JSON.stringify(val)
              : (val as Date);
        const date = val instanceof Date ? val : new Date(dateVal);
        if (!isNaN(date.getTime())) {
          cell.value = date;
          cell.numFmt = 'yyyy-mm-dd hh:mm:ss';
          cell.alignment = { horizontal: 'center' };
        }
      }

      // Auto Adjust Column Width
      const strVal =
        cell.value != null
          ? typeof cell.value === 'object'
            ? cell.value instanceof Date
              ? cell.value.toISOString()
              : JSON.stringify(cell.value)
            : String(cell.value)
          : '';
      const col = worksheet.getColumn(colIndex + 1);
      if (strVal.length + 4 > (col.width || 15)) {
        col.width = Math.min(40, strVal.length + 4);
      }
    });
  });

  // Totals Row if currency/numeric columns exist
  if (numericColumns.size > 0) {
    const totalRowValues: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      if (idx === 0) {
        totalRowValues[header] = 'TOTAL';
      } else if (numericColumns.has(header)) {
        const totalSum = data.reduce((acc, row) => {
          const num = Number(row[header]);
          return acc + (isNaN(num) ? 0 : num);
        }, 0);
        totalRowValues[header] = totalSum;
      }
    });

    const totalRow = worksheet.addRow(totalRowValues);
    totalRow.height = 22;
    totalRow.font = { bold: true, color: { argb: '1A365D' } };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'E2E8F0' },
    };

    headers.forEach((header, colIndex) => {
      const cell = totalRow.getCell(colIndex + 1);
      if (currencyColumns.has(header)) {
        cell.numFmt = '#,##0.00 "USD"';
        cell.alignment = { horizontal: 'right' };
      } else if (numericColumns.has(header)) {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      }
    });
  }

  await workbook.xlsx.writeFile(filePath);
}
