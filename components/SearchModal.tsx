'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import PTDetails from './PTDetails';
import { Pickticket } from '@/types/pickticket';
import { isPTDefunct } from '@/lib/utils';
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

export default function SearchModal({ onClose, mostRecentSync }: SearchModalProps) {
  const [searchType, setSearchType] = useState<'PT' | 'PO' | 'CONTAINER'>('PT');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<Pickticket[]>([]);
  const [containerGroups, setContainerGroups] = useState<ContainerGroup[]>([]);
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [viewingPTDetails, setViewingPTDetails] = useState<Pickticket | null>(null);
  const router = useRouter();

  async function handleSearch() {
    if (!searchQuery.trim()) return;

    setSearching(true);
    setSearched(true);
    setResults([]);
    setContainerGroups([]);
    setExpandedContainers(new Set());

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
        // Fetch compiled info for all PTs
        const ptIds = data.map(pt => pt.id);
        const compiledInfo = await fetchCompiledPTInfo(ptIds);

        // Attach compiled_with to each PT
        // Attach compiled_with to each PT
        data.forEach(pt => {
          if (compiledInfo[pt.id]) {
            (pt as any).compiled_with = compiledInfo[pt.id];
          }
        });

        if (searchType === 'CONTAINER') {
          const grouped = data.reduce((acc, pt) => {
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
          setResults(data);
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

  function PTResultCard({ pt, mostRecentSync }: { pt: Pickticket; mostRecentSync?: Date | null }) {
    const isDefunct = isPTDefunct(pt, mostRecentSync);
    const showDefunct = isDefunct && !pt.assigned_lane; // ADD THIS
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
              <div className="text-sm text-gray-400">{showDefunct ? 'Status' : 'Location'}</div>
              {showDefunct ? (
                <div className="bg-red-600 px-3 py-1 rounded-lg font-bold text-white inline-block">
                  DEFUNCT
                </div>
              ) : (
                <div
                  onClick={() => {
                    if (pt.assigned_lane) {
                      // Close the search modal immediately
                      onClose();
                      // Navigate to the main page with the lane query
                      router.push(`/?lane=${pt.assigned_lane}`);
                    }
                  }}
                  className={`text-xl md:text-3xl font-bold transition-all ${pt.assigned_lane
                    ? 'text-green-400 cursor-pointer hover:text-green-300 hover:underline'
                    : 'text-yellow-400'
                    }`}
                >
                  {pt.assigned_lane ? `Lane ${pt.assigned_lane}` : 'Not assigned'}
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
              {pt.compiled_with!.map((cpt: any) => (
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
    const isDefunct = isPTDefunct(pt, mostRecentSync);
    const showDefunct = isDefunct && !pt.assigned_lane; // ADD THIS
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
            {showDefunct ? (
              <div className="bg-red-600 px-2 py-1 rounded text-xs font-bold text-white inline-block mt-1">
                DEFUNCT
              </div>
            ) : (
              <>
                <div className="text-sm text-blue-400 mt-1">
                  {pt.actual_pallet_count || 'TBD'} pallets
                </div>
                <div className={`text-sm font-semibold mt-1 ${pt.assigned_lane ? 'text-green-400' : 'text-yellow-400'}`}>
                  {pt.assigned_lane ? `Lane ${pt.assigned_lane}` : 'Unassigned'}
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
                  <PTResultCard key={result.id} pt={result} />
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
                  const allDefunct = group.pts.every(pt => isPTDefunct(pt, mostRecentSync));

                  // Group PTs by customer for multi-column layout
                  const ptsByCustomer = group.pts.reduce((acc, pt) => {
                    const customer = pt.customer || 'OTHER';
                    if (!acc[customer]) acc[customer] = [];
                    acc[customer].push(pt);
                    return acc;
                  }, {} as Record<string, Pickticket[]>);

                  const customers = Object.keys(ptsByCustomer).sort();

                  return (
                    <div key={group.container_number} className={`bg-gray-800 rounded-lg border-2 ${allDefunct ? 'border-red-500' : 'border-purple-500'}`}>
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
                        {allDefunct && (
                          <div className="bg-red-600 px-4 py-2 rounded-lg font-bold text-white">
                            ALL DEFUNCT
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
                                    <PTCompactCard key={pt.id} pt={pt} />
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
      {viewingPTDetails && (
        <PTDetails
          pt={viewingPTDetails}
          onClose={() => setViewingPTDetails(null)}
          mostRecentSync={mostRecentSync}
        />
      )}
    </div>
  );
}