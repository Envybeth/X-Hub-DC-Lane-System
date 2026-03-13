'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import AssignModal from './AssignModal';
import StorageAddModal from './StorageAddModal';
import StorageLaneModal from './StorageLaneModal';
import { StorageAssignment, StorageGroup } from '@/types/storage';
import { useRealtimeCoordinator } from './RealtimeProvider';
import { normalizePuNumber } from '@/lib/shipmentIdentity';
import { isShipmentLoadMismatch } from '@/lib/shipmentLoadConflicts';

const LANE_GRID_FALLBACK_FULL_SYNC_MS = 900000;
const LANE_GRID_FALLBACK_DEGRADED_SYNC_MS = 30000;

interface Lane {
  id: number;
  lane_number: string;
  max_capacity: number;
  lane_type: string;
  current_pallets?: number;
  isStaging?: boolean;
  stagingPuNumber?: string | null;
  isFinalized?: boolean;
  hasStorage?: boolean;
  storageAssignments?: StorageAssignment[];
  hasLoadChangeConflict?: boolean;
  staleConflictCount?: number;
}

type ViewMode = 'regular' | 'storage';

interface LaneGridProps {
  readOnly?: boolean;
}

interface LaneAssignmentRow {
  lane_number: string;
  pallet_count: number | null;
}

interface ShipmentLaneRow {
  id: number;
  staging_lane: string | null;
  pu_number: string;
  pu_date: string | null;
  status: string;
  updated_at: string | null;
}

interface ShipmentLanePtRow {
  shipment_id: number;
  pt_id: number;
  removed_from_staging: boolean;
}

interface ShipmentLaneConflictPtRow {
  id: number;
  pu_number: string | null;
  pu_date: string | null;
  status: string | null;
  assigned_lane: string | null;
}

function describeSupabaseError(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  if (!error) return 'Unknown Supabase error';
  return [error.code, error.message, error.details, error.hint].filter(Boolean).join(' | ') || 'Unknown Supabase error';
}

function sortLaneNumbers(values: string[]) {
  return [...values].sort((a, b) => {
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    return a.localeCompare(b);
  });
}

function isUnlabeledStatus(status?: string | null) {
  const normalized = (status || '').trim().toLowerCase();
  return normalized === '' || normalized === 'unlabeled';
}

export default function LaneGrid({ readOnly = false }: LaneGridProps) {
  const { health: realtimeHealth, subscribeScope } = useRealtimeCoordinator();
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [selectedLane, setSelectedLane] = useState<Lane | null>(null);
  const [assignModalLaneTabs, setAssignModalLaneTabs] = useState<string[]>([]);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('regular');
  const [storageAssignments, setStorageAssignments] = useState<StorageAssignment[]>([]);
  const [storageTableAvailable, setStorageTableAvailable] = useState(true);
  const [storageWarning, setStorageWarning] = useState('');
  const [showStorageAddModal, setShowStorageAddModal] = useState(false);
  const [storageModalData, setStorageModalData] = useState<{
    mode: 'lane' | 'group';
    title: string;
    assignments: StorageAssignment[];
  } | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  const laneRefreshTimerRef = useRef<number | null>(null);
  const laneFetchInFlightRef = useRef(false);
  const laneFetchQueuedRef = useRef(false);
  const pendingVisibleRefreshRef = useRef(false);
  const autoOpenedSearchKeyRef = useRef<string | null>(null);

  const fetchLanes = useCallback(async () => {
    if (laneFetchInFlightRef.current) {
      laneFetchQueuedRef.current = true;
      return;
    }
    laneFetchInFlightRef.current = true;

    try {
      const [{ data: laneRows }, { data: storageRows, error: storageError }] = await Promise.all([
        supabase
          .from('lanes')
          .select('id, lane_number, max_capacity, lane_type')
          .order('id'),
        supabase
          .from('container_storage_assignments')
          .select('id, container_number, customer, lane_number, active, organized_to_label, organized_at, created_at, updated_at')
          .eq('active', true)
          .order('container_number', { ascending: true })
          .order('customer', { ascending: true })
          .order('lane_number', { ascending: true })
      ]);

      if (!laneRows) {
        setLanes([]);
        return;
      }

      let activeStorageAssignments: StorageAssignment[] = [];
      if (storageError) {
        const isMissingTable = storageError.code === '42P01';
        setStorageTableAvailable(false);
        setStorageAssignments([]);
        setStorageWarning(
          isMissingTable
            ? 'Storage table is missing. Run sql/container_storage_assignments.sql in Supabase SQL Editor.'
            : `Storage table unavailable: ${describeSupabaseError(storageError)}`
        );
      } else {
        activeStorageAssignments = (storageRows || []) as StorageAssignment[];
        setStorageTableAvailable(true);
        setStorageWarning('');

        if (activeStorageAssignments.length > 0) {
          const containerNumbers = Array.from(new Set(activeStorageAssignments.map((row) => row.container_number)));
          const { data: storagePTs, error: storagePTError } = await supabase
            .from('picktickets')
            .select('container_number, status')
            .in('container_number', containerNumbers)
            .neq('customer', 'PAPER');

          if (storagePTError) {
            console.error('Failed to evaluate storage auto-organize:', storagePTError);
          } else if (storagePTs) {
            const statusByContainer = new Map<string, { total: number; unlabeled: number }>();

            storagePTs.forEach((pt) => {
              const key = String(pt.container_number || '').trim();
              if (!key) return;

              const current = statusByContainer.get(key) || { total: 0, unlabeled: 0 };
              current.total += 1;
              if (isUnlabeledStatus(pt.status)) {
                current.unlabeled += 1;
              }
              statusByContainer.set(key, current);
            });

            const completedContainers = new Set(
              Array.from(statusByContainer.entries())
                .filter(([, counts]) => counts.total > 0 && counts.unlabeled === 0)
                .map(([containerNumber]) => containerNumber)
            );

            const autoOrganizeIds = activeStorageAssignments
              .filter((assignment) => completedContainers.has(assignment.container_number))
              .map((assignment) => assignment.id);

            if (autoOrganizeIds.length > 0) {
              const { error: autoOrganizeError } = await supabase
                .from('container_storage_assignments')
                .update({
                  active: false,
                  organized_to_label: true,
                  organized_at: new Date().toISOString()
                })
                .in('id', autoOrganizeIds);

              if (autoOrganizeError) {
                console.error('Failed to auto-organize storage assignments:', autoOrganizeError);
              } else {
                const autoOrganizedIdSet = new Set(autoOrganizeIds);
                activeStorageAssignments = activeStorageAssignments.filter((assignment) => !autoOrganizedIdSet.has(assignment.id));
              }
            }
          }
        }

        setStorageAssignments(activeStorageAssignments);
      }

      const storageByLane = new Map<string, StorageAssignment[]>();
      activeStorageAssignments.forEach((assignment) => {
        const laneKey = String(assignment.lane_number);
        const current = storageByLane.get(laneKey) || [];
        current.push(assignment);
        storageByLane.set(laneKey, current);
      });

      const laneNumbers = laneRows.map((lane) => String(lane.lane_number));
      const [assignmentResponse, shipmentResponse] = await Promise.all([
        laneNumbers.length > 0
          ? supabase
            .from('lane_assignments')
            .select('lane_number, pallet_count')
            .in('lane_number', laneNumbers)
          : Promise.resolve({ data: [], error: null }),
        laneNumbers.length > 0
          ? supabase
            .from('shipments')
            .select('id, staging_lane, pu_number, pu_date, status, updated_at')
            .eq('archived', false)
            .in('staging_lane', laneNumbers)
          : Promise.resolve({ data: [], error: null })
      ]);

      if (assignmentResponse.error) {
        console.error('Failed to load lane assignment totals:', assignmentResponse.error);
      }
      if (shipmentResponse.error) {
        console.error('Failed to load staging lanes:', shipmentResponse.error);
      }

      const currentPalletsByLane = new Map<string, number>();
      ((assignmentResponse.data || []) as LaneAssignmentRow[]).forEach((assignment) => {
        const laneKey = String(assignment.lane_number || '').trim();
        if (!laneKey) return;
        currentPalletsByLane.set(laneKey, (currentPalletsByLane.get(laneKey) || 0) + (assignment.pallet_count || 0));
      });

      const activeShipmentByLane = new Map<string, ShipmentLaneRow>();
      ((shipmentResponse.data || []) as ShipmentLaneRow[]).forEach((shipment) => {
        const laneKey = String(shipment.staging_lane || '').trim();
        if (!laneKey) return;

        const existing = activeShipmentByLane.get(laneKey);
        if (!existing) {
          activeShipmentByLane.set(laneKey, shipment);
          return;
        }

        const existingUpdatedAt = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const candidateUpdatedAt = shipment.updated_at ? new Date(shipment.updated_at).getTime() : 0;
        if (candidateUpdatedAt > existingUpdatedAt) {
          activeShipmentByLane.set(laneKey, shipment);
        }
      });

      const activeShipments = Array.from(activeShipmentByLane.values());
      const activeShipmentById = new Map(activeShipments.map((shipment) => [shipment.id, shipment] as const));
      const staleConflictCountByLane = new Map<string, number>();

      if (activeShipments.length > 0) {
        const shipmentIds = activeShipments.map((shipment) => shipment.id);
        const { data: conflictShipmentPtRows, error: conflictShipmentPtRowsError } = await supabase
          .from('shipment_pts')
          .select('shipment_id, pt_id, removed_from_staging')
          .in('shipment_id', shipmentIds)
          .eq('removed_from_staging', true);
        if (conflictShipmentPtRowsError) {
          console.error('Failed to load shipment hazard links:', conflictShipmentPtRowsError);
        } else {
          const typedConflictShipmentPtRows = (conflictShipmentPtRows || []) as ShipmentLanePtRow[];
          const ptIds = Array.from(
            new Set(
              typedConflictShipmentPtRows
                .map((row) => Number(row.pt_id))
                .filter((ptId) => Number.isFinite(ptId))
            )
          );

          if (ptIds.length > 0) {
            const { data: conflictPtRows, error: conflictPtRowsError } = await supabase
              .from('picktickets')
              .select('id, pu_number, pu_date, status, assigned_lane')
              .in('id', ptIds);
            if (conflictPtRowsError) {
              console.error('Failed to load shipment hazard PTs:', conflictPtRowsError);
            } else {
              const ptById = new Map<number, ShipmentLaneConflictPtRow>();
              ((conflictPtRows || []) as ShipmentLaneConflictPtRow[]).forEach((row) => {
                ptById.set(Number(row.id), row);
              });

              typedConflictShipmentPtRows.forEach((row) => {
                const shipment = activeShipmentById.get(row.shipment_id);
                const pt = ptById.get(Number(row.pt_id));
                if (!shipment || !pt) return;
                if (String(pt.status || '').trim().toLowerCase() === 'shipped') return;
                if (String(pt.assigned_lane || '').trim() !== String(shipment.staging_lane || '').trim()) return;
                if (!isShipmentLoadMismatch({
                  shipmentPuNumber: shipment.pu_number,
                  shipmentPuDate: shipment.pu_date,
                  ptPuNumber: pt.pu_number,
                  ptPuDate: pt.pu_date
                })) {
                  return;
                }

                const laneKey = String(shipment.staging_lane || '').trim();
                if (!laneKey) return;
                staleConflictCountByLane.set(laneKey, (staleConflictCountByLane.get(laneKey) || 0) + 1);
              });
            }
          }
        }
      }

      const lanesWithCapacity = laneRows.map((lane) => {
        const laneKey = String(lane.lane_number);
        const activeShipment = activeShipmentByLane.get(laneKey);
        const laneStorageAssignments = storageByLane.get(laneKey) || [];
        const staleConflictCount = staleConflictCountByLane.get(laneKey) || 0;

        return {
          ...lane,
          current_pallets: currentPalletsByLane.get(laneKey) || 0,
          isStaging: Boolean(activeShipment),
          stagingPuNumber: normalizePuNumber(activeShipment?.pu_number) || null,
          isFinalized: activeShipment?.status === 'finalized',
          hasStorage: laneStorageAssignments.length > 0,
          storageAssignments: laneStorageAssignments,
          hasLoadChangeConflict: staleConflictCount > 0,
          staleConflictCount
        } as Lane;
      });

      setLanes(lanesWithCapacity);
    } finally {
      laneFetchInFlightRef.current = false;
      if (laneFetchQueuedRef.current) {
        laneFetchQueuedRef.current = false;
        void fetchLanes();
      }
    }
  }, []);

  const scheduleLaneRefresh = useCallback(() => {
    if (document.hidden) {
      pendingVisibleRefreshRef.current = true;
      return;
    }
    if (laneRefreshTimerRef.current) {
      window.clearTimeout(laneRefreshTimerRef.current);
    }
    laneRefreshTimerRef.current = window.setTimeout(() => {
      void fetchLanes();
      laneRefreshTimerRef.current = null;
    }, 450);
  }, [fetchLanes]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!pendingVisibleRefreshRef.current) return;
      pendingVisibleRefreshRef.current = false;
      void fetchLanes();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchLanes]);

  useEffect(() => {
    void fetchLanes();
  }, [fetchLanes]);

  useEffect(() => {
    const unsubscribe = subscribeScope('lane-grid', () => {
      scheduleLaneRefresh();
    });
    return () => unsubscribe();
  }, [scheduleLaneRefresh, subscribeScope]);

  useEffect(() => {
    if (realtimeHealth === 'live') return;
    if (document.hidden) return;
    void fetchLanes();
  }, [fetchLanes, realtimeHealth]);

  useEffect(() => {
    const intervalMs = realtimeHealth === 'live'
      ? LANE_GRID_FALLBACK_FULL_SYNC_MS
      : LANE_GRID_FALLBACK_DEGRADED_SYNC_MS;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void fetchLanes();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [fetchLanes, realtimeHealth]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    const laneQuery = params.get('lane');
    const ptQuery = params.get('pt');

    if (!laneQuery) {
      autoOpenedSearchKeyRef.current = null;
      return;
    }

    const searchKey = `${laneQuery}::${ptQuery || ''}`;
    if (autoOpenedSearchKeyRef.current === searchKey) return;
    if (lanes.length === 0 || showAssignModal) return;

    const targetLaneFromQuery = lanes.find((lane) => lane.lane_number === laneQuery);
    if (!targetLaneFromQuery) return;
    const targetLane = targetLaneFromQuery;
    let cancelled = false;
    let timer: number | null = null;

    async function openFromSearchResult() {
      let laneTabs: string[] = [];

      if (ptQuery) {
        const ptId = Number.parseInt(ptQuery, 10);
        if (Number.isFinite(ptId) && ptId > 0) {
          const { data: assignmentRows, error: assignmentError } = await supabase
            .from('lane_assignments')
            .select('lane_number')
            .eq('pt_id', ptId);

          if (assignmentError) {
            console.error('Failed to load PT lane tabs for assign modal:', assignmentError);
          } else {
            const uniqueLanes = Array.from(new Set(
              (assignmentRows || [])
                .map((row) => String(row.lane_number || '').trim())
                .filter(Boolean)
            ));
            laneTabs = uniqueLanes.length > 1 ? sortLaneNumbers(uniqueLanes) : [];
          }
        }
      }

      if (cancelled) return;

      timer = window.setTimeout(() => {
        autoOpenedSearchKeyRef.current = searchKey;
        if (targetLane.hasStorage && targetLane.storageAssignments && targetLane.storageAssignments.length > 0) {
          setStorageModalData({
            mode: 'lane',
            title: `Storage Lane ${targetLane.lane_number}`,
            assignments: targetLane.storageAssignments
          });
          return;
        }

        if (readOnly) return;

        setAssignModalLaneTabs(laneTabs);
        setSelectedLane(targetLane);
        setShowAssignModal(true);
      }, 0);
    }

    void openFromSearchResult();

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [searchParams, lanes, readOnly, showAssignModal]);

  const storageContainerGroups = useMemo(() => {
    const byContainer = new Map<string, { assignments: StorageAssignment[]; customers: Set<string>; laneNumbers: Set<string> }>();

    storageAssignments.forEach((assignment) => {
      const existing = byContainer.get(assignment.container_number);
      if (!existing) {
        byContainer.set(assignment.container_number, {
          assignments: [assignment],
          customers: new Set([assignment.customer]),
          laneNumbers: new Set([assignment.lane_number])
        });
        return;
      }

      existing.assignments.push(assignment);
      existing.customers.add(assignment.customer);
      existing.laneNumbers.add(assignment.lane_number);
    });

    return Array.from(byContainer.entries())
      .map(([containerNumber, value]) => {
        const laneNumbers = sortLaneNumbers(Array.from(value.laneNumbers));
        const laneMap = new Map(
          lanes
            .filter((lane) => lane.hasStorage)
            .map((lane) => [String(lane.lane_number), lane] as const)
        );

        const groupedLanes = laneNumbers
          .map((laneNumber) => laneMap.get(laneNumber))
          .filter((lane): lane is Lane => Boolean(lane));

        return {
          containerNumber,
          customers: Array.from(value.customers).sort((a, b) => a.localeCompare(b)),
          assignments: value.assignments,
          lanes: groupedLanes,
          laneNumbers
        };
      })
      .sort((a, b) => a.containerNumber.localeCompare(b.containerNumber));
  }, [storageAssignments, lanes]);

  function openStorageLaneDetails(lane: Lane) {
    const assignments = lane.storageAssignments || [];
    if (assignments.length === 0) return;

    setStorageModalData({
      mode: 'lane',
      title: `Storage Lane ${lane.lane_number}`,
      assignments
    });
  }

  function openStorageGroupDetails(group: StorageGroup) {
    setStorageModalData({
      mode: 'group',
      title: `Container ${group.container_number} • ${group.customer}`,
      assignments: group.assignments
    });
  }

  function handleLaneClick(lane: Lane) {
    if (lane.hasStorage) {
      openStorageLaneDetails(lane);
      return;
    }

    if (lane.hasLoadChangeConflict) {
      window.alert(`Lane ${lane.lane_number} is blocked by a stale PT load mismatch. Move the stale PT out before assigning more PTs to this staging lane.`);
      return;
    }

    if (readOnly) {
      return;
    }

    setAssignModalLaneTabs([]);
    setSelectedLane(lane);
    setShowAssignModal(true);
  }

  function handleAssignModalLaneTabSelect(laneNumber: string) {
    const targetLane = lanes.find((lane) => String(lane.lane_number) === String(laneNumber));
    if (!targetLane) return;
    setSelectedLane(targetLane);
  }

  function handleAssignModalClose() {
    setShowAssignModal(false);
    setSelectedLane(null);
    setAssignModalLaneTabs([]);
    fetchLanes();
    router.replace('/', { scroll: false });
  }

  function handleStorageUpdated() {
    fetchLanes();
  }

  function getLaneColor(lane: Lane) {
    if (lane.hasLoadChangeConflict) return 'bg-red-800 border-red-400';
    if (lane.hasStorage) return 'bg-gray-700 border-gray-500';
    if (lane.isFinalized) return 'bg-yellow-600 border-yellow-400';
    if (lane.isStaging) return 'bg-purple-700 border-purple-500';

    const current = lane.current_pallets || 0;
    const max = lane.max_capacity;
    const percentage = (current / max) * 100;

    if (percentage >= 100) return 'bg-red-700 border-red-500';
    if (percentage >= 75) return 'bg-orange-700 border-orange-500';
    if (percentage >= 50) return 'bg-yellow-700 border-yellow-500';
    if (current === 0) return 'bg-gray-700 border-gray-500';
    return 'bg-green-700 border-green-500';
  }

  function renderLaneContent(lane: Lane, compact = false) {
    const storageRows = lane.storageAssignments || [];

    return (
      <div className={`flex flex-col items-center justify-center h-full ${compact ? 'space-y-0.5' : 'space-y-1'}`}>
        <div className={`${compact ? 'text-sm md:text-base' : 'text-base md:text-2xl'} font-bold`}>
          {!lane.hasStorage && lane.hasLoadChangeConflict && '⚠️ '}
          {!lane.hasStorage && !lane.hasLoadChangeConflict && lane.isStaging && '📦 '}
          {lane.lane_number}
        </div>

        {lane.hasStorage && storageRows.length > 0 ? (
          <div className="flex flex-col gap-1 w-full">
            {storageRows.slice(0, 2).map((row) => (
              <div key={row.id} className={`${compact ? 'text-[9px] md:text-[10px] px-1.5 py-0.5' : 'text-[10px] md:text-xs px-2 py-0.5'} font-bold text-gray-100 bg-black/35 rounded shadow-sm break-all`}>
                {row.container_number} • {row.customer}
              </div>
            ))}
            {storageRows.length > 2 && (
              <div className={`${compact ? 'text-[9px] md:text-[10px] px-1.5 py-0.5' : 'text-[10px] md:text-xs px-2 py-0.5'} font-bold text-gray-200 bg-black/30 rounded`}>
                +{storageRows.length - 2} more
              </div>
            )}
          </div>
        ) : (
          <>
            {lane.stagingPuNumber && (
              <div className={`${compact ? 'text-[9px] md:text-[10px] px-1.5 py-0.5' : 'text-[10px] md:text-xs px-2 py-0.5'} font-bold text-purple-100 bg-black/30 rounded shadow-sm break-all`}>
                PU: {lane.stagingPuNumber}
              </div>
            )}
            <div className={compact ? 'text-[10px] md:text-xs' : 'text-xs md:text-sm'}>
              {lane.current_pallets || 0}/{lane.max_capacity}
            </div>
            {lane.hasLoadChangeConflict && (
              <div className={`${compact ? 'mt-0.5 text-[9px] md:text-[10px] px-1.5 py-0.5' : 'mt-1 text-[10px] md:text-xs px-2 py-1'} bg-red-950/80 text-red-100 font-bold rounded shadow-sm uppercase text-center`}>
                Hazard{lane.staleConflictCount ? ` · ${lane.staleConflictCount}` : ''}
              </div>
            )}
            {lane.isFinalized && (
              <div className={`${compact ? 'mt-0.5 text-[9px] md:text-[10px] px-1.5 py-0.5' : 'mt-1 text-[10px] md:text-xs px-2 py-1'} bg-green-600 text-white font-bold rounded shadow-sm uppercase`}>
                Finished
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const lanesByType = useMemo(() => ({
    large: lanes.filter((l) => l.max_capacity === 34),
    medium: lanes.filter((l) => l.max_capacity === 25),
    small: lanes.filter((l) => l.max_capacity === 15),
    mini: lanes.filter((l) => l.max_capacity === 4)
  }), [lanes]);

  function renderLaneSection(title: string, titleColor: string, lanesInSection: Lane[], colsClass: string) {
    if (lanesInSection.length === 0) return null;

    return (
      <div>
        <h2 className={`text-lg md:text-2xl font-bold mb-3 md:mb-4 ${titleColor} border-b-2 pb-2`}>
          {title}
        </h2>
        <div className={colsClass}>
          {lanesInSection.map((lane) => (
            <button
              key={lane.id}
              onClick={() => handleLaneClick(lane)}
              className={`${getLaneColor(lane)} border-2 rounded-lg p-2 md:p-3 hover:opacity-85 transition-all flex flex-col justify-between`}
            >
              {renderLaneContent(lane)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="inline-flex bg-gray-800 p-1 rounded-lg border border-gray-700">
          <button
            onClick={() => setViewMode('regular')}
            className={`px-3 md:px-4 py-2 rounded-md font-semibold text-sm md:text-base ${viewMode === 'regular' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
          >
            Regular Lanes
          </button>
          <button
            onClick={() => setViewMode('storage')}
            className={`px-3 md:px-4 py-2 rounded-md font-semibold text-sm md:text-base ${viewMode === 'storage' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'}`}
          >
            Storage View
          </button>
        </div>

        {viewMode === 'storage' && storageTableAvailable && !readOnly && (
          <button
            onClick={() => setShowStorageAddModal(true)}
            className="bg-green-600 hover:bg-green-700 px-4 md:px-5 py-2 rounded-lg font-bold"
          >
            + Add Storage
          </button>
        )}
      </div>

      {!storageTableAvailable && (
        <div className="bg-red-900 border border-red-600 p-3 rounded-lg text-sm md:text-base">
          {storageWarning}
        </div>
      )}

      {viewMode === 'storage' && storageContainerGroups.length === 0 ? (
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 text-center text-gray-400">
          No lanes currently assigned for unloaded storage.
        </div>
      ) : viewMode === 'storage' ? (
        <div className="space-y-3">
          {storageContainerGroups.map((group) => (
            <div
              key={group.containerNumber}
              className="bg-gray-900 border border-blue-800 rounded-lg p-2 md:p-3"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-2">
                <div>
                  <div className="text-sm md:text-lg font-bold text-blue-300">
                    Container {group.containerNumber}
                  </div>
                  <div className="text-[11px] md:text-xs text-gray-300">
                    Lanes: {group.laneNumbers.join(', ')}
                  </div>
                </div>
                <button
                  onClick={() => openStorageGroupDetails({
                    container_number: group.containerNumber,
                    customer: group.customers.join(' / '),
                    lane_numbers: group.laneNumbers,
                    assignments: group.assignments
                  })}
                  className="bg-blue-700 hover:bg-blue-600 px-2.5 py-1.5 rounded-lg text-xs md:text-sm font-semibold self-start md:self-auto"
                >
                  Open Group
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5 mb-2">
                {group.customers.map((customer) => (
                  <div
                    key={`${group.containerNumber}-${customer}`}
                    className="bg-gray-700 border border-gray-500 px-2 py-1 rounded text-[11px] md:text-xs font-bold"
                  >
                    {customer}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-1.5 md:gap-2">
                {group.lanes.map((lane) => (
                  <button
                    key={`${group.containerNumber}-${lane.id}`}
                    onClick={() => handleLaneClick(lane)}
                    className={`${getLaneColor(lane)} border rounded-lg p-1.5 md:p-2 hover:opacity-85 transition-all flex flex-col justify-between min-h-[66px] md:min-h-[72px]`}
                  >
                    {renderLaneContent(lane, true)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {renderLaneSection('Large Lanes (34 pallets)', 'text-blue-400 border-blue-700', lanesByType.large, 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 md:gap-4')}
          {renderLaneSection('Medium Lanes (25 pallets)', 'text-green-400 border-green-700', lanesByType.medium, 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 md:gap-4')}
          {renderLaneSection('Small Lanes (15 pallets)', 'text-yellow-400 border-yellow-700', lanesByType.small, 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 md:gap-4')}
          {renderLaneSection('Mini Lanes (4 pallets)', 'text-purple-400 border-purple-700', lanesByType.mini, 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 md:gap-4')}
        </>
      )}

      {showAssignModal && selectedLane && (
        <AssignModal
          lane={selectedLane}
          onClose={handleAssignModalClose}
          laneTabs={assignModalLaneTabs}
          onSelectLaneTab={assignModalLaneTabs.length > 1 ? handleAssignModalLaneTabSelect : undefined}
        />
      )}

      {showStorageAddModal && (
        <StorageAddModal
          lanes={lanes.map((lane) => ({ lane_number: String(lane.lane_number) }))}
          onClose={() => setShowStorageAddModal(false)}
          onSaved={handleStorageUpdated}
        />
      )}

      {storageModalData && (
        <StorageLaneModal
          mode={storageModalData.mode}
          title={storageModalData.title}
          assignments={storageModalData.assignments}
          readOnly={readOnly}
          onClose={() => setStorageModalData(null)}
          onUpdated={handleStorageUpdated}
        />
      )}
    </div>
  );
}
