'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import ShipmentCard, { Shipment } from '@/components/ShipmentCard';
import { isPTArchived } from '@/lib/utils';
import { exportShipmentSummaryPdf, ShipmentPdfLoad } from '@/lib/shipmentPdf';
import { useAuth } from '@/components/AuthProvider';
import { useRealtimeCoordinator } from '@/components/RealtimeProvider';
import ActionToast from '@/components/ActionToast';

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

function shipmentKey(shipment: Shipment) {
  return `${shipment.pu_number}-${shipment.pu_date}`;
}

function cloneShipmentSnapshot(shipment: Shipment): Shipment {
  return JSON.parse(JSON.stringify(shipment)) as Shipment;
}

function describeSupabaseError(error: { code?: string; message?: string; details?: string; hint?: string } | null) {
  if (!error) return 'Unknown Supabase error';
  return [error.code, error.message, error.details, error.hint].filter(Boolean).join(' | ') || 'Unknown Supabase error';
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
  const shipmentRefreshTimerRef = useRef<number | null>(null);
  const shipmentFetchInFlightRef = useRef(false);
  const shipmentFetchQueuedRef = useRef(false);
  const hasLoadedShipmentsRef = useRef(false);
  const includeHistoricalShipmentsRef = useRef(false);
  const staleRefreshRequestedRef = useRef(false);
  const focusedShipmentKeyRef = useRef<string | null>(null);
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

  const refreshShipmentView = useCallback((shipmentKeyToFocus: string, includeStale = false) => {
    focusedShipmentKeyRef.current = shipmentKeyToFocus;
    setExpandedShipmentKey(shipmentKeyToFocus);
    void fetchShipmentsRef.current();
    if (includeStale) {
      void fetchStaleSnapshotsRef.current();
    }
  }, []);

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

  const scheduleShipmentRefresh = useCallback((includeStale = false) => {
    if (includeStale) {
      staleRefreshRequestedRef.current = true;
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
  }, [staleSnapshotStoreAvailable]);

  useEffect(() => {
    const unsubscribe = subscribeScope('shipments', (payload) => {
      scheduleShipmentRefresh(Boolean(payload.includeStale));
    });

    return () => unsubscribe();
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
      snapshotMap[`${row.pu_number}-${row.pu_date}`] = row.snapshot;
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
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date, status, ctn, carrier, last_synced_at')
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
        const key = `${pt.pu_number}-${pt.pu_date}`;
        const isShipped = pt.status === 'shipped';

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: pt.pu_number!,
            pu_date: pt.pu_date!,
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
          last_synced_at: pt.last_synced_at || undefined
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
        const key = `${shipmentRow.pu_number}-${shipmentRow.pu_date}`;
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
          const key = `${shipmentRow.pu_number}-${shipmentRow.pu_date}`;
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

          <div className="flex flex-col md:flex-row gap-2 w-full md:w-auto">
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

      <ActionToast message={ocrToggleToast} type="info" />
    </div>
  );
}
