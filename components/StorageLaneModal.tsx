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
  readOnly?: boolean;
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

interface UrgencyMeta {
  label: string;
  badgeClass: string;
  detail: string;
  detailClass: string;
  order: number;
}

interface UrgencyOverviewItem {
  label: string;
  count: number;
  badgeClass: string;
  order: number;
}

type UrgencyOverviewRow = Pick<Pickticket, 'status' | 'pu_number' | 'pu_date' | 'start_date' | 'cancel_date'>;

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

function parseFlexibleDate(value?: string | null): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const usMatch = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (usMatch) {
    const month = Number(usMatch[1]);
    const day = Number(usMatch[2]);
    const yearPart = usMatch[3];
    const year = yearPart
      ? (yearPart.length === 2 ? 2000 + Number(yearPart) : Number(yearPart))
      : new Date().getFullYear();
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysUntilDate(date: Date | null): number | null {
  if (!date) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

function daysSinceDate(date: Date | null): number | null {
  if (!date) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.floor((now.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
}

function normalizeStatus(status?: string | null) {
  const normalized = (status || '').trim().toLowerCase();
  return normalized || 'unlabeled';
}

function statusBadgeMeta(status: string): UrgencyMeta | null {
  switch (status) {
    case 'labeled':
      return {
        label: 'Labeled',
        badgeClass: 'bg-yellow-600 text-yellow-50 border border-yellow-300',
        detail: 'Status: Labeled',
        detailClass: 'text-yellow-300 text-[10px] md:text-xs',
        order: 90
      };
    case 'staged':
      return {
        label: 'Staged',
        badgeClass: 'bg-blue-700 text-white border border-blue-300',
        detail: 'Status: Staged',
        detailClass: 'text-blue-300 text-[10px] md:text-xs',
        order: 91
      };
    case 'ready_to_ship':
      return {
        label: 'Ready to Ship',
        badgeClass: 'bg-green-700 text-white border border-green-300',
        detail: 'Status: Ready to Ship',
        detailClass: 'text-green-300 text-[10px] md:text-xs',
        order: 92
      };
    case 'shipped':
      return {
        label: 'Shipped',
        badgeClass: 'bg-emerald-700 text-white border border-emerald-300',
        detail: 'Status: Shipped',
        detailClass: 'text-emerald-300 text-[10px] md:text-xs',
        order: 93
      };
    default:
      return null;
  }
}

function getUrgencyMeta(pt: UrgencyOverviewRow): UrgencyMeta {
  const workflowMeta = statusBadgeMeta(normalizeStatus(pt.status));
  if (workflowMeta) return workflowMeta;

  const hasPuUrgent = Boolean(pt.pu_number && pt.pu_date);
  const cancelDate = parseFlexibleDate(pt.cancel_date);
  const startDate = parseFlexibleDate(pt.start_date);
  const daysUntilCancel = daysUntilDate(cancelDate);
  const daysSinceStart = daysSinceDate(startDate);

  if (hasPuUrgent) {
    return {
      label: 'URGENT',
      badgeClass: 'bg-red-700 text-white border border-red-300 text-xs md:text-sm font-extrabold',
      detail: `PU #${pt.pu_number} • ${pt.pu_date}`,
      detailClass: 'text-red-300 text-[10px] md:text-xs font-semibold',
      order: 0
    };
  }

  if (daysUntilCancel !== null) {
    if (daysUntilCancel <= 0) {
      return {
        label: 'Critical',
        badgeClass: 'bg-red-700 text-white border border-red-300',
        detail: `Days until cancel: ${daysUntilCancel}`,
        detailClass: 'text-red-300 text-[10px] md:text-xs',
        order: 1
      };
    }
    if (daysUntilCancel <= 2) {
      return {
        label: 'Rush',
        badgeClass: 'bg-red-600 text-white border border-red-300',
        detail: `Days until cancel: ${daysUntilCancel}`,
        detailClass: 'text-red-300 text-[10px] md:text-xs',
        order: 2
      };
    }
    if (daysUntilCancel <= 5) {
      return {
        label: 'Soon',
        badgeClass: 'bg-orange-600 text-white border border-orange-300',
        detail: `Days until cancel: ${daysUntilCancel}`,
        detailClass: 'text-orange-300 text-[10px] md:text-xs',
        order: 3
      };
    }
    if (daysUntilCancel <= 10) {
      return {
        label: 'Watch',
        badgeClass: 'bg-yellow-600 text-yellow-100 border border-yellow-300',
        detail: `Days until cancel: ${daysUntilCancel}`,
        detailClass: 'text-yellow-300 text-[10px] md:text-xs',
        order: 4
      };
    }
  }

  const neutralDetailPieces: string[] = [];
  neutralDetailPieces.push(daysUntilCancel === null ? 'Days until cancel: N/A' : `Days until cancel: ${daysUntilCancel}`);
  if (daysSinceStart !== null) neutralDetailPieces.push(`Start +${daysSinceStart}d`);

  return {
    label: 'Normal',
    badgeClass: 'bg-gray-600 text-white border border-gray-400',
    detail: neutralDetailPieces.join(' • '),
    detailClass: 'text-gray-300 text-[10px] md:text-xs',
    order: 5
  };
}

function buildUrgencyOverview(rows: UrgencyOverviewRow[]): UrgencyOverviewItem[] {
  const overviewMap = new Map<string, UrgencyOverviewItem>();

  rows.forEach((row) => {
    const meta = getUrgencyMeta(row);
    const existing = overviewMap.get(meta.label);
    if (existing) {
      existing.count += 1;
      return;
    }

    overviewMap.set(meta.label, {
      label: meta.label,
      count: 1,
      badgeClass: meta.badgeClass,
      order: meta.order
    });
  });

  return Array.from(overviewMap.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export default function StorageLaneModal({ mode, title, assignments, readOnly = false, onClose, onUpdated }: StorageLaneModalProps) {
  const [localAssignments, setLocalAssignments] = useState<StorageAssignment[]>(assignments);
  const [selectedLane, setSelectedLane] = useState<string | null>(null);
  const [expandedAssignmentIds, setExpandedAssignmentIds] = useState<Set<number>>(new Set());
  const [ptRowsByAssignmentId, setPtRowsByAssignmentId] = useState<Record<number, Pickticket[]>>({});
  const [loadingAssignmentIds, setLoadingAssignmentIds] = useState<number[]>([]);
  const [urgencyOverviewByAssignmentId, setUrgencyOverviewByAssignmentId] = useState<Record<number, UrgencyOverviewItem[]>>({});
  const [loadingOverviewIds, setLoadingOverviewIds] = useState<number[]>([]);
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

  useEffect(() => {
    const assignmentsNeedingOverview = visibleAssignments.filter(
      (assignment) => !urgencyOverviewByAssignmentId[assignment.id] && !loadingOverviewIds.includes(assignment.id)
    );

    assignmentsNeedingOverview.forEach((assignment) => {
      void fetchUrgencyOverviewForAssignment(assignment);
    });
  }, [visibleAssignments, urgencyOverviewByAssignmentId, loadingOverviewIds]);

  async function fetchUrgencyOverviewForAssignment(assignment: StorageAssignment) {
    setLoadingOverviewIds((prev) => (prev.includes(assignment.id) ? prev : [...prev, assignment.id]));

    try {
      const { data, error } = await supabase
        .from('picktickets')
        .select('status, pu_number, pu_date, start_date, cancel_date')
        .eq('container_number', assignment.container_number)
        .eq('customer', assignment.customer);

      if (error) {
        setErrorText(`Failed to load urgency overview. ${describeSupabaseError(error)}`);
        return;
      }

      const rows = (data || []) as UrgencyOverviewRow[];
      setUrgencyOverviewByAssignmentId((prev) => ({
        ...prev,
        [assignment.id]: buildUrgencyOverview(rows)
      }));
    } catch (error) {
      console.error('Failed to load storage urgency overview:', error);
      setErrorText('Failed to load urgency overview for this assignment.');
    } finally {
      setLoadingOverviewIds((prev) => prev.filter((id) => id !== assignment.id));
    }
  }

  async function fetchPTsForAssignment(assignment: StorageAssignment) {
    setLoadingAssignmentIds((prev) => (prev.includes(assignment.id) ? prev : [...prev, assignment.id]));
    setErrorText('');

    try {
      const { data, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, container_number, assigned_lane, store_dc, start_date, cancel_date, actual_pallet_count, ctn, status, pu_number, pu_date, qty, last_synced_at, compiled_pallet_id')
        .eq('container_number', assignment.container_number)
        .eq('customer', assignment.customer)
        .order('pt_number');

      if (error) {
        setErrorText(`Failed to load PTs. ${describeSupabaseError(error)}`);
        return;
      }

      const rows = (data || []) as Pickticket[];
      setPtRowsByAssignmentId((prev) => ({ ...prev, [assignment.id]: rows }));
      setUrgencyOverviewByAssignmentId((prev) => (
        prev[assignment.id]
          ? prev
          : { ...prev, [assignment.id]: buildUrgencyOverview(rows) }
      ));
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
      setUrgencyOverviewByAssignmentId((prev) => {
        const next = { ...prev };
        assignmentIds.forEach((id) => {
          delete next[id];
        });
        return next;
      });
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

        {mode === 'group' && localAssignments.length > 0 && !readOnly && (
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
              const isLoadingOverview = loadingOverviewIds.includes(assignment.id);
              const urgencyOverview = urgencyOverviewByAssignmentId[assignment.id] || [];

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
                      {!readOnly && (
                        <button
                          onClick={() => requestLaneOrganize(assignment)}
                          disabled={isActionDisabled(assignment.id)}
                          className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-sm"
                        >
                          {markingAssignmentId === assignment.id ? 'Saving...' : 'Organized to Label'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-2">
                    {isLoadingOverview ? (
                      <div className="text-[11px] md:text-xs text-gray-400">Calculating urgency overview...</div>
                    ) : urgencyOverview.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {urgencyOverview.map((overview) => (
                          <span
                            key={`${assignment.id}-${overview.label}`}
                            className={`px-2 py-0.5 rounded text-[11px] md:text-xs font-bold ${overview.badgeClass}`}
                          >
                            {overview.label}: {overview.count}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] md:text-xs text-gray-400">No PT urgency data.</div>
                    )}
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
                                {(() => {
                                  const urgency = getUrgencyMeta(pt);
                                  return (
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                      <span className={`px-2 py-0.5 rounded font-bold ${urgency.badgeClass}`}>
                                        {urgency.label}
                                      </span>
                                      <span className={urgency.detailClass}>
                                        {urgency.detail}
                                      </span>
                                    </div>
                                  );
                                })()}
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
