import { supabase } from '@/lib/supabase';
import { normalizePuDate, normalizePuNumber } from '@/lib/shipmentIdentity';
import {
  buildStagedLaneAssignmentUnits,
  normalizeStagedLaneAssignmentsBatch
} from '@/lib/stagedLaneAssignments';

type PickticketLaneContextRow = {
  id: number;
  assigned_lane: string | null;
  status: string | null;
  actual_pallet_count: number | null;
  pt_number: string | null;
  compiled_pallet_id: number | null;
  carrier: string | null;
};

type LaneAssignmentPtRow = {
  pt_id: number;
};

type ShipmentUpsertRow = {
  id: number;
  status: string | null;
};

export type SetShipmentStagingLaneErrorCode =
  | 'invalid_input'
  | 'lane_missing'
  | 'lane_conflict';

export class SetShipmentStagingLaneError extends Error {
  readonly code: SetShipmentStagingLaneErrorCode;
  readonly targetLane: string | null;
  readonly foreignPtIds: number[];

  constructor(
    code: SetShipmentStagingLaneErrorCode,
    message: string,
    options?: { targetLane?: string | null; foreignPtIds?: number[] }
  ) {
    super(message);
    this.name = 'SetShipmentStagingLaneError';
    this.code = code;
    this.targetLane = options?.targetLane ?? null;
    this.foreignPtIds = options?.foreignPtIds ?? [];
  }
}

export type SetShipmentStagingLaneParams = {
  puNumber: string;
  puDate: string;
  targetLane: string | number;
  carrier?: string | null;
};

export type SetShipmentStagingLaneResult = {
  shipmentId: number;
  shipmentStatus: string | null;
  targetLane: string;
  stagedPtIds: number[];
  alreadyInLaneCount: number;
};

function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export async function setShipmentStagingLaneWithAutoLink(
  params: SetShipmentStagingLaneParams
): Promise<SetShipmentStagingLaneResult> {
  const puNumber = normalizePuNumber(params.puNumber);
  const puDate = normalizePuDate(params.puDate);
  const targetLane = toTrimmedText(params.targetLane);

  if (!puNumber || !puDate || !targetLane) {
    throw new SetShipmentStagingLaneError(
      'invalid_input',
      'PU number, PU date, and target lane are required.',
      { targetLane }
    );
  }

  const { data: laneMatch, error: laneCheckError } = await supabase
    .from('lanes')
    .select('lane_number')
    .eq('lane_number', targetLane)
    .maybeSingle();
  if (laneCheckError) throw laneCheckError;
  if (!laneMatch) {
    throw new SetShipmentStagingLaneError(
      'lane_missing',
      `Lane ${targetLane} does not exist.`,
      { targetLane }
    );
  }

  const { data: pickticketRows, error: pickticketError } = await supabase
    .from('picktickets')
    .select('id, assigned_lane, status, actual_pallet_count, pt_number, compiled_pallet_id, carrier')
    .eq('pu_number', puNumber)
    .eq('pu_date', puDate)
    .neq('status', 'shipped');
  if (pickticketError) throw pickticketError;

  const typedPickticketRows = (pickticketRows || []) as PickticketLaneContextRow[];
  const shipmentPtIdSet = new Set<number>(
    typedPickticketRows
      .map((row) => Number(row.id))
      .filter((ptId) => Number.isFinite(ptId))
  );

  const { data: laneRows, error: laneRowsError } = await supabase
    .from('lane_assignments')
    .select('pt_id')
    .eq('lane_number', targetLane);
  if (laneRowsError) throw laneRowsError;

  const uniqueLanePtIds = Array.from(
    new Set(
      ((laneRows || []) as LaneAssignmentPtRow[])
        .map((row) => Number(row.pt_id))
        .filter((ptId) => Number.isFinite(ptId))
    )
  );

  const sameShipmentPtIds = uniqueLanePtIds.filter((ptId) => shipmentPtIdSet.has(ptId));
  const foreignPtIds = uniqueLanePtIds.filter((ptId) => !shipmentPtIdSet.has(ptId));
  if (foreignPtIds.length > 0) {
    throw new SetShipmentStagingLaneError(
      'lane_conflict',
      `Lane ${targetLane} has ${foreignPtIds.length} PT(s) from other shipment(s).`,
      { targetLane, foreignPtIds }
    );
  }

  const preferredCarrier = toTrimmedText(params.carrier);
  const fallbackCarrier = toTrimmedText(
    typedPickticketRows.find((row) => toTrimmedText(row.carrier))?.carrier
  );

  const shipmentUpsertPayload: {
    pu_number: string;
    pu_date: string;
    staging_lane: string;
    status: 'in_process';
    updated_at: string;
    carrier?: string;
  } = {
    pu_number: puNumber,
    pu_date: puDate,
    staging_lane: targetLane,
    status: 'in_process',
    updated_at: new Date().toISOString()
  };
  if (preferredCarrier || fallbackCarrier) {
    shipmentUpsertPayload.carrier = preferredCarrier || fallbackCarrier;
  }

  const { data: shipmentDataRaw, error: shipmentError } = await supabase
    .from('shipments')
    .upsert(shipmentUpsertPayload, { onConflict: 'pu_number,pu_date' })
    .select('id, status')
    .single();
  if (shipmentError) throw shipmentError;

  const shipmentData = shipmentDataRaw as ShipmentUpsertRow | null;
  if (!shipmentData || !Number.isFinite(Number(shipmentData.id))) {
    throw new Error('Failed to resolve shipment row after setting staging lane.');
  }

  const assignedLaneByPtId = new Map<number, string | null>();
  const stagedPtIdSet = new Set<number>();
  const alreadyInTargetLane = new Set<number>();

  typedPickticketRows.forEach((pt) => {
    const ptId = Number(pt.id);
    if (!Number.isFinite(ptId)) return;
    const assignedLane = toTrimmedText(pt.assigned_lane) || null;
    assignedLaneByPtId.set(ptId, assignedLane);

    if (assignedLane === targetLane) {
      alreadyInTargetLane.add(ptId);
      stagedPtIdSet.add(ptId);
    }
  });

  sameShipmentPtIds.forEach((ptId) => {
    if (!shipmentPtIdSet.has(ptId)) return;
    alreadyInTargetLane.add(ptId);
    stagedPtIdSet.add(ptId);
  });

  const stagedPtIds = [...stagedPtIdSet].sort((a, b) => a - b);
  const stageStatus = shipmentData.status === 'finalized' ? 'ready_to_ship' : 'staged';

  if (stagedPtIds.length > 0) {
    const { error: upsertShipmentPtsError } = await supabase
      .from('shipment_pts')
      .upsert(
        stagedPtIds.map((ptId) => ({
          shipment_id: shipmentData.id,
          pt_id: ptId,
          original_lane: assignedLaneByPtId.get(ptId),
          removed_from_staging: false
        })),
        { onConflict: 'shipment_id,pt_id' }
      );
    if (upsertShipmentPtsError) throw upsertShipmentPtsError;

    const { error: updatePickticketsError } = await supabase
      .from('picktickets')
      .update({ status: stageStatus, assigned_lane: targetLane })
      .in('id', stagedPtIds);
    if (updatePickticketsError) throw updatePickticketsError;

    const stagedUnits = buildStagedLaneAssignmentUnits(stagedPtIds, typedPickticketRows);
    await normalizeStagedLaneAssignmentsBatch(stagedUnits, targetLane);
  }

  return {
    shipmentId: Number(shipmentData.id),
    shipmentStatus: shipmentData.status,
    targetLane,
    stagedPtIds,
    alreadyInLaneCount: alreadyInTargetLane.size
  };
}
