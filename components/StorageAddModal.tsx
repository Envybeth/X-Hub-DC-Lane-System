'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import ActionToast from './ActionToast';

interface LaneOption {
  lane_number: string;
}

interface StorageCustomer {
  customer: string;
  ptCount: number;
}

interface StorageAddModalProps {
  lanes: LaneOption[];
  onClose: () => void;
  onSaved: () => void;
}

function describeSupabaseError(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  if (!error) return 'Unknown Supabase error';
  return [error.code, error.message, error.details, error.hint].filter(Boolean).join(' | ') || 'Unknown Supabase error';
}

export default function StorageAddModal({ lanes, onClose, onSaved }: StorageAddModalProps) {
  const [searchInput, setSearchInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [containerMatches, setContainerMatches] = useState<string[]>([]);
  const [selectedContainer, setSelectedContainer] = useState('');
  const [customers, setCustomers] = useState<StorageCustomer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [laneInputs, setLaneInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [toastMessage, setToastMessage] = useState('');

  const validLaneNumbers = useMemo(() => new Set(lanes.map((lane) => String(lane.lane_number))), [lanes]);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => setToastMessage(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  async function handleSearchContainers() {
    const term = searchInput.trim();
    if (!term) return;

    setSearching(true);
    setErrorText('');
    setSelectedContainer('');
    setCustomers([]);
    setLaneInputs({});

    try {
      const { data, error } = await supabase
        .from('picktickets')
        .select('container_number')
        .not('container_number', 'is', null)
        .or(`container_number.eq.${term},container_number.ilike.%${term}`)
        .limit(200);

      if (error) {
        setErrorText(`Search failed. ${describeSupabaseError(error)}`);
        return;
      }

      const uniqueMatches = Array.from(new Set((data || []).map((row) => row.container_number).filter(Boolean))).sort();

      if (uniqueMatches.length === 0) {
        setContainerMatches([]);
        setErrorText('No containers found for that search.');
        return;
      }

      const { data: activeStorageRows, error: activeStorageError } = await supabase
        .from('container_storage_assignments')
        .select('container_number')
        .in('container_number', uniqueMatches)
        .eq('active', true);

      if (activeStorageError) {
        setErrorText(`Search failed. ${describeSupabaseError(activeStorageError)}`);
        return;
      }

      const activeStorageSet = new Set(
        (activeStorageRows || [])
          .map((row) => String(row.container_number || '').trim().toLowerCase())
          .filter(Boolean)
      );

      const matchesNotInActiveStorage = uniqueMatches.filter(
        (container) => !activeStorageSet.has(container.toLowerCase())
      );

      if (matchesNotInActiveStorage.length === 0 && activeStorageSet.size > 0) {
        setContainerMatches([]);
        setErrorText('That container is already in storage.');
        setToastMessage('Already in storage');
        return;
      }

      const { data: statusRows, error: statusError } = await supabase
        .from('picktickets')
        .select('container_number, status')
        .in('container_number', matchesNotInActiveStorage)
        .neq('customer', 'PAPER');

      if (statusError) {
        setErrorText(`Search failed. ${describeSupabaseError(statusError)}`);
        return;
      }

      const statusByContainer = new Map<string, { total: number; unlabeled: number }>();
      (statusRows || []).forEach((row) => {
        const container = String(row.container_number || '').trim().toLowerCase();
        if (!container) return;

        const current = statusByContainer.get(container) || { total: 0, unlabeled: 0 };
        current.total += 1;
        const normalizedStatus = String(row.status || '').trim().toLowerCase();
        if (!normalizedStatus || normalizedStatus === 'unlabeled') {
          current.unlabeled += 1;
        }
        statusByContainer.set(container, current);
      });

      const organizedSet = new Set(
        Array.from(statusByContainer.entries())
          .filter(([, counts]) => counts.total > 0 && counts.unlabeled === 0)
          .map(([container]) => container)
      );

      const unorganizedMatches = matchesNotInActiveStorage.filter((container) => !organizedSet.has(container.toLowerCase()));
      setContainerMatches(unorganizedMatches);

      if (unorganizedMatches.length === 0 && organizedSet.size > 0) {
        setErrorText('That container is already organized.');
        setToastMessage("Already organized");
        return;
      }

      if (activeStorageSet.size > 0 && unorganizedMatches.length > 0) {
        setToastMessage('Some results are already in storage and were hidden.');
      } else if (unorganizedMatches.length < matchesNotInActiveStorage.length) {
        setToastMessage('Some results were hidden because they are already organized.');
      }
    } catch (error) {
      console.error('Container search failed:', error);
      setErrorText('Container search failed.');
    } finally {
      setSearching(false);
    }
  }

  async function loadCustomersForContainer(containerNumber: string) {
    setSelectedContainer(containerNumber);
    setCustomers([]);
    setLaneInputs({});
    setLoadingCustomers(true);
    setErrorText('');

    try {
      const { data, error } = await supabase
        .from('picktickets')
        .select('id, customer')
        .eq('container_number', containerNumber)
        .neq('customer', 'PAPER');

      if (error) {
        setErrorText(`Failed to load customers. ${describeSupabaseError(error)}`);
        return;
      }

      const byCustomer = (data || []).reduce((acc, row) => {
        const customer = (row.customer || '').trim() || 'UNKNOWN';
        acc[customer] = (acc[customer] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const customerRows = Object.entries(byCustomer)
        .map(([customer, ptCount]) => ({ customer, ptCount }))
        .sort((a, b) => a.customer.localeCompare(b.customer));

      setCustomers(customerRows);

      const defaults: Record<string, string> = {};
      customerRows.forEach((row) => {
        defaults[row.customer] = '';
      });
      setLaneInputs(defaults);
    } catch (error) {
      console.error('Failed to load customers for container:', error);
      setErrorText('Failed to load customers for selected container.');
    } finally {
      setLoadingCustomers(false);
    }
  }

  async function handleSave() {
    if (!selectedContainer) {
      setErrorText('Select a container first.');
      return;
    }

    if (customers.length === 0) {
      setErrorText('No customers found for this container.');
      return;
    }

    const payload: Array<{
      container_number: string;
      customer: string;
      lane_number: string;
      active: boolean;
      organized_to_label: boolean;
      organized_at: null;
    }> = [];

    for (const row of customers) {
      const raw = laneInputs[row.customer] || '';
      const parsedLanes = Array.from(
        new Set(
          raw
            .split(/[\s,]+/)
            .map((value) => value.trim())
            .filter(Boolean)
        )
      );

      if (parsedLanes.length === 0) {
        setErrorText(`Enter at least one lane for ${row.customer}.`);
        return;
      }

      for (const laneNumber of parsedLanes) {
        if (!validLaneNumbers.has(laneNumber)) {
          setErrorText(`Lane ${laneNumber} does not exist.`);
          return;
        }

        payload.push({
          container_number: selectedContainer,
          customer: row.customer,
          lane_number: laneNumber,
          active: true,
          organized_to_label: false,
          organized_at: null
        });
      }
    }

    const requestedLaneNumbers = Array.from(new Set(payload.map((row) => String(row.lane_number))));
    if (requestedLaneNumbers.length === 0) {
      setErrorText('No lanes were selected.');
      return;
    }

    try {
      const [{ data: laneAssignments, error: laneAssignmentError }, { data: stagingLanes, error: stagingError }, { data: activeStorageLanes, error: activeStorageError }] = await Promise.all([
        supabase
          .from('lane_assignments')
          .select('lane_number')
          .in('lane_number', requestedLaneNumbers),
        supabase
          .from('shipments')
          .select('staging_lane')
          .in('staging_lane', requestedLaneNumbers)
          .eq('archived', false),
        supabase
          .from('container_storage_assignments')
          .select('lane_number')
          .in('lane_number', requestedLaneNumbers)
          .eq('active', true)
      ]);

      if (laneAssignmentError || stagingError || activeStorageError) {
        const combinedError = laneAssignmentError || stagingError || activeStorageError;
        setErrorText(`Failed to validate lane availability. ${describeSupabaseError(combinedError)}`);
        return;
      }

      const unavailableLanes = new Set<string>();
      (laneAssignments || []).forEach((row) => unavailableLanes.add(String(row.lane_number)));
      (stagingLanes || []).forEach((row) => {
        if (row.staging_lane) unavailableLanes.add(String(row.staging_lane));
      });
      (activeStorageLanes || []).forEach((row) => unavailableLanes.add(String(row.lane_number)));

      if (unavailableLanes.size > 0) {
        const sortedUnavailable = Array.from(unavailableLanes).sort((a, b) => {
          const aNum = Number(a);
          const bNum = Number(b);
          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
          return a.localeCompare(b);
        });
        setErrorText(`Lane(s) ${sortedUnavailable.join(', ')} are not empty. Storage can only use empty lanes.`);
        return;
      }
    } catch (error) {
      console.error('Failed to validate lane availability:', error);
      setErrorText('Failed to validate lane availability.');
      return;
    }

    setSaving(true);
    setErrorText('');

    try {
      const { error } = await supabase
        .from('container_storage_assignments')
        .upsert(payload, { onConflict: 'container_number,customer,lane_number' });

      if (error) {
        setErrorText(`Failed to save storage assignments. ${describeSupabaseError(error)}`);
        return;
      }

      onSaved();
      onClose();
    } catch (error) {
      console.error('Failed to save storage assignments:', error);
      setErrorText('Failed to save storage assignments.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[70] p-2 md:p-4">
      <div className="bg-gray-800 rounded-lg p-4 md:p-6 max-w-3xl w-full max-h-[92vh] overflow-y-auto border border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl md:text-2xl font-bold">Add Unloaded Container Storage</h2>
          <button onClick={onClose} className="text-3xl hover:text-red-400">&times;</button>
        </div>

        <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 md:p-4 mb-4">
          <label className="block text-sm md:text-base font-semibold mb-2">Search Container</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSearchContainers();
                }
              }}
              placeholder="Enter full container or last digits"
              className="flex-1 bg-gray-700 border border-gray-600 text-white p-2 md:p-3 rounded-lg"
            />
            <button
              onClick={handleSearchContainers}
              disabled={searching || !searchInput.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-semibold"
            >
              {searching ? 'Searching...' : 'Search'}
            </button>
          </div>

          {containerMatches.length > 0 && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {containerMatches.map((container) => (
                <button
                  key={container}
                  onClick={() => loadCustomersForContainer(container)}
                  className={`text-left p-2 rounded border transition-colors ${selectedContainer === container
                    ? 'bg-blue-700 border-blue-500'
                    : 'bg-gray-700 border-gray-600 hover:bg-gray-600'
                    }`}
                >
                  {container}
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedContainer && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 md:p-4 mb-4">
            <div className="text-sm md:text-base font-bold mb-3">
              Container: <span className="text-blue-300">{selectedContainer}</span>
            </div>

            {loadingCustomers ? (
              <div className="text-gray-300">Loading customers...</div>
            ) : customers.length === 0 ? (
              <div className="text-gray-300">No customers found for this container.</div>
            ) : (
              <div className="space-y-3">
                {customers.map((row) => (
                  <div key={row.customer} className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center bg-gray-800 border border-gray-700 rounded p-2 md:p-3">
                    <div>
                      <div className="font-bold text-white">{row.customer}</div>
                      <div className="text-xs text-gray-400">{row.ptCount} PTs</div>
                    </div>
                    <input
                      type="text"
                      value={laneInputs[row.customer] || ''}
                      onChange={(e) => setLaneInputs((prev) => ({ ...prev, [row.customer]: e.target.value }))}
                      placeholder="Lane(s): ex. 12 or 12,13"
                      className="bg-gray-700 border border-gray-600 text-white p-2 rounded"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {errorText && (
          <div className="mb-3 bg-red-900 border border-red-600 text-red-100 p-2 rounded text-sm">
            {errorText}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-semibold"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !selectedContainer || customers.length === 0}
            className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-semibold"
          >
            {saving ? 'Saving...' : 'Save Storage'}
          </button>
        </div>
      </div>

      <ActionToast message={toastMessage || null} type="info" zIndexClass="z-[110]" />
    </div>
  );
}
