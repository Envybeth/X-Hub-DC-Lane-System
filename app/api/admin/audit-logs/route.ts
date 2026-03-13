import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/serverAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { AppRole } from '@/lib/auth';

type AuditLogRow = {
  id: number;
  user_id: string | null;
  action: string;
  target_table: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type UserProfileRow = {
  id: string;
  username: string;
  display_name: string | null;
  role: AppRole;
};

type PickticketLookupRow = {
  id: number;
  pt_number: string | null;
  po_number: string | null;
};

type AuditLogResponseRow = AuditLogRow & {
  actor_username: string | null;
  actor_display_name: string | null;
  actor_role: AppRole | null;
  summary: string;
};

const SYNC_NOISE_TABLES = new Set(['picktickets', 'containers', 'shipment_pts', 'shipments']);
const SYNC_LOOKBACK_MS = 15 * 60 * 1000;

function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function toDetailsObject(row: AuditLogRow): Record<string, unknown> {
  if (!row.details || typeof row.details !== 'object' || Array.isArray(row.details)) {
    return {};
  }
  return row.details;
}

function toSnapshotObject(row: AuditLogRow, key: 'before' | 'after'): Record<string, unknown> | null {
  const details = toDetailsObject(row);
  const snapshot = details[key];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return null;
  }
  return snapshot as Record<string, unknown>;
}

function readDetail(row: AuditLogRow, key: string, snapshot?: 'before' | 'after'): string | null {
  if (!snapshot) {
    return toText(toDetailsObject(row)[key]);
  }
  const source = toSnapshotObject(row, snapshot);
  if (!source) return null;
  return toText(source[key]);
}

function readDetailAny(row: AuditLogRow, key: string): string | null {
  return readDetail(row, key, 'after') || readDetail(row, key) || readDetail(row, key, 'before');
}

function parseTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function isGoogleSheetSyncLog(row: AuditLogRow): boolean {
  if ((row.target_table || '').toLowerCase() !== 'sync_jobs') return false;
  const operation = (readDetailAny(row, 'operation') || '').toLowerCase();
  if (operation) return operation === 'google_sheet_sync';
  return row.action === 'INSERT';
}

function isCriticalShipmentTransition(row: AuditLogRow): boolean {
  if ((row.target_table || '').toLowerCase() !== 'shipments') return false;

  const statusBefore = readDetail(row, 'status', 'before');
  const statusAfter = readDetail(row, 'status', 'after') || readDetailAny(row, 'status');
  if (statusBefore && statusAfter && statusBefore !== statusAfter) {
    return true;
  }

  const archivedBefore = readDetail(row, 'archived', 'before');
  const archivedAfter = readDetail(row, 'archived', 'after') || readDetailAny(row, 'archived');
  if ((archivedBefore || archivedAfter) && archivedBefore !== archivedAfter) {
    return true;
  }

  return false;
}

function compactSyncNoise(logs: AuditLogRow[]): AuditLogRow[] {
  const syncMarkers = logs
    .filter((row) => isGoogleSheetSyncLog(row))
    .map((row) => ({
      userId: row.user_id || null,
      createdAtMs: parseTimestampMs(row.created_at)
    }))
    .filter((row): row is { userId: string | null; createdAtMs: number } => row.createdAtMs !== null);

  if (syncMarkers.length === 0) return logs;

  return logs.filter((row) => {
    if (isGoogleSheetSyncLog(row)) return true;

    const tableName = (row.target_table || '').toLowerCase();
    if (!SYNC_NOISE_TABLES.has(tableName)) return true;
    if (tableName === 'shipments' && isCriticalShipmentTransition(row)) return true;

    const rowTimeMs = parseTimestampMs(row.created_at);
    if (rowTimeMs === null) return true;

    for (const marker of syncMarkers) {
      const deltaMs = marker.createdAtMs - rowTimeMs;
      if (deltaMs < 0 || deltaMs > SYNC_LOOKBACK_MS) continue;

      if (row.user_id && marker.userId && row.user_id !== marker.userId) {
        continue;
      }
      if (row.user_id && !marker.userId) {
        continue;
      }

      return false;
    }

    return true;
  });
}

function filterNotificationRows(logs: AuditLogRow[]): AuditLogRow[] {
  return logs.filter((row) => isGoogleSheetSyncLog(row) || isCriticalShipmentTransition(row));
}

function extractPtId(row: AuditLogRow): string | null {
  const ptId = readDetailAny(row, 'pt_id');
  if (ptId) return ptId;
  if (row.target_table === 'picktickets') {
    return toText(row.target_id);
  }
  return null;
}

function formatLaneLabel(value: string | null): string {
  if (value === null) return 'Unknown lane';
  if (!value.trim()) return 'Unassigned';
  return `Lane ${value}`;
}

function humanizeValue(value: string): string {
  return value.replace(/_/g, ' ');
}

function getActionLabel(action: string): string {
  if (action === 'INSERT') return 'Created';
  if (action === 'UPDATE') return 'Updated';
  if (action === 'DELETE') return 'Deleted';
  if (action === 'MOVE') return 'Moved';
  return action;
}

function getFriendlyTableName(tableName: string): string {
  return tableName.replace(/_/g, ' ');
}

function combineLaneMoveLogs(logs: AuditLogRow[]): AuditLogRow[] {
  const consumedIds = new Set<number>();
  const combined: AuditLogRow[] = [];
  const maxLookahead = 12;
  const maxMoveDeltaMs = 20_000;

  for (let i = 0; i < logs.length; i += 1) {
    const row = logs[i];
    if (consumedIds.has(row.id)) continue;

    if (row.target_table === 'lane_assignments' && row.action === 'INSERT') {
      const insertPtId = extractPtId(row);
      const insertLane = readDetailAny(row, 'lane_number');
      const insertTimestamp = Date.parse(row.created_at);

      if (insertPtId && insertLane && Number.isFinite(insertTimestamp)) {
        for (let j = i + 1; j < Math.min(logs.length, i + maxLookahead + 1); j += 1) {
          const candidate = logs[j];
          if (consumedIds.has(candidate.id)) continue;
          if (candidate.target_table !== 'lane_assignments' || candidate.action !== 'DELETE') continue;
          if ((candidate.user_id || '') !== (row.user_id || '')) continue;
          if (extractPtId(candidate) !== insertPtId) continue;

          const deleteLane = readDetailAny(candidate, 'lane_number');
          if (!deleteLane || deleteLane === insertLane) continue;

          const deleteTimestamp = Date.parse(candidate.created_at);
          if (!Number.isFinite(deleteTimestamp)) continue;
          const deltaMs = insertTimestamp - deleteTimestamp;
          if (deltaMs < 0 || deltaMs > maxMoveDeltaMs) continue;

          consumedIds.add(row.id);
          consumedIds.add(candidate.id);

          combined.push({
            ...row,
            action: 'MOVE',
            target_id: insertPtId,
            details: {
              operation: 'combined_lane_move',
              pt_id: insertPtId,
              pt_number: readDetailAny(row, 'pt_number') || readDetailAny(candidate, 'pt_number'),
              po_number: readDetailAny(row, 'po_number') || readDetailAny(candidate, 'po_number'),
              from_lane: deleteLane,
              to_lane: insertLane,
              source_log_ids: [candidate.id, row.id],
              source: {
                delete: candidate.details,
                insert: row.details
              }
            }
          });
          break;
        }
      }
    }

    if (consumedIds.has(row.id)) continue;
    consumedIds.add(row.id);
    combined.push(row);
  }

  return combined;
}

function buildAuditSummary(
  row: AuditLogRow,
  pickticketsById: Map<string, PickticketLookupRow>
): string {
  const ptId = extractPtId(row);
  const pickedFromLookup = ptId ? pickticketsById.get(ptId) : null;
  const ptNumber = readDetailAny(row, 'pt_number') || pickedFromLookup?.pt_number || null;
  const poNumber = readDetailAny(row, 'po_number') || pickedFromLookup?.po_number || null;
  const ptLabel = ptNumber
    ? `PT ${ptNumber}${poNumber ? ` / PO ${poNumber}` : ''}`
    : (ptId ? `PT ID ${ptId}` : 'PT');

  if (isGoogleSheetSyncLog(row)) {
    const details = toDetailsObject(row);
    const reconciliation = (details.reconciliation && typeof details.reconciliation === 'object' && !Array.isArray(details.reconciliation))
      ? details.reconciliation as Record<string, unknown>
      : {};
    const sourceSheet = readDetailAny(row, 'source_sheet') || row.target_id || 'Unknown sheet';
    const syncedCount = readDetailAny(row, 'synced_count') || '0';
    const skippedCount = readDetailAny(row, 'skipped_count') || '0';
    const errorCount = readDetailAny(row, 'error_count') || '0';
    const newLoadGroupCount = readDetailAny(row, 'new_load_group_count') || '0';
    const staleConflictShipments = toText(reconciliation.stale_conflict_shipments) || '0';
    const finalizedReopened = toText(reconciliation.finalized_reopened) || '0';
    const summarySuffixParts = [
      newLoadGroupCount !== '0' ? `${newLoadGroupCount} new load${newLoadGroupCount === '1' ? '' : 's'}` : null,
      staleConflictShipments !== '0' ? `${staleConflictShipments} blocked load${staleConflictShipments === '1' ? '' : 's'}` : null,
      finalizedReopened !== '0' ? `${finalizedReopened} reopened` : null
    ].filter(Boolean);
    const summarySuffix = summarySuffixParts.length > 0 ? ` • ${summarySuffixParts.join(' • ')}` : '';
    if (errorCount !== '0') {
      return `Google Sheet sync completed with errors (${syncedCount} synced, ${skippedCount} skipped, ${errorCount} errors)${summarySuffix}`;
    }
    return `Google Sheet sync completed (${syncedCount} synced, ${skippedCount} skipped) from ${sourceSheet}${summarySuffix}`;
  }

  if (row.target_table === 'lane_assignments') {
    const laneBefore = readDetail(row, 'lane_number', 'before') || readDetailAny(row, 'from_lane');
    const laneAfter = readDetail(row, 'lane_number', 'after') || readDetailAny(row, 'to_lane') || readDetailAny(row, 'lane_number');
    const palletBefore = readDetail(row, 'pallet_count', 'before');
    const palletAfter = readDetail(row, 'pallet_count', 'after') || readDetailAny(row, 'pallet_count');

    if (row.action === 'MOVE' || (row.action === 'UPDATE' && laneBefore && laneAfter && laneBefore !== laneAfter)) {
      return `${ptLabel} moved from ${formatLaneLabel(laneBefore)} to ${formatLaneLabel(laneAfter)}`;
    }

    if (row.action === 'INSERT') {
      return `${ptLabel} assigned to ${formatLaneLabel(laneAfter || laneBefore)}`;
    }

    if (row.action === 'DELETE') {
      return `${ptLabel} removed from ${formatLaneLabel(laneBefore || laneAfter)}`;
    }

    if (row.action === 'UPDATE' && palletBefore && palletAfter && palletBefore !== palletAfter) {
      const laneText = laneAfter || laneBefore;
      return `${ptLabel} pallet count changed${laneText ? ` in ${formatLaneLabel(laneText)}` : ''}: ${palletBefore} -> ${palletAfter}`;
    }

    return `${ptLabel} lane assignment updated${laneAfter ? ` in ${formatLaneLabel(laneAfter)}` : ''}`;
  }

  if (row.target_table === 'picktickets') {
    const statusBefore = readDetail(row, 'status', 'before');
    const statusAfter = readDetail(row, 'status', 'after') || readDetailAny(row, 'status');
    const laneBefore = readDetail(row, 'assigned_lane', 'before');
    const laneAfter = readDetail(row, 'assigned_lane', 'after') || readDetailAny(row, 'assigned_lane');
    const palletBefore = readDetail(row, 'actual_pallet_count', 'before');
    const palletAfter = readDetail(row, 'actual_pallet_count', 'after') || readDetailAny(row, 'actual_pallet_count');

    if (row.action === 'INSERT') return `${ptLabel} created`;
    if (row.action === 'DELETE') return `${ptLabel} deleted`;

    if (statusBefore && statusAfter && statusBefore !== statusAfter) {
      return `${ptLabel} status changed: ${humanizeValue(statusBefore)} -> ${humanizeValue(statusAfter)}`;
    }

    if ((laneBefore || laneAfter) && laneBefore !== laneAfter) {
      return `${ptLabel} lane changed: ${formatLaneLabel(laneBefore)} -> ${formatLaneLabel(laneAfter)}`;
    }

    if ((palletBefore || palletAfter) && palletBefore !== palletAfter) {
      return `${ptLabel} pallet count changed: ${palletBefore || '0'} -> ${palletAfter || '0'}`;
    }

    return `${ptLabel} updated`;
  }

  if (row.target_table === 'shipment_pts') {
    const shipmentId = readDetailAny(row, 'shipment_id');
    if (row.action === 'INSERT') return `${ptLabel} added to shipment staging${shipmentId ? ` (Shipment ${shipmentId})` : ''}`;
    if (row.action === 'DELETE') return `${ptLabel} removed from shipment staging${shipmentId ? ` (Shipment ${shipmentId})` : ''}`;
    return `${ptLabel} shipment staging link updated${shipmentId ? ` (Shipment ${shipmentId})` : ''}`;
  }

  if (row.target_table === 'shipments') {
    const puNumber = readDetailAny(row, 'pu_number') || row.target_id || 'Unknown PU';
    const statusBefore = readDetail(row, 'status', 'before');
    const statusAfter = readDetail(row, 'status', 'after') || readDetailAny(row, 'status');
    const stagingBefore = readDetail(row, 'staging_lane', 'before');
    const stagingAfter = readDetail(row, 'staging_lane', 'after') || readDetailAny(row, 'staging_lane');
    const archivedBefore = readDetail(row, 'archived', 'before');
    const archivedAfter = readDetail(row, 'archived', 'after') || readDetailAny(row, 'archived');

    if (row.action === 'INSERT') return `PU ${puNumber} shipment created`;
    if (row.action === 'DELETE') return `PU ${puNumber} shipment deleted`;

    if (statusBefore && statusAfter && statusBefore !== statusAfter) {
      return `PU ${puNumber} status changed: ${humanizeValue(statusBefore)} -> ${humanizeValue(statusAfter)}`;
    }

    if ((stagingBefore || stagingAfter) && stagingBefore !== stagingAfter) {
      return `PU ${puNumber} staging lane changed: ${formatLaneLabel(stagingBefore)} -> ${formatLaneLabel(stagingAfter)}`;
    }

    if ((archivedBefore || archivedAfter) && archivedBefore !== archivedAfter) {
      if (archivedAfter === 'true') return `PU ${puNumber} marked archived`;
      if (archivedAfter === 'false') return `PU ${puNumber} unarchived`;
    }

    return `PU ${puNumber} shipment updated`;
  }

  const laneNumber = readDetailAny(row, 'lane_number');
  const containerNumber = readDetailAny(row, 'container_number');
  const parts: string[] = [];
  if (ptNumber) parts.push(`PT ${ptNumber}`);
  else if (ptId) parts.push(`PT ID ${ptId}`);
  if (laneNumber) parts.push(formatLaneLabel(laneNumber));
  if (containerNumber) parts.push(`Container ${containerNumber}`);

  if (parts.length > 0) {
    return `${getActionLabel(row.action)} ${getFriendlyTableName(row.target_table)}: ${parts.join(' · ')}`;
  }

  return `${getActionLabel(row.action)} ${getFriendlyTableName(row.target_table)}`;
}

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { searchParams } = new URL(request.url);

  const userId = searchParams.get('userId')?.trim() || '';
  const date = searchParams.get('date')?.trim() || '';
  const view = searchParams.get('view')?.trim().toLowerCase() || 'history';
  const limitRaw = Number.parseInt(searchParams.get('limit') || '200', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;
  const expandedLimit = Math.min(Math.max(limit * 6, limit), 5000);

  let query = supabaseAdmin
    .from('user_action_logs')
    .select('id, user_id, action, target_table, target_id, details, created_at')
    .gte('created_at', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(expandedLimit);

  if (userId) {
    query = query.eq('user_id', userId);
  }

  if (date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    query = query.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
  }

  const { data: logsData, error: logsError } = await query;
  if (logsError) {
    return NextResponse.json(
      { error: `Failed to load audit logs. If this is a new setup, run sql/user_action_logs.sql. (${logsError.message})` },
      { status: 500 }
    );
  }

  const rawLogs = (logsData || []) as AuditLogRow[];
  const combinedLogs = combineLaneMoveLogs(rawLogs);
  const compactedLogs = compactSyncNoise(combinedLogs);
  const scopedLogs = view === 'notifications' ? filterNotificationRows(compactedLogs) : compactedLogs;
  const logs = scopedLogs.slice(0, limit);
  const actorIds = Array.from(new Set(logs.map((row) => row.user_id).filter((id): id is string => Boolean(id))));

  let profilesById = new Map<string, UserProfileRow>();
  if (actorIds.length > 0) {
    const { data: profilesData } = await supabaseAdmin
      .from('user_profiles')
      .select('id, username, display_name, role')
      .in('id', actorIds);

    const profiles = (profilesData || []) as UserProfileRow[];
    profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  const ptIds = Array.from(
    new Set(
      logs
        .map((row) => extractPtId(row))
        .filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id))
    )
  );

  const pickticketsById = new Map<string, PickticketLookupRow>();
  if (ptIds.length > 0) {
    const { data: pickticketsData } = await supabaseAdmin
      .from('picktickets')
      .select('id, pt_number, po_number')
      .in('id', ptIds.map((id) => Number(id)));

    ((pickticketsData || []) as PickticketLookupRow[]).forEach((pickticket) => {
      pickticketsById.set(String(pickticket.id), pickticket);
    });
  }

  const rows: AuditLogResponseRow[] = logs.map((row) => {
    const actor = row.user_id ? profilesById.get(row.user_id) : null;
    return {
      ...row,
      actor_username: actor?.username || null,
      actor_display_name: actor?.display_name || null,
      actor_role: actor?.role || null,
      summary: buildAuditSummary(row, pickticketsById)
    };
  });

  return NextResponse.json({ logs: rows });
}
