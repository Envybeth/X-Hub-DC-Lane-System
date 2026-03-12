import { supabase } from '@/lib/supabase';

export type StagedLaneAssignmentSourceRow = {
  id: number;
  pt_number: string | null;
  actual_pallet_count: number | null;
  compiled_pallet_id?: number | null;
};

export type StagedLaneAssignmentUnit = {
  representativePtId: number;
  memberPtIds: number[];
  palletCount: number;
  compiledPalletId: number | null;
};

function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function compareTextNumeric(a: string, b: string): number {
  const aDigits = a.replace(/\D/g, '');
  const bDigits = b.replace(/\D/g, '');
  if (aDigits && bDigits) {
    const aNum = Number(aDigits);
    const bNum = Number(bDigits);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
      return aNum - bNum;
    }
  }
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

export function buildStagedLaneAssignmentUnits(
  ptIds: number[],
  shipmentPtRows: StagedLaneAssignmentSourceRow[]
): StagedLaneAssignmentUnit[] {
  const rowsById = new Map<number, StagedLaneAssignmentSourceRow>();
  const compiledMembersById = new Map<number, StagedLaneAssignmentSourceRow[]>();

  shipmentPtRows.forEach((row) => {
    const ptId = Number(row.id);
    if (!Number.isFinite(ptId)) return;

    rowsById.set(ptId, row);

    const compiledId = Number(row.compiled_pallet_id);
    if (!Number.isFinite(compiledId) || compiledId <= 0) return;

    const current = compiledMembersById.get(compiledId) || [];
    current.push(row);
    compiledMembersById.set(compiledId, current);
  });

  const uniquePtIds = Array.from(
    new Set(
      ptIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );
  const stagedPtIdSet = new Set(uniquePtIds);
  const seenCompiledIds = new Set<number>();
  const seenPtIds = new Set<number>();

  const units = uniquePtIds
    .map((ptId) => {
      const row = rowsById.get(ptId);
      if (!row) return null;

      const compiledId = Number(row.compiled_pallet_id);
      if (Number.isFinite(compiledId) && compiledId > 0) {
        if (seenCompiledIds.has(compiledId)) return null;
        seenCompiledIds.add(compiledId);

        const members = (compiledMembersById.get(compiledId) || [])
          .filter((member) => stagedPtIdSet.has(Number(member.id)))
          .sort((left, right) => {
            const byPtNumber = compareTextNumeric(
              toTrimmedText(left.pt_number) || String(left.id),
              toTrimmedText(right.pt_number) || String(right.id)
            );
            if (byPtNumber !== 0) return byPtNumber;
            return Number(left.id) - Number(right.id);
          });
        if (members.length === 0) return null;

        members.forEach((member) => {
          seenPtIds.add(Number(member.id));
        });

        const representative = members[0];
        const palletCount = Number(representative.actual_pallet_count || 0);

        return {
          representativePtId: Number(representative.id),
          memberPtIds: members.map((member) => Number(member.id)),
          palletCount: Number.isFinite(palletCount) ? Math.max(0, Math.trunc(palletCount)) : 0,
          compiledPalletId: compiledId
        } satisfies StagedLaneAssignmentUnit;
      }

      if (seenPtIds.has(ptId)) return null;
      seenPtIds.add(ptId);

      const palletCount = Number(row.actual_pallet_count || 0);
      return {
        representativePtId: ptId,
        memberPtIds: [ptId],
        palletCount: Number.isFinite(palletCount) ? Math.max(0, Math.trunc(palletCount)) : 0,
        compiledPalletId: null
      } satisfies StagedLaneAssignmentUnit;
    })
    .filter((unit): unit is StagedLaneAssignmentUnit => Boolean(unit));

  return units.sort((left, right) => {
    const leftRow = rowsById.get(left.representativePtId);
    const rightRow = rowsById.get(right.representativePtId);
    return compareTextNumeric(
      toTrimmedText(leftRow?.pt_number) || String(left.representativePtId),
      toTrimmedText(rightRow?.pt_number) || String(right.representativePtId)
    );
  });
}

export async function normalizeStagedLaneAssignmentsBatch(
  units: StagedLaneAssignmentUnit[],
  targetLane: string
) {
  if (units.length === 0) return;

  const memberPtIds = Array.from(
    new Set(
      units.flatMap((unit) => unit.memberPtIds)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );

  if (memberPtIds.length > 0) {
    const { error: deleteAssignmentsError } = await supabase
      .from('lane_assignments')
      .delete()
      .in('pt_id', memberPtIds);
    if (deleteAssignmentsError) throw deleteAssignmentsError;
  }

  const { data: existingLaneAssignments, error: existingLaneAssignmentsError } = await supabase
    .from('lane_assignments')
    .select('id, order_position')
    .eq('lane_number', targetLane)
    .order('order_position', { ascending: true });
  if (existingLaneAssignmentsError) throw existingLaneAssignmentsError;

  const shiftBy = units.length;
  if ((existingLaneAssignments || []).length > 0 && shiftBy > 0) {
    await Promise.all(
      (existingLaneAssignments || []).map(async (assignment) => {
        const { error: shiftAssignmentError } = await supabase
          .from('lane_assignments')
          .update({ order_position: (assignment.order_position || 0) + shiftBy })
          .eq('id', assignment.id);
        if (shiftAssignmentError) throw shiftAssignmentError;
      })
    );
  }

  const { error: insertAssignmentsError } = await supabase
    .from('lane_assignments')
    .insert(
      units.map((unit, index) => ({
        lane_number: targetLane,
        pt_id: unit.representativePtId,
        pallet_count: unit.palletCount,
        order_position: index + 1,
        compiled_pallet_id: unit.compiledPalletId
      }))
    );
  if (insertAssignmentsError) throw insertAssignmentsError;
}
