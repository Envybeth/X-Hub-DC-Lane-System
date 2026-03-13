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
  const shipmentKey = buildNormalizedPuLoadKey(params.shipmentPuNumber, params.shipmentPuDate);
  if (!shipmentKey) return false;

  const ptKey = buildNormalizedPuLoadKey(params.ptPuNumber, params.ptPuDate);
  return shipmentKey !== ptKey;
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

  return `PU ${normalizedPuNumber} (${normalizedPuDate})`;
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

    const loadKey = buildNormalizedPuLoadKey(row.pu_number, row.pu_date);
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
      if (!shipmentKey) return;

      const conflicts = laneRows
        .filter((candidate) => (
          buildNormalizedPuLoadKey(candidate.pu_number, candidate.pu_date) !== shipmentKey
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
