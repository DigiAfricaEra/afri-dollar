/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, max-lines-per-function */
import fs from 'fs';

import PDFDocument from 'pdfkit';

import type { ReportData } from '../../types';

export interface PDFWriterOptions {
  title: string;
  parameters?: Record<string, unknown>;
}

export async function generatePDF(
  data: ReportData[],
  filePath: string,
  options: PDFWriterOptions | string
): Promise<void> {
  const title = typeof options === 'string' ? options : options.title;
  const parameters = typeof options === 'string' ? undefined : options.parameters;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // --- Header Section ---
    doc.fillColor('#1A365D').fontSize(20).font('Helvetica-Bold').text('AfriDollar', 36, 36);
    doc.fillColor('#4A5568').fontSize(14).font('Helvetica').text(title, 36, 60);

    const generatedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
    doc
      .fontSize(9)
      .fillColor('#718096')
      .text(`Generated: ${generatedAt} UTC`, 36, 78, { align: 'right' });

    doc
      .moveTo(36, 92)
      .lineTo(doc.page.width - 36, 92)
      .strokeColor('#CBD5E0')
      .lineWidth(1)
      .stroke();

    // --- Filters Banner ---
    let startY = 104;
    if (parameters && Object.keys(parameters).length > 0) {
      doc.rect(36, startY, doc.page.width - 72, 28).fill('#EDF2F7');
      doc
        .fillColor('#2D3748')
        .fontSize(9)
        .font('Helvetica-Bold')
        .text('Filter Parameters:', 44, startY + 8);

      const filterText = Object.entries(parameters)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' | ');

      doc
        .font('Helvetica')
        .fillColor('#4A5568')
        .text(filterText || 'None', 140, startY + 8);
      startY += 38;
    }

    if (!data || data.length === 0) {
      doc
        .fillColor('#718096')
        .fontSize(12)
        .font('Helvetica-Oblique')
        .text('No data available for this report.', 36, startY + 20, { align: 'center' });
    } else {
      // --- Table Rendering ---
      const headers = Object.keys(data[0]);
      const tableWidth = doc.page.width - 72;
      const colWidth = Math.max(40, tableWidth / headers.length);
      const rowHeight = 20;

      // Table Header Row
      let currentY = startY;
      doc.rect(36, currentY, tableWidth, rowHeight).fill('#1A365D');
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');

      headers.forEach((header, index) => {
        const x = 36 + index * colWidth;
        const formattedHeader = header.replace(/([A-Z])/g, ' $1').toUpperCase();
        doc.text(formattedHeader, x + 4, currentY + 6, {
          width: colWidth - 8,
          height: rowHeight,
          ellipsis: true,
        });
      });

      currentY += rowHeight;

      // Track numerical column totals
      const totals: Record<string, number> = {};
      const numericColumns = new Set<string>();

      headers.forEach((header) => {
        const isNumeric = data.every((row) => {
          const val = row[header];
          return val == null || val === '' || !isNaN(Number(val));
        });
        if (isNumeric) {
          const hasNonZero = data.some((row) => Number(row[header]) !== 0);
          if (hasNonZero) numericColumns.add(header);
        }
      });

      // Table Data Rows
      data.forEach((row, rowIndex) => {
        // Page overflow check
        if (currentY + rowHeight > doc.page.height - 50) {
          doc.addPage();
          currentY = 36;

          // Repeat Header on new page
          doc.rect(36, currentY, tableWidth, rowHeight).fill('#1A365D');
          doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
          headers.forEach((header, index) => {
            const x = 36 + index * colWidth;
            const formattedHeader = header.replace(/([A-Z])/g, ' $1').toUpperCase();
            doc.text(formattedHeader, x + 4, currentY + 6, {
              width: colWidth - 8,
              height: rowHeight,
              ellipsis: true,
            });
          });
          currentY += rowHeight;
        }

        // Alternating row background
        if (rowIndex % 2 === 1) {
          doc.rect(36, currentY, tableWidth, rowHeight).fill('#F7FAFC');
        }

        doc.fillColor('#2D3748').fontSize(8).font('Helvetica');

        headers.forEach((header, index) => {
          const x = 36 + index * colWidth;
          const rawValue = row[header];
          let displayValue = '';

          if (rawValue instanceof Date) {
            displayValue = rawValue.toISOString().substring(0, 10);
          } else if (rawValue != null) {
            displayValue =
              typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue);
          }

          if (numericColumns.has(header) && rawValue != null) {
            const num =
              typeof rawValue === 'number'
                ? rawValue
                : Number(
                    typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue)
                  );
            if (!isNaN(num)) {
              totals[header] = (totals[header] || 0) + num;
            }
          }

          doc.text(displayValue, x + 4, currentY + 6, {
            width: colWidth - 8,
            height: rowHeight,
            ellipsis: true,
            align: numericColumns.has(header) ? 'right' : 'left',
          });
        });

        currentY += rowHeight;
      });

      // Totals Row if numerical columns exist
      if (numericColumns.size > 0 && currentY + rowHeight <= doc.page.height - 50) {
        doc.rect(36, currentY, tableWidth, rowHeight).fill('#E2E8F0');
        doc.fillColor('#1A365D').fontSize(8).font('Helvetica-Bold');
        doc.text('TOTAL', 40, currentY + 6, { width: colWidth - 8 });

        headers.forEach((header, index) => {
          if (numericColumns.has(header) && totals[header] !== undefined) {
            const x = 36 + index * colWidth;
            const formattedTotal = totals[header].toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            doc.text(formattedTotal, x + 4, currentY + 6, {
              width: colWidth - 8,
              align: 'right',
            });
          }
        });
      }
    }

    // --- Dynamic Footer & Page Numbers ---
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc
        .moveTo(36, doc.page.height - 36)
        .lineTo(doc.page.width - 36, doc.page.height - 36)
        .strokeColor('#E2E8F0')
        .lineWidth(0.5)
        .stroke();
      doc
        .fillColor('#A0AEC0')
        .fontSize(8)
        .font('Helvetica')
        .text(
          `AfriDollar Platform — Confidential | Page ${i + 1} of ${pages.count}`,
          36,
          doc.page.height - 28,
          { align: 'center' }
        );
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}
