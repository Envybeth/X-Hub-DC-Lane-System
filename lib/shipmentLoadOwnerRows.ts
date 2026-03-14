import { supabase } from '@/lib/supabase';
import { normalizePuDate, normalizePuNumber } from '@/lib/shipmentIdentity';

export type ShipmentLoadOwnerRow = {
  id: number;
  pu_number: string | null;
  pu_date: string | null;
  status: string | null;
  carrier: string | null;
  staging_lane: string | null;
  archived: boolean | null;
  updated_at: string | null;
  created_at: string | null;
};

type SaveShipmentByLoadOwnerParams = {
  puNumber: string;
  puDate: string;
  values: {
    staging_lane?: string | null;
    status?: string | null;
    carrier?: string | null;
    archived?: boolean | null;
    updated_at?: string | null;
  };
};

const SHIPMENT_SELECT_COLUMNS = 'id, pu_number, pu_date, status, carrier, staging_lane, archived, updated_at, created_at';

function shipmentRowTimestamp(row: ShipmentLoadOwnerRow): number {
  const updatedAt = row.updated_at ? new Date(row.updated_at).getTime() : Number.NaN;
  if (Number.isFinite(updatedAt)) return updatedAt;

  const createdAt = row.created_at ? new Date(row.created_at).getTime() : Number.NaN;
  if (Number.isFinite(createdAt)) return createdAt;

  return 0;
}

function sortShipmentRowsByRecency(rows: ShipmentLoadOwnerRow[]): ShipmentLoadOwnerRow[] {
  return [...rows].sort((left, right) => {
    const timestampDelta = shipmentRowTimestamp(right) - shipmentRowTimestamp(left);
    if (timestampDelta !== 0) return timestampDelta;
    return Number(right.id) - Number(left.id);
  });
}

export function pickReusableShipmentRowForLoadOwner(
  rows: ShipmentLoadOwnerRow[],
  puNumber: string | null | undefined,
  puDate: string | null | undefined
): ShipmentLoadOwnerRow | null {
  const normalizedPuNumber = normalizePuNumber(puNumber);
  const normalizedPuDate = normalizePuDate(puDate);
  if (!normalizedPuNumber) return null;

  const matchingOwnerRows = rows.filter((row) => normalizePuNumber(row.pu_number) === normalizedPuNumber);
  if (matchingOwnerRows.length === 0) return null;

  const activeRows = sortShipmentRowsByRecency(
    matchingOwnerRows.filter((row) => !Boolean(row.archived))
  );

  if (activeRows.length === 0) return null;

  if (normalizedPuDate) {
    const exactDateMatch = activeRows.find((row) => normalizePuDate(row.pu_date) === normalizedPuDate);
    if (exactDateMatch) return exactDateMatch;
  }

  return activeRows[0] || null;
}

export async function loadShipmentRowsForLoadOwner(
  puNumber: string | null | undefined
): Promise<ShipmentLoadOwnerRow[]> {
  const normalizedPuNumber = normalizePuNumber(puNumber);
  if (!normalizedPuNumber) return [];

  const { data, error } = await supabase
    .from('shipments')
    .select(SHIPMENT_SELECT_COLUMNS)
    .eq('pu_number', normalizedPuNumber);
  if (error) throw error;

  return (data || []) as ShipmentLoadOwnerRow[];
}

export async function saveShipmentByLoadOwner(
  params: SaveShipmentByLoadOwnerParams
): Promise<ShipmentLoadOwnerRow> {
  const normalizedPuNumber = normalizePuNumber(params.puNumber);
  const normalizedPuDate = normalizePuDate(params.puDate);
  if (!normalizedPuNumber || !normalizedPuDate) {
    throw new Error('PU number and PU date are required to save a shipment row.');
  }

  const existingRows = await loadShipmentRowsForLoadOwner(normalizedPuNumber);
  const reusableRow = pickReusableShipmentRowForLoadOwner(existingRows, normalizedPuNumber, normalizedPuDate);
  const payload = {
    pu_number: normalizedPuNumber,
    pu_date: normalizedPuDate,
    ...params.values
  };

  if (reusableRow) {
    const { data, error } = await supabase
      .from('shipments')
      .update(payload)
      .eq('id', reusableRow.id)
      .select(SHIPMENT_SELECT_COLUMNS)
      .single();
    if (error) throw error;
    return data as ShipmentLoadOwnerRow;
  }

  const { data, error } = await supabase
    .from('shipments')
    .insert(payload)
    .select(SHIPMENT_SELECT_COLUMNS)
    .single();
  if (error) throw error;

  return data as ShipmentLoadOwnerRow;
}
