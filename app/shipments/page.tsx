'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import ShipmentCard, { Shipment } from '@/components/ShipmentCard';
import OCRCamera from '@/components/OCRCamera';
import { isPTArchived } from '@/lib/utils';
import { exportShipmentSummaryPdf, ShipmentPdfLoad } from '@/lib/shipmentPdf';
import { useAuth } from '@/components/AuthProvider';
import { useRealtimeCoordinator } from '@/components/RealtimeProvider';
import ActionToast from '@/components/ActionToast';
import { buildPuLoadKey, normalizePuDate, normalizePuNumber } from '@/lib/shipmentIdentity';
import { setShipmentStagingLaneWithAutoLink } from '@/lib/setShipmentStagingLane';
import { buildSetShipmentStagingLaneErrorMessage, buildSetShipmentStagingLaneSuccessMessage } from '@/lib/setShipmentStagingLaneFeedback';
import { describeUnknownStageError } from '@/lib/stageShipmentExecution';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_TO_ARCHIVED_DAYS = 7;
const HIDE_ARCHIVED_AFTER_DAYS = 21;
const OCR_TOGGLE_STORAGE_KEY = 'shipments_ocr_required';
const SHIPMENTS_FALLBACK_FULL_SYNC_MS = 180000;

type ShipmentSnapshotMap = Record<string, Shipment>;
type StaleSnapshotRow = {
  pu_number: string;
  pu_date: string;
  snapshot: Shipment;
};

type PickticketShipmentRow = {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  assigned_lane: string | null;
  actual_pallet_count: number | null;
  container_number: string;
  store_dc: string;
  cancel_date: string;
  start_date: string;
  pu_number: string;
  pu_date: string;
  status: string;
  ctn: string | null;
  carrier: string | null;
  last_synced_at: string | null;
  compiled_pallet_id: number | null;
};

type ShipmentRecordRow = {
  id: number;
  pu_number: string;
  pu_date: string;
  staging_lane: string | null;
  status: string;
  carrier: string | null;
  archived: boolean;
  updated_at: string | null;
  created_at: string | null;
};

type ShipmentPtRecordRow = {
  shipment_id: number;
  pt_id: number;
  removed_from_staging: boolean;
};

type PlannerQueueRow = {
  step_no: number;
  shipment_id: number;
  pu_number: string;
  pu_date: string;
  staging_lane: string | null;
  source_lane: string;
  assignment_id: number;
  representative_pt_id: number;
  representative_pt_number: string | null;
  representative_po_number: string | null;
  move_type: string;
  pending_member_count: number;
  pending_member_pt_ids: number[] | null;
  pallets_to_move: number;
  pallets_in_front: number;
  days_until_pu: number;
  base_score: number;
  transition_score: number;
  cumulative_score: number;
};

function shipmentKey(shipment: Shipment) {
  return buildPuLoadKey(shipment.pu_number, shipment.pu_date) || `${shipment.pu_number}-${shipment.pu_date}`;
}

function cloneShipmentSnapshot(shipment: Shipment): Shipment {
  return JSON.parse(JSON.stringify(shipment)) as Shipment;
}

function describeSupabaseError(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  if (!error) return 'Unknown Supabase error';
  return [error.code, error.message, error.details, error.hint].filter(Boolean).join(' | ') || 'Unknown Supabase error';
}

function isMissingRpcFunction(error: { code?: string; message?: string; details?: string } | null, functionName: string) {
  if (!error) return false;
  const fullText = `${error.code || ''} ${error.message || ''} ${error.details || ''}`.toLowerCase();
  return fullText.includes('42883') && fullText.includes(functionName.toLowerCase());
}

function toSafeNumber(value: unknown, fallback = 0): number {
  const cast = Number(value);
  return Number.isFinite(cast) ? cast : fallback;
}

function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function plannerRowHasStagingLane(row: PlannerQueueRow): boolean {
  return toTrimmedText(row.staging_lane).length > 0;
}

function plannerRowShipmentKey(row: PlannerQueueRow): string {
  return buildPuLoadKey(row.pu_number, row.pu_date) || `${row.pu_number}-${row.pu_date}`;
}

function plannerRowsMatchIdentity(a: PlannerQueueRow, b: PlannerQueueRow): boolean {
  return (
    toTrimmedText(a.pu_number) === toTrimmedText(b.pu_number)
    && toTrimmedText(a.pu_date) === toTrimmedText(b.pu_date)
    && toSafeNumber(a.representative_pt_id) === toSafeNumber(b.representative_pt_id)
    && toTrimmedText(a.move_type) === toTrimmedText(b.move_type)
  );
}

function looksTransientPlannerStageError(message: string): boolean {
  const normalized = toTrimmedText(message).toLowerCase();
  return (
    normalized.includes('failed to fetch')
    || normalized.includes('network')
    || normalized.includes('timeout')
    || normalized.includes('not found')
    || normalized.includes('stale')
    || normalized.includes('connection')
  );
}

function normalizePlannerQueueRows(rows: PlannerQueueRow[]): PlannerQueueRow[] {
  return rows.map((row) => ({
    ...row,
    pu_number: toTrimmedText(row.pu_number),
    pu_date: toTrimmedText(row.pu_date),
    staging_lane: toTrimmedText(row.staging_lane) || null,
    source_lane: toTrimmedText(row.source_lane),
    representative_pt_number: toTrimmedText(row.representative_pt_number) || null,
    representative_po_number: toTrimmedText(row.representative_po_number) || null,
    move_type: toTrimmedText(row.move_type),
    step_no: toSafeNumber(row.step_no, 0),
    shipment_id: toSafeNumber(row.shipment_id, 0),
    assignment_id: toSafeNumber(row.assignment_id, 0),
    representative_pt_id: toSafeNumber(row.representative_pt_id, 0),
    pending_member_count: toSafeNumber(row.pending_member_count, 0),
    pallets_to_move: toSafeNumber(row.pallets_to_move, 0),
    pallets_in_front: toSafeNumber(row.pallets_in_front, 0),
    days_until_pu: toSafeNumber(row.days_until_pu, 0),
    base_score: toSafeNumber(row.base_score, 0),
    transition_score: toSafeNumber(row.transition_score, 0),
    cumulative_score: toSafeNumber(row.cumulative_score, 0)
  }));
}

function getDaysSince(timestamp?: string | null, fallbackDate?: string): number | null {
  const primaryDate = timestamp ? new Date(timestamp) : null;
  if (primaryDate && !Number.isNaN(primaryDate.getTime())) {
    return Math.floor((Date.now() - primaryDate.getTime()) / DAY_MS);
  }

  if (!fallbackDate) return null;
  const fallback = new Date(fallbackDate);
  if (Number.isNaN(fallback.getTime())) return null;
  return Math.floor((Date.now() - fallback.getTime()) / DAY_MS);
}

export default function ShipmentsPage() {
  const { session, isGuest, isAdmin } = useAuth();
  const { health: realtimeHealth, subscribeScope } = useRealtimeCoordinator();
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [mostRecentSync, setMostRecentSync] = useState<Date | null>(null);
  const [expandedShipmentKey, setExpandedShipmentKey] = useState<string | null>(null);
  const [loadSearch, setLoadSearch] = useState('');
  const [searchSelectedShipmentKey, setSearchSelectedShipmentKey] = useState<string | null>(null);
  const [staleSnapshots, setStaleSnapshots] = useState<ShipmentSnapshotMap>({});
  const [staleSnapshotStoreAvailable, setStaleSnapshotStoreAvailable] = useState(true);
  const [historicalShipmentsLoaded, setHistoricalShipmentsLoaded] = useState(false);
  const [historicalShipmentsLoading, setHistoricalShipmentsLoading] = useState(false);
  const [requireOCRForStaging, setRequireOCRForStaging] = useState(true);
  const [verifyingOCRTogglePassword, setVerifyingOCRTogglePassword] = useState(false);
  const [ocrToggleToast, setOcrToggleToast] = useState('');
  const [plannerQueue, setPlannerQueue] = useState<PlannerQueueRow[]>([]);
  const [plannerLoading, setPlannerLoading] = useState(false);
  const [plannerExecutingAssignmentId, setPlannerExecutingAssignmentId] = useState<number | null>(null);
  const [plannerAssigningShipmentKey, setPlannerAssigningShipmentKey] = useState<string | null>(null);
  const [plannerToast, setPlannerToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [plannerQueueStale, setPlannerQueueStale] = useState(false);
  const [plannerMaxSteps, setPlannerMaxSteps] = useState(40);
  const [plannerIncludeFinalized, setPlannerIncludeFinalized] = useState(false);
  const [plannerModalOpen, setPlannerModalOpen] = useState(false);
  const [plannerScanningRow, setPlannerScanningRow] = useState<PlannerQueueRow | null>(null);
  const [mobileMoreOptionsOpen, setMobileMoreOptionsOpen] = useState(false);
  const shipmentRefreshTimerRef = useRef<number | null>(null);
  const shipmentFetchInFlightRef = useRef(false);
  const shipmentFetchQueuedRef = useRef(false);
  const hasLoadedShipmentsRef = useRef(false);
  const includeHistoricalShipmentsRef = useRef(false);
  const staleRefreshRequestedRef = useRef(false);
  const pendingVisibleRefreshRef = useRef(false);
  const pageHiddenAtRef = useRef<number | null>(null);
  const focusedShipmentKeyRef = useRef<string | null>(null);
  const plannerQueueContainerRef = useRef<HTMLDivElement | null>(null);
  const fetchShipmentsRef = useRef<() => Promise<void>>(async () => { });
  const fetchStaleSnapshotsRef = useRef<() => Promise<void>>(async () => { });

  useEffect(() => {
    void fetchShipmentsRef.current();
    void fetchStaleSnapshotsRef.current();
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(OCR_TOGGLE_STORAGE_KEY);
    if (saved === '0') {
      setRequireOCRForStaging(false);
    } else {
      setRequireOCRForStaging(true);
    }
  }, []);

  useEffect(() => {
    if (!ocrToggleToast) return;
    const timer = window.setTimeout(() => setOcrToggleToast(''), 2500);
    return () => window.clearTimeout(timer);
  }, [ocrToggleToast]);

  useEffect(() => {
    if (!plannerToast) return;
    const timer = window.setTimeout(() => setPlannerToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [plannerToast]);

  useEffect(() => {
    if (!plannerModalOpen || isGuest || plannerLoading) return;
    if (plannerQueue.length === 0 || plannerQueueStale) {
      void buildPlannerQueue({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannerModalOpen, isGuest, plannerLoading, plannerQueue.length, plannerQueueStale]);

  useEffect(() => {
    if (plannerModalOpen) return;
    setPlannerScanningRow(null);
  }, [plannerModalOpen]);

  const refreshShipmentView = useCallback((shipmentKeyToFocus: string, includeStale = false) => {
    focusedShipmentKeyRef.current = shipmentKeyToFocus;
    setExpandedShipmentKey(shipmentKeyToFocus);
    if (plannerModalOpen || plannerQueue.length > 0) {
      setPlannerQueueStale(true);
    }
    void fetchShipmentsRef.current();
    if (includeStale) {
      void fetchStaleSnapshotsRef.current();
    }
  }, [plannerModalOpen, plannerQueue.length]);

  const ensureHistoricalShipmentsLoaded = useCallback(async () => {
    if (includeHistoricalShipmentsRef.current || historicalShipmentsLoading) return;
    includeHistoricalShipmentsRef.current = true;
    setHistoricalShipmentsLoaded(true);
    setHistoricalShipmentsLoading(true);
    try {
      await fetchShipmentsRef.current();
    } finally {
      setHistoricalShipmentsLoading(false);
    }
  }, [historicalShipmentsLoading]);

  useEffect(() => {
    const targetKey = focusedShipmentKeyRef.current;
    if (!targetKey || loading) return;

    const target = document.querySelector<HTMLElement>(`[data-shipment-card-key="${targetKey}"]`);
    if (!target) return;

    const rafId = window.requestAnimationFrame(() => {
      const topOffsetPx = 92;
      const targetTop = target.getBoundingClientRect().top + window.scrollY - topOffsetPx;
      window.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'smooth'
      });
      if (focusedShipmentKeyRef.current === targetKey) {
        focusedShipmentKeyRef.current = null;
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [shipments, loading]);

  async function handleToggleOCRRequirement() {
    if (verifyingOCRTogglePassword) return;

    const input = window.prompt('Enter password to change OCR requirement for staging:');
    if (input === null) return;
    const password = input.trim();
    if (!password) {
      setOcrToggleToast('Password required');
      return;
    }

    setVerifyingOCRTogglePassword(true);
    try {
      const response = await fetch('/api/shipments/ocr-toggle-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || ''}`
        },
        body: JSON.stringify({ password })
      });

      type AuthResponse = { authorized?: boolean; message?: string };
      const payload = (await response.json().catch(() => ({}))) as AuthResponse;

      if (!response.ok || !payload.authorized) {
        setOcrToggleToast(payload.message || 'Incorrect password');
        return;
      }

      const nextValue = !requireOCRForStaging;
      setRequireOCRForStaging(nextValue);
      window.localStorage.setItem(OCR_TOGGLE_STORAGE_KEY, nextValue ? '1' : '0');
      setOcrToggleToast(nextValue ? 'OCR required for staging' : 'OCR bypass enabled');
    } catch (error) {
      console.error('Failed to verify OCR toggle password:', error);
      setOcrToggleToast('Failed to verify password');
    } finally {
      setVerifyingOCRTogglePassword(false);
    }
  }

  async function buildPlannerQueue(options?: { silent?: boolean }) {
    if (plannerLoading) return null;

    setPlannerLoading(true);
    try {
      const boundedMaxSteps = Math.max(1, Math.min(200, Math.trunc(plannerMaxSteps) || 40));
      if (boundedMaxSteps !== plannerMaxSteps) {
        setPlannerMaxSteps(boundedMaxSteps);
      }

      const { data, error } = await supabase.rpc('plan_shipment_staging_sequence', {
        p_max_steps: boundedMaxSteps,
        p_include_finalized: plannerIncludeFinalized
      });

      if (error) {
        if (isMissingRpcFunction(error, 'plan_shipment_staging_sequence')) {
          setPlannerToast({
            message: 'Planner function missing. Run sql/transactional_stage_move_functions.sql in Supabase first.',
            type: 'error'
          });
          return null;
        }
        throw error;
      }

      const typedRows = normalizePlannerQueueRows((data || []) as PlannerQueueRow[]);
      setPlannerQueue(typedRows);
      setPlannerQueueStale(false);

      if (!options?.silent) {
        if (typedRows.length === 0) {
          setPlannerToast({ message: 'No stage candidates found right now.', type: 'info' });
        } else {
          setPlannerToast({ message: `Planner queue built (${typedRows.length} step${typedRows.length === 1 ? '' : 's'})`, type: 'success' });
        }
      }
      return typedRows;
    } catch (error) {
      console.error('Failed to build planner queue:', error);
      setPlannerToast({ message: 'Failed to build planner queue', type: 'error' });
      return null;
    } finally {
      setPlannerLoading(false);
    }
  }

  function scrollPlannerQueueToTop(behavior: ScrollBehavior = 'auto') {
    if (!plannerQueueContainerRef.current) return;
    plannerQueueContainerRef.current.scrollTo({ top: 0, behavior });
  }

  async function executePlannerStageViaShipmentCardFlow(row: PlannerQueueRow) {
    const { data: stageRows, error: stageError } = await supabase.rpc('stage_pickticket_into_shipment_lane', {
      p_pu_number: row.pu_number,
      p_pu_date: row.pu_date,
      p_pt_id: row.representative_pt_id,
      p_original_lane: toTrimmedText(row.source_lane) || null
    });

    if (stageError) {
      if (isMissingRpcFunction(stageError, 'stage_pickticket_into_shipment_lane')) {
        throw new Error('Staging function missing. Run sql/transactional_stage_move_functions.sql in Supabase first.');
      }
      throw stageError;
    }

    if (row.move_type !== 'compiled_group') {
      return;
    }

    const stageRow = (Array.isArray(stageRows) ? stageRows[0] : stageRows) as {
      shipment_id?: number | null;
      staging_lane?: string | null;
      pt_status?: string | null;
      pallet_count?: number | null;
    } | null;

    const shipmentId = Number(stageRow?.shipment_id || 0);
    if (!Number.isFinite(shipmentId) || shipmentId <= 0) return;

    const memberIds = (row.pending_member_pt_ids || [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0 && value !== row.representative_pt_id);

    if (memberIds.length === 0) return;

    const { data: memberRows, error: memberRowsError } = await supabase
      .from('picktickets')
      .select('id, assigned_lane, status')
      .in('id', memberIds)
      .neq('status', 'shipped');
    if (memberRowsError) throw memberRowsError;

    const activeMembers = ((memberRows || []) as Array<{ id: number; assigned_lane: string | null; status: string | null }>)
      .filter((member) => Number.isFinite(Number(member.id)));
    if (activeMembers.length === 0) return;

    const { error: upsertShipmentPtsError } = await supabase
      .from('shipment_pts')
      .upsert(
        activeMembers.map((member) => ({
          shipment_id: shipmentId,
          pt_id: member.id,
          original_lane: toTrimmedText(member.assigned_lane) || toTrimmedText(row.source_lane) || null,
          removed_from_staging: false
        })),
        { onConflict: 'shipment_id,pt_id' }
      );
    if (upsertShipmentPtsError) throw upsertShipmentPtsError;

    const activeMemberIds = activeMembers.map((member) => member.id);

    const { error: cleanupAssignmentsError } = await supabase
      .from('lane_assignments')
      .delete()
      .in('pt_id', activeMemberIds);
    if (cleanupAssignmentsError) throw cleanupAssignmentsError;

    const stageLane = toTrimmedText(stageRow?.staging_lane) || null;
    const stageStatus = toTrimmedText(stageRow?.pt_status) || 'staged';
    const stagePalletCount = Number(stageRow?.pallet_count);
    const updatePayload: { assigned_lane?: string | null; status: string; actual_pallet_count?: number } = {
      status: stageStatus
    };
    if (stageLane !== null) updatePayload.assigned_lane = stageLane;
    if (Number.isFinite(stagePalletCount)) {
      updatePayload.actual_pallet_count = Math.max(0, Math.trunc(stagePalletCount));
    }

    const { error: updateMembersError } = await supabase
      .from('picktickets')
      .update(updatePayload)
      .in('id', activeMemberIds)
      .neq('status', 'shipped');
    if (updateMembersError) throw updateMembersError;
  }

  async function executePlannerStage(row: PlannerQueueRow) {
    if (isGuest || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null) return;
    if (!plannerRowHasStagingLane(row)) {
      setPlannerToast({
        message: `PU ${row.pu_number || 'N/A'} has no staging lane. Use Set Lane first.`,
        type: 'info'
      });
      return;
    }

    setPlannerExecutingAssignmentId(row.assignment_id);
    let stageSucceeded = false;
    let stageRow = row;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await executePlannerStageViaShipmentCardFlow(stageRow);
          stageSucceeded = true;
          break;
        } catch (stageError) {
          const stageErrorText = describeUnknownStageError(stageError);
          const isRetryable = attempt === 0 && looksTransientPlannerStageError(stageErrorText);
          if (!isRetryable) {
            throw stageError;
          }

          setPlannerToast({
            message: 'Connection/queue looked stale. Refreshing and retrying once...',
            type: 'info'
          });
          await fetchShipmentsRef.current();
          const rebuiltRows = await buildPlannerQueue({ silent: true });
          const candidateRows = rebuiltRows || plannerQueue;
          const byAssignment = candidateRows.find((candidate) => candidate.assignment_id === stageRow.assignment_id);
          const byIdentity = candidateRows.find((candidate) => plannerRowsMatchIdentity(candidate, stageRow));
          const refreshedRow = byAssignment || byIdentity || null;

          if (!refreshedRow) {
            throw new Error(
              `Queue changed while reconnecting. ${stageErrorText}. Rebuild queue and stage again.`
            );
          }
          stageRow = refreshedRow;
        }
      }

      if (!stageSucceeded) {
        throw new Error('Stage did not complete.');
      }

      setPlannerToast({
        message: `Staged step ${stageRow.step_no}: PU ${stageRow.pu_number} PT ${stageRow.representative_pt_number || stageRow.representative_pt_id}`,
        type: 'success'
      });
    } catch (error) {
      console.error('Failed to stage planner row:', error);
      setPlannerToast({
        message: `Failed to execute planned step: ${describeUnknownStageError(error)}`,
        type: 'error'
      });
      return;
    } finally {
      setPlannerExecutingAssignmentId(null);
    }

    if (!stageSucceeded) return;

    try {
      await fetchShipmentsRef.current();
      await buildPlannerQueue({ silent: true });
      window.requestAnimationFrame(() => {
        scrollPlannerQueueToTop('smooth');
      });
    } catch (refreshError) {
      console.error('Staged planner row but refresh failed:', refreshError);
      setPlannerToast({
        message: `Step staged, but refresh failed: ${describeUnknownStageError(refreshError)}`,
        type: 'info'
      });
    }
  }

  async function stagePlannerRow(row: PlannerQueueRow) {
    if (!plannerRowHasStagingLane(row)) {
      setPlannerToast({
        message: `PU ${row.pu_number || 'N/A'} has no staging lane. Use Set Lane first.`,
        type: 'info'
      });
      return;
    }

    if (plannerScanningRow !== null) return;

    if (!requireOCRForStaging) {
      await executePlannerStage(row);
      return;
    }

    setPlannerScanningRow(row);
  }

  async function setPlannerShipmentStagingLane(row: PlannerQueueRow) {
    if (isGuest || plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null) return;

    const requestedLane = window.prompt(`Set staging lane for PU ${row.pu_number || 'N/A'} (${row.pu_date || 'N/A'}):`)?.trim();
    if (!requestedLane) return;
    const laneNumber = Number.parseInt(requestedLane, 10);
    if (!Number.isFinite(laneNumber)) {
      setPlannerToast({ message: 'Enter a valid lane number.', type: 'error' });
      return;
    }

    const shipmentKeyValue = plannerRowShipmentKey(row);
    setPlannerAssigningShipmentKey(shipmentKeyValue);
    try {
      const result = await setShipmentStagingLaneWithAutoLink({
        puNumber: row.pu_number,
        puDate: row.pu_date,
        targetLane: laneNumber
      });

      setPlannerToast({
        message: buildSetShipmentStagingLaneSuccessMessage({
          result,
          puNumber: row.pu_number,
          queueRefreshed: true
        }),
        type: 'success'
      });

      await fetchShipmentsRef.current();
      await buildPlannerQueue({ silent: true });
    } catch (error) {
      console.error('Failed to set staging lane from planner:', error);
      setPlannerToast({
        message: buildSetShipmentStagingLaneErrorMessage(error, requestedLane),
        type: 'error'
      });
    } finally {
      setPlannerAssigningShipmentKey(null);
    }
  }

  async function stageNextPlannerStep() {
    if (plannerQueue.length === 0) {
      setPlannerToast({ message: 'Build planner queue first.', type: 'info' });
      return;
    }
    if (!plannerRowHasStagingLane(plannerQueue[0])) {
      setPlannerToast({
        message: 'Top queue row has no staging lane. Click Set Lane on that row first.',
        type: 'info'
      });
      return;
    }
    await stagePlannerRow(plannerQueue[0]);
  }

  const scheduleShipmentRefresh = useCallback((includeStale = false) => {
    if (includeStale) {
      staleRefreshRequestedRef.current = true;
    }
    if (plannerModalOpen || plannerQueue.length > 0) {
      setPlannerQueueStale(true);
    }
    if (document.hidden) {
      pendingVisibleRefreshRef.current = true;
      return;
    }
    if (shipmentRefreshTimerRef.current) {
      window.clearTimeout(shipmentRefreshTimerRef.current);
    }
    shipmentRefreshTimerRef.current = window.setTimeout(() => {
      void fetchShipmentsRef.current();
      if (staleSnapshotStoreAvailable && staleRefreshRequestedRef.current) {
        staleRefreshRequestedRef.current = false;
        void fetchStaleSnapshotsRef.current();
      }
      shipmentRefreshTimerRef.current = null;
    }, 450);
  }, [plannerModalOpen, plannerQueue.length, staleSnapshotStoreAvailable]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        pageHiddenAtRef.current = Date.now();
        return;
      }
      if (document.visibilityState !== 'visible') return;

      const hiddenForMs = pageHiddenAtRef.current ? Date.now() - pageHiddenAtRef.current : 0;
      pageHiddenAtRef.current = null;
      const longBackgroundGap = hiddenForMs >= 15000;
      const shouldRefreshOnReturn = pendingVisibleRefreshRef.current || longBackgroundGap || realtimeHealth !== 'live' || plannerModalOpen;
      if (!shouldRefreshOnReturn) return;

      pendingVisibleRefreshRef.current = false;
      void fetchShipmentsRef.current();
      if (staleSnapshotStoreAvailable && staleRefreshRequestedRef.current) {
        staleRefreshRequestedRef.current = false;
        void fetchStaleSnapshotsRef.current();
      }
      if (plannerModalOpen) {
        void buildPlannerQueue({ silent: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staleSnapshotStoreAvailable, realtimeHealth, plannerModalOpen]);

  useEffect(() => {
    const unsubscribeShipments = subscribeScope('shipments', (payload) => {
      scheduleShipmentRefresh(Boolean(payload.includeStale));
    });

    const unsubscribeLaneGrid = subscribeScope('lane-grid', () => {
      scheduleShipmentRefresh(false);
    });

    return () => {
      unsubscribeShipments();
      unsubscribeLaneGrid();
    };
  }, [scheduleShipmentRefresh, subscribeScope]);

  useEffect(() => {
    if (realtimeHealth !== 'disconnected') return;
    if (document.hidden) return;
    void fetchShipmentsRef.current();
    if (staleSnapshotStoreAvailable) {
      void fetchStaleSnapshotsRef.current();
    }
  }, [realtimeHealth, staleSnapshotStoreAvailable]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void fetchShipmentsRef.current();
      if (staleSnapshotStoreAvailable) {
        void fetchStaleSnapshotsRef.current();
      }
    }, SHIPMENTS_FALLBACK_FULL_SYNC_MS);

    return () => window.clearInterval(timer);
  }, [staleSnapshotStoreAvailable]);

  async function fetchStaleSnapshotsFromSupabase() {
    const { data, error } = await supabase
      .from('stale_shipment_snapshots')
      .select('pu_number, pu_date, snapshot');

    if (error) {
      console.warn(
        `Stale snapshot store unavailable (run sql/stale_shipment_snapshots.sql). ${describeSupabaseError(error)}`
      );
      setStaleSnapshotStoreAvailable(false);
      return;
    }

    const snapshotMap: ShipmentSnapshotMap = {};
    (data as StaleSnapshotRow[]).forEach((row) => {
      if (!row.snapshot) return;
      const key = buildPuLoadKey(row.pu_number, row.pu_date);
      if (!key) return;
      snapshotMap[key] = row.snapshot;
    });
    setStaleSnapshots(snapshotMap);
    setStaleSnapshotStoreAvailable(true);
  }

  async function fetchShipments() {
    if (shipmentFetchInFlightRef.current) {
      shipmentFetchQueuedRef.current = true;
      return;
    }
    shipmentFetchInFlightRef.current = true;
    if (!hasLoadedShipmentsRef.current) {
      setLoading(true);
    }

    try {
      let pickticketQuery = supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date, status, ctn, carrier, last_synced_at, compiled_pallet_id')
        .not('pu_number', 'is', null)
        .not('pu_date', 'is', null)
        .neq('customer', 'PAPER');

      if (!includeHistoricalShipmentsRef.current) {
        pickticketQuery = pickticketQuery.neq('status', 'shipped');
      }

      const { data: pts, error } = await pickticketQuery;

      if (error) throw error;

      const typedPTs = (pts || []) as PickticketShipmentRow[];
      const groupedShipments: { [key: string]: Shipment } = {};

      const latestSync = typedPTs
        .map((pt) => pt.last_synced_at)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
      if (latestSync) {
        setMostRecentSync(new Date(latestSync));
      }

      typedPTs.forEach(pt => {
        const normalizedPuNumber = normalizePuNumber(pt.pu_number);
        const normalizedPuDate = normalizePuDate(pt.pu_date);
        const key = buildPuLoadKey(normalizedPuNumber, normalizedPuDate);
        if (!normalizedPuNumber || !normalizedPuDate || !key) return;
        const isShipped = pt.status === 'shipped';

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: normalizedPuNumber,
            pu_date: normalizedPuDate,
            carrier: pt.carrier || '',
            pts: [],
            staging_lane: null,
            status: isShipped ? 'finalized' : 'not_started',
            archived: isShipped,
            shipped_at: null
          };
        }

        if (!groupedShipments[key].carrier && pt.carrier) {
          groupedShipments[key].carrier = pt.carrier;
        }

        groupedShipments[key].pts.push({
          id: pt.id,
          pt_number: pt.pt_number,
          po_number: pt.po_number,
          customer: pt.customer,
          assigned_lane: pt.assigned_lane,
          actual_pallet_count: pt.actual_pallet_count || 0,
          moved_to_staging: false,
          container_number: pt.container_number,
          store_dc: pt.store_dc,
          cancel_date: pt.cancel_date,
          start_date: pt.start_date,
          removed_from_staging: false,
          status: isShipped ? 'shipped' : pt.status,
          ctn: pt.ctn || undefined,
          last_synced_at: pt.last_synced_at || undefined,
          compiled_pallet_id: pt.compiled_pallet_id
        });
        if (isShipped) {
          groupedShipments[key].archived = true;
        }
      });

      const { data: shipmentRows, error: shipmentRowsError } = await supabase
        .from('shipments')
        .select('id, pu_number, pu_date, staging_lane, status, carrier, archived, updated_at, created_at')
        ;
      if (shipmentRowsError) throw shipmentRowsError;

      const matchedShipmentRows: ShipmentRecordRow[] = [];
      ((shipmentRows || []) as ShipmentRecordRow[]).forEach((shipmentRow) => {
        const key = buildPuLoadKey(shipmentRow.pu_number, shipmentRow.pu_date);
        if (!key) return;
        const shipment = groupedShipments[key];
        if (!shipment) return;

        shipment.staging_lane = shipmentRow.staging_lane;
        if (shipmentRow.status === 'not_started' || shipmentRow.status === 'in_process' || shipmentRow.status === 'finalized') {
          shipment.status = shipmentRow.status;
        }
        shipment.carrier = shipmentRow.carrier || shipment.carrier;
        shipment.archived = shipmentRow.archived || false;
        shipment.shipped_at = shipmentRow.updated_at || shipmentRow.created_at || null;
        matchedShipmentRows.push(shipmentRow);
      });

      if (matchedShipmentRows.length > 0) {
        const shipmentIds = matchedShipmentRows.map((shipmentRow) => shipmentRow.id);
        const { data: shipmentPtRows, error: shipmentPtRowsError } = await supabase
          .from('shipment_pts')
          .select('shipment_id, pt_id, removed_from_staging')
          .in('shipment_id', shipmentIds);
        if (shipmentPtRowsError) throw shipmentPtRowsError;

        const movedByShipmentId = new Map<number, Map<number, boolean>>();
        ((shipmentPtRows || []) as ShipmentPtRecordRow[]).forEach((row) => {
          const byPt = movedByShipmentId.get(row.shipment_id) || new Map<number, boolean>();
          byPt.set(row.pt_id, row.removed_from_staging);
          movedByShipmentId.set(row.shipment_id, byPt);
        });

        matchedShipmentRows.forEach((shipmentRow) => {
          const key = buildPuLoadKey(shipmentRow.pu_number, shipmentRow.pu_date);
          if (!key) return;
          const shipment = groupedShipments[key];
          if (!shipment) return;

          const movedByPt = movedByShipmentId.get(shipmentRow.id);
          if (!movedByPt) return;

          shipment.pts.forEach((pt) => {
            const removed = movedByPt.get(pt.id);
            if (removed === undefined) return;
            pt.moved_to_staging = !removed;
            pt.removed_from_staging = removed;
          });
        });
      }

      const syncReference = latestSync ? new Date(latestSync) : mostRecentSync;
      if (!isGuest && syncReference) {
        const staleReadyToShipLoads = Object.values(groupedShipments).filter((shipment) => {
          if (shipment.archived || shipment.pts.length === 0) return false;
          const hasShippedPT = shipment.pts.some((pt) => pt.status === 'shipped');
          if (hasShippedPT) return false;
          const allReadyToShip = shipment.pts.every((pt) => pt.status === 'ready_to_ship');
          if (!allReadyToShip) return false;
          const allDefunctBySync = shipment.pts.every((pt) => isPTArchived(pt, syncReference));
          return allDefunctBySync;
        });

        for (const staleReadyLoad of staleReadyToShipLoads) {
          const ptIds = staleReadyLoad.pts.map((pt) => pt.id);
          if (ptIds.length === 0) continue;
          // Keep stale/defunct loads in their existing historical section after auto-ship.
          const preservedShippedAt = new Date(
            Date.now() - ((HIDE_ARCHIVED_AFTER_DAYS + 1) * DAY_MS)
          ).toISOString();

          const { error: ptShipError } = await supabase
            .from('picktickets')
            .update({ status: 'shipped' })
            .in('id', ptIds);
          if (ptShipError) {
            console.warn(`Auto-ship skipped for PU ${staleReadyLoad.pu_number}: ${ptShipError.message}`);
            continue;
          }

          const { error: laneClearError } = await supabase
            .from('lane_assignments')
            .delete()
            .in('pt_id', ptIds);
          if (laneClearError) {
            console.warn(`Lane clear failed during auto-ship for PU ${staleReadyLoad.pu_number}: ${laneClearError.message}`);
          }

          const { error: shipmentArchiveError } = await supabase
            .from('shipments')
            .upsert({
              pu_number: staleReadyLoad.pu_number,
              pu_date: staleReadyLoad.pu_date,
              carrier: staleReadyLoad.carrier || null,
              status: 'finalized',
              archived: true,
              staging_lane: null,
              updated_at: preservedShippedAt
            }, {
              onConflict: 'pu_number,pu_date'
            });
          if (shipmentArchiveError) {
            console.warn(`Shipment archive failed during auto-ship for PU ${staleReadyLoad.pu_number}: ${shipmentArchiveError.message}`);
            continue;
          }

          staleReadyLoad.pts.forEach((pt) => {
            pt.status = 'shipped';
          });
          staleReadyLoad.status = 'finalized';
          staleReadyLoad.archived = true;
          staleReadyLoad.staging_lane = null;
          staleReadyLoad.shipped_at = preservedShippedAt;
        }
      }

      Object.values(groupedShipments).forEach((shipment) => {
        const hasShippedPT = shipment.pts.some(pt => pt.status === 'shipped');
        if (!hasShippedPT) return;

        shipment.pts.forEach(pt => {
          pt.status = 'shipped';
        });
        shipment.status = 'finalized';
        shipment.archived = true;
        shipment.staging_lane = null;

        if (!shipment.shipped_at) {
          const latestShippedSync = shipment.pts
            .map(pt => (pt.last_synced_at ? new Date(pt.last_synced_at) : null))
            .filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()))
            .sort((a, b) => b.getTime() - a.getTime())[0];
          shipment.shipped_at = latestShippedSync ? latestShippedSync.toISOString() : null;
        }
      });

      const sortedShipments = Object.values(groupedShipments).sort((a, b) => {
        const dateA = new Date(a.pu_date);
        const dateB = new Date(b.pu_date);
        return dateB.getTime() - dateA.getTime();
      });

      setShipments(sortedShipments);

    } catch (error) {
      console.error('Error fetching shipments:', error);
    } finally {
      hasLoadedShipmentsRef.current = true;
      setLoading(false);
      shipmentFetchInFlightRef.current = false;
      if (shipmentFetchQueuedRef.current) {
        shipmentFetchQueuedRef.current = false;
        void fetchShipments();
      }
    }
  }

  fetchShipmentsRef.current = fetchShipments;
  fetchStaleSnapshotsRef.current = fetchStaleSnapshotsFromSupabase;

  const isInActiveSection = useCallback((shipment: Shipment) => {
    if (shipment.archived) return false;
    const hasShippedPT = shipment.pts.some(pt => pt.status === 'shipped');
    if (hasShippedPT) return false;
    const allArchivedBySync = shipment.pts.every(pt => isPTArchived(pt, mostRecentSync));
    return !allArchivedBySync;
  }, [mostRecentSync]);

  const isInShippedSection = useCallback((shipment: Shipment) => {
    const hasShippedPT = shipment.pts.some(pt => pt.status === 'shipped');
    if (!hasShippedPT) return false;
    const daysSinceShipped = getDaysSince(shipment.shipped_at, shipment.pu_date);
    return daysSinceShipped === null || daysSinceShipped <= SHIPPED_TO_ARCHIVED_DAYS;
  }, []);

  const isInArchivedSection = useCallback((shipment: Shipment) => {
    const hasShippedPT = shipment.pts.some(pt => pt.status === 'shipped');
    if (!hasShippedPT) return false;
    const daysSinceShipped = getDaysSince(shipment.shipped_at, shipment.pu_date);
    if (daysSinceShipped === null) return false;
    return daysSinceShipped > SHIPPED_TO_ARCHIVED_DAYS && daysSinceShipped <= HIDE_ARCHIVED_AFTER_DAYS;
  }, []);

  const activeStatusSortOrder: Record<Shipment['status'], number> = {
    in_process: 0,
    not_started: 1,
    finalized: 2
  };

  const activeShipments = shipments
    .filter((shipment) => isInActiveSection(shipment))
    .sort((a, b) => {
      const rankA = activeStatusSortOrder[a.status] ?? Number.MAX_SAFE_INTEGER;
      const rankB = activeStatusSortOrder[b.status] ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;

      const timeA = new Date(a.pu_date).getTime();
      const timeB = new Date(b.pu_date).getTime();
      const hasValidTimeA = !Number.isNaN(timeA);
      const hasValidTimeB = !Number.isNaN(timeB);

      if (hasValidTimeA && hasValidTimeB && timeA !== timeB) {
        return timeA - timeB;
      }

      return (a.pu_number || '').localeCompare((b.pu_number || ''), undefined, {
        sensitivity: 'base',
        numeric: true
      });
    });

  const shippedShipments = shipments.filter(s => {
    return isInShippedSection(s);
  });

  const archivedShipments = shipments.filter(s => {
    return isInArchivedSection(s);
  });

  const staleArchiveCandidates = shipments.filter(
    (shipment) =>
      !isInActiveSection(shipment) &&
      !isInShippedSection(shipment) &&
      !isInArchivedSection(shipment)
  );

  useEffect(() => {
    if (shipments.length === 0 || !staleSnapshotStoreAvailable) return;

    const staleNow = shipments.filter(
      (shipment) =>
        !isInActiveSection(shipment) &&
        !isInShippedSection(shipment) &&
        !isInArchivedSection(shipment)
    );

    async function syncStaleSnapshotsToSupabase() {
      const staleNowByKey = new Map(staleNow.map(shipment => [shipmentKey(shipment), shipment]));
      const existingKeys = new Set(Object.keys(staleSnapshots));

      const staleToInsert = staleNow.filter(shipment => !existingKeys.has(shipmentKey(shipment)));
      const staleToDelete = Object.keys(staleSnapshots)
        .filter(key => !staleNowByKey.has(key))
        .map(key => staleSnapshots[key]);

      if (staleToInsert.length === 0 && staleToDelete.length === 0) {
        return;
      }

      if (staleToInsert.length > 0) {
        const payload = staleToInsert.map(shipment => ({
          pu_number: shipment.pu_number,
          pu_date: shipment.pu_date,
          snapshot: cloneShipmentSnapshot(shipment)
        }));

        const { error } = await supabase
          .from('stale_shipment_snapshots')
          .upsert(payload, { onConflict: 'pu_number,pu_date' });

        if (error) {
          console.warn(`Failed to insert stale shipment snapshots. ${describeSupabaseError(error)}`);
          setStaleSnapshotStoreAvailable(false);
          return;
        }
      }

      for (const snapshot of staleToDelete) {
        const { error } = await supabase
          .from('stale_shipment_snapshots')
          .delete()
          .eq('pu_number', snapshot.pu_number)
          .eq('pu_date', snapshot.pu_date);

        if (error) {
          console.warn(`Failed to delete stale shipment snapshot. ${describeSupabaseError(error)}`);
          setStaleSnapshotStoreAvailable(false);
          return;
        }
      }

      await fetchStaleSnapshotsFromSupabase();
    }

    syncStaleSnapshotsToSupabase();
  }, [shipments, staleSnapshots, staleSnapshotStoreAvailable, isInActiveSection, isInShippedSection, isInArchivedSection]);

  const staleSnapshotShipments = staleArchiveCandidates
    .map(shipment => {
      const key = shipmentKey(shipment);
      return staleSnapshots[key] || cloneShipmentSnapshot(shipment);
    })
    .sort((a, b) => new Date(b.pu_date).getTime() - new Date(a.pu_date).getTime());

  const activeShipmentsForExport = [...activeShipments].sort((a, b) => {
    const byPuDate = new Date(a.pu_date).getTime() - new Date(b.pu_date).getTime();
    if (byPuDate !== 0) return byPuDate;
    return (a.pu_number || '').localeCompare((b.pu_number || ''), undefined, { sensitivity: 'base' });
  });

  const readyToShipActiveLoads: ShipmentPdfLoad[] = activeShipmentsForExport
    .filter(shipment => shipment.status === 'finalized')
    .map(shipment => ({
      puNumber: shipment.pu_number || '',
      carrier: shipment.carrier || '',
      rows: shipment.pts
        .filter(pt => pt.status === 'ready_to_ship')
        .map(pt => ({
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
    }))
    .filter(load => load.rows.length > 0);

  const allActiveLoadSummaries: ShipmentPdfLoad[] = activeShipmentsForExport
    .map(shipment => ({
      puNumber: shipment.pu_number || '',
      carrier: shipment.carrier || '',
      rows: shipment.pts
        .map((pt) => ({
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
    }))
    .filter((load) => load.rows.length > 0);

  function exportAllReadyToShipPDF() {
    if (readyToShipActiveLoads.length === 0) return;
    exportShipmentSummaryPdf(readyToShipActiveLoads, 'shipment-summary-ready-to-ship');
  }

  function exportAllActiveLoadSummariesPDF() {
    if (allActiveLoadSummaries.length === 0) return;
    exportShipmentSummaryPdf(allActiveLoadSummaries, 'shipment-summary-all-active-loads');
  }

  const normalizedLoadSearch = loadSearch.trim().toLowerCase();
  const loadSearchResults = normalizedLoadSearch
    ? shipments.filter((shipment) => (shipment.pu_number || '').toLowerCase().includes(normalizedLoadSearch))
    : [];

  const selectedSearchShipment = searchSelectedShipmentKey
    ? shipments.find(shipment => shipmentKey(shipment) === searchSelectedShipmentKey) || null
    : null;
  const readyToShipCount = readyToShipActiveLoads.length;
  const allActiveLoadSummaryCount = allActiveLoadSummaries.length;

  function handleOpenSearchShipment(targetShipment: Shipment) {
    setSearchSelectedShipmentKey(shipmentKey(targetShipment));
    setLoadSearch('');
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 md:mb-8 gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold">📦 Shipment Management</h1>
            <p className="text-gray-400 mt-2 text-sm md:text-base">Manage pickup staging and consolidation</p>
            {isGuest && (
              <div className="text-xs md:text-sm text-yellow-300 mt-1">Guest mode: read-only</div>
            )}
            <div className="relative mt-3 md:mt-4 max-w-xl">
              <input
                type="text"
                value={loadSearch}
                onChange={(e) => setLoadSearch(e.target.value)}
                placeholder="Search PU Load ID / PU #"
                className="w-full bg-gray-800 border border-gray-600 text-white p-3 rounded-lg text-sm md:text-base"
              />
              {loadSearchResults.length > 0 && (
                <div className="absolute z-40 mt-1 w-full bg-gray-800 border border-gray-600 rounded-lg max-h-72 overflow-y-auto shadow-xl">
                  {loadSearchResults.map((shipment) => (
                    <button
                      key={shipmentKey(shipment)}
                      onClick={() => handleOpenSearchShipment(shipment)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-700 border-b border-gray-700 last:border-b-0"
                    >
                      <div className="font-bold text-white">PU #{shipment.pu_number}</div>
                      <div className="text-sm text-gray-300">
                        {shipment.pu_date} | {shipment.carrier || 'No Carrier'} | {shipment.pts.length} PTs
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 w-full md:w-auto">
            <div className="md:hidden">
              <button
                onClick={() => setMobileMoreOptionsOpen((prev) => !prev)}
                className="w-full text-center bg-orange-600 hover:bg-orange-700 px-6 py-3 rounded-lg font-semibold transition-colors"
                aria-expanded={mobileMoreOptionsOpen}
                aria-label="Toggle more options"
              >
                More Options {mobileMoreOptionsOpen ? '▲' : '▼'}
              </button>

              {mobileMoreOptionsOpen && (
                <div className="mt-2 p-2 rounded-lg border border-orange-700/60 bg-orange-950/40 flex flex-col gap-2">
                  {!isGuest && (
                    <button
                      onClick={() => {
                        setPlannerModalOpen(true);
                        setMobileMoreOptionsOpen(false);
                      }}
                      className="w-full text-center bg-cyan-700 hover:bg-cyan-800 px-4 py-2.5 rounded-lg font-semibold transition-colors"
                    >
                      Open Staging Optimizer
                    </button>
                  )}
                  {!isGuest && (
                    <button
                      onClick={() => {
                        void handleToggleOCRRequirement();
                        setMobileMoreOptionsOpen(false);
                      }}
                      disabled={verifyingOCRTogglePassword}
                      className={`w-full text-center px-4 py-2.5 rounded-lg font-semibold transition-colors ${requireOCRForStaging
                        ? 'bg-indigo-600 hover:bg-indigo-700'
                        : 'bg-amber-600 hover:bg-amber-700'
                        }`}
                    >
                      {verifyingOCRTogglePassword ? 'Checking...' : `OCR: ${requireOCRForStaging ? 'ON' : 'OFF'}`}
                    </button>
                  )}
                  {readyToShipCount > 0 && (
                    <button
                      onClick={() => {
                        exportAllReadyToShipPDF();
                        setMobileMoreOptionsOpen(false);
                      }}
                      className="w-full text-center bg-blue-600 hover:bg-blue-700 px-4 py-2.5 rounded-lg font-semibold transition-colors"
                    >
                      Export All Ready to Ship ({readyToShipCount})
                    </button>
                  )}
                  {allActiveLoadSummaryCount > 0 && (
                    <button
                      onClick={() => {
                        exportAllActiveLoadSummariesPDF();
                        setMobileMoreOptionsOpen(false);
                      }}
                      className="w-full text-center bg-cyan-600 hover:bg-cyan-700 px-4 py-2.5 rounded-lg font-semibold transition-colors"
                    >
                      Export All Load Summaries ({allActiveLoadSummaryCount})
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="hidden md:flex md:flex-row gap-2">
              {!isGuest && (
                <button
                  onClick={() => setPlannerModalOpen(true)}
                  className="w-full md:w-auto text-center bg-cyan-700 hover:bg-cyan-800 px-6 py-3 rounded-lg font-semibold transition-colors"
                >
                  Open Staging Optimizer
                </button>
              )}
              {!isGuest && (
                <button
                  onClick={handleToggleOCRRequirement}
                  disabled={verifyingOCRTogglePassword}
                  className={`w-full md:w-auto text-center px-6 py-3 rounded-lg font-semibold transition-colors ${requireOCRForStaging
                    ? 'bg-indigo-600 hover:bg-indigo-700'
                    : 'bg-amber-600 hover:bg-amber-700'
                    }`}
                >
                  {verifyingOCRTogglePassword ? 'Checking...' : `OCR: ${requireOCRForStaging ? 'ON' : 'OFF'}`}
                </button>
              )}
              {readyToShipCount > 0 && (
                <button
                  onClick={exportAllReadyToShipPDF}
                  className="w-full md:w-auto text-center bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-semibold transition-colors"
                >
                  Export All Ready to Ship ({readyToShipCount})
                </button>
              )}
              {allActiveLoadSummaryCount > 0 && (
                <button
                  onClick={exportAllActiveLoadSummariesPDF}
                  className="w-full md:w-auto text-center bg-cyan-600 hover:bg-cyan-700 px-6 py-3 rounded-lg font-semibold transition-colors"
                >
                  Export All Load Summaries ({allActiveLoadSummaryCount})
                </button>
              )}
            </div>

            <Link
              href="/"
              className="w-full md:w-auto text-center bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-lg font-semibold transition-colors"
            >
              ← Back to Lanes
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="text-2xl animate-pulse">Loading shipments...</div>
          </div>
        ) : (
          <>
  {/* Active Shipments */}
  <div className="mb-8">
    <h2 className="text-2xl font-bold mb-4">Active Shipments ({activeShipments.length})</h2>
    {activeShipments.length === 0 ? (
      <div className="bg-gray-800 p-8 rounded-lg text-center text-gray-400">
        No active shipments found
      </div>
    ) : (
      <div className="space-y-4">
        {activeShipments.map((shipment) => {
          const currentKey = shipmentKey(shipment);
          return (
            <div key={currentKey} data-shipment-card-key={currentKey}>
              <ShipmentCard
                shipment={shipment}
                onUpdate={() => refreshShipmentView(currentKey)}
                mostRecentSync={mostRecentSync}
                isExpanded={expandedShipmentKey === currentKey}
                onToggleExpand={(isExpanded) => {
                  setExpandedShipmentKey(isExpanded ? currentKey : null);
                  if (isExpanded) {
                    focusedShipmentKeyRef.current = currentKey;
                  }
                }}
                requireOCRForStaging={requireOCRForStaging}
                readOnly={isGuest}
                allowAdminStatusEdit={isAdmin}
              />
            </div>
          );
        })}
      </div>
    )}
  </div>

  {/* Shipped Shipments */}
  <div className="border-t-4 border-green-600 pt-8 mb-8">
    <details
      className="bg-green-950/20 rounded-lg border border-green-700/40"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          void ensureHistoricalShipmentsLoaded();
        }
      }}
    >
      <summary className="cursor-pointer list-none p-4 md:p-5 flex items-center justify-between">
        <span className="text-2xl font-bold text-green-400">
          ✈️ Shipped ({historicalShipmentsLoaded ? shippedShipments.length : 'Load'})
        </span>
        <span className="text-sm text-green-200/80">Closed by default</span>
      </summary>
      <div className="px-3 md:px-5 pb-5">
        {historicalShipmentsLoading ? (
          <div className="py-4 text-sm text-green-100/80 animate-pulse">Loading shipped shipments...</div>
        ) : !historicalShipmentsLoaded ? (
          <div className="py-4 text-sm text-green-100/80">Open this section to load shipped shipments.</div>
        ) : shippedShipments.length === 0 ? (
          <div className="bg-gray-900 p-6 rounded-lg text-center text-gray-300">No shipped shipments in view</div>
        ) : (
          <div className="space-y-4 opacity-75">
            {shippedShipments.map((shipment) => {
              const currentKey = shipmentKey(shipment);
              return (
                <div key={currentKey} data-shipment-card-key={currentKey}>
                  <ShipmentCard
                    shipment={shipment}
                    onUpdate={() => refreshShipmentView(currentKey)}
                    mostRecentSync={mostRecentSync}
                    isExpanded={expandedShipmentKey === currentKey}
                    onToggleExpand={(isExpanded) => {
                      setExpandedShipmentKey(isExpanded ? currentKey : null);
                      if (isExpanded) {
                        focusedShipmentKeyRef.current = currentKey;
                      }
                    }}
                    requireOCRForStaging={requireOCRForStaging}
                    readOnly={isGuest}
                    allowAdminStatusEdit={isAdmin}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  </div>

  {/* Archived Shipments */}
  <div className="border-t-4 border-gray-600 pt-8">
    <details
      className="bg-gray-800 rounded-lg border border-gray-700"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          void ensureHistoricalShipmentsLoaded();
        }
      }}
    >
      <summary className="cursor-pointer list-none p-4 md:p-5 flex items-center justify-between">
        <span className="text-2xl font-bold text-gray-300">
          Archived ({historicalShipmentsLoaded ? archivedShipments.length : 'Load'})
        </span>
        <span className="text-sm text-gray-400">Closed by default</span>
      </summary>
      <div className="px-3 md:px-5 pb-5">
        {historicalShipmentsLoading ? (
          <div className="py-4 text-sm text-gray-300 animate-pulse">Loading archived shipments...</div>
        ) : !historicalShipmentsLoaded ? (
          <div className="py-4 text-sm text-gray-300">Open this section to load archived shipments.</div>
        ) : archivedShipments.length === 0 ? (
          <div className="bg-gray-900 p-6 rounded-lg text-center text-gray-400">No archived shipments in view</div>
        ) : (
          <div className="space-y-4 opacity-60">
            {archivedShipments.map((shipment) => {
              const currentKey = shipmentKey(shipment);
              return (
                <div key={currentKey} data-shipment-card-key={currentKey}>
                  <ShipmentCard
                    shipment={shipment}
                    onUpdate={() => refreshShipmentView(currentKey)}
                    mostRecentSync={mostRecentSync}
                    isExpanded={expandedShipmentKey === currentKey}
                    onToggleExpand={(isExpanded) => {
                      setExpandedShipmentKey(isExpanded ? currentKey : null);
                      if (isExpanded) {
                        focusedShipmentKeyRef.current = currentKey;
                      }
                    }}
                    requireOCRForStaging={requireOCRForStaging}
                    readOnly={isGuest}
                    allowAdminStatusEdit={isAdmin}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  </div>

  <div className="border-t-2 border-gray-700 pt-8 mt-8">
    <details className="bg-gray-800 rounded-lg border border-gray-700">
      <summary className="cursor-pointer list-none p-4 md:p-5 flex items-center justify-between">
        <span className="text-xl font-bold text-gray-200">Stale Snapshot Archive ({staleSnapshotShipments.length})</span>
        <span className="text-sm text-gray-400">Closed by default</span>
      </summary>
      <div className="px-3 md:px-5 pb-5">
        <p className="text-xs md:text-sm text-gray-400 mb-4">
          Snapshots are frozen at the moment a shipment first becomes stale.
        </p>
        {staleSnapshotShipments.length === 0 ? (
          <div className="bg-gray-900 p-6 rounded-lg text-center text-gray-400">
            No stale shipments right now
          </div>
        ) : (
          <div className="space-y-4 opacity-70">
            {staleSnapshotShipments.map((shipment) => {
              const staleKey = `stale-${shipmentKey(shipment)}`;
              return (
                <div key={staleKey} data-shipment-card-key={staleKey}>
                  <ShipmentCard
                    shipment={shipment}
                    onUpdate={() => refreshShipmentView(staleKey, true)}
                    mostRecentSync={mostRecentSync}
                    isExpanded={expandedShipmentKey === staleKey}
                    readOnly={true}
                    onToggleExpand={(isExpanded) => {
                      setExpandedShipmentKey(isExpanded ? staleKey : null);
                      if (isExpanded) {
                        focusedShipmentKeyRef.current = staleKey;
                      }
                    }}
                    requireOCRForStaging={requireOCRForStaging}
                    allowAdminStatusEdit={isAdmin}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  </div>
</>
        )}
      </div>

      {!isGuest && plannerModalOpen && (
        <div className="fixed inset-0 z-[90] bg-black/80 p-2 md:p-6 overflow-y-auto">
          <div className="mx-auto w-full max-w-[96rem] bg-slate-900 border border-slate-600 rounded-xl shadow-2xl">
            <div className="flex items-start justify-between gap-3 p-4 md:p-5 border-b border-slate-700">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold text-cyan-300">Staging Optimizer</h2>
                <p className="text-sm text-slate-300 mt-1">
                  Optimized staging order across loads. Each row includes PT/PO, PU, source lane, and target staging lane.
                </p>
              </div>
              <button
                onClick={() => setPlannerModalOpen(false)}
                className="text-3xl leading-none text-slate-200 hover:text-red-400 px-2"
                aria-label="Close staging optimizer"
              >
                &times;
              </button>
            </div>

            <div className="p-4 md:p-5 space-y-4">
              <div className="flex flex-wrap gap-2 items-center">
                <label className="text-xs text-slate-300">
                  Max Steps
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={plannerMaxSteps}
                    onChange={(event) => setPlannerMaxSteps(Math.max(1, Math.min(200, Number(event.target.value) || 40)))}
                    className="ml-2 w-24 bg-slate-950 border border-slate-500 rounded px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs text-slate-300 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={plannerIncludeFinalized}
                    onChange={(event) => setPlannerIncludeFinalized(event.target.checked)}
                  />
                  Include finalized
                </label>
                <button
                  onClick={() => buildPlannerQueue()}
                  disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null}
                  className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-semibold text-sm"
                >
                  {plannerLoading ? 'Building...' : 'Build Queue'}
                </button>
                <button
                  onClick={stageNextPlannerStep}
                  disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null || plannerQueue.length === 0}
                  className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-semibold text-sm"
                >
                  {plannerExecutingAssignmentId !== null ? 'Staging...' : 'Stage Next'}
                </button>
                <button
                  onClick={() => {
                    setPlannerQueue([]);
                    setPlannerQueueStale(false);
                  }}
                  disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null || plannerQueue.length === 0}
                  className="bg-slate-700 hover:bg-slate-600 disabled:bg-gray-700 px-4 py-2 rounded-lg font-semibold text-sm"
                >
                  Clear
                </button>
              </div>

              {realtimeHealth !== 'live' && (
                <div className={`border px-3 py-2 rounded text-sm ${realtimeHealth === 'disconnected'
                  ? 'bg-red-900/60 border-red-500 text-red-200'
                  : 'bg-amber-900/60 border-amber-500 text-amber-200'
                  }`}>
                  Realtime status is {realtimeHealth}. Queue may be stale. The optimizer will auto-refresh when you return to this tab, and retries once on transient stage errors.
                </div>
              )}

              {plannerQueueStale && plannerQueue.length > 0 && (
                <div className="bg-yellow-900/60 border border-yellow-600 text-yellow-200 px-3 py-2 rounded text-sm">
                  Queue may be stale after recent changes. Rebuild queue for best recommendations.
                </div>
              )}

              <div ref={plannerQueueContainerRef} className="max-h-[70vh] overflow-auto border border-slate-700 rounded-lg">
                {plannerQueue.length > 0 ? (
                  <>
                    <div className="md:hidden divide-y divide-slate-800">
                      {plannerQueue.map((row) => {
                        const rowHasStagingLane = plannerRowHasStagingLane(row);
                        const rowShipmentKey = plannerRowShipmentKey(row);
                        return (
                          <div
                            key={`${row.step_no}-${row.assignment_id}`}
                            className={`p-3 space-y-3 ${row.step_no === 1 ? 'bg-cyan-950/30' : 'bg-slate-900/80'}`}
                          >
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold text-cyan-200">Step {row.step_no}</span>
                              <span className="text-slate-300">Due: {row.days_until_pu === 9999 ? 'N/A' : row.days_until_pu}</span>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                              <div className="rounded border border-slate-700 bg-slate-950 p-2 text-center">
                                <div className="text-[11px] text-slate-400">Source</div>
                                <div className="text-base font-bold text-cyan-200">{row.source_lane ? `L${row.source_lane}` : 'N/A'}</div>
                              </div>
                              <div className="rounded border border-slate-700 bg-slate-950 p-2 text-center">
                                <div className="text-[11px] text-slate-400">Stage</div>
                                <div className={`text-base font-bold ${rowHasStagingLane ? 'text-green-300' : 'text-amber-300'}`}>
                                  {rowHasStagingLane ? `L${row.staging_lane}` : 'Not Set'}
                                </div>
                              </div>
                              <div className="rounded border border-slate-700 bg-slate-950 p-2 text-center">
                                <div className="text-[11px] text-slate-400">Pallets</div>
                                <div className="text-base font-bold text-white">{row.pallets_to_move}p</div>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <div className="rounded border border-slate-700 bg-slate-950 p-2">
                                <div className="text-[11px] text-slate-400">PT #</div>
                                <div className="text-sm font-semibold text-white">
                                  {row.representative_pt_number || String(row.representative_pt_id || 'N/A')}
                                </div>
                              </div>
                              <div className="rounded border border-slate-700 bg-slate-950 p-2">
                                <div className="text-[11px] text-slate-400">PO #</div>
                                <div className="text-sm font-semibold text-white">{row.representative_po_number || 'N/A'}</div>
                              </div>
                            </div>

                            <div className="text-xs text-slate-300 flex flex-wrap gap-x-3 gap-y-1">
                              <span>PU: {row.pu_number || 'N/A'}</span>
                              <span>Date: {row.pu_date || 'N/A'}</span>
                              <span>In Front: {row.pallets_in_front}p</span>
                              <span>Pending: {row.pending_member_count}</span>
                              <span>Type: {row.move_type === 'compiled_group' ? 'compiled' : 'single'}</span>
                            </div>

                            {rowHasStagingLane ? (
                              <button
                                onClick={() => stagePlannerRow(row)}
                                disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null}
                                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-600 px-3 py-2 rounded font-semibold text-sm"
                              >
                                {plannerExecutingAssignmentId === row.assignment_id ? 'Staging...' : 'Stage'}
                              </button>
                            ) : (
                              <button
                                onClick={() => setPlannerShipmentStagingLane(row)}
                                disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null}
                                className="w-full bg-amber-600 hover:bg-amber-700 disabled:bg-gray-600 px-3 py-2 rounded font-semibold text-sm"
                              >
                                {plannerAssigningShipmentKey === rowShipmentKey ? 'Saving...' : 'Set Lane'}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <table className="hidden md:table w-full min-w-[1280px] text-sm">
                      <thead className="sticky top-0 bg-slate-950 text-left text-slate-300">
                        <tr className="border-b border-slate-700">
                          <th className="py-2 px-3">Step</th>
                          <th className="py-2 px-3">PU #</th>
                          <th className="py-2 px-3">PU Date</th>
                          <th className="py-2 px-3">PT #</th>
                          <th className="py-2 px-3">PO #</th>
                          <th className="py-2 px-3">Source Lane</th>
                          <th className="py-2 px-3">Stage Lane</th>
                          <th className="py-2 px-3">Pallets</th>
                          <th className="py-2 px-3">In Front</th>
                          <th className="py-2 px-3">Type</th>
                          <th className="py-2 px-3">Pending PTs</th>
                          <th className="py-2 px-3">Due (days)</th>
                          <th className="py-2 px-3">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plannerQueue.map((row) => {
                          const rowHasStagingLane = plannerRowHasStagingLane(row);
                          const rowShipmentKey = plannerRowShipmentKey(row);
                          return (
                            <tr
                              key={`${row.step_no}-${row.assignment_id}`}
                              className={`border-b border-slate-800 ${row.step_no === 1 ? 'bg-cyan-950/30' : ''}`}
                            >
                              <td className="py-2 px-3 font-bold">{row.step_no}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.pu_number || 'N/A'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.pu_date || 'N/A'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.representative_pt_number || String(row.representative_pt_id || 'N/A')}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.representative_po_number || 'N/A'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.source_lane ? `L${row.source_lane}` : 'N/A'}</td>
                              <td className={`py-2 px-3 whitespace-nowrap font-semibold ${rowHasStagingLane ? 'text-green-300' : 'text-amber-300'}`}>
                                {rowHasStagingLane ? `L${row.staging_lane}` : 'Not Set'}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.pallets_to_move}p</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.pallets_in_front}p</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.move_type === 'compiled_group' ? 'compiled' : 'single'}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.pending_member_count}</td>
                              <td className="py-2 px-3 whitespace-nowrap">{row.days_until_pu === 9999 ? 'N/A' : row.days_until_pu}</td>
                              <td className="py-2 px-3">
                                {rowHasStagingLane ? (
                                  <button
                                    onClick={() => stagePlannerRow(row)}
                                    disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null}
                                    className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-xs"
                                  >
                                    {plannerExecutingAssignmentId === row.assignment_id ? 'Staging...' : 'Stage'}
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => setPlannerShipmentStagingLane(row)}
                                    disabled={plannerLoading || plannerExecutingAssignmentId !== null || plannerAssigningShipmentKey !== null || plannerScanningRow !== null}
                                    className="bg-amber-600 hover:bg-amber-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-xs"
                                  >
                                    {plannerAssigningShipmentKey === rowShipmentKey ? 'Saving...' : 'Set Lane'}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <div className="p-4 text-sm text-slate-300">Build queue to see optimized staging rows.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {plannerScanningRow && (
        <OCRCamera
          expectedPT={toTrimmedText(plannerScanningRow.representative_pt_number) || String(plannerScanningRow.representative_pt_id || '')}
          expectedPO={toTrimmedText(plannerScanningRow.representative_po_number)}
          onSuccess={() => {
            const selectedRow = plannerScanningRow;
            setPlannerScanningRow(null);
            if (selectedRow) {
              void executePlannerStage(selectedRow);
            }
          }}
          onCancel={() => setPlannerScanningRow(null)}
        />
      )}

      {selectedSearchShipment && (
        <div className="fixed inset-0 z-[70] bg-black bg-opacity-80 flex items-start justify-center p-2 md:p-6 overflow-y-auto">
          <div className="w-full max-w-7xl">
            <div className="flex justify-between items-center bg-gray-800 border border-gray-700 rounded-t-lg p-3 md:p-4">
              <div className="text-lg md:text-2xl font-bold">
                Search Result: PU #{selectedSearchShipment.pu_number}
              </div>
              <button
                onClick={() => setSearchSelectedShipmentKey(null)}
                className="text-3xl md:text-4xl hover:text-red-400"
              >
                &times;
              </button>
            </div>
            <div className="bg-gray-900 border-x border-b border-gray-700 rounded-b-lg p-2 md:p-4">
              <ShipmentCard
                key={`search-${shipmentKey(selectedSearchShipment)}`}
                shipment={selectedSearchShipment}
                onUpdate={() => {
                  setExpandedShipmentKey(shipmentKey(selectedSearchShipment));
                  fetchShipments();
                }}
                mostRecentSync={mostRecentSync}
                isExpanded={true}
                requireOCRForStaging={requireOCRForStaging}
                readOnly={isGuest}
                allowAdminStatusEdit={isAdmin}
              />
            </div>
          </div>
        </div>
      )}

      <ActionToast message={plannerToast?.message || null} type={plannerToast?.type || 'info'} zIndexClass="z-[130]" />
      <ActionToast message={ocrToggleToast} type="info" />
    </div>
  );
}
