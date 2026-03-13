export type SyncSkippedBreakdown = {
  picked_up: number;
  paper: number;
  missing_pt_or_po: number;
};

export type SyncReconciliationSummary = {
  shipmentRowsNormalized: number;
  shipmentDatesReconciled: number;
  mergedRows: number;
  finalizedReopened: number;
  staleStageConflicts: number;
  staleConflictShipments: number;
  shipmentLinksRemoved: number;
};

export type SyncSummaryData = {
  success: boolean;
  message: string;
  sourceSheet: string | null;
  syncedCount: number;
  skippedCount: number;
  errorCount: number;
  sheetRowCount: number;
  candidateRowCount: number;
  containerCount: number;
  activeSheetLoadCount: number;
  newLoadGroupCount: number;
  newLoadGroupExamples: string[];
  skippedBreakdown: SyncSkippedBreakdown;
  reconciliation: SyncReconciliationSummary;
};

export type SyncSummarySection = {
  title: string;
  lines: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function readNumber(source: Record<string, unknown> | null, keys: string[]): number {
  if (!source) return 0;
  for (const key of keys) {
    const value = source[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function readStringArray(source: Record<string, unknown> | null, keys: string[]): string[] {
  if (!source) return [];
  for (const key of keys) {
    const value = source[key];
    if (!Array.isArray(value)) continue;
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }
  return [];
}

function readSkippedBreakdown(source: Record<string, unknown> | null): SyncSkippedBreakdown {
  const breakdown = asRecord(source?.skipped_breakdown ?? source?.skippedBreakdown);
  return {
    picked_up: readNumber(breakdown, ['picked_up', 'pickedUp']),
    paper: readNumber(breakdown, ['paper']),
    missing_pt_or_po: readNumber(breakdown, ['missing_pt_or_po', 'missingPtOrPo'])
  };
}

function readReconciliation(source: Record<string, unknown> | null): SyncReconciliationSummary {
  const reconciliation = asRecord(source?.reconciliation);
  return {
    shipmentRowsNormalized: readNumber(reconciliation, ['shipmentRowsNormalized', 'shipment_rows_normalized']),
    shipmentDatesReconciled: readNumber(reconciliation, ['shipmentDatesReconciled', 'shipment_dates_reconciled']),
    mergedRows: readNumber(reconciliation, ['mergedRows', 'merged_rows']),
    finalizedReopened: readNumber(reconciliation, ['finalizedReopened', 'finalized_reopened']),
    staleStageConflicts: readNumber(reconciliation, ['staleStageConflicts', 'stale_stage_conflicts']),
    staleConflictShipments: readNumber(reconciliation, ['staleConflictShipments', 'stale_conflict_shipments']),
    shipmentLinksRemoved: readNumber(reconciliation, ['shipmentLinksRemoved', 'shipment_links_removed'])
  };
}

export function normalizeSyncSummaryData(raw: unknown): SyncSummaryData {
  const source = asRecord(raw);
  const skippedBreakdown = readSkippedBreakdown(source);
  const reconciliation = readReconciliation(source);
  const errorCount = readNumber(source, ['errors', 'errorCount', 'error_count']);
  const successValue = source?.success;
  const success = typeof successValue === 'boolean' ? successValue : errorCount === 0;

  return {
    success,
    message: readString(source, ['message']) || (success ? 'Sync completed.' : 'Sync completed with errors.'),
    sourceSheet: readString(source, ['sourceSheet', 'source_sheet']),
    syncedCount: readNumber(source, ['count', 'syncedCount', 'synced_count']),
    skippedCount: readNumber(source, ['skipped', 'skippedCount', 'skipped_count']),
    errorCount,
    sheetRowCount: readNumber(source, ['sheetRowCount', 'sheet_row_count']),
    candidateRowCount: readNumber(source, ['candidateRowCount', 'candidate_row_count']),
    containerCount: readNumber(source, ['containerCount', 'container_count']),
    activeSheetLoadCount: readNumber(source, ['activeSheetLoadCount', 'active_sheet_load_count']),
    newLoadGroupCount: readNumber(source, ['newLoadGroupCount', 'new_load_group_count']),
    newLoadGroupExamples: readStringArray(source, ['newLoadGroupExamples', 'new_load_group_examples']),
    skippedBreakdown,
    reconciliation
  };
}

export function buildSyncNotificationTitle(summary: SyncSummaryData): string {
  return summary.errorCount > 0 ? 'Google Sheet Sync Completed With Errors' : 'Google Sheet Sync Completed';
}

export function buildSyncNotificationMessage(summary: SyncSummaryData): string {
  const sourceText = summary.sourceSheet ? ` from ${summary.sourceSheet}` : '';
  return `${summary.syncedCount} synced, ${summary.skippedCount} skipped${sourceText}`;
}

export function buildSyncNotificationDetails(summary: SyncSummaryData): string[] {
  const details: string[] = [];

  if (summary.errorCount > 0) {
    details.push(`Row errors: ${summary.errorCount}`);
  }
  if (summary.newLoadGroupCount > 0) {
    details.push(`New PU loads in sheet: ${summary.newLoadGroupCount}`);
  }
  if (summary.reconciliation.staleConflictShipments > 0) {
    details.push(`Loads blocked by stale staged PTs: ${summary.reconciliation.staleConflictShipments}`);
  }
  if (summary.reconciliation.finalizedReopened > 0) {
    details.push(`Finalized loads reopened: ${summary.reconciliation.finalizedReopened}`);
  }
  if (summary.reconciliation.mergedRows > 0) {
    details.push(`Shipment rows merged: ${summary.reconciliation.mergedRows}`);
  }
  if (details.length === 0) {
    details.push('No shipment-level corrections were needed.');
  }

  return details.slice(0, 5);
}

export function buildSyncPrimarySection(summary: SyncSummaryData): string[] {
  const lines = [
    summary.message,
    summary.sourceSheet ? `Source sheet: ${summary.sourceSheet}` : null,
    `Synced: ${summary.syncedCount}`,
    `Skipped: ${summary.skippedCount}`,
    `Row errors: ${summary.errorCount}`,
    `Skip reasons: picked up ${summary.skippedBreakdown.picked_up}, PAPER ${summary.skippedBreakdown.paper}, missing PT/PO ${summary.skippedBreakdown.missing_pt_or_po}`
  ];

  return lines.filter((line): line is string => Boolean(line));
}

export function buildSyncDetailSections(summary: SyncSummaryData): SyncSummarySection[] {
  const sections: SyncSummarySection[] = [];

  const sheetLines = [
    summary.sheetRowCount > 0 ? `Rows read from sheet: ${summary.sheetRowCount}` : null,
    summary.candidateRowCount > 0 ? `Candidate PT rows after sync filters: ${summary.candidateRowCount}` : null,
    summary.containerCount > 0 ? `Containers referenced: ${summary.containerCount}` : null,
    summary.activeSheetLoadCount > 0 ? `Active PU loads in sheet: ${summary.activeSheetLoadCount}` : null,
    summary.newLoadGroupCount > 0 ? `New PU loads discovered: ${summary.newLoadGroupCount}` : 'New PU loads discovered: 0'
  ].filter((line): line is string => Boolean(line));

  if (summary.newLoadGroupExamples.length > 0) {
    sheetLines.push(`Examples: ${summary.newLoadGroupExamples.join(', ')}`);
  }

  sections.push({
    title: 'Sheet Snapshot',
    lines: sheetLines
  });

  const shipmentImpactLines = [
    summary.reconciliation.staleConflictShipments > 0
      ? `Loads flagged with stale staged PT hazards: ${summary.reconciliation.staleConflictShipments}`
      : null,
    summary.reconciliation.staleStageConflicts > 0
      ? `PTs force-unstaged because their PU load changed: ${summary.reconciliation.staleStageConflicts}`
      : null,
    summary.reconciliation.finalizedReopened > 0
      ? `Finalized loads reopened to in-process: ${summary.reconciliation.finalizedReopened}`
      : null,
    summary.reconciliation.shipmentRowsNormalized > 0
      ? `Shipment rows retargeted/normalized: ${summary.reconciliation.shipmentRowsNormalized}`
      : null,
    summary.reconciliation.shipmentDatesReconciled > 0
      ? `Shipment date reconciliations: ${summary.reconciliation.shipmentDatesReconciled}`
      : null,
    summary.reconciliation.mergedRows > 0
      ? `Duplicate shipment rows merged: ${summary.reconciliation.mergedRows}`
      : null,
    summary.reconciliation.shipmentLinksRemoved > 0
      ? `Old shipment links removed for unstaged PTs: ${summary.reconciliation.shipmentLinksRemoved}`
      : null
  ].filter((line): line is string => Boolean(line));

  sections.push({
    title: 'Shipment Impact',
    lines: shipmentImpactLines.length > 0
      ? shipmentImpactLines
      : ['No shipment-level corrections were needed during this sync.']
  });

  return sections;
}
