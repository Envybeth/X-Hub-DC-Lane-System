import { buildPuLoadKey, normalizePuDate, normalizePuNumber } from './shipmentIdentity';

export type DuplicateStagingLaneShipmentRow = {
  id: number;
  pu_number: string | null | undefined;
  pu_date: string | null | undefined;
  staging_lane: string | null | undefined;
  status: string | null | undefined;
  archived?: boolean | null | undefined;
};

export type ShipmentDuplicateStagingLaneConflict = {
  lane: string;
  conflicting_shipment_id: number;
  conflicting_pu_number: string | null;
  conflicting_pu_date: string | null;
  conflicting_status: string | null;
  message: string;
};

export type DuplicateStagingLaneConflictMaps = {
  conflictsByShipmentKey: Map<string, ShipmentDuplicateStagingLaneConflict[]>;
  shipmentsByLane: Map<string, DuplicateStagingLaneShipmentRow[]>;
};

export const STALE_STAGE_CONFLICT_BADGE_LABEL = '⚠️ Staged PT belongs to another load';
export const STALE_STAGE_CONFLICT_PANEL_TITLE = 'Action required: a staged PT in this lane belongs to a different PU load';
export const STALE_STAGE_CONFLICT_PANEL_DESCRIPTION = 'This load is blocked until the staged PT is moved out of the staging lane or its load identity is corrected. You cannot stage more PTs into this load or finalize it yet.';

function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function buildNormalizedPuLoadKey(
  puNumber: string | null | undefined,
  puDate: string | null | undefined
): string | null {
  return buildPuLoadKey(normalizePuNumber(puNumber), normalizePuDate(puDate));
}

export function buildNormalizedPuOwnerKey(
  puNumber: string | null | undefined
): string | null {
  return normalizePuNumber(puNumber);
}

export function isActiveShipmentStageStatus(status: string | null | undefined): boolean {
  const normalized = toTrimmedText(status).toLowerCase();
  return normalized === 'staged' || normalized === 'ready_to_ship';
}

export function isReadyToShipStatus(status: string | null | undefined): boolean {
  return toTrimmedText(status).toLowerCase() === 'ready_to_ship';
}

export function isShipmentLoadMismatch(params: {
  shipmentPuNumber: string | null | undefined;
  shipmentPuDate: string | null | undefined;
  ptPuNumber: string | null | undefined;
  ptPuDate: string | null | undefined;
}): boolean {
  const shipmentPuNumber = normalizePuNumber(params.shipmentPuNumber);
  const shipmentPuDate = normalizePuDate(params.shipmentPuDate);
  if (!shipmentPuNumber || !shipmentPuDate) return false;

  const ptPuNumber = normalizePuNumber(params.ptPuNumber);
  const ptPuDate = normalizePuDate(params.ptPuDate);

  // A date-only shift on the same PU number is treated as the same operational load.
  // Sync should retarget/merge the shipment row, not force a stale staged-PT hazard.
  if (ptPuNumber && ptPuDate && shipmentPuNumber === ptPuNumber) {
    return false;
  }

  return true;
}

export function isSameShipmentLoadDateShift(params: {
  shipmentPuNumber: string | null | undefined;
  shipmentPuDate: string | null | undefined;
  ptPuNumber: string | null | undefined;
  ptPuDate: string | null | undefined;
}): boolean {
  const shipmentPuNumber = normalizePuNumber(params.shipmentPuNumber);
  const shipmentPuDate = normalizePuDate(params.shipmentPuDate);
  const ptPuNumber = normalizePuNumber(params.ptPuNumber);
  const ptPuDate = normalizePuDate(params.ptPuDate);

  return Boolean(
    shipmentPuNumber
    && shipmentPuDate
    && ptPuNumber
    && ptPuDate
    && shipmentPuNumber === ptPuNumber
    && shipmentPuDate !== ptPuDate
  );
}

export function formatPuLoadLabel(
  puNumber: string | null | undefined,
  puDate: string | null | undefined
): string {
  const normalizedPuNumber = normalizePuNumber(puNumber);
  const normalizedPuDate = normalizePuDate(puDate);

  if (!normalizedPuNumber || !normalizedPuDate) {
    return 'No current PU load';
  }

  return `PU Load ${normalizedPuNumber} (${normalizedPuDate})`;
}

export function buildStaleStageConflictBlockedMessage(
  puNumber: string | null | undefined
): string {
  const normalizedPuNumber = normalizePuNumber(puNumber) || 'N/A';
  return `PU Load ${normalizedPuNumber} is blocked because a PT still staged in this lane now belongs to a different PU load. Resolve that staged PT conflict before staging more PTs or finalizing this load.`;
}

export function buildStaleStageLaneAlertMessage(
  lane: string | null | undefined
): string {
  const normalizedLane = toTrimmedText(lane) || '?';
  return `Lane ${normalizedLane} is blocked because a PT still staged there now belongs to a different PU load. Move that staged PT out before assigning more PTs to this staging lane.`;
}

function buildDuplicateStagingLaneConflictMessage(params: {
  lane: string;
  conflictingPuNumber: string | null | undefined;
  conflictingPuDate: string | null | undefined;
}): string {
  const conflictingLoadLabel = formatPuLoadLabel(params.conflictingPuNumber, params.conflictingPuDate);
  return `Lane ${params.lane} is also assigned to ${conflictingLoadLabel}. Move one of the loads to a different staging lane before staging or finalizing.`;
}

export function buildDuplicateStagingLaneConflictMaps(
  rows: DuplicateStagingLaneShipmentRow[]
): DuplicateStagingLaneConflictMaps {
  const groupedByLane = new Map<string, DuplicateStagingLaneShipmentRow[]>();
  const seenLoadKeysByLane = new Map<string, Set<string>>();

  rows.forEach((row) => {
    if (row.archived) return;

    const lane = toTrimmedText(row.staging_lane);
    if (!lane) return;

    const loadKey = buildNormalizedPuOwnerKey(row.pu_number);
    if (!loadKey) return;

    const seenLoadKeys = seenLoadKeysByLane.get(lane) || new Set<string>();
    if (seenLoadKeys.has(loadKey)) return;
    seenLoadKeys.add(loadKey);
    seenLoadKeysByLane.set(lane, seenLoadKeys);

    const groupedRows = groupedByLane.get(lane) || [];
    groupedRows.push({
      ...row,
      staging_lane: lane
    });
    groupedByLane.set(lane, groupedRows);
  });

  const conflictsByShipmentKey = new Map<string, ShipmentDuplicateStagingLaneConflict[]>();
  const duplicateShipmentsByLane = new Map<string, DuplicateStagingLaneShipmentRow[]>();

  groupedByLane.forEach((laneRows, lane) => {
    if (laneRows.length < 2) return;
    duplicateShipmentsByLane.set(lane, laneRows);

    laneRows.forEach((shipmentRow) => {
      const shipmentKey = buildNormalizedPuLoadKey(shipmentRow.pu_number, shipmentRow.pu_date);
      const shipmentOwnerKey = buildNormalizedPuOwnerKey(shipmentRow.pu_number);
      if (!shipmentKey) return;
      if (!shipmentOwnerKey) return;

      const conflicts = laneRows
        .filter((candidate) => (
          buildNormalizedPuOwnerKey(candidate.pu_number) !== shipmentOwnerKey
        ))
        .map((candidate) => ({
          lane,
          conflicting_shipment_id: Number(candidate.id),
          conflicting_pu_number: normalizePuNumber(candidate.pu_number) || null,
          conflicting_pu_date: normalizePuDate(candidate.pu_date) || null,
          conflicting_status: toTrimmedText(candidate.status) || null,
          message: buildDuplicateStagingLaneConflictMessage({
            lane,
            conflictingPuNumber: candidate.pu_number,
            conflictingPuDate: candidate.pu_date
          })
        }));

      if (conflicts.length > 0) {
        conflictsByShipmentKey.set(shipmentKey, conflicts);
      }
    });
  });

  return {
    conflictsByShipmentKey,
    shipmentsByLane: duplicateShipmentsByLane
  };
}
