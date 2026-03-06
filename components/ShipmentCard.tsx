'use client';

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import ConfirmModal from './ConfirmModal';
import PTDetails from './PTDetails';
import ActionToast from './ActionToast';
import { isPTArchived } from '@/lib/utils';
import { exportShipmentSummaryPdf, ShipmentPdfLoad } from '@/lib/shipmentPdf';

import OCRCamera from './OCRCamera';


export interface ShipmentPT {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  assigned_lane: string | null;
  actual_pallet_count: number;
  moved_to_staging: boolean;
  container_number: string;
  store_dc: string;
  start_date: string;
  cancel_date: string;
  removed_from_staging?: boolean;
  status?: string;
  ctn?: string;
  last_synced_at?: string;
  compiled_pallet_id?: number | null;
  compiled_with?: ShipmentPT[];
}

export interface Shipment {
  pu_number: string;
  pu_date: string;
  carrier: string;
  pts: ShipmentPT[];
  staging_lane: string | null;
  status: 'not_started' | 'in_process' | 'finalized';
  archived?: boolean;
  shipped_at?: string | null;
}

const SHIPMENT_STATUS_OPTIONS: Shipment['status'][] = ['not_started', 'in_process', 'finalized'];
const PICKTICKET_STATUS_OPTIONS = ['unlabeled', 'labeled', 'staged', 'ready_to_ship', 'shipped'] as const;
type PickticketStatusOption = (typeof PICKTICKET_STATUS_OPTIONS)[number];

function normalizeAdminPtStatus(status?: string | null): PickticketStatusOption {
  const normalized = (status || '').trim().toLowerCase();
  if (PICKTICKET_STATUS_OPTIONS.includes(normalized as PickticketStatusOption)) {
    return normalized as PickticketStatusOption;
  }
  return 'unlabeled';
}

type ShipmentLaneDisplayGroup = {
  key: string;
  primary: ShipmentPT;
  members: ShipmentPT[];
};

function normalizeDigits(value?: string | null): string {
  return (value || '').replace(/\D/g, '');
}

function compareTextNumeric(a: string, b: string): number {
  const aDigits = normalizeDigits(a);
  const bDigits = normalizeDigits(b);
  if (aDigits && bDigits) {
    const aNum = Number(aDigits);
    const bNum = Number(bDigits);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
      return aNum - bNum;
    }
  }
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function getSortedUniqueLabels(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  ).sort(compareTextNumeric);
}

function getRangeLabel(values: Array<string | null | undefined>): string {
  const labels = getSortedUniqueLabels(values);
  if (labels.length === 0) return '-';
  if (labels.length === 1) return labels[0];
  return `${labels[0]} - ${labels[labels.length - 1]}`;
}

function sumUniquePallets(pts: ShipmentPT[], predicate: (pt: ShipmentPT) => boolean): number {
  const seenCompiledIds = new Set<number>();
  let total = 0;

  pts.forEach((pt) => {
    if (!predicate(pt)) return;

    const compiledId = pt.compiled_pallet_id;
    if (compiledId !== null && compiledId !== undefined) {
      if (seenCompiledIds.has(compiledId)) return;
      seenCompiledIds.add(compiledId);
    }

    total += Number(pt.actual_pallet_count || 0);
  });

  return total;
}

export interface ShipmentCardProps {
  shipment: Shipment;
  onUpdate: () => void;
  mostRecentSync?: Date | null;
  isExpanded?: boolean;
  onToggleExpand?: (isExpanded: boolean) => void;
  readOnly?: boolean;
  requireOCRForStaging?: boolean;
  allowAdminStatusEdit?: boolean;
}


export default function ShipmentCard({
  shipment,
  onUpdate,
  mostRecentSync,
  isExpanded = false,
  onToggleExpand,
  readOnly = false,
  requireOCRForStaging = true,
  allowAdminStatusEdit = false
}: ShipmentCardProps) {
  const [expanded, setExpanded] = useState(isExpanded);
  const [selectingLane, setSelectingLane] = useState(false);
  const [selectedLaneInput, setSelectedLaneInput] = useState('');
  const [selectedPTDetails, setSelectedPTDetails] = useState<ShipmentPT | null>(null);
  const [ptDepthInfo, setPtDepthInfo] = useState<{ [key: number]: { palletsInFront: number; maxCapacity: number } }>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [changingStagingLane, setChangingStagingLane] = useState(false);
  const [newStagingLane, setNewStagingLane] = useState('');
  const [stagingLaneError, setStagingLaneError] = useState('');
  const [deletingShipment, setDeletingShipment] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [laneOrderByPtId, setLaneOrderByPtId] = useState<Record<number, number>>({});
  const [laneLocationsByPtId, setLaneLocationsByPtId] = useState<Record<number, string[]>>({});
  const [stagingPTIds, setStagingPTIds] = useState<number[]>([]);
  const [adminShipmentStatus, setAdminShipmentStatus] = useState<Shipment['status']>(shipment.status);
  const [adminShipmentArchived, setAdminShipmentArchived] = useState(Boolean(shipment.archived));
  const [adminSavingShipmentStatus, setAdminSavingShipmentStatus] = useState(false);
  const [adminPtStatusById, setAdminPtStatusById] = useState<Record<number, PickticketStatusOption>>({});
  const [adminSavingPtIds, setAdminSavingPtIds] = useState<number[]>([]);

  //ocr
  const [scanningPT, setScanningPT] = useState<ShipmentPT | null>(null);
  const [manualCompiledStagePTs, setManualCompiledStagePTs] = useState<ShipmentPT[] | null>(null);
  const [manualCompiledInput, setManualCompiledInput] = useState('');
  const [manualCompiledError, setManualCompiledError] = useState('');

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => { }
  });

  const totalPallets = useMemo(
    () => sumUniquePallets(shipment.pts, () => true),
    [shipment.pts]
  );
  const movedCount = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging).length;
  const movedPTsTotalPallets = useMemo(
    () => sumUniquePallets(shipment.pts, (pt) => pt.moved_to_staging && !pt.removed_from_staging),
    [shipment.pts]
  );
  const hasShippedPT = shipment.pts.some(pt => pt.status === 'shipped');
  const hasReadyToShipPT = shipment.pts.some(pt => pt.status === 'ready_to_ship');
  const isReadyToShipLoad = shipment.status === 'finalized' && hasReadyToShipPT && !hasShippedPT && !shipment.archived;

  const statusConfig = {
    not_started: { label: 'Not Started', color: 'bg-red-600', textColor: 'text-red-400' },
    in_process: { label: 'In Process', color: 'bg-orange-600', textColor: 'text-orange-400' },
    finalized: { label: 'Finalized', color: 'bg-green-600', textColor: 'text-green-400' }
  };
  const headerStatus = hasShippedPT
    ? { label: 'Shipped', color: 'bg-blue-600 text-white' }
    : statusConfig[shipment.status];

  // Sync with prop
  useEffect(() => {
    setExpanded(isExpanded);
  }, [isExpanded]);

  // Update parent when toggling
  function handleToggle() {
    const newExpanded = !expanded;
    setExpanded(newExpanded);
    if (onToggleExpand) {
      onToggleExpand(newExpanded);
    }
  }

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  useEffect(() => {
    setAdminShipmentStatus(shipment.status);
    setAdminShipmentArchived(Boolean(shipment.archived));
  }, [shipment.status, shipment.archived, shipment.pu_number, shipment.pu_date]);

  async function normalizeStagedPTLaneAssignments(ptId: number, targetLane: string, palletCount: number) {
    const normalizedPalletCount = Number.isFinite(palletCount) ? Math.max(0, Math.trunc(palletCount)) : 0;

    const { data: existingPtAssignments, error: existingPtAssignmentsError } = await supabase
      .from('lane_assignments')
      .select('id')
      .eq('pt_id', ptId);
    if (existingPtAssignmentsError) throw existingPtAssignmentsError;

    if (existingPtAssignments && existingPtAssignments.length > 0) {
      const assignmentIds = existingPtAssignments.map((assignment) => assignment.id);
      const { error: deleteAssignmentsError } = await supabase
        .from('lane_assignments')
        .delete()
        .in('id', assignmentIds);
      if (deleteAssignmentsError) throw deleteAssignmentsError;
    }

    const { data: existingLaneAssignments, error: existingLaneAssignmentsError } = await supabase
      .from('lane_assignments')
      .select('id, order_position')
      .eq('lane_number', targetLane)
      .order('order_position', { ascending: true });
    if (existingLaneAssignmentsError) throw existingLaneAssignmentsError;

    if (existingLaneAssignments) {
      for (const assignment of existingLaneAssignments) {
        const { error: shiftAssignmentError } = await supabase
          .from('lane_assignments')
          .update({ order_position: (assignment.order_position || 0) + 1 })
          .eq('id', assignment.id);
        if (shiftAssignmentError) throw shiftAssignmentError;
      }
    }

    const { error: insertAssignmentError } = await supabase
      .from('lane_assignments')
      .insert({
        lane_number: targetLane,
        pt_id: ptId,
        pallet_count: normalizedPalletCount,
        order_position: 1
      });
    if (insertAssignmentError) throw insertAssignmentError;
  }

  // THE WATCHDOG: Automatically syncs PTs in the staging lane to staged/ready_to_ship based on shipment status.
  useEffect(() => {
    if (readOnly) return;

    const unsyncedPTs = shipment.pts.filter(pt =>
      pt.assigned_lane === shipment.staging_lane &&
      (!pt.moved_to_staging || pt.removed_from_staging)
    );

    if (unsyncedPTs.length > 0 && shipment.staging_lane) {
      autoSyncPTs(unsyncedPTs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, shipment.pts, shipment.staging_lane]);

  //OCR move PT
  async function performMovePT(pt: ShipmentPT) {
    setStagingPTIds((prev) => (prev.includes(pt.id) ? prev : [...prev, pt.id]));
    showToast(`Staging PT ${pt.pt_number}...`, 'success');

    try {
      if (!shipment.staging_lane) throw new Error('Staging lane not set');

      const { error: stageError } = await supabase.rpc('stage_pickticket_into_shipment_lane', {
        p_pu_number: shipment.pu_number,
        p_pu_date: shipment.pu_date,
        p_pt_id: pt.id,
        p_original_lane: pt.assigned_lane
      });
      if (stageError) throw stageError;

      showToast(`✅ PT ${pt.pt_number} staged`, 'success');
      onUpdate();
    } catch (error) {
      console.error('Error moving PT:', error);
      showToast('Failed to move PT', 'error');
    } finally {
      setStagingPTIds((prev) => prev.filter((id) => id !== pt.id));
    }
  }

  async function autoSyncPTs(ptsToSync: ShipmentPT[]) {
    try {
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id, status')
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date)
        .single();

      if (!shipmentData) return;
      const ptStatus = shipmentData.status === 'finalized' ? 'ready_to_ship' : 'staged';

      let syncedCount = 0;
      for (const pt of ptsToSync) {
        await supabase
          .from('shipment_pts')
          .upsert({
            shipment_id: shipmentData.id,
            pt_id: pt.id,
            original_lane: pt.assigned_lane,
            removed_from_staging: false
          }, { onConflict: 'shipment_id,pt_id' });

        await supabase
          .from('picktickets')
          .update({ status: ptStatus })
          .eq('id', pt.id);

        syncedCount++;
      }
      if (syncedCount > 0) {
        onUpdate();
        showToast(`${syncedCount} rogue PT(s) auto-staged`, 'success');
      }
    } catch (error) {
      console.error('Auto-sync failed:', error);
    }
  }

  function handleUnfinalizeShipment() {
    showConfirm(
      'Un-Finalize Shipment',
      'Move this PU load back to In Process? Ready to Ship PTs will return to Staged so you can continue adding PTs.',
      async () => {
        await unfinalizeShipmentAction();
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      }
    );
  }

  async function unfinalizeShipmentAction() {
    try {
      await supabase
        .from('shipments')
        .update({ status: 'in_process', updated_at: new Date().toISOString() })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      const readyPTIds = shipment.pts
        .filter((pt) => pt.status === 'ready_to_ship')
        .map((pt) => pt.id);

      if (readyPTIds.length > 0) {
        await supabase
          .from('picktickets')
          .update({ status: 'staged' })
          .in('id', readyPTIds);
      }

      showToast('Shipment moved back to In Process', 'success');
      onUpdate();
    } catch (error) {
      console.error('Error un-finalizing shipment:', error);
      showToast('Failed to un-finalize shipment', 'error');
    }
  }

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type });
  }

  function showConfirm(title: string, message: string, onConfirm: () => void) {
    setConfirmModal({ isOpen: true, title, message, onConfirm });
  }

  async function handleAdminSaveShipmentStatus() {
    if (!allowAdminStatusEdit) return;

    setAdminSavingShipmentStatus(true);
    try {
      const { error } = await supabase
        .from('shipments')
        .upsert({
          pu_number: shipment.pu_number,
          pu_date: shipment.pu_date,
          carrier: shipment.carrier || null,
          staging_lane: shipment.staging_lane,
          status: adminShipmentStatus,
          archived: adminShipmentArchived,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'pu_number,pu_date'
        });

      if (error) throw error;

      showToast('Admin override saved for shipment', 'success');
      onUpdate();
    } catch (error) {
      console.error('Failed to save admin shipment status override:', error);
      showToast('Failed to save shipment override', 'error');
    } finally {
      setAdminSavingShipmentStatus(false);
    }
  }

  async function handleAdminSavePtStatus(pt: ShipmentPT) {
    if (!allowAdminStatusEdit) return;

    const nextStatus = adminPtStatusById[pt.id] ?? normalizeAdminPtStatus(pt.status);
    if (!PICKTICKET_STATUS_OPTIONS.includes(nextStatus)) {
      showToast('Select a valid PT status', 'error');
      return;
    }

    setAdminSavingPtIds((prev) => (prev.includes(pt.id) ? prev : [...prev, pt.id]));
    try {
      const { error } = await supabase
        .from('picktickets')
        .update({ status: nextStatus })
        .eq('id', pt.id);

      if (error) throw error;

      setAdminPtStatusById((prev) => ({ ...prev, [pt.id]: nextStatus }));
      showToast(`PT ${pt.pt_number} status updated`, 'success');
      onUpdate();
    } catch (error) {
      console.error('Failed to save admin PT status override:', error);
      showToast(`Failed to update PT ${pt.pt_number}`, 'error');
    } finally {
      setAdminSavingPtIds((prev) => prev.filter((id) => id !== pt.id));
    }
  }

  const compiledMembersById = useMemo(() => {
    const groups = new Map<number, ShipmentPT[]>();
    shipment.pts.forEach((pt) => {
      const compiledId = pt.compiled_pallet_id;
      if (compiledId === null || compiledId === undefined) return;
      const existing = groups.get(compiledId) || [];
      existing.push(pt);
      groups.set(compiledId, existing);
    });

    groups.forEach((members, compiledId) => {
      groups.set(
        compiledId,
        [...members].sort((a, b) => compareTextNumeric(a.pt_number, b.pt_number))
      );
    });

    return groups;
  }, [shipment.pts]);

  function getCompiledMembers(pt: ShipmentPT): ShipmentPT[] {
    const compiledId = pt.compiled_pallet_id;
    if (compiledId === null || compiledId === undefined) return [pt];
    return compiledMembersById.get(compiledId) || [pt];
  }

  function getCompiledRepresentativeId(ptId: number): number {
    const target = shipment.pts.find((pt) => pt.id === ptId);
    if (!target) return ptId;
    const compiledId = target.compiled_pallet_id;
    if (compiledId === null || compiledId === undefined) return ptId;

    const members = compiledMembersById.get(compiledId);
    if (!members || members.length === 0) return ptId;

    return [...members]
      .sort((a, b) => compareTextNumeric(a.pt_number, b.pt_number))[0]
      .id;
  }

  const ptsByLane = shipment.pts.reduce((acc, pt) => {
    if (pt.moved_to_staging && !pt.removed_from_staging && shipment.staging_lane) {
      const stagingKey = `staging_${shipment.staging_lane}`;
      if (!acc[stagingKey]) acc[stagingKey] = [];
      acc[stagingKey].push(pt);
    } else {
      const laneKey = pt.assigned_lane || 'unassigned';
      if (!acc[laneKey]) acc[laneKey] = [];
      acc[laneKey].push(pt);
    }
    return acc;
  }, {} as Record<string, ShipmentPT[]>);

  const sortedPtsByLane = Object.fromEntries(
    Object.entries(ptsByLane).map(([laneKey, pts]) => [
      laneKey,
      [...pts].sort((a, b) => {
        const aOrder = laneOrderByPtId[a.id] ?? Number.MAX_SAFE_INTEGER;
        const bOrder = laneOrderByPtId[b.id] ?? Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return b.id - a.id;
      })
    ])
  ) as Record<string, ShipmentPT[]>;

  const sortedLanes = Object.keys(ptsByLane).sort((a, b) => {
    if (a.startsWith('staging_')) return -1;
    if (b.startsWith('staging_')) return 1;
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return parseInt(a) - parseInt(b);
  });

  const displayGroupsByLane = useMemo(() => {
    return Object.fromEntries(
      sortedLanes.map((laneKey) => {
        const lanePts = sortedPtsByLane[laneKey] || [];
        const groups: ShipmentLaneDisplayGroup[] = [];
        const seenCompiledIds = new Set<number>();

        lanePts.forEach((pt) => {
          const compiledId = pt.compiled_pallet_id;
          if (compiledId !== null && compiledId !== undefined) {
            if (seenCompiledIds.has(compiledId)) return;
            seenCompiledIds.add(compiledId);

            const members = lanePts
              .filter((candidate) => candidate.compiled_pallet_id === compiledId)
              .sort((a, b) => compareTextNumeric(a.pt_number, b.pt_number));

            const primary = members.find((member) => member.id === pt.id) || members[0] || pt;
            groups.push({
              key: `compiled-${compiledId}`,
              primary,
              members
            });
            return;
          }

          groups.push({
            key: `pt-${pt.id}`,
            primary: pt,
            members: [pt]
          });
        });

        return [laneKey, groups];
      })
    ) as Record<string, ShipmentLaneDisplayGroup[]>;
  }, [sortedLanes, sortedPtsByLane]);

  useEffect(() => {
    if (expanded) {
      fetchDepthInfo();
      fetchLaneOrderMap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, shipment.pts]);

  async function fetchLaneOrderMap() {
    const ptIds = shipment.pts.map((pt) => pt.id);
    if (ptIds.length === 0) {
      setLaneOrderByPtId({});
      setLaneLocationsByPtId({});
      return;
    }

    const { data: assignments, error } = await supabase
      .from('lane_assignments')
      .select('pt_id, lane_number, order_position')
      .in('pt_id', ptIds);

    if (error) {
      console.error('Failed to fetch lane order positions:', error);
      return;
    }

    const orderMap: Record<number, number> = {};
    const laneMap: Record<number, string[]> = {};
    (assignments || []).forEach((assignment) => {
      const ptId = Number(assignment.pt_id);
      const orderPosition = assignment.order_position || Number.MAX_SAFE_INTEGER;
      orderMap[ptId] = Math.min(orderMap[ptId] ?? Number.MAX_SAFE_INTEGER, orderPosition);

      const laneNumber = String(assignment.lane_number || '').trim();
      if (!laneNumber) return;
      if (!laneMap[ptId]) laneMap[ptId] = [];
      if (!laneMap[ptId].includes(laneNumber)) {
        laneMap[ptId].push(laneNumber);
      }
    });
    Object.keys(laneMap).forEach((ptIdKey) => {
      const ptId = Number(ptIdKey);
      laneMap[ptId] = laneMap[ptId].sort((a, b) => {
        const aNum = Number(a);
        const bNum = Number(b);
        if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
        return a.localeCompare(b);
      });
    });
    setLaneOrderByPtId(orderMap);
    setLaneLocationsByPtId(laneMap);
  }

  async function fetchDepthInfo() {
    const depthMap: { [key: number]: { palletsInFront: number; maxCapacity: number } } = {};

    const assignedLaneNumbers = Array.from(
      new Set(
        shipment.pts
          .map((pt) => String(pt.assigned_lane || '').trim())
          .filter(Boolean)
      )
    );
    if (assignedLaneNumbers.length === 0) {
      setPtDepthInfo(depthMap);
      return;
    }

    const [{ data: laneRows, error: laneRowsError }, { data: assignmentRows, error: assignmentRowsError }] = await Promise.all([
      supabase
        .from('lanes')
        .select('lane_number, max_capacity')
        .in('lane_number', assignedLaneNumbers),
      supabase
        .from('lane_assignments')
        .select('lane_number, pt_id, pallet_count, order_position')
        .in('lane_number', assignedLaneNumbers)
        .order('order_position', { ascending: true })
    ]);

    if (laneRowsError) {
      console.error('Failed to fetch lane capacities for depth info:', laneRowsError);
      setPtDepthInfo(depthMap);
      return;
    }

    if (assignmentRowsError) {
      console.error('Failed to fetch lane assignments for depth info:', assignmentRowsError);
      setPtDepthInfo(depthMap);
      return;
    }

    type LaneRow = {
      lane_number: string;
      max_capacity: number;
    };
    type LaneAssignmentDepthRow = {
      lane_number: string;
      pt_id: number;
      pallet_count: number | null;
      order_position: number | null;
    };

    const maxCapacityByLane = new Map<string, number>();
    ((laneRows || []) as LaneRow[]).forEach((laneRow) => {
      maxCapacityByLane.set(String(laneRow.lane_number), laneRow.max_capacity);
    });

    const assignmentsByLane = new Map<string, LaneAssignmentDepthRow[]>();
    ((assignmentRows || []) as LaneAssignmentDepthRow[]).forEach((assignmentRow) => {
      const laneKey = String(assignmentRow.lane_number);
      const existing = assignmentsByLane.get(laneKey) || [];
      existing.push(assignmentRow);
      assignmentsByLane.set(laneKey, existing);
    });

    const palletsInFrontByPtId = new Map<number, number>();
    const totalPalletsByLane = new Map<string, number>();

    assignmentsByLane.forEach((laneAssignments, laneKey) => {
      laneAssignments.sort((a, b) => (a.order_position || Number.MAX_SAFE_INTEGER) - (b.order_position || Number.MAX_SAFE_INTEGER));

      let runningTotal = 0;
      laneAssignments.forEach((assignmentRow) => {
        palletsInFrontByPtId.set(Number(assignmentRow.pt_id), runningTotal);
        runningTotal += Number(assignmentRow.pallet_count || 0);
      });
      totalPalletsByLane.set(laneKey, runningTotal);
    });

    shipment.pts.forEach((pt) => {
      const laneKey = String(pt.assigned_lane || '').trim();
      if (!laneKey) return;

      const maxCapacity = maxCapacityByLane.get(laneKey);
      if (maxCapacity === undefined) return;

      const palletsInFront = palletsInFrontByPtId.has(pt.id)
        ? (palletsInFrontByPtId.get(pt.id) || 0)
        : (totalPalletsByLane.get(laneKey) || 0);

      depthMap[pt.id] = {
        palletsInFront,
        maxCapacity
      };
    });

    setPtDepthInfo(depthMap);
  }

  function getDepthColor(palletsInFront: number, maxCapacity: number): string {
    const percentage = (palletsInFront / maxCapacity) * 100;

    if (percentage < 20) return 'bg-blue-400 text-blue-900';
    if (percentage < 40) return 'bg-cyan-400 text-cyan-900';
    if (percentage < 60) return 'bg-yellow-400 text-yellow-900';
    if (percentage < 80) return 'bg-orange-500 text-orange-900';
    return 'bg-red-600 text-white';
  }

  async function handleSetStagingLane() {
    if (!selectedLaneInput.trim()) {
      showToast('Please enter a lane number', 'error');
      return;
    }

    const laneNumber = parseInt(selectedLaneInput.trim());
    if (isNaN(laneNumber)) {
      showToast('Please enter a valid lane number', 'error');
      return;
    }

    // Check if lane has existing PTs
    const { data: existingPTs } = await supabase
      .from('lane_assignments')
      .select('id, pt_id')
      .eq('lane_number', laneNumber);

    if (existingPTs && existingPTs.length > 0) {
      showConfirm(
        'Lane Has PTs',
        `⚠️ Warning: Lane ${laneNumber} has ${existingPTs.length} PT(s) assigned.\n\nAre you sure you want to use this lane for staging?`,
        async () => {
          await performSetStagingLane(laneNumber, existingPTs.map(pt => pt.pt_id));
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    } else {
      await performSetStagingLane(laneNumber, []);
    }
  }

  async function performSetStagingLane(laneNumber: number, existingPTIds: number[]) {
    try {
      // Create/update shipment
      const { data: shipmentData, error: shipmentError } = await supabase
        .from('shipments')
        .upsert({
          pu_number: shipment.pu_number,
          pu_date: shipment.pu_date,
          carrier: shipment.carrier,
          staging_lane: laneNumber.toString(),
          status: 'in_process',
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'pu_number,pu_date'
        })
        .select()
        .single();

      if (shipmentError) throw shipmentError;

      // Automatically stage any PTs that belong to this shipment AND are already in the target lane
      const shipmentPTIds = shipment.pts.map(pt => pt.id);
      const ptsToMarkAsStaged = new Set<number>();

      shipment.pts.forEach(pt => {
        if (pt.assigned_lane === laneNumber.toString()) {
          ptsToMarkAsStaged.add(pt.id);
        }
      });
      existingPTIds.forEach(id => {
        if (shipmentPTIds.includes(id)) {
          ptsToMarkAsStaged.add(id);
        }
      });

      const ptsArray = Array.from(ptsToMarkAsStaged);
      const normalizedRepresentativeIds = new Set<number>();

      for (const ptId of ptsArray) {
        await supabase
          .from('shipment_pts')
          .upsert({
            shipment_id: shipmentData.id,
            pt_id: ptId,
            original_lane: null,
            removed_from_staging: false
          }, {
            onConflict: 'shipment_id,pt_id'
          });

        await supabase
          .from('picktickets')
          .update({ status: 'ready_to_ship', assigned_lane: laneNumber.toString() })
          .eq('id', ptId);

        const representativeId = getCompiledRepresentativeId(ptId);
        if (!normalizedRepresentativeIds.has(representativeId)) {
          normalizedRepresentativeIds.add(representativeId);
          const palletCount = shipment.pts.find((pt) => pt.id === representativeId)?.actual_pallet_count || 0;
          await normalizeStagedPTLaneAssignments(representativeId, laneNumber.toString(), palletCount);
        }
      }

      if (ptsArray.length > 0) {
        showToast(`Staging lane ${laneNumber} set (${ptsArray.length} PTs swept into staging)`, 'success');
      } else {
        showToast(`Staging lane ${laneNumber} set`, 'success');
      }

      setSelectingLane(false);
      setSelectedLaneInput('');
      onUpdate();
    } catch (error) {
      console.error('Error setting staging lane:', error);
      showToast('Failed to set staging lane', 'error');
    }
  }

  async function handleChangeStagingLane() {
    if (!newStagingLane.trim() || !shipment.staging_lane) return;

    const targetLaneNumber = parseInt(newStagingLane.trim());

    if (isNaN(targetLaneNumber)) {
      setStagingLaneError('Invalid lane number');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    if (targetLaneNumber.toString() === shipment.staging_lane) {
      setStagingLaneError('Already staging lane');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    const { data: existingPTs } = await supabase
      .from('lane_assignments')
      .select('id')
      .eq('lane_number', targetLaneNumber);

    if (existingPTs && existingPTs.length > 0) {
      showConfirm(
        'Lane Has PTs',
        `⚠️ Warning: Lane ${targetLaneNumber} has ${existingPTs.length} PT(s) assigned.\n\nMove staging lane anyway?`,
        async () => {
          await performChangeStagingLane(targetLaneNumber);
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    } else {
      showConfirm(
        'Change Staging Lane',
        `Move all PTs from Lane ${shipment.staging_lane} to Lane ${targetLaneNumber}?`,
        async () => {
          await performChangeStagingLane(targetLaneNumber);
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    }
  }

  async function performChangeStagingLane(targetLaneNumber: number) {
    try {
      const stagedPTs = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging);

      await supabase
        .from('shipments')
        .update({
          staging_lane: targetLaneNumber.toString(),
          updated_at: new Date().toISOString()
        })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      const normalizedRepresentativeIds = new Set<number>();
      for (const pt of stagedPTs) {
        await supabase
          .from('picktickets')
          .update({ assigned_lane: targetLaneNumber.toString() })
          .eq('id', pt.id);

        const representativeId = getCompiledRepresentativeId(pt.id);
        if (!normalizedRepresentativeIds.has(representativeId)) {
          normalizedRepresentativeIds.add(representativeId);
          const palletCount = shipment.pts.find((candidate) => candidate.id === representativeId)?.actual_pallet_count || 0;
          await normalizeStagedPTLaneAssignments(representativeId, targetLaneNumber.toString(), palletCount);
        }
      }

      showToast(`Moved to Lane ${targetLaneNumber}`, 'success');
      setChangingStagingLane(false);
      setNewStagingLane('');
      setStagingLaneError('');
      onUpdate();
    } catch (error) {
      console.error('Error changing staging lane:', error);
      showToast('Failed to change lane', 'error');
    }
  }

  async function handleDeleteStagingData() {
    if (deleteConfirmText !== 'DELETE') {
      showToast('Type DELETE to confirm', 'error');
      return;
    }

    try {
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id')
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date)
        .single();

      if (!shipmentData) throw new Error('Shipment not found');

      const stagedPTs = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging);

      for (const pt of stagedPTs) {
        await supabase
          .from('lane_assignments')
          .delete()
          .eq('pt_id', pt.id);

        await supabase
          .from('picktickets')
          .update({
            assigned_lane: null,
            actual_pallet_count: null,
            status: 'labeled'
          })
          .eq('id', pt.id);
      }

      await supabase
        .from('shipment_pts')
        .delete()
        .eq('shipment_id', shipmentData.id);

      await supabase
        .from('shipments')
        .update({
          status: 'not_started',
          staging_lane: null,
          updated_at: new Date().toISOString()
        })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      showToast('Staging data cleared', 'success');
      setDeletingShipment(false);
      setDeleteConfirmText('');
      onUpdate();
    } catch (error) {
      console.error('Error deleting staging data:', error);
      showToast('Failed to clear data', 'error');
    }
  }

  function getRepresentativePTForCompiledGroup(pts: ShipmentPT[]): ShipmentPT {
    return [...pts].sort((a, b) => {
      const aLaneCount = laneLocationsByPtId[a.id]?.length || 0;
      const bLaneCount = laneLocationsByPtId[b.id]?.length || 0;
      if (aLaneCount !== bLaneCount) return bLaneCount - aLaneCount;
      return compareTextNumeric(a.pt_number, b.pt_number);
    })[0] || pts[0];
  }

  async function performMoveCompiledGroup(pts: ShipmentPT[]) {
    if (!shipment.staging_lane) throw new Error('Staging lane not set');
    if (pts.length === 0) return;

    const uniquePts = Array.from(new Map(pts.map((pt) => [pt.id, pt])).values());
    const ptIds = uniquePts.map((pt) => pt.id);
    const representative = getRepresentativePTForCompiledGroup(uniquePts);

    setStagingPTIds((previous) => Array.from(new Set([...previous, ...ptIds])));
    showToast(`Staging compiled pallet (${uniquePts.length} PTs)...`, 'success');

    try {
      const { data: stageRows, error: stageError } = await supabase.rpc('stage_pickticket_into_shipment_lane', {
        p_pu_number: shipment.pu_number,
        p_pu_date: shipment.pu_date,
        p_pt_id: representative.id,
        p_original_lane: representative.assigned_lane
      });
      if (stageError) throw stageError;

      const stageRow = Array.isArray(stageRows) ? stageRows[0] : stageRows;
      let shipmentId = stageRow?.shipment_id ? Number(stageRow.shipment_id) : null;
      const stagedLane = stageRow?.staging_lane
        ? String(stageRow.staging_lane)
        : (shipment.staging_lane ? String(shipment.staging_lane) : null);
      const stagedStatus = String(stageRow?.pt_status || (shipment.status === 'finalized' ? 'ready_to_ship' : 'staged'));

      if (!shipmentId) {
        const { data: shipmentRow, error: shipmentLookupError } = await supabase
          .from('shipments')
          .select('id')
          .eq('pu_number', shipment.pu_number)
          .eq('pu_date', shipment.pu_date)
          .order('id', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (shipmentLookupError) throw shipmentLookupError;
        shipmentId = shipmentRow?.id || null;
      }

      const nonRepresentativePtIds = uniquePts
        .filter((pt) => pt.id !== representative.id)
        .map((pt) => pt.id);

      if (nonRepresentativePtIds.length > 0) {
        const { error: cleanupAssignmentsError } = await supabase
          .from('lane_assignments')
          .delete()
          .in('pt_id', nonRepresentativePtIds);
        if (cleanupAssignmentsError) throw cleanupAssignmentsError;
      }

      if (shipmentId) {
        const upsertRows = uniquePts.map((pt) => ({
          shipment_id: shipmentId as number,
          pt_id: pt.id,
          original_lane: pt.assigned_lane,
          removed_from_staging: false
        }));
        const { error: upsertShipmentPtsError } = await supabase
          .from('shipment_pts')
          .upsert(upsertRows, {
            onConflict: 'shipment_id,pt_id'
          });
        if (upsertShipmentPtsError) throw upsertShipmentPtsError;
      }

      const { error: updateGroupPtError } = await supabase
        .from('picktickets')
        .update({
          assigned_lane: stagedLane,
          status: stagedStatus
        })
        .in('id', ptIds);
      if (updateGroupPtError) throw updateGroupPtError;

      showToast(`✅ Compiled pallet staged (${uniquePts.length} PTs)`, 'success');
      onUpdate();
    } catch (error) {
      console.error('Error staging compiled pallet:', error);
      showToast('Failed to stage compiled pallet', 'error');
    } finally {
      setStagingPTIds((previous) => previous.filter((id) => !ptIds.includes(id)));
    }
  }

  async function handleMovePT(pt: ShipmentPT) {
    if (!shipment.staging_lane) {
      showToast('Select staging lane first', 'error');
      return;
    }

    const groupedPTs = getCompiledMembers(pt);
    const isCompiledGroup = groupedPTs.length > 1;

    if (isCompiledGroup) {
      if (requireOCRForStaging) {
        setManualCompiledStagePTs(groupedPTs);
        setManualCompiledInput('');
        setManualCompiledError('');
        return;
      }

      await performMoveCompiledGroup(groupedPTs);
      return;
    }

    if (requireOCRForStaging) {
      setScanningPT(pt);
      return;
    }

    await performMovePT(pt);
  }

  async function confirmManualCompiledStage() {
    if (!manualCompiledStagePTs || manualCompiledStagePTs.length === 0) return;

    const entered = normalizeDigits(manualCompiledInput);
    if (!entered) {
      setManualCompiledError('Enter any PT or PO from this compiled pallet.');
      return;
    }

    const allowedTokens = new Set<string>();
    manualCompiledStagePTs.forEach((pt) => {
      const ptDigits = normalizeDigits(pt.pt_number);
      const poDigits = normalizeDigits(pt.po_number);
      if (ptDigits) allowedTokens.add(ptDigits);
      if (poDigits) allowedTokens.add(poDigits);
    });

    if (!allowedTokens.has(entered)) {
      setManualCompiledError('Input does not match any PT/PO in this compiled pallet.');
      return;
    }

    const groupedPTs = [...manualCompiledStagePTs];
    setManualCompiledStagePTs(null);
    setManualCompiledInput('');
    setManualCompiledError('');
    await performMoveCompiledGroup(groupedPTs);
  }

  async function handleFinalizeShipment() {
    const allMoved = shipment.pts.every(pt => pt.moved_to_staging && !pt.removed_from_staging);
    const message = allMoved
      ? 'Finalize this PU load now? This will set staged PTs to Ready to Ship.'
      : 'Not all PTs are moved to staging. Finalize this PU load anyway? This will set currently staged PTs to Ready to Ship.';

    showConfirm(
      'Finalize Shipment',
      message,
      async () => {
        await finalizeShipmentAction();
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
      }
    );
  }

  async function finalizeShipmentAction() {
    try {
      await supabase
        .from('shipments')
        .update({ status: 'finalized', updated_at: new Date().toISOString() })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      // UPDATE ALL STAGED PTs TO ready_to_ship
      const stagedPTIds = shipment.pts
        .filter(pt => pt.moved_to_staging && !pt.removed_from_staging)
        .map(pt => pt.id);

      if (stagedPTIds.length > 0) {
        await supabase
          .from('picktickets')
          .update({ status: 'ready_to_ship' })
          .in('id', stagedPTIds);
      }

      showToast('Shipment finalized!', 'success');
      onUpdate();
    } catch (error) {
      console.error('Error finalizing shipment:', error);
      showToast('Failed to finalize', 'error');
    }
  }

  function exportShipmentPDF() {
    try {
      const load: ShipmentPdfLoad = {
        puNumber: shipment.pu_number || '',
        carrier: shipment.carrier || '',
        rows: shipment.pts.map(pt => ({
          puDate: shipment.pu_date || '',
          customer: pt.customer || '',
          dc: pt.store_dc || '',
          pickticket: pt.pt_number || '',
          po: pt.po_number || '',
          ctn: pt.ctn || '',
          palletQty: pt.actual_pallet_count !== null && pt.actual_pallet_count !== undefined ? String(pt.actual_pallet_count) : '',
          container: pt.container_number || '',
          location: pt.assigned_lane ? `L${pt.assigned_lane}` : '',
          notes: ''
        }))
      };

      exportShipmentSummaryPdf([load], `shipment-summary-PU-${shipment.pu_number}`);
      showToast('Shipment PDF exported', 'success');
    } catch (error) {
      console.error('Error exporting shipment PDF:', error);
      showToast('Failed to export PDF', 'error');
    }
  }

  return (
    <>
      <div className="bg-gray-800 rounded-lg border-2 border-gray-600">
        {/* Header - mobile responsive */}
        <button
          onClick={handleToggle}
          className="w-full p-3 md:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between hover:bg-gray-750 transition-colors gap-3"
        >
          <div className="flex items-center gap-3 md:gap-6 w-full sm:w-auto">
            <div className="text-xl md:text-2xl text-blue-400">
              {expanded ? '▼' : '▶'}
            </div>
            <div className="text-left flex-1">
              <div className="text-2xl md:text-3xl font-bold break-all">PU #{shipment.pu_number}</div>
              <div className="text-gray-300 mt-1 break-all">
                <span className='text-m md:text-xl'>{shipment.carrier} | {shipment.pu_date} | {shipment.pts.length} PTs | </span><span className='text-yellow-300 font-bold text-xl md:text-2xl'>{totalPallets}</span><span className='text-yellow-400 text-l font-bold md:text-xl'>p</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
            {shipment.staging_lane && (
              <div className="bg-purple-700 px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-l md:text-base">
                Staging: L{shipment.staging_lane}
              </div>
            )}
            <div className="relative inline-flex mt-1 sm:mt-0">
              <div className={`px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-xs md:text-base ${headerStatus.color}`}>
                {headerStatus.label}
              </div>
              {isReadyToShipLoad && (
                <div className="absolute -top-1.5 -right-1 md:-top-2 md:-right-1 bg-blue-600 text-white px-1.5 md:px-2 py-[1px] rounded-full font-extrabold text-[8px] md:text-[10px] leading-none tracking-tight shadow-[0_0_10px_rgba(59,130,246,0.65)] ring-1 ring-blue-300/70 whitespace-nowrap pointer-events-none">
                  <span className="md:hidden">READY ✈️</span>
                  <span className="hidden md:inline">READY TO SHIP ✈️</span>
                </div>
              )}
            </div>
          </div>
        </button>

        {/* Expanded content */}
        {expanded && (
          <div className="p-3 md:p-6 border-t-2 border-gray-600 space-y-4 md:space-y-6">
            {allowAdminStatusEdit && (
              <div className="bg-indigo-900 border border-indigo-600 p-3 md:p-4 rounded-lg">
                <div className="font-bold text-sm md:text-base text-indigo-200 mb-3">
                  Admin Status Override
                </div>
                <div className="flex flex-col lg:flex-row gap-3 lg:items-center">
                  <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <label className="text-xs md:text-sm text-indigo-100 whitespace-nowrap">Shipment status</label>
                    <select
                      value={adminShipmentStatus}
                      onChange={(event) => setAdminShipmentStatus(event.target.value as Shipment['status'])}
                      className="bg-gray-900 border border-indigo-500 text-white rounded px-3 py-2 text-sm md:text-base"
                    >
                      {SHIPMENT_STATUS_OPTIONS.map((statusOption) => (
                        <option key={statusOption} value={statusOption}>
                          {statusOption}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-xs md:text-sm text-indigo-100">
                    <input
                      type="checkbox"
                      checked={adminShipmentArchived}
                      onChange={(event) => setAdminShipmentArchived(event.target.checked)}
                    />
                    Archived
                  </label>
                  <button
                    onClick={handleAdminSaveShipmentStatus}
                    disabled={adminSavingShipmentStatus}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 px-3 md:px-5 py-2 rounded-lg font-semibold text-sm md:text-base"
                  >
                    {adminSavingShipmentStatus ? 'Saving...' : 'Save Shipment Override'}
                  </button>
                </div>
              </div>
            )}

            {/* Action buttons - wrap on mobile */}
            {/* Only show action buttons if NOT archived */}
            {!readOnly && !shipment.archived && shipment.staging_lane && (
              <>
                {/* Change Lane Button */}
                {shipment.staging_lane && !changingStagingLane && (
                  <button
                    onClick={() => setChangingStagingLane(true)}
                    className="bg-purple-600 hover:bg-purple-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap border border-purple-700 mr-3"
                  >
                    Change Lane
                  </button>
                )}

                {/* Clear Data Button - Always Visible */}
                {!deletingShipment ? (
                  <button
                    onClick={() => setDeletingShipment(true)}
                    className="bg-red-600 hover:bg-red-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap border border-red-700"
                  >
                    Reset Shipment
                  </button>
                ) : (
                  <div className="w-full bg-red-900 border-2 border-red-600 p-3 md:p-4 rounded-lg">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 md:gap-3">
                      <label className="font-semibold text-white text-sm md:text-base whitespace-nowrap">Type DELETE:</label>
                      <input
                        type="text"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder="DELETE"
                        className="bg-gray-900 text-white p-2 rounded flex-1 w-full uppercase text-sm md:text-base"
                      />
                      <div className="flex gap-2 w-full sm:w-auto">
                        <button
                          onClick={handleDeleteStagingData}
                          disabled={deleteConfirmText !== 'DELETE'}
                          className="flex-1 sm:flex-none bg-red-700 hover:bg-red-800 disabled:bg-gray-600 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => {
                            setDeletingShipment(false);
                            setDeleteConfirmText('');
                          }}
                          className="flex-1 sm:flex-none bg-gray-600 hover:bg-gray-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {changingStagingLane && (
                  <div className="w-full bg-gray-700 p-3 md:p-4 rounded-lg relative">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 md:gap-3">
                      <label className="font-semibold text-sm md:text-base whitespace-nowrap">New Lane:</label>
                      <input
                        type="text"
                        value={newStagingLane}
                        onChange={(e) => {
                          setNewStagingLane(e.target.value);
                          setStagingLaneError('');
                        }}
                        placeholder="Enter lane number"
                        className={`bg-gray-900 text-white p-2 rounded flex-1 w-full text-sm md:text-base ${stagingLaneError ? 'border-2 border-red-500' : ''}`}
                      />
                      <div className="flex gap-2 w-full sm:w-auto">
                        <button
                          onClick={handleChangeStagingLane}
                          className="flex-1 sm:flex-none bg-green-600 hover:bg-green-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Move
                        </button>
                        <button
                          onClick={() => {
                            setChangingStagingLane(false);
                            setNewStagingLane('');
                            setStagingLaneError('');
                          }}
                          className="flex-1 sm:flex-none bg-gray-600 hover:bg-gray-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    {stagingLaneError && (
                      <div className="mt-2 text-red-500 text-xs md:text-sm animate-fade-in">
                        {stagingLaneError}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Staging lane selection - TEXT INPUT */}
            {!readOnly && !shipment.staging_lane && !shipment.archived ? (
              <div className="bg-yellow-900 border-2 border-yellow-600 p-3 md:p-4 rounded-lg">
                <div className="font-bold text-base md:text-xl mb-2 md:mb-3">⚠️ Select Staging Lane</div>
                <p className="text-xs md:text-sm mb-3 md:mb-4">Enter a lane number to consolidate all PTs</p>
                {!selectingLane ? (
                  <button
                    onClick={() => setSelectingLane(true)}
                    className="bg-blue-600 hover:bg-blue-700 px-4 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base"
                  >
                    Select Lane
                  </button>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-2 md:gap-3">
                    <input
                      type="text"
                      value={selectedLaneInput}
                      onChange={(e) => setSelectedLaneInput(e.target.value)}
                      placeholder="Enter lane number (e.g., 101)"
                      className="flex-1 bg-gray-900 text-white p-2 md:p-3 rounded-lg text-sm md:text-base"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleSetStagingLane}
                        className="flex-1 sm:flex-none bg-green-600 hover:bg-green-700 px-4 md:px-6 py-2 rounded-lg font-bold text-sm md:text-base"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => {
                          setSelectingLane(false);
                          setSelectedLaneInput('');
                        }}
                        className="flex-1 sm:flex-none bg-gray-600 hover:bg-gray-700 px-4 md:px-6 py-2 rounded-lg text-sm md:text-base"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : !readOnly && shipment.staging_lane && !shipment.archived ? (
              <div className="bg-gray-700 p-3 md:p-4 rounded-lg">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <div className="font-bold text-sm md:text-lg">Staging Progress</div>
                    <div className="text-gray-400 mt-1">
                      <span className='text-yellow-300 font-bold text-lg md:text-lg'>{movedPTsTotalPallets} of {totalPallets} Pallets → Lane {shipment.staging_lane}</span>
                      <br></br>
                      <span className='text-sm md:text-m '>{movedCount} of {shipment.pts.length} PTs → Lane {shipment.staging_lane}</span>
                    </div>
                  </div>
                  {shipment.status !== 'finalized' && (
                    <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                      <button
                        onClick={handleFinalizeShipment}
                        className="w-full sm:w-auto bg-green-600 hover:bg-green-700 px-4 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base"
                      >
                        Finalize
                      </button>
                      <button
                        onClick={exportShipmentPDF}
                        className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                      >
                        Export Shipment PDF
                      </button>
                    </div>
                  )}
                  {shipment.status === 'finalized' && !shipment.archived && (
                    <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                      <button
                        onClick={handleUnfinalizeShipment}
                        className="bg-orange-600 hover:bg-orange-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                      >
                        Un-Finalize
                      </button>
                      <button
                        onClick={exportShipmentPDF}
                        className="bg-blue-600 hover:bg-blue-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                      >
                        Export Shipment PDF
                      </button>
                      <button
                        onClick={() => showConfirm(
                          'Mark as Shipped',
                          'This will clear the staging lane and archive this shipment. Continue?',
                          async () => {
                            try {
                              // Archive shipment AND clear staging lane
                              await supabase
                                .from('shipments')
                                .update({
                                  archived: true,
                                  staging_lane: null,
                                  updated_at: new Date().toISOString()
                                })
                                .eq('pu_number', shipment.pu_number)
                                .eq('pu_date', shipment.pu_date);

                              // Get PT IDs directly from picktickets by pu_number and pu_date
                              const { data: ptsToShip } = await supabase
                                .from('picktickets')
                                .select('id')
                                .eq('pu_number', shipment.pu_number)
                                .eq('pu_date', shipment.pu_date);

                              const ptIds = ptsToShip?.map(pt => pt.id) || [];

                              if (ptIds.length === 0) {
                                showToast('No PTs found to ship', 'error');
                                return;
                              }

                              // Clear lane assignments
                              await supabase
                                .from('lane_assignments')
                                .delete()
                                .in('pt_id', ptIds);

                              // This is ARCHIVING - CHANGE this one
                              await supabase
                                .from('picktickets')
                                .update({
                                  status: 'shipped'
                                  // ✅ REMOVE the lines that clear assigned_lane and actual_pallet_count
                                })
                                .in('id', ptIds);

                              console.log(`✅ Marked ${ptIds.length} PTs as shipped`);

                              showToast('Shipment marked as shipped!', 'success');
                              onUpdate();
                            } catch (error) {
                              console.error('Error marking as shipped:', error);
                              showToast('Failed to mark as shipped', 'error');
                            }
                            setConfirmModal({ ...confirmModal, isOpen: false });
                          }
                        )}
                        className="bg-green-600 hover:bg-green-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                      >
                        ✈️ Mark as Shipped
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* PT List */}
            <div className="space-y-4 md:space-y-6">
              <h3 className="text-base md:text-xl font-bold">Picktickets</h3>
              {sortedLanes.map((laneKey) => {
                const isStaging = laneKey.startsWith('staging_');
                const actualLaneNumber = isStaging ? laneKey.replace('staging_', '') : laneKey;
                const isUnassigned = laneKey === 'unassigned';
                const laneGroups = displayGroupsByLane[laneKey] || [];
                const lanePtCount = ptsByLane[laneKey]?.length || 0;
                const laneCardCount = laneGroups.length;
                const allShippedInLane = laneGroups.length > 0 && laneGroups.every((group) =>
                  group.members.every((member) => member.status === 'shipped')
                );

                return (
                  <div key={laneKey} className="space-y-2 md:space-y-3">
                    {!allShippedInLane && (
                      <>
                        {isStaging ? (
                          <h4 className="text-lg md:text-2xl font-bold text-purple-400 border-b-2 border-purple-700 pb-2">
                            📦 STAGING (L{actualLaneNumber}) - {laneCardCount} cards / {lanePtCount} PTs
                          </h4>
                        ) : (
                          <h4 className="text-sm md:text-lg font-semibold text-blue-400 border-b border-blue-700 pb-2">
                            {isUnassigned
                              ? `⚠️ Unassigned (${laneCardCount} cards / ${lanePtCount} PTs)`
                              : `L${laneKey} (${laneCardCount} cards / ${lanePtCount} PTs)`}
                          </h4>
                        )}
                      </>
                    )}

                    {laneGroups.map((group) => {
                      const primary = group.primary;
                      const members = group.members;
                      const isCompiled = members.length > 1;
                      const isShipped = members.some((member) => member.status === 'shipped');
                      const isArchived = members.every((member) => isPTArchived(member, mostRecentSync));
                      const isCurrentlyStaged = members.every((member) => member.moved_to_staging && !member.removed_from_staging);
                      const isStagingInProgress = members.some((member) => stagingPTIds.includes(member.id));

                      const laneLocations = Array.from(
                        new Set(
                          members.flatMap((member) => {
                            const explicit = laneLocationsByPtId[member.id];
                            if (explicit && explicit.length > 0) return explicit;
                            if (member.assigned_lane) return [member.assigned_lane];
                            return [];
                          })
                        )
                      );

                      const hasLaneAssigned = laneLocations.some((laneNumber) => laneNumber !== shipment.staging_lane);
                      const canMoveToStaging =
                        hasLaneAssigned &&
                        !isCurrentlyStaged &&
                        Boolean(shipment.staging_lane) &&
                        shipment.status !== 'finalized';

                      const representativeDepth = ptDepthInfo[primary.id];
                      const depthColor = representativeDepth
                        ? getDepthColor(representativeDepth.palletsInFront, representativeDepth.maxCapacity)
                        : '';

                      const customerNames = Array.from(new Set(members.map((member) => member.customer).filter(Boolean)));
                      const customerLabel = customerNames.length <= 1
                        ? (customerNames[0] || 'No customer')
                        : `${customerNames.length} customers`;
                      const groupPalletCount = Math.max(...members.map((member) => Number(member.actual_pallet_count || 0)));
                      const ptRangeLabel = getRangeLabel(members.map((member) => member.pt_number));
                      const poRangeLabel = getRangeLabel(members.map((member) => member.po_number));

                      return (
                        <div
                          key={group.key}
                          className={`p-3 md:p-4 rounded-lg border-2 ${isCompiled ? 'bg-orange-950/35 border-orange-500' :
                            isShipped
                              ? 'bg-gray-800 border-gray-600 opacity-75'
                              : isCurrentlyStaged
                                ? 'bg-green-900 border-green-600'
                                : laneLocations.length === 0
                                  ? 'bg-gray-700 border-gray-600'
                                  : 'bg-gray-700 border-gray-600'
                            }`}
                        >
                          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              {isCompiled && (
                                <div className="inline-block bg-orange-600 px-2.5 py-1 rounded font-bold text-[11px] md:text-xs mb-2">
                                  COMPILED PALLET · {members.length} PTs
                                </div>
                              )}

                              <div className="space-y-1">
                                {isCompiled ? (
                                  <>
                                    <div className="text-sm md:text-base font-semibold break-all">
                                      PT Range: {ptRangeLabel}
                                    </div>
                                    <div className="text-sm md:text-base text-gray-200 break-all">
                                      PO Range: {poRangeLabel}
                                    </div>
                                    <details className="mt-1 rounded border border-orange-700/60 bg-orange-950/35 px-2 py-1">
                                      <summary className="cursor-pointer text-xs md:text-sm text-orange-200">
                                        Show PT/PO list
                                      </summary>
                                      <div className="mt-2 space-y-1">
                                        {members.map((member) => (
                                          <div key={member.id} className="text-xs md:text-sm text-gray-100 break-all">
                                            PT #{member.pt_number} | PO {member.po_number}
                                          </div>
                                        ))}
                                      </div>
                                    </details>
                                  </>
                                ) : (
                                  <div className="text-sm md:text-base font-semibold break-all">
                                    PT #{primary.pt_number} | PO {primary.po_number}
                                  </div>
                                )}
                              </div>

                              <div className="text-xs md:text-sm text-gray-200 mt-2 break-all">
                                {customerLabel} | <span className="text-yellow-300 font-bold">{groupPalletCount}p</span>
                              </div>

                              {isShipped ? (
                                <div className="text-sm md:text-base font-bold text-green-400 mt-2">✈️ Shipped</div>
                              ) : isArchived ? (
                                <div className="bg-gray-700 px-2.5 py-1 rounded-lg font-bold text-white inline-block mt-2 text-xs md:text-sm">
                                  ARCHIVED
                                </div>
                              ) : laneLocations.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-2 mt-2">
                                  <div className="text-sm md:text-base font-bold text-white bg-purple-700 border border-purple-800 rounded-lg px-2 py-1">
                                    L{laneLocations.join('/')}
                                  </div>
                                  {representativeDepth && (
                                    <span className={`px-2 py-0.5 rounded-full text-[10px] md:text-xs font-bold ${depthColor}`}>
                                      {representativeDepth.palletsInFront}p ({Math.round((representativeDepth.palletsInFront / representativeDepth.maxCapacity) * 100)}%)
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs md:text-sm text-gray-400 mt-2">NOT ASSIGNED</div>
                              )}
                            </div>

                            <div className="flex gap-2 justify-end lg:justify-start">
                              <button
                                onClick={() => setSelectedPTDetails(primary)}
                                className="bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded-lg font-semibold text-xs md:text-sm whitespace-nowrap"
                              >
                                Details
                              </button>
                              {!isShipped && !readOnly && (
                                <>
                                  {canMoveToStaging && (
                                    <button
                                      onClick={() => handleMovePT(primary)}
                                      disabled={isStagingInProgress}
                                      className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-3 py-2 rounded-lg font-semibold text-xs md:text-sm whitespace-nowrap"
                                    >
                                      {isStagingInProgress ? '⏳ Staging...' : (isCompiled ? '✓ Stage All' : '✓ Stage')}
                                    </button>
                                  )}
                                  {laneLocations.length === 0 && (
                                    <div className="bg-yellow-700 px-3 py-2 rounded-lg text-xs md:text-sm font-semibold whitespace-nowrap">
                                      Assign first
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          </div>

                          {allowAdminStatusEdit && (
                            <div className="mt-3 pt-3 border-t border-indigo-700">
                              <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
                                <span className="text-xs md:text-sm text-indigo-200 font-semibold whitespace-nowrap">
                                  Admin PT status
                                </span>
                                <select
                                  value={adminPtStatusById[primary.id] ?? normalizeAdminPtStatus(primary.status)}
                                  onChange={(event) => {
                                    const nextValue = event.target.value as PickticketStatusOption;
                                    if (!PICKTICKET_STATUS_OPTIONS.includes(nextValue)) return;
                                    setAdminPtStatusById((prev) => ({ ...prev, [primary.id]: nextValue }));
                                  }}
                                  className="flex-1 bg-gray-900 border border-indigo-600 text-white rounded px-3 py-2 text-sm md:text-base"
                                >
                                  {PICKTICKET_STATUS_OPTIONS.map((statusOption) => (
                                    <option key={statusOption} value={statusOption}>
                                      {statusOption}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  onClick={() => handleAdminSavePtStatus(primary)}
                                  disabled={adminSavingPtIds.includes(primary.id)}
                                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 px-3 md:px-4 py-2 rounded-lg font-semibold text-xs md:text-sm whitespace-nowrap"
                                >
                                  {adminSavingPtIds.includes(primary.id) ? 'Saving...' : 'Save PT Status'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* PT Details Modal */}
        {selectedPTDetails && (
          <PTDetails
            pt={selectedPTDetails}
            onClose={() => setSelectedPTDetails(null)}
            mostRecentSync={mostRecentSync}
          />
        )}
      </div>

      {/* Toast */}
      <ActionToast message={toast?.message ?? null} type={toast?.type} zIndexClass="z-[110]" />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal({ ...confirmModal, isOpen: false })}
      />

      {manualCompiledStagePTs && (
        <div className="fixed inset-0 bg-black/90 z-[105] flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-gray-800 border border-orange-500 rounded-xl p-4 md:p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg md:text-xl font-bold text-orange-300">Stage Compiled Pallet</h3>
              <button
                type="button"
                onClick={() => {
                  setManualCompiledStagePTs(null);
                  setManualCompiledInput('');
                  setManualCompiledError('');
                }}
                className="text-2xl leading-none hover:text-red-400"
              >
                &times;
              </button>
            </div>

            <p className="text-sm text-gray-300 mb-3">
              OCR is skipped for compiled pallets. Enter any PT or PO from this group to stage all PTs together.
            </p>

            <div className="mb-3 max-h-40 overflow-auto rounded border border-gray-700 bg-gray-900/70 p-2 space-y-1">
              {manualCompiledStagePTs
                .slice()
                .sort((a, b) => compareTextNumeric(a.pt_number, b.pt_number))
                .map((pt) => (
                  <div key={pt.id} className="text-xs md:text-sm text-gray-200">
                    PT #{pt.pt_number} | PO {pt.po_number}
                  </div>
                ))}
            </div>

            <input
              type="text"
              value={manualCompiledInput}
              onChange={(event) => {
                setManualCompiledInput(event.target.value);
                setManualCompiledError('');
              }}
              placeholder="Enter any PT or PO from this group"
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm md:text-base"
              autoFocus
            />

            {manualCompiledError && (
              <div className="text-xs md:text-sm text-red-400 mt-2">{manualCompiledError}</div>
            )}

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void confirmManualCompiledStage()}
                className="flex-1 bg-green-600 hover:bg-green-700 px-3 py-2 rounded-lg font-semibold text-sm md:text-base"
              >
                Verify & Stage All
              </button>
              <button
                type="button"
                onClick={() => {
                  setManualCompiledStagePTs(null);
                  setManualCompiledInput('');
                  setManualCompiledError('');
                }}
                className="flex-1 bg-gray-600 hover:bg-gray-700 px-3 py-2 rounded-lg font-semibold text-sm md:text-base"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OCR Camera Modal */}
      {scanningPT && (
        <OCRCamera
          expectedPT={scanningPT.pt_number}
          expectedPO={scanningPT.po_number}
          onSuccess={() => {
            performMovePT(scanningPT);
            setScanningPT(null);
          }}
          onCancel={() => setScanningPT(null)}
        />
      )}
    </>
  );
}
