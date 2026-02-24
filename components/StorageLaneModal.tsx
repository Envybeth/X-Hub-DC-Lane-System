'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import PTDetails from './PTDetails';
import ConfirmModal from './ConfirmModal';
import { Pickticket } from '@/types/pickticket';
import { StorageAssignment } from '@/types/storage';

interface StorageLaneModalProps {
  mode: 'lane' | 'group';
  title: string;
  assignments: StorageAssignment[];
  onClose: () => void;
  onUpdated: () => void;
}

interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  onConfirm: () => void;
}

function describeSupabaseError(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  if (!error) return 'Unknown Supabase error';
  return [error.code, error.message, error.details, error.hint].filter(Boolean).join(' | ') || 'Unknown Supabase error';
}

function sortLaneNumbers(lanes: string[]) {
  return [...lanes].sort((a, b) => {
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    return a.localeCompare(b);
  });
}

export default function StorageLaneModal({ mode, title, assignments, onClose, onUpdated }: StorageLaneModalProps) {
  const [localAssignments, setLocalAssignments] = useState<StorageAssignment[]>(assignments);
  const [selectedLane, setSelectedLane] = useState<string | null>(null);
  const [expandedAssignmentIds, setExpandedAssignmentIds] = useState<Set<number>>(new Set());
  const [ptRowsByAssignmentId, setPtRowsByAssignmentId] = useState<Record<number, Pickticket[]>>({});
  const [loadingAssignmentIds, setLoadingAssignmentIds] = useState<number[]>([]);
  const [markingAssignmentId, setMarkingAssignmentId] = useState<number | null>(null);
  const [isBulkOrganizing, setIsBulkOrganizing] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [selectedPTDetails, setSelectedPTDetails] = useState<Pickticket | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmState>({
    isOpen: false,
    title: '',
    message: '',
    confirmText: 'Confirm',
    onConfirm: () => {}
  });

  useEffect(() => {
    setLocalAssignments(assignments);
  }, [assignments]);

  const laneTabs = useMemo(() => {
    const lanes = Array.from(new Set(localAssignments.map((assignment) => assignment.lane_number)));
    return sortLaneNumbers(lanes);
  }, [localAssignments]);

  useEffect(() => {
    if (mode !== 'group') {
      setSelectedLane(null);
      return;
    }

    if (laneTabs.length === 0) {
      setSelectedLane(null);
      return;
    }

    if (!selectedLane || !laneTabs.includes(selectedLane)) {
      setSelectedLane(laneTabs[0]);
    }
  }, [mode, laneTabs, selectedLane]);

  const visibleAssignments = useMemo(() => {
    if (mode !== 'group') return localAssignments;
    if (!selectedLane) return [];
    return localAssignments.filter((assignment) => assignment.lane_number === selectedLane);
  }, [mode, localAssignments, selectedLane]);

  async function fetchPTsForAssignment(assignment: StorageAssignment) {
    setLoadingAssignmentIds((prev) => (prev.includes(assignment.id) ? prev : [...prev, assignment.id]));
    setErrorText('');

    try {
      const { data, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, container_number, assigned_lane, store_dc, start_date, cancel_date, actual_pallet_count, ctn, status, pu_number, qty, last_synced_at, compiled_pallet_id')
        .eq('container_number', assignment.container_number)
        .eq('customer', assignment.customer)
        .order('pt_number');

      if (error) {
        setErrorText(`Failed to load PTs. ${describeSupabaseError(error)}`);
        return;
      }

      setPtRowsByAssignmentId((prev) => ({ ...prev, [assignment.id]: data || [] }));
    } catch (error) {
      console.error('Failed to load storage PT rows:', error);
      setErrorText('Failed to load PT rows for this storage assignment.');
    } finally {
      setLoadingAssignmentIds((prev) => prev.filter((id) => id !== assignment.id));
    }
  }

  async function toggleAssignmentDropdown(assignment: StorageAssignment) {
    const isExpanded = expandedAssignmentIds.has(assignment.id);
    if (isExpanded) {
      setExpandedAssignmentIds((prev) => {
        const next = new Set(prev);
        next.delete(assignment.id);
        return next;
      });
      return;
    }

    setExpandedAssignmentIds((prev) => new Set(prev).add(assignment.id));

    if (!ptRowsByAssignmentId[assignment.id]) {
      await fetchPTsForAssignment(assignment);
    }
  }

  async function markAssignmentsOrganized(assignmentIds: number[]) {
    setErrorText('');

    try {
      const { error } = await supabase
        .from('container_storage_assignments')
        .update({
          active: false,
          organized_to_label: true,
          organized_at: new Date().toISOString()
        })
        .in('id', assignmentIds);

      if (error) {
        setErrorText(`Failed to mark organized. ${describeSupabaseError(error)}`);
        return false;
      }

      const assignmentIdSet = new Set(assignmentIds);
      const remaining = localAssignments.filter((row) => !assignmentIdSet.has(row.id));
      setLocalAssignments(remaining);
      onUpdated();

      if (remaining.length === 0) {
        onClose();
      }

      return true;
    } catch (error) {
      console.error('Failed to mark storage assignment organized:', error);
      setErrorText('Failed to mark storage assignment(s) as organized to label.');
      return false;
    }
  }

  function openConfirm(title: string, message: string, onConfirm: () => void, confirmText = 'Confirm') {
    setConfirmModal({
      isOpen: true,
      title,
      message,
      confirmText,
      onConfirm
    });
  }

  function requestLaneOrganize(assignment: StorageAssignment) {
    openConfirm(
      'Confirm Lane Organize',
      `Mark Lane ${assignment.lane_number} as Organized to Label for ${assignment.customer} / ${assignment.container_number}?`,
      () => {
        void (async () => {
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          setMarkingAssignmentId(assignment.id);
          await markAssignmentsOrganized([assignment.id]);
          setMarkingAssignmentId(null);
        })();
      },
      'Yes, Organize Lane'
    );
  }

  function requestBulkOrganize() {
    if (localAssignments.length === 0) return;

    const laneNumbers = sortLaneNumbers(Array.from(new Set(localAssignments.map((row) => row.lane_number))));
    const containerNumbers = Array.from(new Set(localAssignments.map((row) => row.container_number)));
    const customerCount = new Set(localAssignments.map((row) => row.customer)).size;
    const containerLabel = containerNumbers.length === 1 ? containerNumbers[0] : `${containerNumbers.length} containers`;

    openConfirm(
      'Confirm Container Organize',
      `Mark all related lanes as Organized to Label for container ${containerLabel}? (${laneNumbers.length} lanes, ${customerCount} customer group${customerCount === 1 ? '' : 's'})`,
      () => {
        void (async () => {
          setConfirmModal((prev) => ({ ...prev, isOpen: false }));
          setIsBulkOrganizing(true);
          await markAssignmentsOrganized(localAssignments.map((row) => row.id));
          setIsBulkOrganizing(false);
        })();
      },
      'Yes, Organize All'
    );
  }

  function isActionDisabled(assignmentId?: number) {
    if (isBulkOrganizing) return true;
    if (markingAssignmentId !== null) return true;
    if (assignmentId !== undefined && markingAssignmentId === assignmentId) return true;
    return false;
  }

  const groupLaneCount = useMemo(
    () => sortLaneNumbers(Array.from(new Set(localAssignments.map((assignment) => assignment.lane_number)))).length,
    [localAssignments]
  );

  const groupContainerCount = useMemo(
    () => new Set(localAssignments.map((assignment) => assignment.container_number)).size,
    [localAssignments]
  );

  const groupCustomerCount = useMemo(
    () => new Set(localAssignments.map((assignment) => assignment.customer)).size,
    [localAssignments]
  );

  const bulkButtonLabel =
    groupContainerCount === 1
      ? `Organized to Label (All ${groupLaneCount} Lanes)`
      : `Organized to Label (All ${groupLaneCount} Lanes / ${groupContainerCount} Containers)`;

  const bulkSummary =
    groupContainerCount === 1
      ? `${groupLaneCount} lanes, ${groupCustomerCount} customer group${groupCustomerCount === 1 ? '' : 's'}`
      : `${groupLaneCount} lanes, ${groupCustomerCount} customer groups, ${groupContainerCount} containers`;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[75] p-2 md:p-4">
      <div className="bg-gray-800 rounded-lg p-4 md:p-6 max-w-5xl w-full max-h-[92vh] overflow-y-auto border border-gray-700">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl md:text-2xl font-bold">{title}</h2>
          <button onClick={onClose} className="text-3xl hover:text-red-400">&times;</button>
        </div>

        {mode === 'group' && localAssignments.length > 0 && (
          <div className="mb-4 bg-gray-900 border border-gray-700 rounded-lg p-3">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="text-sm text-gray-300">
                Group Summary: {bulkSummary}
              </div>
              <button
                onClick={requestBulkOrganize}
                disabled={isActionDisabled()}
                className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-3 py-2 rounded font-semibold text-sm"
              >
                {isBulkOrganizing ? 'Saving...' : bulkButtonLabel}
              </button>
            </div>
          </div>
        )}

        {mode === 'group' && laneTabs.length > 1 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {laneTabs.map((laneNumber) => (
              <button
                key={laneNumber}
                onClick={() => setSelectedLane(laneNumber)}
                className={`px-3 py-2 rounded-lg font-semibold ${selectedLane === laneNumber
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600'
                  }`}
              >
                Lane {laneNumber}
              </button>
            ))}
          </div>
        )}

        {errorText && (
          <div className="mb-3 bg-red-900 border border-red-600 text-red-100 p-2 rounded text-sm">
            {errorText}
          </div>
        )}

        {visibleAssignments.length === 0 ? (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 text-gray-300">
            No active storage assignments left in this view.
          </div>
        ) : (
          <div className="space-y-3">
            {visibleAssignments.map((assignment) => {
              const rows = ptRowsByAssignmentId[assignment.id] || [];
              const isExpanded = expandedAssignmentIds.has(assignment.id);
              const isLoadingRows = loadingAssignmentIds.includes(assignment.id);

              return (
                <div key={assignment.id} className="bg-gray-900 border border-gray-700 rounded-lg p-3 md:p-4">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="bg-gray-700 px-3 py-1 rounded-lg text-sm font-semibold">Lane {assignment.lane_number}</span>
                      <span className="bg-blue-800 px-3 py-1 rounded-lg text-sm font-semibold">Container {assignment.container_number}</span>
                      <span className="bg-purple-800 px-3 py-1 rounded-lg text-sm font-semibold">{assignment.customer}</span>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => toggleAssignmentDropdown(assignment)}
                        className="bg-gray-700 hover:bg-gray-600 px-3 py-1.5 rounded font-semibold text-sm"
                      >
                        {isExpanded ? 'Hide PTs' : 'Show PTs'}
                      </button>
                      <button
                        onClick={() => requestLaneOrganize(assignment)}
                        disabled={isActionDisabled(assignment.id)}
                        className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-sm"
                      >
                        {markingAssignmentId === assignment.id ? 'Saving...' : 'Organized to Label'}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-3 border-t border-gray-700 pt-3">
                      {isLoadingRows ? (
                        <div className="text-gray-300">Loading PTs...</div>
                      ) : rows.length === 0 ? (
                        <div className="text-gray-300">No PT rows found for this container/customer.</div>
                      ) : (
                        <div className="space-y-2">
                          {rows.map((pt) => (
                            <div key={pt.id} className="bg-gray-800 border border-gray-700 rounded p-2 md:p-3 flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="font-bold text-sm md:text-base break-all">PT #{pt.pt_number} | PO {pt.po_number}</div>
                                <div className="text-xs md:text-sm text-gray-300 break-all">
                                  {pt.customer} | Lane {pt.assigned_lane || 'Unassigned'} | {pt.actual_pallet_count || 0}p
                                </div>
                              </div>
                              <button
                                onClick={() => setSelectedPTDetails(pt)}
                                className="bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded font-semibold text-xs md:text-sm"
                              >
                                Details
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {selectedPTDetails && (
        <PTDetails
          pt={selectedPTDetails}
          onClose={() => setSelectedPTDetails(null)}
        />
      )}

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
}
