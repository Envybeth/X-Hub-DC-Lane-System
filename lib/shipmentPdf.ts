import { jsPDF } from 'jspdf';

export interface ShipmentPdfRow {
  puDate: string;
  customer: string;
  dc: string;
  pickticket: string;
  po: string;
  ctn: string;
  palletQty: string;
  container: string;
  location: string;
  notes?: string;
}

export interface ShipmentPdfLoad {
  puNumber: string;
  carrier: string;
  rows: ShipmentPdfRow[];
}

const HEADERS = [
  'PU Date',
  'Customer',
  'DC #',
  'Pickticket #',
  'PO #',
  'CTN',
  'Pallet Qty',
  'Container #',
  'PU #',
  'Carrier',
  'Location',
  'Notes'
];

// Keep PU# wide enough for single-line in most cases; allow carrier to wrap.
const COL_WEIGHTS = [0.72, 1.12, 0.78, 1.2, 1.08, 0.72, 0.78, 1.92, 1.24, 1.15, 1.02, 0.84];
const MERGED_LOAD_COL_INDEXES = new Set([8, 9]); // PU#, Carrier
const CELL_LINE_HEIGHT = 2.2;
const MIN_ROW_HEIGHT = 3.8;
const CELL_TEXT_INSET = 1.2;
const HEADER_HEIGHT = 6;

function formatToday() {
  return new Date().toLocaleDateString('en-US');
}

function formatPuDate(value: string) {
  if (!value) return '';
  const isoDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateMatch) {
    return `${Number(isoDateMatch[2])}/${Number(isoDateMatch[3])}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.getUTCMonth() + 1}/${parsed.getUTCDate()}`;
}

function drawCenteredWrappedText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  fontStyle: 'normal' | 'bold' = 'normal',
  lineHeight = CELL_LINE_HEIGHT
) {
  doc.setFont('helvetica', fontStyle);
  doc.setFontSize(fontSize);
  const lines = doc.splitTextToSize(text || '', Math.max(width - CELL_TEXT_INSET, 1));
  const safeLines = (lines.length > 0 ? lines : ['']) as string[];
  const blockHeight = safeLines.length * lineHeight;
  const firstLineY = y + (height / 2) - (blockHeight / 2) + (lineHeight / 2);

  safeLines.forEach((line, index) => {
    doc.text(line, x + (width / 2), firstLineY + (index * lineHeight), {
      align: 'center',
      baseline: 'middle'
    });
  });
}

function buildRowCells(row: ShipmentPdfRow, load: ShipmentPdfLoad): string[] {
  return [
    formatPuDate(row.puDate || ''),
    row.customer || '',
    row.dc || '',
    row.pickticket || '',
    row.po || '',
    row.ctn || '',
    row.palletQty || '',
    row.container || '',
    load.puNumber || '',
    load.carrier || '',
    row.location || '',
    row.notes || ''
  ];
}

function getMergedColumnValue(rowCells: string[][], colIndex: number): string | null {
  if (rowCells.length === 0) return null;
  const normalized = rowCells.map((cells) => (cells[colIndex] || '').trim());
  if (normalized.some((value) => value.length === 0)) return null;
  const first = normalized[0].toLowerCase();
  const allSame = normalized.every((value) => value.toLowerCase() === first);
  return allSame ? normalized[0] : null;
}

function sortLoadRowsByCustomer(rows: ShipmentPdfRow[]): ShipmentPdfRow[] {
  return [...rows].sort((a, b) => {
    const byCustomer = (a.customer || '').localeCompare((b.customer || ''), undefined, { sensitivity: 'base' });
    if (byCustomer !== 0) return byCustomer;

    const byDc = (a.dc || '').localeCompare((b.dc || ''), undefined, { sensitivity: 'base' });
    if (byDc !== 0) return byDc;

    const byPt = (a.pickticket || '').localeCompare((b.pickticket || ''), undefined, { sensitivity: 'base' });
    if (byPt !== 0) return byPt;

    return (a.po || '').localeCompare((b.po || ''), undefined, { sensitivity: 'base' });
  });
}

export function exportShipmentSummaryPdf(loads: ShipmentPdfLoad[], fileBaseName: string) {
  if (loads.length === 0) return;

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'letter'
  });

  const marginX = 10;
  const marginTop = 10;
  const bottomMargin = 10;
  const loadGap = 4;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const tableWidth = pageWidth - (marginX * 2);

  const totalWeight = COL_WEIGHTS.reduce((sum, value) => sum + value, 0);
  const colWidths = COL_WEIGHTS.map(value => (tableWidth * value) / totalWeight);

  const drawTitleAndHeader = () => {
    const titleHeight = 10;
    const titleY = marginTop + 7;
    const headerY = marginTop + titleHeight;

    doc.setDrawColor(70, 70, 70);
    doc.setFillColor(244, 244, 244);
    doc.rect(marginX, marginTop, tableWidth, titleHeight, 'FD');

    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(`Shipment Summary - ${formatToday()}`, pageWidth / 2, titleY, { align: 'center' });

    doc.setFontSize(9);
    let currentX = marginX;
    for (let i = 0; i < HEADERS.length; i++) {
      doc.setFillColor(225, 225, 225);
      doc.rect(currentX, headerY, colWidths[i], HEADER_HEIGHT, 'FD');
      doc.setTextColor(0, 0, 0);
      drawCenteredWrappedText(doc, HEADERS[i], currentX, headerY, colWidths[i], HEADER_HEIGHT, 7.8, 'bold', 2.2);
      currentX += colWidths[i];
    }

    return headerY + HEADER_HEIGHT;
  };

  let cursorY = drawTitleAndHeader();
  const contentBottom = pageHeight - bottomMargin;

  for (let loadIndex = 0; loadIndex < loads.length; loadIndex++) {
    const load = loads[loadIndex];
    if (load.rows.length === 0) continue;
    const sortedRows = sortLoadRowsByCustomer(load.rows);
    const rowCells = sortedRows.map(row => buildRowCells(row, load));
    const mergedPuDate = getMergedColumnValue(rowCells, 0);
    const shouldMergePuDate = Boolean(mergedPuDate);
    const mergedLocation = getMergedColumnValue(rowCells, 10);
    const shouldMergeLocation = Boolean(mergedLocation);
    const rowHeights = rowCells.map(cells => {
      let maxLines = 1;
      for (let index = 0; index < cells.length; index++) {
        if (MERGED_LOAD_COL_INDEXES.has(index)) continue;
        if (index === 0 && shouldMergePuDate) continue;
        if (index === 10 && shouldMergeLocation) continue;
        const wrapped = doc.splitTextToSize(cells[index] || '', Math.max(colWidths[index] - CELL_TEXT_INSET, 1));
        maxLines = Math.max(maxLines, wrapped.length || 1);
      }
      return Math.max(MIN_ROW_HEIGHT, (maxLines * CELL_LINE_HEIGHT) + 1);
    });

    const loadHeight = rowHeights.reduce((sum, h) => sum + h, 0);

    if (cursorY + loadHeight > contentBottom) {
      doc.addPage('letter', 'landscape');
      cursorY = drawTitleAndHeader();
    }

    const loadFill = loadIndex % 2 === 0 ? [255, 255, 255] : [246, 246, 246];
    const puDateColX = marginX;
    const puColX = marginX + colWidths.slice(0, 8).reduce((sum, w) => sum + w, 0);
    const carrierColX = puColX + colWidths[8];

    let rowY = cursorY;
    for (let rowIndex = 0; rowIndex < rowCells.length; rowIndex++) {
      const cells = rowCells[rowIndex];
      const height = rowHeights[rowIndex];

      let currentX = marginX;
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        if (
          MERGED_LOAD_COL_INDEXES.has(colIndex) ||
          (colIndex === 0 && shouldMergePuDate) ||
          (colIndex === 10 && shouldMergeLocation)
        ) {
          currentX += colWidths[colIndex];
          continue;
        }

        doc.setFillColor(loadFill[0], loadFill[1], loadFill[2]);
        doc.rect(currentX, rowY, colWidths[colIndex], height, 'FD');

        doc.setTextColor(0, 0, 0);
        const isPuDateCell = colIndex === 0;
        const isLocationCell = colIndex === 10;
        const fontSize = isLocationCell ? 8.9 : isPuDateCell ? 8.1 : 7.4;
        const lineHeight = isLocationCell ? 2.5 : 2.2;
        const fontStyle: 'normal' | 'bold' = (isPuDateCell || isLocationCell) ? 'bold' : 'normal';
        drawCenteredWrappedText(doc, cells[colIndex] || '', currentX, rowY, colWidths[colIndex], height, fontSize, fontStyle, lineHeight);

        currentX += colWidths[colIndex];
      }

      rowY += height;
    }

    doc.setFillColor(loadFill[0], loadFill[1], loadFill[2]);
    if (shouldMergePuDate) {
      doc.rect(puDateColX, cursorY, colWidths[0], loadHeight, 'FD');
    }
    doc.rect(puColX, cursorY, colWidths[8], loadHeight, 'FD');
    doc.rect(carrierColX, cursorY, colWidths[9], loadHeight, 'FD');
    const locationColX = carrierColX + colWidths[9];
    if (shouldMergeLocation) {
      doc.rect(locationColX, cursorY, colWidths[10], loadHeight, 'FD');
    }

    doc.setTextColor(0, 0, 0);
    if (shouldMergePuDate) {
      drawCenteredWrappedText(doc, mergedPuDate || '', puDateColX, cursorY, colWidths[0], loadHeight, 8.1, 'bold', 2.3);
    }
    drawCenteredWrappedText(doc, load.puNumber || '', puColX, cursorY, colWidths[8], loadHeight, 9, 'bold', 2.7);
    drawCenteredWrappedText(doc, load.carrier || '', carrierColX, cursorY, colWidths[9], loadHeight, 7.6, 'normal', 2.3);
    if (shouldMergeLocation) {
      drawCenteredWrappedText(doc, mergedLocation || '', locationColX, cursorY, colWidths[10], loadHeight, 8.9, 'bold', 2.5);
    }

    cursorY += loadHeight;
    if (loadIndex < loads.length - 1) {
      cursorY += loadGap;
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - 10, 6, { align: 'right' });
  }

  const safeDate = formatToday().replace(/\//g, '-');
  doc.save(`${fileBaseName}-${safeDate}.pdf`);
}
