import 'server-only';
import { google } from 'googleapis';
import { getSupabaseAdmin } from './supabaseAdmin';
import { buildPuLoadKey, normalizePuDate, normalizePuNumber } from './shipmentIdentity';
import {
  formatPuLoadLabel,
  isActiveShipmentStageStatus,
  isShipmentLoadMismatch
} from './shipmentLoadConflicts';

function parseDate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.trim() === '') return null;

  // Handle 4-digit year: "02/09/2026" or "1/30/2026"
  let dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    const month = dateMatch[1];
    const day = dateMatch[2];
    const year = dateMatch[3];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Handle 2-digit year: "1/30/26" or "2/4/26"
  dateMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/);
  if (dateMatch) {
    const month = dateMatch[1];
    const day = dateMatch[2];
    const yearShort = dateMatch[3];
    const year = `20${yearShort}`;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return null;
}

const getGoogleAuth = () => {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    return new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }
};

const auth = getGoogleAuth();
const sheets = google.sheets({ version: 'v4', auth });
const UPSERT_CHUNK_SIZE = 500;

type SupabaseAdminClient = ReturnType<typeof getSupabaseAdmin>;

type ShipmentRow = {
  id: number;
  pu_number: string | null;
  pu_date: string | null;
  staging_lane: string | null;
  status: string | null;
  carrier: string | null;
  archived: boolean | null;
  updated_at: string | null;
  created_at: string | null;
};

type ShipmentPtRow = {
  shipment_id: number;
  pt_id: number;
  original_lane: string | null;
  removed_from_staging: boolean | null;
};

type PickticketStateRow = {
  id: number;
  pu_number: string | null;
  pu_date: string | null;
  status: string | null;
  carrier: string | null;
};

type ReconcileResult = {
  shipmentRowsNormalized: number;
  shipmentDatesReconciled: number;
  mergedRows: number;
  finalizedReopened: number;
  staleStageConflicts: number;
  staleConflictShipments: number;
  shipmentLinksRemoved: number;
};

type SyncGoogleSheetOptions = {
  actorUserId?: string | null;
};

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function quoteSheetNameForRange(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function trimToNull(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseInteger(value?: string): number | null {
  if (!value || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseDecimal(value?: string): number | null {
  if (!value || value.trim() === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function statusRank(status?: string | null): number {
  const normalized = (status || '').trim().toLowerCase();
  if (normalized === 'finalized') return 3;
  if (normalized === 'in_process') return 2;
  if (normalized === 'not_started') return 1;
  return 0;
}

function pickHigherShipmentStatus(a?: string | null, b?: string | null): string {
  return statusRank(a) >= statusRank(b) ? (a || 'not_started') : (b || 'not_started');
}

async function loadShipmentRows(supabaseAdmin: SupabaseAdminClient): Promise<ShipmentRow[]> {
  const { data, error } = await supabaseAdmin
    .from('shipments')
    .select('id, pu_number, pu_date, staging_lane, status, carrier, archived, updated_at, created_at');
  if (error) throw error;
  return (data || []) as ShipmentRow[];
}

async function loadShipmentPtRows(
  supabaseAdmin: SupabaseAdminClient,
  shipmentIds: number[]
): Promise<ShipmentPtRow[]> {
  if (shipmentIds.length === 0) return [];
  const links: ShipmentPtRow[] = [];

  for (const chunk of chunkArray(shipmentIds, UPSERT_CHUNK_SIZE)) {
    const { data, error } = await supabaseAdmin
      .from('shipment_pts')
      .select('shipment_id, pt_id, original_lane, removed_from_staging')
      .in('shipment_id', chunk);
    if (error) throw error;
    links.push(...(((data || []) as ShipmentPtRow[])));
  }

  return links;
}

async function loadPickticketStateRows(supabaseAdmin: SupabaseAdminClient): Promise<PickticketStateRow[]> {
  const { data, error } = await supabaseAdmin
    .from('picktickets')
    .select('id, pu_number, pu_date, status, carrier')
    .neq('customer', 'PAPER');
  if (error) throw error;
  return (data || []) as PickticketStateRow[];
}

async function mergeShipmentRows(
  supabaseAdmin: SupabaseAdminClient,
  sourceRow: ShipmentRow,
  targetRow: ShipmentRow,
  sourceLinks: ShipmentPtRow[],
  nowIso: string
): Promise<void> {
  for (const sourceLink of sourceLinks) {
    const { error: upsertLinkError } = await supabaseAdmin
      .from('shipment_pts')
      .upsert({
        shipment_id: targetRow.id,
        pt_id: sourceLink.pt_id,
        original_lane: sourceLink.original_lane,
        removed_from_staging: Boolean(sourceLink.removed_from_staging)
      }, {
        onConflict: 'shipment_id,pt_id'
      });
    if (upsertLinkError) throw upsertLinkError;
  }

  if (sourceLinks.length > 0) {
    const { error: deleteSourceLinksError } = await supabaseAdmin
      .from('shipment_pts')
      .delete()
      .eq('shipment_id', sourceRow.id);
    if (deleteSourceLinksError) throw deleteSourceLinksError;
  }

  const mergedStatus = pickHigherShipmentStatus(sourceRow.status, targetRow.status);
  const mergedCarrier = trimToNull(targetRow.carrier) || trimToNull(sourceRow.carrier);
  const mergedStagingLane = trimToNull(targetRow.staging_lane) || trimToNull(sourceRow.staging_lane);
  const mergedArchived = Boolean(targetRow.archived) && Boolean(sourceRow.archived);

  const { error: updateTargetError } = await supabaseAdmin
    .from('shipments')
    .update({
      carrier: mergedCarrier,
      staging_lane: mergedStagingLane,
      status: mergedStatus,
      archived: mergedArchived,
      updated_at: nowIso
    })
    .eq('id', targetRow.id);
  if (updateTargetError) throw updateTargetError;

  const { error: deleteSourceError } = await supabaseAdmin
    .from('shipments')
    .delete()
    .eq('id', sourceRow.id);
  if (deleteSourceError) throw deleteSourceError;
}

async function reconcileShipmentIdentityAndStatus(
  supabaseAdmin: SupabaseAdminClient
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    shipmentRowsNormalized: 0,
    shipmentDatesReconciled: 0,
    mergedRows: 0,
    finalizedReopened: 0,
    staleStageConflicts: 0,
    staleConflictShipments: 0,
    shipmentLinksRemoved: 0
  };

  const nowIso = new Date().toISOString();
  const shipments = await loadShipmentRows(supabaseAdmin);
  if (shipments.length === 0) {
    return result;
  }

  const shipmentIds = shipments.map((row) => row.id);
  const shipmentPtRows = await loadShipmentPtRows(supabaseAdmin, shipmentIds);
  const pickticketRows = await loadPickticketStateRows(supabaseAdmin);

  const pickticketById = new Map<number, PickticketStateRow>();
  const nonShippedPtIdsByPuKey = new Map<string, number[]>();
  const readyToShipPtIdsByPuKey = new Map<string, number[]>();
  const carrierByPuKey = new Map<string, string>();

  pickticketRows.forEach((row) => {
    const normalizedPuNumber = normalizePuNumber(row.pu_number);
    const normalizedPuDate = normalizePuDate(row.pu_date);
    const key = buildPuLoadKey(normalizedPuNumber, normalizedPuDate);
    const normalizedCarrier = trimToNull(row.carrier);
    pickticketById.set(row.id, {
      ...row,
      pu_number: normalizedPuNumber,
      pu_date: normalizedPuDate,
      carrier: normalizedCarrier
    });

    if (!normalizedPuNumber || !normalizedPuDate || !key) return;

    if (normalizedCarrier && !carrierByPuKey.has(key)) {
      carrierByPuKey.set(key, normalizedCarrier);
    }

    const normalizedStatus = (row.status || '').trim().toLowerCase();
    if (normalizedStatus !== 'shipped') {
      const ids = nonShippedPtIdsByPuKey.get(key) || [];
      ids.push(row.id);
      nonShippedPtIdsByPuKey.set(key, ids);
    }
    if (normalizedStatus === 'ready_to_ship') {
      const ids = readyToShipPtIdsByPuKey.get(key) || [];
      ids.push(row.id);
      readyToShipPtIdsByPuKey.set(key, ids);
    }
  });

  const linksByShipmentId = new Map<number, ShipmentPtRow[]>();
  shipmentPtRows.forEach((row) => {
    const existing = linksByShipmentId.get(row.shipment_id) || [];
    existing.push(row);
    linksByShipmentId.set(row.shipment_id, existing);
  });

  const staleStagePtIds = new Set<number>();
  const staleShipmentIdsToTouch = new Set<number>();
  const finalizedShipmentIdsToReopen = new Set<number>();
  const shipmentLinksToMarkRemoved: Array<{ shipmentId: number; ptId: number }> = [];
  const shipmentLinksToDelete: Array<{ shipmentId: number; ptId: number }> = [];

  for (const shipment of shipments) {
    const shipmentLinks = linksByShipmentId.get(shipment.id) || [];

    shipmentLinks.forEach((linkRow) => {
      if (Boolean(linkRow.removed_from_staging)) return;

      const ptRow = pickticketById.get(linkRow.pt_id);
      if (!isShipmentLoadMismatch({
        shipmentPuNumber: shipment.pu_number,
        shipmentPuDate: shipment.pu_date,
        ptPuNumber: ptRow?.pu_number,
        ptPuDate: ptRow?.pu_date
      })) {
        return;
      }

      if (isActiveShipmentStageStatus(ptRow?.status)) {
        linkRow.removed_from_staging = true;
        shipmentLinksToMarkRemoved.push({ shipmentId: shipment.id, ptId: linkRow.pt_id });
        staleStagePtIds.add(linkRow.pt_id);
        staleShipmentIdsToTouch.add(shipment.id);
        result.staleStageConflicts += 1;

        if (ptRow) {
          ptRow.status = 'labeled';
        }

        if ((shipment.status || '').trim().toLowerCase() === 'finalized') {
          finalizedShipmentIdsToReopen.add(shipment.id);
        }
        return;
      }

      shipmentLinksToDelete.push({ shipmentId: shipment.id, ptId: linkRow.pt_id });
    });
  }

  result.staleConflictShipments = staleShipmentIdsToTouch.size;

  for (const link of shipmentLinksToDelete) {
    const { error } = await supabaseAdmin
      .from('shipment_pts')
      .delete()
      .eq('shipment_id', link.shipmentId)
      .eq('pt_id', link.ptId);
    if (error) throw error;

    const existing = linksByShipmentId.get(link.shipmentId) || [];
    linksByShipmentId.set(
      link.shipmentId,
      existing.filter((row) => row.pt_id !== link.ptId)
    );
    result.shipmentLinksRemoved += 1;
  }

  for (const link of shipmentLinksToMarkRemoved) {
    const { error } = await supabaseAdmin
      .from('shipment_pts')
      .update({ removed_from_staging: true })
      .eq('shipment_id', link.shipmentId)
      .eq('pt_id', link.ptId);
    if (error) throw error;
  }

  if (staleStagePtIds.size > 0) {
    const { error: demoteStalePtsError } = await supabaseAdmin
      .from('picktickets')
      .update({ status: 'labeled' })
      .in('id', Array.from(staleStagePtIds))
      .in('status', ['staged', 'ready_to_ship']);
    if (demoteStalePtsError) throw demoteStalePtsError;
  }

  for (const shipment of shipments) {
    if (!staleShipmentIdsToTouch.has(shipment.id) && !finalizedShipmentIdsToReopen.has(shipment.id)) {
      continue;
    }

    const nextStatus = finalizedShipmentIdsToReopen.has(shipment.id) ? 'in_process' : shipment.status;
    const { error: updateShipmentError } = await supabaseAdmin
      .from('shipments')
      .update({
        status: nextStatus,
        updated_at: nowIso
      })
      .eq('id', shipment.id);
    if (updateShipmentError) throw updateShipmentError;

    shipment.status = nextStatus;
    if (finalizedShipmentIdsToReopen.has(shipment.id)) {
      result.finalizedReopened += 1;
    }
  }

  for (const shipment of shipments) {
    const shipmentLinks = linksByShipmentId.get(shipment.id) || [];
    const activeShipmentLinks = shipmentLinks.filter((linkRow) => !Boolean(linkRow.removed_from_staging));
    const linkedKeys = new Set<string>();

    activeShipmentLinks.forEach((linkRow) => {
      const ptRow = pickticketById.get(linkRow.pt_id);
      const key = buildPuLoadKey(ptRow?.pu_number, ptRow?.pu_date);
      if (key) linkedKeys.add(key);
    });

    const normalizedShipmentPu = normalizePuNumber(shipment.pu_number);
    const normalizedShipmentDate = normalizePuDate(shipment.pu_date);
    const originalKey = buildPuLoadKey(shipment.pu_number, shipment.pu_date);
    const normalizedKey = buildPuLoadKey(normalizedShipmentPu, normalizedShipmentDate);
    const canonicalLinkedKey = linkedKeys.size === 1 ? Array.from(linkedKeys)[0] : null;
    const targetKey = canonicalLinkedKey || normalizedKey;

    if (!targetKey) continue;
    const [targetPuNumber, targetPuDate] = targetKey.split('::');
    const targetCarrier = carrierByPuKey.get(targetKey) || trimToNull(shipment.carrier);

    const puChanged = trimToNull(shipment.pu_number) !== targetPuNumber;
    const puDateChanged = normalizePuDate(shipment.pu_date) !== targetPuDate;
    const carrierChanged = trimToNull(shipment.carrier) !== targetCarrier;
    if (!puChanged && !puDateChanged && !carrierChanged) {
      continue;
    }

    const { data: conflictingRows, error: conflictingRowsError } = await supabaseAdmin
      .from('shipments')
      .select('id, pu_number, pu_date, staging_lane, status, carrier, archived, updated_at, created_at')
      .eq('pu_number', targetPuNumber)
      .eq('pu_date', targetPuDate)
      .neq('id', shipment.id)
      .order('id', { ascending: false })
      .limit(1);
    if (conflictingRowsError) throw conflictingRowsError;

    const conflictingRow = ((conflictingRows || []) as ShipmentRow[])[0];
    if (conflictingRow) {
      await mergeShipmentRows(supabaseAdmin, shipment, conflictingRow, activeShipmentLinks, nowIso);
      result.mergedRows += 1;
      continue;
    }

    const { error: updateShipmentError } = await supabaseAdmin
      .from('shipments')
      .update({
        pu_number: targetPuNumber,
        pu_date: targetPuDate,
        carrier: targetCarrier,
        updated_at: nowIso
      })
      .eq('id', shipment.id);
    if (updateShipmentError) throw updateShipmentError;

    if (puChanged || carrierChanged || !originalKey || originalKey !== normalizedKey) {
      result.shipmentRowsNormalized += 1;
    }
    if (puDateChanged || (canonicalLinkedKey && canonicalLinkedKey !== originalKey)) {
      result.shipmentDatesReconciled += 1;
    }
  }

  const reconciledShipments = await loadShipmentRows(supabaseAdmin);
  const activeShipments = reconciledShipments.filter((row) => !Boolean(row.archived));
  if (activeShipments.length === 0) {
    return result;
  }

  const activeShipmentIds = activeShipments.map((row) => row.id);
  const reconciledShipmentPtRows = await loadShipmentPtRows(supabaseAdmin, activeShipmentIds);
  const linkedPtIdsByShipment = new Map<number, Set<number>>();
  reconciledShipmentPtRows.forEach((row) => {
    if (Boolean(row.removed_from_staging)) return;
    const existing = linkedPtIdsByShipment.get(row.shipment_id) || new Set<number>();
    existing.add(row.pt_id);
    linkedPtIdsByShipment.set(row.shipment_id, existing);
  });

  for (const shipment of activeShipments) {
    if ((shipment.status || '').trim().toLowerCase() !== 'finalized') continue;

    const key = buildPuLoadKey(shipment.pu_number, shipment.pu_date);
    if (!key) continue;

    const expectedPtIds = nonShippedPtIdsByPuKey.get(key) || [];
    if (expectedPtIds.length === 0) continue;

    const linkedPtIds = linkedPtIdsByShipment.get(shipment.id) || new Set<number>();
    const hasNewUnlinkedPt = expectedPtIds.some((ptId) => !linkedPtIds.has(ptId));
    if (!hasNewUnlinkedPt) continue;

    const readyToShipIds = readyToShipPtIdsByPuKey.get(key) || [];
    if (readyToShipIds.length > 0) {
      const { error: demoteError } = await supabaseAdmin
        .from('picktickets')
        .update({ status: 'staged' })
        .in('id', readyToShipIds);
      if (demoteError) throw demoteError;
    }

    const { error: reopenError } = await supabaseAdmin
      .from('shipments')
      .update({
        status: 'in_process',
        updated_at: nowIso
      })
      .eq('id', shipment.id);
    if (reopenError) throw reopenError;

    result.finalizedReopened += 1;
  }

  return result;
}

async function logSyncSummaryEvent(
  supabaseAdmin: SupabaseAdminClient,
  options: SyncGoogleSheetOptions,
  payload: {
    sourceSheetName: string;
    syncedCount: number;
    skippedCount: number;
    errorCount: number;
    sheetRowCount: number;
    candidateRowCount: number;
    containerCount: number;
    activeSheetLoadCount: number;
    newLoadGroupCount: number;
    newLoadGroupExamples: string[];
    skippedBreakdown: {
      picked_up: number;
      paper: number;
      missing_pt_or_po: number;
    };
    reconciliation: ReconcileResult;
  }
) {
  const actorUserId = trimToNull(options.actorUserId);
  const { error } = await supabaseAdmin
    .from('user_action_logs')
    .insert({
      user_id: actorUserId,
      action: 'INSERT',
      target_table: 'sync_jobs',
      target_id: payload.sourceSheetName,
      details: {
        operation: 'google_sheet_sync',
        source_sheet: payload.sourceSheetName,
        synced_count: payload.syncedCount,
        skipped_count: payload.skippedCount,
        error_count: payload.errorCount,
        sheet_row_count: payload.sheetRowCount,
        candidate_row_count: payload.candidateRowCount,
        container_count: payload.containerCount,
        active_sheet_load_count: payload.activeSheetLoadCount,
        new_load_group_count: payload.newLoadGroupCount,
        new_load_group_examples: payload.newLoadGroupExamples,
        skipped_breakdown: payload.skippedBreakdown,
        reconciliation: {
          shipment_rows_normalized: payload.reconciliation.shipmentRowsNormalized,
          shipment_dates_reconciled: payload.reconciliation.shipmentDatesReconciled,
          merged_rows: payload.reconciliation.mergedRows,
          finalized_reopened: payload.reconciliation.finalizedReopened,
          stale_stage_conflicts: payload.reconciliation.staleStageConflicts,
          stale_conflict_shipments: payload.reconciliation.staleConflictShipments,
          shipment_links_removed: payload.reconciliation.shipmentLinksRemoved
        }
      }
    });
  if (error) {
    console.warn('Failed to log sync summary event:', error.message);
  }
}

async function resolveSourceSheetName(spreadsheetId: string): Promise<string> {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
  });

  const firstSheetName = metadata.data.sheets?.[0]?.properties?.title;
  if (!firstSheetName) {
    throw new Error('No sheets found in the spreadsheet');
  }

  return firstSheetName;
}

export async function syncGoogleSheetData(options: SyncGoogleSheetOptions = {}) {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      throw new Error('GOOGLE_SHEET_ID is not configured');
    }
    const supabaseAdmin = getSupabaseAdmin();
    const sourceSheetName = await resolveSourceSheetName(spreadsheetId);
    const existingPickticketRows = await loadPickticketStateRows(supabaseAdmin);
    const existingLoadKeys = new Set<string>();

    console.log(`📊 Syncing from sheet: ${sourceSheetName}`);

    existingPickticketRows.forEach((row) => {
      if ((row.status || '').trim().toLowerCase() === 'shipped') return;
      const key = buildPuLoadKey(normalizePuNumber(row.pu_number), normalizePuDate(row.pu_date));
      if (key) existingLoadKeys.add(key);
    });

    // Fetch columns A through S (19 columns)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteSheetNameForRange(sourceSheetName)}!A:S`,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      console.log('No data found.');
      await logSyncSummaryEvent(supabaseAdmin, options, {
        sourceSheetName,
        syncedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        sheetRowCount: 0,
        candidateRowCount: 0,
        containerCount: 0,
        activeSheetLoadCount: 0,
        newLoadGroupCount: 0,
        newLoadGroupExamples: [],
        skippedBreakdown: {
          picked_up: 0,
          paper: 0,
          missing_pt_or_po: 0
        },
        reconciliation: {
          shipmentRowsNormalized: 0,
          shipmentDatesReconciled: 0,
          mergedRows: 0,
          finalizedReopened: 0,
          staleStageConflicts: 0,
          staleConflictShipments: 0,
          shipmentLinksRemoved: 0
        }
      });
      return {
        success: false,
        message: 'No data found',
        sourceSheet: sourceSheetName,
        count: 0,
        skipped: 0,
        errors: 0,
        sheetRowCount: 0,
        candidateRowCount: 0,
        containerCount: 0,
        activeSheetLoadCount: 0,
        newLoadGroupCount: 0,
        newLoadGroupExamples: [],
        skipped_breakdown: {
          picked_up: 0,
          paper: 0,
          missing_pt_or_po: 0
        },
        reconciliation: {
          shipmentRowsNormalized: 0,
          shipmentDatesReconciled: 0,
          mergedRows: 0,
          finalizedReopened: 0,
          staleStageConflicts: 0,
          staleConflictShipments: 0,
          shipmentLinksRemoved: 0
        }
      };
    }

    const dataRows = rows.slice(1);

    let syncedCount = 0;
    let errorCount = 0;
    const skippedBreakdown = {
      picked_up: 0,
      paper: 0,
      missing_pt_or_po: 0
    };
    const containerNumbers = new Set<string>();
    const sheetLoadLabelsByKey = new Map<string, string>();
    const nowIso = new Date().toISOString();
    type PickticketUpsertRow = {
      customer?: string;
      store_dc?: string;
      pt_number: string;
      po_number: string;
      dept_number?: string;
      qty: number | null;
      ctn: string | null;
      weight: number | null;
      cubic_feet: number | null;
      est_pallet: number | null;
      start_date: string | null;
      cancel_date: string | null;
      container_number: string | null;
      routing_number: string | null;
      pu_number: string | null;
      carrier: string | null;
      pu_date: string | null;
      last_synced_at: string;
    };
    const pickticketRows: PickticketUpsertRow[] = [];

    for (const row of dataRows) {
      const [
        customer,           // A (0)
        store_dc,          // B (1)
        pt_number,         // C (2)
        po_number,         // D (3)
        dept_number,       // E (4)
        qty,               // F (5)
        ctn,               // G (6) - CTN field (text)
        weight,            // H (7)
        cubic_feet,        // I (8)
        est_pallet,        // J (9)
        start_date,        // K (10)
        cancel_date,       // L (11)
        container_number,  // M (12)
        routing_number,    // N (13)
        pu_number,         // O (14)
        carrier,           // P (15)
        pu_date,           // Q (16)
        // R (17) - skipped/not used
        pickup_status,     // S (18)
      ] = row;

      const normalizedCustomer = trimToNull(customer);
      const normalizedStoreDc = trimToNull(store_dc);
      const normalizedPtNumber = trimToNull(pt_number);
      const normalizedPoNumber = trimToNull(po_number);
      const normalizedDeptNumber = trimToNull(dept_number);
      const normalizedCtn = trimToNull(ctn);
      const normalizedContainerNumber = trimToNull(container_number);
      const normalizedRoutingNumber = trimToNull(routing_number);
      const normalizedPuNumber = normalizePuNumber(pu_number);
      const normalizedPuDate = normalizePuDate(parseDate(pu_date));
      const normalizedCarrier = trimToNull(carrier);
      const normalizedPickupStatus = trimToNull(pickup_status);

      // SKIP if already picked up
      if (normalizedPickupStatus && normalizedPickupStatus.toLowerCase().includes('picked up')) {
        skippedBreakdown.picked_up += 1;
        continue;
      }

      // SKIP if customer is PAPER
      if (normalizedCustomer && normalizedCustomer.toUpperCase() === 'PAPER') {
        skippedBreakdown.paper += 1;
        continue;
      }

      if (!normalizedPtNumber || !normalizedPoNumber) {
        skippedBreakdown.missing_pt_or_po += 1;
        continue;
      }

      if (normalizedContainerNumber) {
        containerNumbers.add(normalizedContainerNumber);
      }

      pickticketRows.push({
        customer: normalizedCustomer || undefined,
        store_dc: normalizedStoreDc || undefined,
        pt_number: normalizedPtNumber,
        po_number: normalizedPoNumber,
        dept_number: normalizedDeptNumber || undefined,
        qty: parseInteger(qty),
        ctn: normalizedCtn,
        weight: parseDecimal(weight),
        cubic_feet: parseDecimal(cubic_feet),
        est_pallet: parseInteger(est_pallet),
        start_date: parseDate(start_date),
        cancel_date: parseDate(cancel_date),
        container_number: normalizedContainerNumber,
        routing_number: normalizedRoutingNumber,
        pu_number: normalizedPuNumber,
        carrier: normalizedCarrier,
        pu_date: normalizedPuDate,
        last_synced_at: nowIso,
      });

      const loadKey = buildPuLoadKey(normalizedPuNumber, normalizedPuDate);
      if (loadKey && !sheetLoadLabelsByKey.has(loadKey)) {
        sheetLoadLabelsByKey.set(loadKey, formatPuLoadLabel(normalizedPuNumber, normalizedPuDate));
      }
    }

    const containerRows = Array.from(containerNumbers).map((value) => ({ container_number: value }));
    for (const chunk of chunkArray(containerRows, UPSERT_CHUNK_SIZE)) {
      const { error: containerBatchError } = await supabaseAdmin
        .from('containers')
        .upsert(chunk, { onConflict: 'container_number' });

      if (!containerBatchError) continue;
      console.error('Container batch upsert failed, falling back to per-row upsert:', containerBatchError);

      for (const item of chunk) {
        const { error: containerRowError } = await supabaseAdmin
          .from('containers')
          .upsert(item, { onConflict: 'container_number' });
        if (containerRowError) {
          errorCount += 1;
          console.error('Error upserting container:', item.container_number, containerRowError);
        }
      }
    }

    for (const chunk of chunkArray(pickticketRows, UPSERT_CHUNK_SIZE)) {
      const { error: ptBatchError } = await supabaseAdmin
        .from('picktickets')
        .upsert(chunk, { onConflict: 'pt_number,po_number' });

      if (!ptBatchError) {
        syncedCount += chunk.length;
        continue;
      }

      console.error('Pickticket batch upsert failed, falling back to per-row upsert:', ptBatchError);
      for (const item of chunk) {
        const { error: ptRowError } = await supabaseAdmin
          .from('picktickets')
          .upsert(item, { onConflict: 'pt_number,po_number' });
        if (ptRowError) {
          errorCount += 1;
          console.error('Error upserting PT:', item.pt_number, ptRowError);
        } else {
          syncedCount += 1;
        }
      }
    }

    const reconcileResult = await reconcileShipmentIdentityAndStatus(supabaseAdmin);

    const skippedCount = skippedBreakdown.picked_up + skippedBreakdown.paper + skippedBreakdown.missing_pt_or_po;
    const success = errorCount === 0;
    const message = success
      ? `Synced ${syncedCount} picktickets from "${sourceSheetName}"`
      : `Sync completed with errors from "${sourceSheetName}"`;
    const newLoadGroupLabels = Array.from(sheetLoadLabelsByKey.entries())
      .filter(([key]) => !existingLoadKeys.has(key))
      .map(([, label]) => label);
    const newLoadGroupExamples = newLoadGroupLabels.slice(0, 6);

    await logSyncSummaryEvent(supabaseAdmin, options, {
      sourceSheetName,
      syncedCount,
      skippedCount,
      errorCount,
      sheetRowCount: dataRows.length,
      candidateRowCount: pickticketRows.length,
      containerCount: containerNumbers.size,
      activeSheetLoadCount: sheetLoadLabelsByKey.size,
      newLoadGroupCount: newLoadGroupLabels.length,
      newLoadGroupExamples,
      skippedBreakdown,
      reconciliation: reconcileResult
    });

    console.log(`✅ ${message}. skipped=${skippedCount} errors=${errorCount}`);
    return {
      success,
      message,
      count: syncedCount,
      skipped: skippedCount,
      skipped_breakdown: skippedBreakdown,
      errors: errorCount,
      sourceSheet: sourceSheetName,
      sheetRowCount: dataRows.length,
      candidateRowCount: pickticketRows.length,
      containerCount: containerNumbers.size,
      activeSheetLoadCount: sheetLoadLabelsByKey.size,
      newLoadGroupCount: newLoadGroupLabels.length,
      newLoadGroupExamples,
      reconciliation: reconcileResult
    };

  } catch (error) {
    console.error('Error syncing Google Sheets:', error);
    throw error;
  }
}
