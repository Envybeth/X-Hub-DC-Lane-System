import { supabase } from './supabase';

function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function isMissingRpcFunction(
  error: { code?: string; message?: string; details?: string } | null,
  functionName: string
) {
  if (!error) return false;
  const fullText = `${error.code || ''} ${error.message || ''} ${error.details || ''}`.toLowerCase();
  return fullText.includes('42883') && fullText.includes(functionName.toLowerCase());
}

export function describeUnknownStageError(error: unknown): string {
  if (!error) return 'Unknown error';
  if (error instanceof Error && toTrimmedText(error.message)) return toTrimmedText(error.message);

  if (typeof error === 'object') {
    const maybeError = error as { code?: string; message?: string; details?: string; hint?: string };
    const parts = [maybeError.code, maybeError.message, maybeError.details, maybeError.hint]
      .map((part) => toTrimmedText(part))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' | ');
  }

  return toTrimmedText(error) || 'Unknown error';
}

export type StageLaneAssignmentIntoShipmentParams = {
  assignmentId: number;
  puNumber: string;
  puDate: string;
};

export type StageLaneAssignmentIntoShipmentResult = {
  shipmentId: number;
  stagingLane: string | null;
  ptStatus: string;
  representativePtId: number | null;
  compiledPalletId: number | null;
  stagedMemberCount: number;
  palletCount: number;
};

export async function stageLaneAssignmentIntoShipment(
  params: StageLaneAssignmentIntoShipmentParams
): Promise<StageLaneAssignmentIntoShipmentResult> {
  const { data, error } = await supabase.rpc('stage_assignment_into_shipment_transactional', {
    p_assignment_id: params.assignmentId,
    p_pu_number: params.puNumber,
    p_pu_date: params.puDate
  });

  if (error) {
    if (isMissingRpcFunction(error, 'stage_assignment_into_shipment_transactional')) {
      throw new Error('Transactional stage function missing. Run sql/transactional_stage_move_functions.sql in Supabase first.');
    }
    throw error;
  }

  const row = (Array.isArray(data) ? data[0] : data) as {
    shipment_id?: number | null;
    staging_lane?: string | null;
    pt_status?: string | null;
    representative_pt_id?: number | null;
    compiled_pallet_id?: number | null;
    staged_member_count?: number | null;
    pallet_count?: number | null;
  } | null;

  const shipmentId = Number(row?.shipment_id || 0);
  if (!Number.isFinite(shipmentId) || shipmentId <= 0) {
    throw new Error('Transactional stage returned no shipment result.');
  }

  const stagedMemberCount = Number(row?.staged_member_count || 0);
  const palletCount = Number(row?.pallet_count || 0);
  const representativePtId = Number(row?.representative_pt_id || 0);
  const compiledPalletId = Number(row?.compiled_pallet_id || 0);

  return {
    shipmentId,
    stagingLane: toTrimmedText(row?.staging_lane) || null,
    ptStatus: toTrimmedText(row?.pt_status) || 'staged',
    representativePtId: Number.isFinite(representativePtId) && representativePtId > 0 ? representativePtId : null,
    compiledPalletId: Number.isFinite(compiledPalletId) && compiledPalletId > 0 ? compiledPalletId : null,
    stagedMemberCount: Number.isFinite(stagedMemberCount) && stagedMemberCount > 0 ? Math.trunc(stagedMemberCount) : 1,
    palletCount: Number.isFinite(palletCount) ? Math.max(0, Math.trunc(palletCount)) : 0
  };
}
