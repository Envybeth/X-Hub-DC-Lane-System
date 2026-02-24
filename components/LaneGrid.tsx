'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import AssignModal from './AssignModal';
import StorageAddModal from './StorageAddModal';
import StorageLaneModal from './StorageLaneModal';
import { StorageAssignment, StorageGroup } from '@/types/storage';

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
}

type ViewMode = 'regular' | 'storage';

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

export default function LaneGrid() {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [selectedLane, setSelectedLane] = useState<Lane | null>(null);
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

  const fetchLanes = useCallback(async () => {
    const { data: laneRows } = await supabase
      .from('lanes')
      .select('*')
      .order('id');

    if (!laneRows) {
      setLanes([]);
      return;
    }

    let activeStorageAssignments: StorageAssignment[] = [];
    const { data: storageRows, error: storageError } = await supabase
      .from('container_storage_assignments')
      .select('id, container_number, customer, lane_number, active, organized_to_label, organized_at, created_at, updated_at')
      .eq('active', true)
      .order('container_number', { ascending: true })
      .order('customer', { ascending: true })
      .order('lane_number', { ascending: true });

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
      setStorageAssignments(activeStorageAssignments);
      setStorageTableAvailable(true);
      setStorageWarning('');
    }

    const storageByLane = new Map<string, StorageAssignment[]>();
    activeStorageAssignments.forEach((assignment) => {
      const laneKey = String(assignment.lane_number);
      const current = storageByLane.get(laneKey) || [];
      current.push(assignment);
      storageByLane.set(laneKey, current);
    });

    const lanesWithCapacity = await Promise.all(
      laneRows.map(async (lane) => {
        const { data: assignments } = await supabase
          .from('lane_assignments')
          .select('pallet_count')
          .eq('lane_number', lane.lane_number);

        const current_pallets = assignments?.reduce((sum, a) => sum + a.pallet_count, 0) || 0;

        const { data: shipmentData } = await supabase
          .from('shipments')
          .select('pu_number, status, archived')
          .eq('staging_lane', lane.lane_number.toString())
          .eq('archived', false);

        const activeShipment = shipmentData?.find((s) => s.status !== 'cleared') || shipmentData?.[0];

        let isStaging = false;
        let stagingPuNumber = null;
        let isFinalized = false;

        if (activeShipment) {
          isStaging = true;
          stagingPuNumber = activeShipment.pu_number;
          isFinalized = activeShipment.status === 'finalized';
        } else {
          const { data: pts } = await supabase
            .from('picktickets')
            .select('status')
            .eq('assigned_lane', lane.lane_number);
          isStaging = (pts && pts.length > 0 && pts.every((pt) => pt.status === 'ready_to_ship')) || false;
        }

        const laneStorageAssignments = storageByLane.get(String(lane.lane_number)) || [];

        return {
          ...lane,
          current_pallets,
          isStaging,
          stagingPuNumber,
          isFinalized,
          hasStorage: laneStorageAssignments.length > 0,
          storageAssignments: laneStorageAssignments
        } as Lane;
      })
    );

    setLanes(lanesWithCapacity);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLanes();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [fetchLanes]);

  useEffect(() => {
    const laneQuery = searchParams.get('lane');
    if (!laneQuery || lanes.length === 0) return;

    const targetLane = lanes.find((lane) => lane.lane_number === laneQuery);
    if (!targetLane) return;

    const timer = window.setTimeout(() => {
      if (targetLane.hasStorage && targetLane.storageAssignments && targetLane.storageAssignments.length > 0) {
        setStorageModalData({
          mode: 'lane',
          title: `Storage Lane ${targetLane.lane_number}`,
          assignments: targetLane.storageAssignments
        });
        return;
      }

      setSelectedLane(targetLane);
      setShowAssignModal(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [searchParams, lanes]);

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

    setSelectedLane(lane);
    setShowAssignModal(true);
  }

  function handleAssignModalClose() {
    setShowAssignModal(false);
    setSelectedLane(null);
    fetchLanes();
    router.replace('/', { scroll: false });
  }

  function handleStorageUpdated() {
    fetchLanes();
  }

  function getLaneColor(lane: Lane) {
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
          {!lane.hasStorage && lane.isStaging && '📦 '}
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

        {viewMode === 'storage' && storageTableAvailable && (
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
          onClose={() => setStorageModalData(null)}
          onUpdated={handleStorageUpdated}
        />
      )}
    </div>
  );
}
