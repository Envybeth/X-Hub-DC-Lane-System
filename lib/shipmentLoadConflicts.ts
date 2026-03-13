import { buildPuLoadKey, normalizePuDate, normalizePuNumber } from './shipmentIdentity';

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
