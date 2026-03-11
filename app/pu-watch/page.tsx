'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { useRealtimeCoordinator } from '@/components/RealtimeProvider';
import PTDetails from '@/components/PTDetails';
import { Pickticket } from '@/types/pickticket';

const PU_WATCH_FALLBACK_FULL_SYNC_MS = 180000;
const FETCH_PAGE_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PuWatchRow {
  id: number;
  pt_number: string | null;
  po_number: string | null;
  customer: string | null;
  container_number: string | null;
  pu_number: string | null;
  pu_date: string | null;
  status: string | null;
  last_synced_at: string | null;
}

interface UrgencyInfo {
  order: number;
  label: string;
  badgeClass: string;
  daysUntil: number | null;
}

interface PuWatchItem {
  id: number;
  ptNumber: string;
  poNumber: string;
  customer: string;
  containerNumber: string;
  puNumber: string;
  puDate: string;
  urgency: UrgencyInfo;
}

interface ContainerGroup {
  containerNumber: string;
  items: PuWatchItem[];
  topUrgency: UrgencyInfo;
  summary: ContainerSummary;
}

interface ContainerSummary {
  totalPts: number;
  uniquePuCount: number;
  overdueCount: number;
  dueTodayCount: number;
  dueTomorrowCount: number;
  dueSoonCount: number;
  unknownDateCount: number;
  nextDueLabel: string;
}

interface AgeBreakdownRow {
  key: string;
  label: string;
  count: number;
  badgeClass: string;
  daysUntil: number | null;
}

interface ActiveContainerBreakdown {
  containerNumber: string;
  metric: 'pt' | 'pu';
}

type ContainerSortKey = 'ptNumber' | 'customer' | 'loadId' | 'puDate';
type SortDirection = 'asc' | 'desc';

interface ContainerSortState {
  key: ContainerSortKey;
  direction: SortDirection;
}

const CONTAINER_SORT_OPTIONS: Array<{ key: ContainerSortKey; label: string }> = [
  { key: 'ptNumber', label: 'PT #' },
  { key: 'customer', label: 'Customer' },
  { key: 'loadId', label: 'Load ID' },
  { key: 'puDate', label: 'PU Date' }
];

const NEUTRAL_CHIP_CLASS = 'px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold ring-1 ring-inset ring-slate-600/70 bg-slate-800/80 text-slate-200';
const OVERDUE_CHIP_CLASS = 'px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold ring-1 ring-inset ring-rose-700/60 bg-rose-950/40 text-rose-200';
const TODAY_CHIP_CLASS = 'px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold ring-1 ring-inset ring-rose-600/60 bg-rose-900/35 text-rose-100';
const TOMORROW_CHIP_CLASS = 'px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold ring-1 ring-inset ring-amber-700/60 bg-amber-950/40 text-amber-200';
const UNKNOWN_DATE_CHIP_CLASS = 'px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold ring-1 ring-inset ring-slate-500/70 bg-slate-900/80 text-slate-300';

function asTrimmedText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isUnlabeledStatus(status: unknown): boolean {
  const normalized = asTrimmedText(status).toLowerCase();
  return normalized === '' || normalized === 'unlabeled';
}

function parsePuDate(value: string): Date | null {
  const normalized = asTrimmedText(value);
  if (!normalized) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const [yText, mText, dText] = normalized.split('-');
    const year = Number.parseInt(yText, 10);
    const month = Number.parseInt(mText, 10);
    const day = Number.parseInt(dText, 10);
    const parsed = new Date(year, month - 1, day);

    if (
      parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day
    ) {
      return parsed;
    }
    return null;
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getDaysUntil(puDate: string): number | null {
  const parsed = parsePuDate(puDate);
  if (!parsed) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((parsed.getTime() - today.getTime()) / DAY_MS);
}

function getUrgencyOrder(daysUntil: number | null): number {
  if (daysUntil === null) return 6;
  if (daysUntil < 0) return 0;
  if (daysUntil === 0) return 1;
  if (daysUntil === 1) return 2;
  if (daysUntil <= 3) return 3;
  if (daysUntil <= 7) return 4;
  return 5;
}

function getUrgencyLabel(daysUntil: number | null): string {
  if (daysUntil === null) return 'Unknown';
  if (daysUntil < 0) return `Overdue ${Math.abs(daysUntil)}d`;
  if (daysUntil === 0) return 'Due Today';
  if (daysUntil === 1) return 'Due Tomorrow';
  return `Due in ${daysUntil}d`;
}

function getUrgencyBadgeClass(daysUntil: number | null): string {
  if (daysUntil === null) return 'bg-slate-800/80 text-slate-200 ring-1 ring-inset ring-slate-600/70';
  if (daysUntil < 0) return 'bg-rose-950/40 text-rose-200 ring-1 ring-inset ring-rose-700/60';
  if (daysUntil === 0) return 'bg-rose-900/35 text-rose-100 ring-1 ring-inset ring-rose-600/60';
  if (daysUntil === 1) return 'bg-amber-950/40 text-amber-200 ring-1 ring-inset ring-amber-700/60';
  if (daysUntil <= 3) return 'bg-amber-950/30 text-amber-300 ring-1 ring-inset ring-amber-700/50';
  if (daysUntil <= 7) return 'bg-sky-800/55 text-sky-50 ring-1 ring-inset ring-sky-500/70';
  return 'bg-slate-900/80 text-slate-200 ring-1 ring-inset ring-slate-600/70';
}

function getUrgencyInfo(puDate: string): UrgencyInfo {
  const daysUntil = getDaysUntil(puDate);
  return {
    order: getUrgencyOrder(daysUntil),
    label: getUrgencyLabel(daysUntil),
    badgeClass: getUrgencyBadgeClass(daysUntil),
    daysUntil: daysUntil ?? null
  };
}

function formatPuDate(puDate: string): string {
  const parsed = parsePuDate(puDate);
  if (!parsed) return puDate || 'N/A';
  return parsed.toLocaleDateString();
}

function formatLatestSync(value: string | null): string {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function compareContainers(a: string, b: string): number {
  return compareText(a, b);
}

function getContainerBorderClass(urgency: UrgencyInfo): string {
  if (urgency.order <= 1) return 'border-rose-700/70';
  if (urgency.order === 2) return 'border-amber-700/70';
  if (urgency.order === 3) return 'border-amber-800/70';
  if (urgency.order === 4) return 'border-sky-500/75';
  return 'border-slate-700/80';
}

function buildAgeBreakdown(values: Array<number | null>): AgeBreakdownRow[] {
  const byDaysKey = new Map<string, { daysUntil: number | null; count: number }>();

  values.forEach((daysUntil) => {
    const key = daysUntil === null ? 'unknown' : String(daysUntil);
    const current = byDaysKey.get(key) || { daysUntil, count: 0 };
    current.count += 1;
    byDaysKey.set(key, current);
  });

  return Array.from(byDaysKey.entries())
    .map(([key, value]) => ({
      key,
      daysUntil: value.daysUntil,
      count: value.count,
      label: getUrgencyLabel(value.daysUntil),
      badgeClass: getUrgencyBadgeClass(value.daysUntil)
    }))
    .sort((a, b) => {
      if (a.daysUntil === null && b.daysUntil === null) return 0;
      if (a.daysUntil === null) return 1;
      if (b.daysUntil === null) return -1;
      return a.daysUntil - b.daysUntil;
    });
}

function buildUniquePuAgeBreakdown(items: PuWatchItem[]): AgeBreakdownRow[] {
  const byPuNumber = new Map<string, number | null>();

  items.forEach((item) => {
    const puNumber = asTrimmedText(item.puNumber);
    if (!puNumber || puNumber === 'N/A') return;

    const daysUntil = item.urgency.daysUntil;
    if (!byPuNumber.has(puNumber)) {
      byPuNumber.set(puNumber, daysUntil);
      return;
    }

    const previousDaysUntil = byPuNumber.get(puNumber);
    if (previousDaysUntil === undefined) {
      byPuNumber.set(puNumber, daysUntil);
      return;
    }
    if (previousDaysUntil === null) {
      if (daysUntil !== null) {
        byPuNumber.set(puNumber, daysUntil);
      }
      return;
    }

    if (daysUntil === null) return;
    if (daysUntil < previousDaysUntil) {
      byPuNumber.set(puNumber, daysUntil);
    }
  });

  return buildAgeBreakdown(Array.from(byPuNumber.values()));
}

function compareByContainerSort(a: PuWatchItem, b: PuWatchItem, key: ContainerSortKey): number {
  if (key === 'ptNumber') {
    return compareText(a.ptNumber, b.ptNumber);
  }

  if (key === 'customer') {
    return compareText(a.customer, b.customer);
  }

  if (key === 'loadId') {
    return compareText(a.puNumber, b.puNumber);
  }

  const aDate = parsePuDate(a.puDate);
  const bDate = parsePuDate(b.puDate);
  const aTime = aDate ? aDate.getTime() : null;
  const bTime = bDate ? bDate.getTime() : null;

  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return aTime - bTime;
  }

  if (aTime === null && bTime !== null) return 1;
  if (aTime !== null && bTime === null) return -1;
  return compareText(a.puDate, b.puDate);
}

function sortContainerItems(items: PuWatchItem[], sortState?: ContainerSortState): PuWatchItem[] {
  if (!sortState) return items;
  const direction = sortState.direction === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    const primary = compareByContainerSort(a, b, sortState.key);
    if (primary !== 0) return primary * direction;
    return compareText(a.ptNumber, b.ptNumber);
  });
}

async function fetchRowsForSyncTimestamp(lastSyncedAt: string): Promise<PuWatchRow[]> {
  const rows: PuWatchRow[] = [];
  let from = 0;

  while (true) {
    const to = from + FETCH_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('picktickets')
      .select('id, pt_number, po_number, customer, container_number, pu_number, pu_date, status, last_synced_at')
      .eq('last_synced_at', lastSyncedAt)
      .not('pu_date', 'is', null)
      .range(from, to);

    if (error) throw error;

    const batch = (data || []) as PuWatchRow[];
    rows.push(...batch);
    if (batch.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }

  return rows;
}

export default function PuWatchPage() {
  const { health: realtimeHealth, subscribeScope } = useRealtimeCoordinator();
  const [items, setItems] = useState<PuWatchItem[]>([]);
  const [activeSummaryBreakdown, setActiveSummaryBreakdown] = useState<'containers' | 'ptRows' | null>(null);
  const [activeContainerBreakdown, setActiveContainerBreakdown] = useState<ActiveContainerBreakdown | null>(null);
  const [viewingPTDetails, setViewingPTDetails] = useState<Pickticket | null>(null);
  const [detailsLoadingId, setDetailsLoadingId] = useState<number | null>(null);
  const [lastSyncIso, setLastSyncIso] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [containerSortById, setContainerSortById] = useState<Record<string, ContainerSortState>>({});
  const fetchInFlightRef = useRef(false);
  const fetchQueuedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const expansionInitializedRef = useRef(false);
  const detailsCacheRef = useRef<Map<number, Pickticket>>(new Map());
  const refreshTimerRef = useRef<number | null>(null);
  const pendingVisibleRefreshRef = useRef(false);
  const fetchRowsRef = useRef<() => Promise<void>>(async () => { });

  const fetchRows = useCallback(async () => {
    if (fetchInFlightRef.current) {
      fetchQueuedRef.current = true;
      return;
    }

    fetchInFlightRef.current = true;
    if (!hasLoadedRef.current) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      setErrorText('');

      const { data: latestSyncRow, error: latestSyncError } = await supabase
        .from('picktickets')
        .select('last_synced_at')
        .not('last_synced_at', 'is', null)
        .order('last_synced_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestSyncError) {
        throw latestSyncError;
      }

      const latestSync = asTrimmedText(latestSyncRow?.last_synced_at);
      setLastSyncIso(latestSync || null);

      if (!latestSync) {
        setItems([]);
        setLastFetchedAt(new Date());
        return;
      }

      const rows = await fetchRowsForSyncTimestamp(latestSync);
      const filteredItems: PuWatchItem[] = rows
        .filter((row) => isUnlabeledStatus(row.status) && asTrimmedText(row.pu_date).length > 0)
        .map((row) => {
          const ptNumber = asTrimmedText(row.pt_number) || `PT-${row.id}`;
          const poNumber = asTrimmedText(row.po_number);
          const customer = asTrimmedText(row.customer) || 'N/A';
          const containerNumber = asTrimmedText(row.container_number) || 'NO CONTAINER';
          const puNumber = asTrimmedText(row.pu_number) || 'N/A';
          const puDate = asTrimmedText(row.pu_date);

          return {
            id: row.id,
            ptNumber,
            poNumber: poNumber || 'N/A',
            customer,
            containerNumber,
            puNumber,
            puDate,
            urgency: getUrgencyInfo(puDate)
          };
        });

      setItems(filteredItems);
      setLastFetchedAt(new Date());
    } catch (error) {
      console.error('Failed to load PU watch data:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      setErrorText(`Failed to load PU watch data. ${message}`);
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
      setRefreshing(false);
      fetchInFlightRef.current = false;

      if (fetchQueuedRef.current) {
        fetchQueuedRef.current = false;
        void fetchRowsRef.current();
      }
    }
  }, []);

  fetchRowsRef.current = fetchRows;

  const scheduleRefresh = useCallback(() => {
    if (document.hidden) {
      pendingVisibleRefreshRef.current = true;
      return;
    }

    if (refreshTimerRef.current) {
      window.clearTimeout(refreshTimerRef.current);
    }

    refreshTimerRef.current = window.setTimeout(() => {
      void fetchRowsRef.current();
      refreshTimerRef.current = null;
    }, 450);
  }, []);

  useEffect(() => {
    void fetchRowsRef.current();
    return () => {
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!pendingVisibleRefreshRef.current) return;
      pendingVisibleRefreshRef.current = false;
      void fetchRowsRef.current();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!activeSummaryBreakdown && !activeContainerBreakdown) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const targetNode = event.target as Node | null;
      if (!targetNode) return;
      const targetElement = targetNode instanceof Element ? targetNode : null;
      if (targetElement?.closest('[data-summary-breakdown-root]')) return;
      if (targetElement?.closest('[data-container-breakdown-root]')) return;
      setActiveSummaryBreakdown(null);
      setActiveContainerBreakdown(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveSummaryBreakdown(null);
        setActiveContainerBreakdown(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [activeSummaryBreakdown, activeContainerBreakdown]);

  useEffect(() => {
    const unsubscribeShipments = subscribeScope('shipments', (payload) => {
      const source = asTrimmedText(payload.source).toLowerCase();
      if (source === 'picktickets') {
        const rawPtId = payload.ptId;
        const numericPtId = typeof rawPtId === 'number' ? rawPtId : Number.parseInt(asTrimmedText(rawPtId), 10);
        if (Number.isFinite(numericPtId)) {
          const eventType = asTrimmedText(payload.eventType).toLowerCase();
          if (eventType === 'delete') {
            setItems((previous) => previous.filter((item) => item.id !== numericPtId));
          } else {
            const status = payload.status;
            const puDate = asTrimmedText(payload.puDate);
            const eventSync = asTrimmedText(payload.lastSyncedAt);
            const inLatestSync = !lastSyncIso || !eventSync || eventSync === lastSyncIso;
            const keepVisible = inLatestSync && isUnlabeledStatus(status) && puDate.length > 0;
            if (!keepVisible) {
              setItems((previous) => previous.filter((item) => item.id !== numericPtId));
            }
          }
        }
      }

      scheduleRefresh();
    });

    const unsubscribeLaneGrid = subscribeScope('lane-grid', () => {
      // Lane assignment moves can affect unlabeled/labeled visibility even if a pickticket
      // row event is delayed or coalesced, so always schedule a lightweight refresh.
      scheduleRefresh();
    });

    return () => {
      unsubscribeShipments();
      unsubscribeLaneGrid();
    };
  }, [lastSyncIso, scheduleRefresh, subscribeScope]);

  useEffect(() => {
    if (realtimeHealth !== 'disconnected') return;
    if (document.hidden) return;
    void fetchRowsRef.current();
  }, [realtimeHealth]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void fetchRowsRef.current();
    }, PU_WATCH_FALLBACK_FULL_SYNC_MS);

    return () => window.clearInterval(timer);
  }, []);

  const containerGroups = useMemo<ContainerGroup[]>(() => {
    const grouped = new Map<string, PuWatchItem[]>();

    items.forEach((item) => {
      const key = item.containerNumber;
      const current = grouped.get(key) || [];
      current.push(item);
      grouped.set(key, current);
    });

      const groups = Array.from(grouped.entries()).map(([containerNumber, groupedItems]) => {
      const sortedItems = [...groupedItems].sort((a, b) => {
        if (a.urgency.order !== b.urgency.order) {
          return a.urgency.order - b.urgency.order;
        }

        const aDays = a.urgency.daysUntil;
        const bDays = b.urgency.daysUntil;
        if (aDays !== null && bDays !== null && aDays !== bDays) {
          return aDays - bDays;
        }
        if (aDays === null && bDays !== null) return 1;
        if (aDays !== null && bDays === null) return -1;
        return compareText(a.ptNumber, b.ptNumber);
      });

      const uniquePuCount = new Set(
        sortedItems
          .map((item) => item.puNumber)
          .filter((value) => value && value !== 'N/A')
      ).size;

      let overdueCount = 0;
      let dueTodayCount = 0;
      let dueTomorrowCount = 0;
      let dueSoonCount = 0;
      let unknownDateCount = 0;
      let soonestDueDays: number | null = null;
      let soonestDueLabel = '';

      sortedItems.forEach((item) => {
        const daysUntil = item.urgency.daysUntil;
        if (daysUntil === null) {
          unknownDateCount += 1;
          return;
        }
        if (daysUntil < 0) overdueCount += 1;
        if (daysUntil === 0) dueTodayCount += 1;
        if (daysUntil === 1) dueTomorrowCount += 1;
        if (daysUntil <= 2) dueSoonCount += 1;
        if (soonestDueDays === null || daysUntil < soonestDueDays) {
          soonestDueDays = daysUntil;
          soonestDueLabel = `${formatPuDate(item.puDate)} • ${item.urgency.label}`;
        }
      });

      const nextDueLabel = soonestDueLabel
        ? soonestDueLabel
        : unknownDateCount > 0
          ? 'Unknown date format present'
          : 'N/A';

      return {
        containerNumber,
        items: sortedItems,
        topUrgency: sortedItems[0]?.urgency || getUrgencyInfo(''),
        summary: {
          totalPts: sortedItems.length,
          uniquePuCount,
          overdueCount,
          dueTodayCount,
          dueTomorrowCount,
          dueSoonCount,
          unknownDateCount,
          nextDueLabel
        }
      };
    });

    groups.sort((a, b) => {
      if (a.topUrgency.order !== b.topUrgency.order) {
        return a.topUrgency.order - b.topUrgency.order;
      }
      const aDays = a.topUrgency.daysUntil;
      const bDays = b.topUrgency.daysUntil;
      if (aDays !== null && bDays !== null && aDays !== bDays) {
        return aDays - bDays;
      }
      if (aDays === null && bDays !== null) return 1;
      if (aDays !== null && bDays === null) return -1;
      return compareContainers(a.containerNumber, b.containerNumber);
    });

    return groups;
  }, [items]);

  useEffect(() => {
    setExpandedContainers((previous) => {
      const next = new Set<string>();

      containerGroups.forEach((group) => {
        if (previous.has(group.containerNumber)) {
          next.add(group.containerNumber);
          return;
        }

        // Auto-expand urgent containers only on first load for quick triage.
        if (!expansionInitializedRef.current) {
          if (group.summary.overdueCount > 0 || group.summary.dueSoonCount > 0) {
            next.add(group.containerNumber);
          }
        }
      });

      return next;
    });

    if (!expansionInitializedRef.current) {
      expansionInitializedRef.current = true;
    }
  }, [containerGroups]);

  useEffect(() => {
    setContainerSortById((previous) => {
      const activeContainerSet = new Set(containerGroups.map((group) => group.containerNumber));
      let changed = false;
      const next: Record<string, ContainerSortState> = {};

      Object.entries(previous).forEach(([containerNumber, sortState]) => {
        if (activeContainerSet.has(containerNumber)) {
          next[containerNumber] = sortState;
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [containerGroups]);

  useEffect(() => {
    if (!activeContainerBreakdown) return;
    const exists = containerGroups.some((group) => group.containerNumber === activeContainerBreakdown.containerNumber);
    if (!exists) {
      setActiveContainerBreakdown(null);
    }
  }, [activeContainerBreakdown, containerGroups]);

  const allExpanded = containerGroups.length > 0 && containerGroups.every((group) => expandedContainers.has(group.containerNumber));

  function cycleContainerSort(containerNumber: string, key: ContainerSortKey) {
    setContainerSortById((previous) => {
      const current = previous[containerNumber];
      const next = { ...previous };

      if (!current || current.key !== key) {
        next[containerNumber] = { key, direction: 'asc' };
        return next;
      }

      if (current.direction === 'asc') {
        next[containerNumber] = { key, direction: 'desc' };
        return next;
      }

      delete next[containerNumber];
      return next;
    });
  }

  function toggleContainer(containerNumber: string) {
    setExpandedContainers((previous) => {
      const next = new Set(previous);
      if (next.has(containerNumber)) {
        next.delete(containerNumber);
      } else {
        next.add(containerNumber);
      }
      return next;
    });
  }

  function expandAllContainers() {
    setExpandedContainers(new Set(containerGroups.map((group) => group.containerNumber)));
  }

  function collapseAllContainers() {
    setExpandedContainers(new Set());
  }

  async function openPTDetailsById(ptId: number) {
    const cached = detailsCacheRef.current.get(ptId);
    if (cached) {
      setViewingPTDetails(cached);
      return;
    }

    setDetailsLoadingId(ptId);
    try {
      const { data, error } = await supabase
        .from('picktickets')
        .select('*')
        .eq('id', ptId)
        .maybeSingle();

      if (error || !data) {
        setErrorText(error?.message || `PT ${ptId} not found.`);
        return;
      }

      const typed = data as Pickticket;
      detailsCacheRef.current.set(ptId, typed);
      setViewingPTDetails(typed);
      setErrorText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setErrorText(`Failed to load PT details. ${message}`);
    } finally {
      setDetailsLoadingId((previous) => (previous === ptId ? null : previous));
    }
  }

  const overdueCount = useMemo(
    () => items.filter((item) => item.urgency.daysUntil !== null && item.urgency.daysUntil < 0).length,
    [items]
  );

  const dueSoonCount = useMemo(
    () => items.filter((item) => item.urgency.daysUntil !== null && item.urgency.daysUntil >= 0 && item.urgency.daysUntil <= 2).length,
    [items]
  );

  const containerAgeBreakdown = useMemo(
    () => buildAgeBreakdown(containerGroups.map((group) => group.topUrgency.daysUntil)),
    [containerGroups]
  );

  const ptAgeBreakdown = useMemo(
    () => buildAgeBreakdown(items.map((item) => item.urgency.daysUntil)),
    [items]
  );

  const containerBreakdownById = useMemo(() => {
    const byContainer = new Map<string, { ptRows: AgeBreakdownRow[]; puRows: AgeBreakdownRow[] }>();

    containerGroups.forEach((group) => {
      byContainer.set(group.containerNumber, {
        ptRows: buildAgeBreakdown(group.items.map((item) => item.urgency.daysUntil)),
        puRows: buildUniquePuAgeBreakdown(group.items)
      });
    });

    return byContainer;
  }, [containerGroups]);

  function toggleSummaryBreakdown(target: 'containers' | 'ptRows') {
    setActiveContainerBreakdown(null);
    setActiveSummaryBreakdown((previous) => (previous === target ? null : target));
  }

  function toggleContainerBreakdown(containerNumber: string, metric: 'pt' | 'pu') {
    setActiveSummaryBreakdown(null);
    setActiveContainerBreakdown((previous) => {
      if (previous?.containerNumber === containerNumber && previous.metric === metric) {
        return null;
      }
      return { containerNumber, metric };
    });
  }

  function renderAgeBreakdownPanel(rows: AgeBreakdownRow[], unitLabel: string) {
    if (rows.length === 0) {
      return (
        <div className="text-xs text-slate-400">
          No rows to break down yet.
        </div>
      );
    }

    return (
      <div className="space-y-1 max-h-56 overflow-y-auto">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-2">
            <span className={`px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold ${row.badgeClass}`}>
              {row.label}
            </span>
            <span className="text-xs md:text-sm font-semibold text-slate-200">
              {row.count} {unitLabel}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl md:text-4xl font-bold">🚚 PU Watch</h1>
            <p className="text-xs md:text-sm text-gray-400 mt-1">
              Latest active-sheet sync only • unlabeled PTs with PU date • grouped by container
            </p>
            <div className="text-xs md:text-sm text-gray-400 mt-2">
              Last sync snapshot: <span className="text-gray-200">{formatLatestSync(lastSyncIso)}</span>
            </div>
            {lastFetchedAt && (
              <div className="text-[11px] md:text-xs text-gray-500 mt-1">
                View refreshed: {lastFetchedAt.toLocaleTimeString()}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void fetchRowsRef.current()}
              disabled={loading || refreshing}
              className="bg-slate-800 border border-cyan-700/60 text-cyan-100 hover:bg-slate-700 disabled:bg-slate-700 disabled:border-slate-600 disabled:text-slate-400 px-4 py-2 rounded-lg font-semibold text-sm md:text-base"
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
            <Link
              href="/"
              className="bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 px-4 py-2 rounded-lg font-semibold text-sm md:text-base"
            >
              ← Back
            </Link>
            <button
              onClick={expandAllContainers}
              disabled={containerGroups.length === 0 || allExpanded}
              className="bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:bg-slate-700 disabled:border-slate-700 disabled:text-slate-500 px-4 py-2 rounded-lg font-semibold text-sm md:text-base"
            >
              Expand All
            </button>
            <button
              onClick={collapseAllContainers}
              disabled={containerGroups.length === 0 || expandedContainers.size === 0}
              className="bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:bg-slate-700 disabled:border-slate-700 disabled:text-slate-500 px-4 py-2 rounded-lg font-semibold text-sm md:text-base"
            >
              Collapse All
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="relative" data-summary-breakdown-root>
            <button
              type="button"
              onClick={() => toggleSummaryBreakdown('containers')}
              className="w-full text-left bg-slate-900/80 border border-slate-700 rounded-lg p-3 hover:bg-slate-800/70 transition-colors"
              aria-expanded={activeSummaryBreakdown === 'containers'}
              aria-label="Toggle containers age breakdown"
            >
              <div className="text-xs text-gray-400 uppercase">Containers</div>
              <div className="text-xl md:text-2xl font-bold">{containerGroups.length}</div>
              <div className="text-[10px] md:text-[11px] text-cyan-300 mt-1">
                Click for day breakdown
              </div>
            </button>
            {activeSummaryBreakdown === 'containers' && (
              <div className="absolute left-0 top-full mt-2 z-30 w-64 max-w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-slate-600 bg-slate-950/95 p-3 shadow-xl">
                <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">
                  By most urgent PU day
                </div>
                {renderAgeBreakdownPanel(containerAgeBreakdown, 'containers')}
              </div>
            )}
          </div>

          <div className="relative" data-summary-breakdown-root>
            <button
              type="button"
              onClick={() => toggleSummaryBreakdown('ptRows')}
              className="w-full text-left bg-slate-900/80 border border-slate-700 rounded-lg p-3 hover:bg-slate-800/70 transition-colors"
              aria-expanded={activeSummaryBreakdown === 'ptRows'}
              aria-label="Toggle PT rows age breakdown"
            >
              <div className="text-xs text-gray-400 uppercase">PT Rows</div>
              <div className="text-xl md:text-2xl font-bold">{items.length}</div>
              <div className="text-[10px] md:text-[11px] text-cyan-300 mt-1">
                Click for day breakdown
              </div>
            </button>
            {activeSummaryBreakdown === 'ptRows' && (
              <div className="absolute left-0 top-full mt-2 z-30 w-64 max-w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-slate-600 bg-slate-950/95 p-3 shadow-xl">
                <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">
                  By PT PU day
                </div>
                {renderAgeBreakdownPanel(ptAgeBreakdown, 'PT')}
              </div>
            )}
          </div>

          <div className="bg-slate-900/80 border border-slate-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 uppercase">Overdue</div>
            <div className="text-xl md:text-2xl font-bold text-rose-300">{overdueCount}</div>
          </div>
          <div className="bg-slate-900/80 border border-slate-700 rounded-lg p-3">
            <div className="text-xs text-gray-400 uppercase">Due 0-2 Days</div>
            <div className="text-xl md:text-2xl font-bold text-amber-300">{dueSoonCount}</div>
          </div>
        </div>

        {errorText && (
          <div className="mb-5 bg-rose-950/40 border border-rose-700/60 text-rose-100 rounded-lg px-4 py-3 text-sm md:text-base">
            {errorText}
          </div>
        )}

        {loading ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-8 text-center text-lg md:text-2xl animate-pulse">
            Loading PU watch...
          </div>
        ) : containerGroups.length === 0 ? (
          <div className="bg-gray-800 border border-gray-700 rounded-lg p-8 text-center">
            <div className="text-lg md:text-2xl font-semibold">No active unlabeled PTs with PU date.</div>
            <div className="text-sm md:text-base text-gray-400 mt-2">
              This view only shows PT rows from the most recent sync snapshot.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {containerGroups.map((group) => {
              const isExpanded = expandedContainers.has(group.containerNumber);
              const sortState = containerSortById[group.containerNumber];
              const visibleItems = sortContainerItems(group.items, sortState);
              const containerBreakdown = containerBreakdownById.get(group.containerNumber);
              const isPtBreakdownOpen =
                activeContainerBreakdown?.containerNumber === group.containerNumber &&
                activeContainerBreakdown.metric === 'pt';
              const isPuBreakdownOpen =
                activeContainerBreakdown?.containerNumber === group.containerNumber &&
                activeContainerBreakdown.metric === 'pu';

              return (
                <div
                  key={group.containerNumber}
                  className={`bg-slate-900/80 border-2 rounded-lg overflow-visible ${getContainerBorderClass(group.topUrgency)}`}
                >
                  <div
                    data-container-breakdown-root
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => {
                      setActiveSummaryBreakdown(null);
                      setActiveContainerBreakdown(null);
                      toggleContainer(group.containerNumber);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setActiveSummaryBreakdown(null);
                        setActiveContainerBreakdown(null);
                        toggleContainer(group.containerNumber);
                      }
                    }}
                    className="w-full px-4 py-3 text-left hover:bg-slate-800/40 transition-colors"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex items-start gap-3 min-w-0">
                        <span className="text-base md:text-lg text-gray-300 pt-0.5">{isExpanded ? '▼' : '▶'}</span>
                        <div className="min-w-0">
                          <div className="text-lg md:text-2xl font-bold truncate">
                            Container #{group.containerNumber}
                          </div>
                          <div className="text-xs md:text-sm text-gray-300 mt-1 truncate">
                            Next due: {group.summary.nextDueLabel}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                        <div className="relative" data-container-breakdown-root>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleContainerBreakdown(group.containerNumber, 'pt');
                            }}
                            className={`${NEUTRAL_CHIP_CLASS} hover:bg-slate-700`}
                            aria-expanded={isPtBreakdownOpen}
                            aria-label={`Toggle PT breakdown for container ${group.containerNumber}`}
                          >
                            {group.summary.totalPts} PT
                          </button>
                          {isPtBreakdownOpen && (
                            <div
                              onClick={(event) => event.stopPropagation()}
                              className="absolute z-30 top-full mt-2 right-0 w-64 max-w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-slate-600 bg-slate-950/95 p-3 shadow-xl"
                            >
                              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">
                                PT day breakdown
                              </div>
                              {renderAgeBreakdownPanel(containerBreakdown?.ptRows || [], 'PT')}
                            </div>
                          )}
                        </div>
                        <div className="relative" data-container-breakdown-root>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleContainerBreakdown(group.containerNumber, 'pu');
                            }}
                            className={`${NEUTRAL_CHIP_CLASS} hover:bg-slate-700`}
                            aria-expanded={isPuBreakdownOpen}
                            aria-label={`Toggle PU breakdown for container ${group.containerNumber}`}
                          >
                            {group.summary.uniquePuCount} PU
                          </button>
                          {isPuBreakdownOpen && (
                            <div
                              onClick={(event) => event.stopPropagation()}
                              className="absolute z-30 top-full mt-2 right-0 w-64 max-w-[min(16rem,calc(100vw-2rem))] rounded-lg border border-slate-600 bg-slate-950/95 p-3 shadow-xl"
                            >
                              <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">
                                PU day breakdown
                              </div>
                              {renderAgeBreakdownPanel(containerBreakdown?.puRows || [], 'PU')}
                            </div>
                          )}
                        </div>
                        {group.summary.overdueCount > 0 && (
                          <span className={OVERDUE_CHIP_CLASS}>
                            {group.summary.overdueCount} overdue
                          </span>
                        )}
                        {group.summary.dueTodayCount > 0 && (
                          <span className={TODAY_CHIP_CLASS}>
                            {group.summary.dueTodayCount} today
                          </span>
                        )}
                        {group.summary.dueTomorrowCount > 0 && (
                          <span className={TOMORROW_CHIP_CLASS}>
                            {group.summary.dueTomorrowCount} tomorrow
                          </span>
                        )}
                        {group.summary.unknownDateCount > 0 && (
                          <span className={UNKNOWN_DATE_CHIP_CLASS}>
                            {group.summary.unknownDateCount} unknown date
                          </span>
                        )}
                        <span className={`px-3 py-1 rounded-full text-xs md:text-sm font-bold ${group.topUrgency.badgeClass}`}>
                          {group.topUrgency.label}
                        </span>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="p-3 md:p-4 space-y-3 border-t border-slate-700">
                      <div className="flex flex-wrap items-center gap-2 pb-2">
                        <span className="text-[11px] md:text-xs text-gray-400 uppercase">Sort</span>
                        {CONTAINER_SORT_OPTIONS.map((option) => {
                          const isActive = sortState?.key === option.key;
                          const directionIcon = isActive
                            ? sortState?.direction === 'asc'
                              ? '↑'
                              : '↓'
                            : '↕';

                          return (
                            <button
                              key={option.key}
                              type="button"
                              onClick={() => cycleContainerSort(group.containerNumber, option.key)}
                              className={`px-2 py-1 rounded-md text-[11px] md:text-xs font-semibold border transition-colors ${
                                isActive
                                  ? 'bg-slate-700 border-cyan-600/70 text-cyan-100 ring-1 ring-cyan-600/40'
                                  : 'bg-slate-900/70 border-slate-700 text-slate-300 hover:bg-slate-800'
                              }`}
                            >
                              {option.label} {directionIcon}
                            </button>
                          );
                        })}
                      </div>

                      {visibleItems.map((item) => (
                        <div key={item.id} className="bg-slate-950/60 border border-slate-700 rounded-lg p-3">
                          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1.6fr_0.9fr_auto_auto_auto] gap-3 md:gap-x-6 md:gap-y-3 md:items-center">
                            <div>
                              <div className="text-[11px] text-gray-400 uppercase">PT #</div>
                              <div className="font-bold text-lg">{item.ptNumber}</div>
                            </div>
                            <div>
                              <div className="text-[11px] text-gray-400 uppercase">PO #</div>
                              <div className="font-semibold">{item.poNumber}</div>
                            </div>
                            <div>
                              <div className="text-[11px] text-gray-400 uppercase">Customer</div>
                              <div className="font-semibold truncate" title={item.customer}>
                                {item.customer}
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] text-gray-400 uppercase">PU #</div>
                              <div className="font-semibold">{item.puNumber}</div>
                            </div>
                            <div className="md:text-right md:min-w-[124px]">
                              <div className="text-[11px] text-gray-400 uppercase">PU Date</div>
                              <div className="font-semibold whitespace-nowrap">{formatPuDate(item.puDate)}</div>
                            </div>
                            <div className="md:min-w-[96px]">
                              <div className="text-[11px] text-gray-400 uppercase">Details</div>
                              <button
                                type="button"
                                onClick={() => void openPTDetailsById(item.id)}
                                disabled={detailsLoadingId === item.id}
                                className="mt-1 min-w-[88px] whitespace-nowrap px-2.5 py-1.5 rounded-md text-[11px] md:text-xs font-semibold border bg-slate-800 border-slate-600 text-slate-100 hover:bg-slate-700 disabled:bg-slate-700 disabled:text-slate-400"
                              >
                                {detailsLoadingId === item.id ? 'Loading...' : 'Details'}
                              </button>
                            </div>
                            <div className="md:text-right md:min-w-[132px]">
                              <div className="text-[11px] text-gray-400 uppercase">Urgency</div>
                              <span className={`inline-block mt-1 px-3 py-1 rounded-full text-xs md:text-sm font-bold ${item.urgency.badgeClass}`}>
                                {item.urgency.label}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {viewingPTDetails && (
        <PTDetails
          pt={viewingPTDetails}
          onClose={() => setViewingPTDetails(null)}
          mostRecentSync={lastSyncIso ? new Date(lastSyncIso) : null}
        />
      )}
    </div>
  );
}
