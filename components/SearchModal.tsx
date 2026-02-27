'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import PTDetails from './PTDetails';
import { Pickticket } from '@/types/pickticket';
import { isPTArchived } from '@/lib/utils';
import { fetchCompiledPTInfo } from '@/lib/compiledPallets';
import { useRouter } from 'next/navigation';

interface SearchModalProps {
  onClose: () => void;
  mostRecentSync?: Date | null;
}

interface ContainerGroup {
  container_number: string;
  pts: Pickticket[];
}

interface QuickAssignRow {
  lane_number: string;
  pallet_count: string;
}

function sortLaneNumbers(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    return a.localeCompare(b);
  });
}

export default function SearchModal({ onClose, mostRecentSync }: SearchModalProps) {
  const [searchType, setSearchType] = useState<'PT' | 'PO' | 'CONTAINER'>('PT');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<Pickticket[]>([]);
  const [containerGroups, setContainerGroups] = useState<ContainerGroup[]>([]);
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [viewingPTDetails, setViewingPTDetails] = useState<Pickticket | null>(null);
  const [fallbackMostRecentSync, setFallbackMostRecentSync] = useState<Date | null>(null);
  const [laneLocationsByPt, setLaneLocationsByPt] = useState<Record<number, string[]>>({});
  const [availableLanes, setAvailableLanes] = useState<string[]>([]);
  const [quickAssignPT, setQuickAssignPT] = useState<Pickticket | null>(null);
  const [quickAssignRows, setQuickAssignRows] = useState<QuickAssignRow[]>([{ lane_number: '', pallet_count: '1' }]);
  const [quickAssignSubmitting, setQuickAssignSubmitting] = useState(false);
  const [quickAssignError, setQuickAssignError] = useState('');
  const router = useRouter();
  const effectiveMostRecentSync = mostRecentSync || fallbackMostRecentSync;

  useEffect(() => {
    if (mostRecentSync) return;

    let cancelled = false;

    async function fetchMostRecentSync() {
      const { data } = await supabase
        .from('picktickets')
        .select('last_synced_at')
        .order('last_synced_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!cancelled && data?.last_synced_at) {
        setFallbackMostRecentSync(new Date(data.last_synced_at));
      }
    }

    fetchMostRecentSync();

    return () => {
      cancelled = true;
    };
  }, [mostRecentSync]);

  async function handleSearch() {
    if (!searchQuery.trim()) return;

    setSearching(true);
    setSearched(true);
    setResults([]);
    setContainerGroups([]);
    setExpandedContainers(new Set());
    setLaneLocationsByPt({});

    try {
      let query = supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, container_number, store_dc, start_date, cancel_date, actual_pallet_count, ctn, status, pu_number, qty, last_synced_at, compiled_pallet_id');

      const searchValue = searchQuery.trim();

      if (searchType === 'PT') {
        query = query.or(`pt_number.eq.${searchValue},pt_number.ilike.%${searchValue}`);
      } else if (searchType === 'PO') {
        query = query.or(`po_number.eq.${searchValue},po_number.ilike.%${searchValue}`);
      } else if (searchType === 'CONTAINER') {
        query = query.or(`container_number.eq.${searchValue},container_number.ilike.%${searchValue}`);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Search error:', error);
      } else if (data) {
        const typedData = data as Pickticket[];
        // Fetch compiled info for all PTs
        const ptIds = typedData.map((pt) => pt.id);
        const compiledInfo = await fetchCompiledPTInfo(ptIds);

        const decorated = typedData.map((pt) => ({
          ...pt,
          compiled_with: compiledInfo[pt.id] || pt.compiled_with
        }));

        const { data: laneRows, error: laneError } = await supabase
          .from('lane_assignments')
          .select('pt_id, lane_number, order_position')
          .in('pt_id', ptIds)
          .order('order_position', { ascending: true });

        if (laneError) {
          console.error('Failed to fetch lane locations for search results:', laneError);
        }

        const laneMap: Record<number, string[]> = {};
        (laneRows || []).forEach((row) => {
          const ptId = Number(row.pt_id);
          const lane = String(row.lane_number || '').trim();
          if (!lane) return;
          if (!laneMap[ptId]) laneMap[ptId] = [];
          if (!laneMap[ptId].includes(lane)) laneMap[ptId].push(lane);
        });
        decorated.forEach((pt) => {
          if ((!laneMap[pt.id] || laneMap[pt.id].length === 0) && pt.assigned_lane) {
            laneMap[pt.id] = [pt.assigned_lane];
          }
        });
        Object.keys(laneMap).forEach((ptIdKey) => {
          const ptId = Number(ptIdKey);
          laneMap[ptId] = sortLaneNumbers(laneMap[ptId] || []);
        });
        setLaneLocationsByPt(laneMap);

        const decoratedWithLocations = decorated.map((pt) => ({
          ...pt,
          lane_locations: laneMap[pt.id] || []
        }));

        if (searchType === 'CONTAINER') {
          const grouped = decoratedWithLocations.reduce((acc, pt) => {
            const containerNum = pt.container_number;
            const existing = acc.find(g => g.container_number === containerNum);
            if (existing) {
              existing.pts.push(pt);
            } else {
              acc.push({
                container_number: containerNum,
                pts: [pt]
              });
            }
            return acc;
          }, [] as ContainerGroup[]);

          setContainerGroups(grouped);
        } else {
          setResults(decoratedWithLocations);
        }
      }
    } catch (error) {
      console.error('Search failed:', error);
    }

    setSearching(false);
  }

  function handleKeyPress(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }

  function toggleContainer(containerNumber: string) {
    setExpandedContainers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(containerNumber)) {
        newSet.delete(containerNumber);
      } else {
        newSet.add(containerNumber);
      }
      return newSet;
    });
  }

  function getPTLaneLocations(pt: Pickticket): string[] {
    const mapped = laneLocationsByPt[pt.id];
    if (mapped && mapped.length > 0) return sortLaneNumbers(mapped);
    if (pt.lane_locations && pt.lane_locations.length > 0) return sortLaneNumbers(pt.lane_locations);
    if (pt.assigned_lane) return [pt.assigned_lane];
    return [];
  }

  async function ensureAvailableLanesLoaded() {
    if (availableLanes.length > 0) return;
    const { data, error } = await supabase
      .from('lanes')
      .select('lane_number')
      .order('lane_number', { ascending: true });
    if (error) {
      console.error('Failed to load lanes for quick assign:', error);
      return;
    }
    const lanes = sortLaneNumbers((data || []).map((row) => String(row.lane_number)));
    setAvailableLanes(lanes);
  }

  async function openQuickAssign(pt: Pickticket) {
    await ensureAvailableLanesLoaded();
    const defaultPallets = pt.actual_pallet_count && pt.actual_pallet_count > 0
      ? String(pt.actual_pallet_count)
      : '1';
    setQuickAssignRows([{ lane_number: '', pallet_count: defaultPallets }]);
    setQuickAssignError('');
    setQuickAssignPT(pt);
  }

  function updateQuickAssignRow(index: number, field: keyof QuickAssignRow, value: string) {
    setQuickAssignRows((prev) => prev.map((row, rowIndex) => (
      rowIndex === index ? { ...row, [field]: value } : row
    )));
  }

  function addQuickAssignRow() {
    setQuickAssignRows((prev) => [...prev, { lane_number: '', pallet_count: '1' }]);
  }

  function removeQuickAssignRow(index: number) {
    setQuickAssignRows((prev) => (prev.length <= 1 ? prev : prev.filter((_, rowIndex) => rowIndex !== index)));
  }

  async function submitQuickAssign() {
    if (!quickAssignPT) return;
    setQuickAssignSubmitting(true);
    setQuickAssignError('');

    try {
      const laneTotals = new Map<string, number>();
      const laneOrder: string[] = [];

      for (const row of quickAssignRows) {
        const laneNumber = row.lane_number.trim();
        if (!laneNumber) continue;
        const palletCount = Number.parseInt(row.pallet_count.trim(), 10);
        if (!Number.isFinite(palletCount) || palletCount <= 0) {
          setQuickAssignError('Each selected lane must have a pallet count greater than 0.');
          setQuickAssignSubmitting(false);
          return;
        }
        if (!laneTotals.has(laneNumber)) laneOrder.push(laneNumber);
        laneTotals.set(laneNumber, (laneTotals.get(laneNumber) || 0) + palletCount);
      }

      if (laneTotals.size === 0) {
        setQuickAssignError('Add at least one lane and pallet quantity.');
        return;
      }

      await ensureAvailableLanesLoaded();
      const missingLanes = laneOrder.filter((lane) => !availableLanes.includes(lane));
      if (missingLanes.length > 0) {
        setQuickAssignError(`Unknown lane(s): ${missingLanes.join(', ')}`);
        return;
      }

      const { data: stagingRows, error: stagingError } = await supabase
        .from('shipments')
        .select('staging_lane')
        .in('staging_lane', laneOrder)
        .eq('archived', false);
      if (stagingError) {
        setQuickAssignError(`Could not validate staging lanes: ${stagingError.message}`);
        return;
      }
      const blockedStagingLanes = Array.from(new Set((stagingRows || []).map((row) => String(row.staging_lane))));
      if (blockedStagingLanes.length > 0) {
        setQuickAssignError(`Quick assign cannot target active staging lane(s): ${blockedStagingLanes.join(', ')}`);
        return;
      }

      const { data: existingPtAssignments, error: existingAssignmentError } = await supabase
        .from('lane_assignments')
        .select('id')
        .eq('pt_id', quickAssignPT.id);
      if (existingAssignmentError) {
        setQuickAssignError(`Failed to check current PT assignments: ${existingAssignmentError.message}`);
        return;
      }
      if ((existingPtAssignments || []).length > 0) {
        setQuickAssignError('PT already has lane assignments. Refresh search and use lane controls.');
        return;
      }

      for (const laneNumber of laneOrder) {
        const { data: laneAssignments, error: laneAssignmentsError } = await supabase
          .from('lane_assignments')
          .select('id, order_position')
          .eq('lane_number', laneNumber);

        if (laneAssignmentsError) {
          setQuickAssignError(`Failed loading lane ${laneNumber}: ${laneAssignmentsError.message}`);
          return;
        }

        for (const assignment of laneAssignments || []) {
          const { error: shiftError } = await supabase
            .from('lane_assignments')
            .update({ order_position: (assignment.order_position || 0) + 1 })
            .eq('id', assignment.id);
          if (shiftError) {
            setQuickAssignError(`Failed to shift lane ${laneNumber}: ${shiftError.message}`);
            return;
          }
        }

        const { error: insertError } = await supabase
          .from('lane_assignments')
          .insert({
            lane_number: laneNumber,
            pt_id: quickAssignPT.id,
            pallet_count: laneTotals.get(laneNumber),
            order_position: 1
          });
        if (insertError) {
          setQuickAssignError(`Failed assigning lane ${laneNumber}: ${insertError.message}`);
          return;
        }
      }

      const totalPallets = Array.from(laneTotals.values()).reduce((sum, value) => sum + value, 0);
      const primaryLane = laneOrder[0];

      const { error: pickticketUpdateError } = await supabase
        .from('picktickets')
        .update({
          assigned_lane: primaryLane,
          actual_pallet_count: totalPallets,
          status: 'labeled'
        })
        .eq('id', quickAssignPT.id);

      if (pickticketUpdateError) {
        setQuickAssignError(`Failed updating PT record: ${pickticketUpdateError.message}`);
        return;
      }

      const updatedLanes = sortLaneNumbers(laneOrder);
      setLaneLocationsByPt((prev) => ({ ...prev, [quickAssignPT.id]: updatedLanes }));
      setResults((prev) => prev.map((result) => (
        result.id === quickAssignPT.id
          ? {
            ...result,
            assigned_lane: primaryLane,
            actual_pallet_count: totalPallets,
            lane_locations: updatedLanes,
            status: 'labeled'
          }
          : result
      )));
      setContainerGroups((prev) => prev.map((group) => ({
        ...group,
        pts: group.pts.map((pt) => (
          pt.id === quickAssignPT.id
            ? {
              ...pt,
              assigned_lane: primaryLane,
              actual_pallet_count: totalPallets,
              lane_locations: updatedLanes,
              status: 'labeled'
            }
            : pt
        ))
      })));
      setQuickAssignPT(null);
    } finally {
      setQuickAssignSubmitting(false);
    }
  }

  function PTResultCard({ pt, mostRecentSync }: { pt: Pickticket; mostRecentSync?: Date | null }) {
    const isArchived = isPTArchived(pt, mostRecentSync);
    const laneLocations = getPTLaneLocations(pt);
    const primaryLane = laneLocations[0] || null;
    const showArchived = isArchived && laneLocations.length === 0; // ADD THIS
    const isCompiled = pt.compiled_with && pt.compiled_with.length > 0;

    return (
      <div className={`bg-gray-800 p-4 rounded-lg border-2 ${isCompiled ? 'border-orange-500' : 'border-gray-600'}`}>
        {isCompiled && (
          <div className="bg-orange-600 px-3 py-1 rounded font-bold text-sm inline-block mb-2">
            COMPILED ({1 + pt.compiled_with!.length} PTs)
          </div>
        )}
        <div className="flex justify-between items-start gap-4">
          <div className="flex-1 grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-gray-400">Pickticket #</div>
              <div className="text-lg font-bold">{pt.pt_number}</div>
            </div>
            <div>
              <div className="text-sm text-gray-400">PO #</div>
              <div className="text-lg font-bold">{pt.po_number}</div>
            </div>
            <div>
              <div className="text-sm text-gray-400">Customer</div>
              <div className="text-lg">{pt.customer}</div>
            </div>
            <div>
              <div className="text-sm text-gray-400">{showArchived ? 'Status' : 'Location'}</div>
              {showArchived ? (
                <div className="bg-gray-600 px-3 py-1 rounded-lg font-bold text-white inline-block">
                  ARCHIVED
                </div>
              ) : (
                <div
                  onClick={() => {
                    if (primaryLane) {
                      // Close the search modal immediately
                      onClose();
                      // Navigate to the main page with the lane query
                      router.push(`/?lane=${primaryLane}`);
                    } else {
                      void openQuickAssign(pt);
                    }
                  }}
                  className={`text-xl md:text-3xl font-bold transition-all cursor-pointer hover:underline ${primaryLane
                    ? 'text-green-400 cursor-pointer hover:text-green-300 hover:underline'
                    : 'text-yellow-400 hover:text-yellow-300'
                    }`}
                >
                  {laneLocations.length > 0 ? `Lane ${laneLocations.join('/')}` : 'Not assigned (click to assign)'}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => setViewingPTDetails(pt)}
            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-semibold flex-shrink-0"
          >
            Details
          </button>
        </div>
        {isCompiled && (
          <div className="mt-3 pt-3 border-t border-gray-600">
            <div className="text-xs text-gray-400 mb-2">Compiled with:</div>
            <div className="space-y-1">
              {pt.compiled_with!.map((cpt) => (
                <div key={cpt.id} className="text-sm text-gray-300">
                  • PT #{cpt.pt_number} ({cpt.customer})
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function PTCompactCard({ pt, mostRecentSync }: { pt: Pickticket; mostRecentSync?: Date | null }) {
    const isArchived = isPTArchived(pt, mostRecentSync);
    const laneLocations = getPTLaneLocations(pt);
    const primaryLane = laneLocations[0] || null;
    const showArchived = isArchived && laneLocations.length === 0; // ADD THIS
    const isCompiled = pt.compiled_with && pt.compiled_with.length > 0;

    return (
      <div className={`bg-gray-800 p-3 rounded-lg border-2 ${isCompiled ? 'border-orange-500' : 'border-gray-600'}`}>
        {isCompiled && (
          <div className="bg-orange-600 px-2 py-0.5 rounded text-xs font-bold text-white inline-block mb-1">
            COMPILED
          </div>
        )}
        <div className="flex justify-between items-start gap-2">
          <div className="flex-1">
            <div className="font-bold">PT #{pt.pt_number}</div>
            <div className="text-xs text-gray-300">PO: {pt.po_number}</div>
            {showArchived ? (
              <div className="bg-red-600 px-2 py-1 rounded text-xs font-bold text-white inline-block mt-1">
                ARCHIVED
              </div>
            ) : (
              <>
                <div className="text-sm text-blue-400 mt-1">
                  {pt.actual_pallet_count || 'TBD'} pallets
                </div>
                <div
                  onClick={() => {
                    if (primaryLane) {
                      onClose();
                      router.push(`/?lane=${primaryLane}`);
                    } else {
                      void openQuickAssign(pt);
                    }
                  }}
                  className={`text-sm font-semibold mt-1 cursor-pointer hover:underline ${primaryLane ? 'text-green-400' : 'text-yellow-400'}`}
                >
                  {laneLocations.length > 0 ? `Lane ${laneLocations.join('/')}` : 'Unassigned (tap to assign)'}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setViewingPTDetails(pt)}
            className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-xs font-semibold flex-shrink-0"
          >
            Details
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-lg p-8 max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold">Search PT / PO / Container</h2>
          <button onClick={onClose} className="text-4xl hover:text-red-500">&times;</button>
        </div>

        {/* Search Type Selection */}
        <div className="mb-6">
          <label className="block text-lg font-semibold mb-3">Search Type</label>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="PT"
                checked={searchType === 'PT'}
                onChange={(e) => setSearchType(e.target.value as 'PT')}
                className="w-5 h-5"
              />
              <span className="text-lg">Pickticket Number</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="PO"
                checked={searchType === 'PO'}
                onChange={(e) => setSearchType(e.target.value as 'PO')}
                className="w-5 h-5"
              />
              <span className="text-lg">PO Number</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="CONTAINER"
                checked={searchType === 'CONTAINER'}
                onChange={(e) => setSearchType(e.target.value as 'CONTAINER')}
                className="w-5 h-5"
              />
              <span className="text-lg">Container Number</span>
            </label>
          </div>
        </div>

        {/* Search Input */}
        <div className="mb-6">
          <label className="block text-lg font-semibold mb-2">
            Enter {searchType === 'PT' ? 'Pickticket' : searchType === 'PO' ? 'PO' : 'Container'} Number
          </label>
          <div className="text-sm text-gray-400 mb-2">
            💡 Tip: You can search with just the last 4 digits
          </div>
          <div className="flex gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={`e.g., 1234 or full number`}
              className="flex-1 bg-gray-700 text-white p-3 rounded-lg text-lg"
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchQuery.trim()}
              className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 px-8 py-3 rounded-lg font-bold text-lg"
            >
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>

        {/* Results for PT/PO Search */}
        {searched && searchType !== 'CONTAINER' && (
          <div className="bg-gray-700 p-6 rounded-lg">
            <h3 className="text-2xl font-bold mb-4">
              Results ({results.length} found)
            </h3>

            {results.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No results found</p>
            ) : (
              <div className="space-y-4">
                {results.map((result) => (
                  <PTResultCard key={result.id} pt={result} mostRecentSync={effectiveMostRecentSync} />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Results for Container Search */}
        {searched && searchType === 'CONTAINER' && (
          <div className="bg-gray-700 p-6 rounded-lg">
            <h3 className="text-2xl font-bold mb-4">
              Containers Found ({containerGroups.length})
            </h3>

            {containerGroups.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No containers found</p>
            ) : (
              <div className="space-y-4">
                {containerGroups.map((group) => {
                  const isExpanded = expandedContainers.has(group.container_number);
                  const allArchived = group.pts.every(pt => isPTArchived(pt, effectiveMostRecentSync));

                  // Group PTs by customer for multi-column layout
                  const ptsByCustomer = group.pts.reduce((acc, pt) => {
                    const customer = pt.customer || 'OTHER';
                    if (!acc[customer]) acc[customer] = [];
                    acc[customer].push(pt);
                    return acc;
                  }, {} as Record<string, Pickticket[]>);

                  const customers = Object.keys(ptsByCustomer).sort();

                  return (
                    <div key={group.container_number} className={`bg-gray-800 rounded-lg border-2 ${allArchived ? 'border-red-500' : 'border-purple-500'}`}>
                      {/* Container Header - Clickable */}
                      <button
                        onClick={() => toggleContainer(group.container_number)}
                        className="w-full p-5 flex items-center justify-between hover:bg-gray-750 transition-colors"
                      >
                        <div className="flex items-center gap-4">
                          <div className="text-2xl text-purple-400">
                            {isExpanded ? '▼' : '▶'}
                          </div>
                          <div className="text-left">
                            <div className="text-2xl font-bold text-purple-400">
                              Container #{group.container_number}
                            </div>
                            <div className="text-sm text-gray-400 mt-1">
                              {group.pts.length} pickticket{group.pts.length !== 1 ? 's' : ''} • Click to {isExpanded ? 'collapse' : 'expand'}
                            </div>
                          </div>
                        </div>
                        {allArchived && (
                          <div className="bg-red-600 px-4 py-2 rounded-lg font-bold text-white">
                            ALL ARCHIVED
                          </div>
                        )}
                      </button>

                      {/* Expanded PT List - Multi-Column by Customer */}
                      {isExpanded && (
                        <div className="p-6 border-t-2 border-purple-500 bg-gray-750">
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {customers.map(customer => (
                              <div key={customer} className="bg-gray-700 p-4 rounded-lg">
                                <h4 className="text-xl font-bold mb-4 text-center border-b border-gray-500 pb-2">
                                  {customer}
                                </h4>
                                <div className="space-y-3">
                                  {ptsByCustomer[customer].map((pt) => (
                                    <PTCompactCard key={pt.id} pt={pt} mostRecentSync={effectiveMostRecentSync} />
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* PT Details Modal */}
      {quickAssignPT && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-[70] p-4">
          <div className="bg-gray-800 rounded-lg p-5 max-w-2xl w-full border-2 border-purple-600">
            <h3 className="text-2xl font-bold mb-2">Quick Assign PT #{quickAssignPT.pt_number}</h3>
            <p className="text-sm text-gray-300 mb-4">
              Split this PT across one or more lanes. Each lane needs its own pallet quantity.
            </p>

            <div className="space-y-3">
              {quickAssignRows.map((row, index) => (
                <div
                  key={index}
                  className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-end"
                >
                  <div className="flex flex-col gap-1 min-w-0">
                    <label htmlFor={`quick-assign-lane-${index}`} className="text-xs text-gray-300 font-semibold">
                      Lane
                    </label>
                    <input
                      id={`quick-assign-lane-${index}`}
                      list="quick-assign-lanes"
                      value={row.lane_number}
                      onChange={(e) => updateQuickAssignRow(index, 'lane_number', e.target.value)}
                      placeholder="Lane #"
                      className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
                    />
                  </div>
                  <div className="flex flex-col gap-1 min-w-0">
                    <label htmlFor={`quick-assign-pallet-${index}`} className="text-xs text-gray-300 font-semibold">
                      Pallet Qty
                    </label>
                    <input
                      id={`quick-assign-pallet-${index}`}
                      type="number"
                      min="1"
                      value={row.pallet_count}
                      onChange={(e) => updateQuickAssignRow(index, 'pallet_count', e.target.value)}
                      placeholder="Pallets"
                      className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-gray-300 font-semibold invisible">
                      Remove
                    </label>
                    <button
                      onClick={() => removeQuickAssignRow(index)}
                      disabled={quickAssignRows.length <= 1}
                      className="w-full sm:w-auto bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-3 py-2 rounded font-bold"
                      type="button"
                      aria-label="Remove lane row"
                    >
                      -
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3">
              <button
                onClick={addQuickAssignRow}
                className="bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded font-bold"
                type="button"
              >
                + Add Lane
              </button>
            </div>

            {quickAssignError && (
              <div className="mt-3 bg-red-900 border border-red-600 rounded p-2 text-sm">
                {quickAssignError}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setQuickAssignPT(null);
                  setQuickAssignError('');
                  setQuickAssignRows([{ lane_number: '', pallet_count: '1' }]);
                }}
                className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded font-semibold"
                type="button"
                disabled={quickAssignSubmitting}
              >
                Cancel
              </button>
              <button
                onClick={() => void submitQuickAssign()}
                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-semibold disabled:bg-gray-600"
                type="button"
                disabled={quickAssignSubmitting}
              >
                {quickAssignSubmitting ? 'Assigning...' : 'Assign'}
              </button>
            </div>
          </div>
          <datalist id="quick-assign-lanes">
            {availableLanes.map((lane) => (
              <option key={lane} value={lane} />
            ))}
          </datalist>
        </div>
      )}

      {/* PT Details Modal */}
      {viewingPTDetails && (
        <PTDetails
          pt={viewingPTDetails}
          onClose={() => setViewingPTDetails(null)}
          mostRecentSync={effectiveMostRecentSync}
        />
      )}
    </div>
  );
}
