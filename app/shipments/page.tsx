'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import ShipmentCard, { Shipment } from '@/components/ShipmentCard';
import { isPTArchived } from '@/lib/utils';
import { exportShipmentSummaryPdf, ShipmentPdfLoad } from '@/lib/shipmentPdf';
import { useAuth } from '@/components/AuthProvider';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPPED_TO_ARCHIVED_DAYS = 7;
const HIDE_ARCHIVED_AFTER_DAYS = 21;
const OCR_TOGGLE_STORAGE_KEY = 'shipments_ocr_required';

type ShipmentSnapshotMap = Record<string, Shipment>;
type StaleSnapshotRow = {
  pu_number: string;
  pu_date: string;
  snapshot: Shipment;
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
  const { session, isGuest } = useAuth();
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [mostRecentSync, setMostRecentSync] = useState<Date | null>(null);
  const [expandedShipmentKey, setExpandedShipmentKey] = useState<string | null>(null);
  const [loadSearch, setLoadSearch] = useState('');
  const [searchSelectedShipmentKey, setSearchSelectedShipmentKey] = useState<string | null>(null);
  const [staleSnapshots, setStaleSnapshots] = useState<ShipmentSnapshotMap>({});
  const [staleSnapshotStoreAvailable, setStaleSnapshotStoreAvailable] = useState(true);
  const [requireOCRForStaging, setRequireOCRForStaging] = useState(true);
  const [verifyingOCRTogglePassword, setVerifyingOCRTogglePassword] = useState(false);
  const [ocrToggleToast, setOcrToggleToast] = useState('');
  const shipmentRefreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    fetchMostRecentSync();
    fetchShipments();

    fetchStaleSnapshotsFromSupabase();
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

  const scheduleShipmentRefresh = useCallback(() => {
    if (shipmentRefreshTimerRef.current) {
      window.clearTimeout(shipmentRefreshTimerRef.current);
    }
    shipmentRefreshTimerRef.current = window.setTimeout(() => {
      void fetchMostRecentSync();
      void fetchShipments();
      if (staleSnapshotStoreAvailable) {
        void fetchStaleSnapshotsFromSupabase();
      }
      shipmentRefreshTimerRef.current = null;
    }, 120);
  }, [staleSnapshotStoreAvailable]);

  useEffect(() => {
    const channel = supabase
      .channel('shipments-page-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, scheduleShipmentRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipment_pts' }, scheduleShipmentRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picktickets' }, scheduleShipmentRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stale_shipment_snapshots' }, scheduleShipmentRefresh)
      .subscribe();

    return () => {
      if (shipmentRefreshTimerRef.current) {
        window.clearTimeout(shipmentRefreshTimerRef.current);
        shipmentRefreshTimerRef.current = null;
      }
      void supabase.removeChannel(channel);
    };
  }, [scheduleShipmentRefresh]);

  async function fetchMostRecentSync() {
    const { data } = await supabase
      .from('picktickets')
      .select('last_synced_at')
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .single();

    if (data?.last_synced_at) {
      setMostRecentSync(new Date(data.last_synced_at));
    }
  }

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
    setLoading(true);

    try {
      // Get all PTs with PU numbers from Excel sync
      const { data: pts, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date, status, ctn, carrier, last_synced_at')
        .not('pu_number', 'is', null)
        .not('pu_date', 'is', null)
        .neq('status', 'shipped')
        .neq('customer', 'PAPER');

      if (error) throw error;

      console.log('Found PTs with PU numbers:', pts?.length || 0);

      const groupedShipments: { [key: string]: Shipment } = {};

      // Group PTs by PU number + date
      pts?.forEach(pt => {
        const key = `${pt.pu_number}-${pt.pu_date}`;

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: pt.pu_number!,
            pu_date: pt.pu_date!,
            carrier: pt.carrier || '',
            pts: [],
            staging_lane: null,
            status: 'not_started',
            archived: false,
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
          status: pt.status,
          ctn: pt.ctn,
          last_synced_at: pt.last_synced_at
        });
      });

      // Also get shipped PTs
      const { data: shippedPTs } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date, status, ctn, carrier, last_synced_at')
        .eq('status', 'shipped')
        .not('pu_number', 'is', null)
        .not('pu_date', 'is', null)
        .neq('customer', 'PAPER');

      // Group shipped PTs
      shippedPTs?.forEach(pt => {
        const key = `${pt.pu_number}-${pt.pu_date}`;

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: pt.pu_number!,
            pu_date: pt.pu_date!,
            carrier: pt.carrier || '',
            pts: [],
            staging_lane: null,
            status: 'finalized',
            archived: true,
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
          status: 'shipped',
          ctn: pt.ctn,
          last_synced_at: pt.last_synced_at
        });

        groupedShipments[key].archived = true;
      });

      // Check shipments table for staging info, status and shipped timestamps
      for (const shipment of Object.values(groupedShipments)) {
        const { data: stagingData } = await supabase
          .from('shipments')
          .select('staging_lane, status, carrier, id, archived, updated_at, created_at')
          .eq('pu_number', shipment.pu_number)
          .eq('pu_date', shipment.pu_date)
          .maybeSingle();

        if (stagingData) {
          shipment.staging_lane = stagingData.staging_lane;
          shipment.status = stagingData.status;
          shipment.carrier = stagingData.carrier || shipment.carrier;
          shipment.archived = stagingData.archived || false;
          shipment.shipped_at = stagingData.updated_at || stagingData.created_at || null;

          const { data: movedPTs } = await supabase
            .from('shipment_pts')
            .select('pt_id, removed_from_staging')
            .eq('shipment_id', stagingData.id);

          if (movedPTs) {
            const movedPTRecords = movedPTs as Array<{ pt_id: number; removed_from_staging: boolean }>;
            shipment.pts.forEach(pt => {
              const movedRecord = movedPTRecords.find(m => m.pt_id === pt.id);
              if (movedRecord) {
                pt.moved_to_staging = !movedRecord.removed_from_staging;
                pt.removed_from_staging = movedRecord.removed_from_staging;
              }
            });
          }
        }
      }

      // SHIPPED always wins: if any PT in a PU is shipped, force whole PU to shipped
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

      console.log('Total shipments:', sortedShipments.length);
      setShipments(sortedShipments);

    } catch (error) {
      console.error('Error fetching shipments:', error);
    } finally {
      setLoading(false);
    }
  }

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

  const activeShipments = shipments.filter(s => {
    return isInActiveSection(s);
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

  const readyToShipActiveLoads: ShipmentPdfLoad[] = activeShipments
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
          location: shipment.staging_lane ? `L${shipment.staging_lane}` : (pt.assigned_lane ? `L${pt.assigned_lane}` : ''),
          notes: ''
        }))
    }))
    .filter(load => load.rows.length > 0);

  function exportAllReadyToShipPDF() {
    if (readyToShipActiveLoads.length === 0) return;
    exportShipmentSummaryPdf(readyToShipActiveLoads, 'shipment-summary-ready-to-ship');
  }

  const normalizedLoadSearch = loadSearch.trim().toLowerCase();
  const loadSearchResults = normalizedLoadSearch
    ? shipments.filter((shipment) => (shipment.pu_number || '').toLowerCase().includes(normalizedLoadSearch))
    : [];

  const selectedSearchShipment = searchSelectedShipmentKey
    ? shipments.find(shipment => shipmentKey(shipment) === searchSelectedShipmentKey) || null
    : null;
  const readyToShipCount = readyToShipActiveLoads.length;

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
        {activeShipments.map((shipment) => (
          <ShipmentCard
            key={`${shipment.pu_number}-${shipment.pu_date}`}
            shipment={shipment}
            onUpdate={() => {
              const currentKey = `${shipment.pu_number}-${shipment.pu_date}`;
              setExpandedShipmentKey(currentKey);
              fetchShipments();
            }}
            mostRecentSync={mostRecentSync}
            isExpanded={expandedShipmentKey === `${shipment.pu_number}-${shipment.pu_date}`}
            onToggleExpand={(isExpanded) => {
              setExpandedShipmentKey(isExpanded ? `${shipment.pu_number}-${shipment.pu_date}` : null);
            }}
            requireOCRForStaging={requireOCRForStaging}
            readOnly={isGuest}
          />
        ))}
      </div>
    )}
  </div>

  {/* Shipped Shipments */}
  {shippedShipments.length > 0 && (
    <div className="border-t-4 border-green-600 pt-8 mb-8">
      <h2 className="text-2xl font-bold mb-4 text-green-400">✈️ Shipped ({shippedShipments.length})</h2>
      <div className="space-y-4 opacity-75">
        {shippedShipments.map((shipment) => (
          <ShipmentCard
            key={`${shipment.pu_number}-${shipment.pu_date}`}
            shipment={shipment}
            onUpdate={() => {
              const currentKey = `${shipment.pu_number}-${shipment.pu_date}`;
              setExpandedShipmentKey(currentKey);
              fetchShipments();
            }}
            mostRecentSync={mostRecentSync}
            isExpanded={expandedShipmentKey === `${shipment.pu_number}-${shipment.pu_date}`}
            onToggleExpand={(isExpanded) => {
              setExpandedShipmentKey(isExpanded ? `${shipment.pu_number}-${shipment.pu_date}` : null);
            }}
            requireOCRForStaging={requireOCRForStaging}
            readOnly={isGuest}
          />
        ))}
      </div>
    </div>
  )}

  {/* Archived Shipments */}
  {archivedShipments.length > 0 && (
    <div className="border-t-4 border-gray-600 pt-8">
      <h2 className="text-2xl font-bold mb-4 text-gray-300">Archived ({archivedShipments.length})</h2>
      <div className="space-y-4 opacity-60">
        {archivedShipments.map((shipment) => (
          <ShipmentCard
            key={`${shipment.pu_number}-${shipment.pu_date}`}
            shipment={shipment}
            onUpdate={() => {
              const currentKey = `${shipment.pu_number}-${shipment.pu_date}`;
              setExpandedShipmentKey(currentKey);
              fetchShipments();
            }}
            mostRecentSync={mostRecentSync}
            isExpanded={expandedShipmentKey === `${shipment.pu_number}-${shipment.pu_date}`}
            onToggleExpand={(isExpanded) => {
              setExpandedShipmentKey(isExpanded ? `${shipment.pu_number}-${shipment.pu_date}` : null);
            }}
            requireOCRForStaging={requireOCRForStaging}
            readOnly={isGuest}
          />
        ))}
      </div>
    </div>
  )}

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
            {staleSnapshotShipments.map((shipment) => (
              <ShipmentCard
                key={`stale-${shipmentKey(shipment)}`}
                shipment={shipment}
                onUpdate={() => { }}
                mostRecentSync={mostRecentSync}
                isExpanded={expandedShipmentKey === `stale-${shipmentKey(shipment)}`}
                readOnly={true}
                onToggleExpand={(isExpanded) => {
                  setExpandedShipmentKey(isExpanded ? `stale-${shipmentKey(shipment)}` : null);
                }}
                requireOCRForStaging={requireOCRForStaging}
              />
            ))}
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
              />
            </div>
          </div>
        </div>
      )}

      {ocrToggleToast && (
        <div className="fixed top-4 right-4 z-[120] bg-gray-900 border border-gray-600 px-4 py-2 rounded-lg text-sm text-white shadow-lg animate-fade-in">
          {ocrToggleToast}
        </div>
      )}
    </div>
  );
}
