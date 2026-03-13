'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import LaneGrid from '@/components/LaneGrid';
import SearchModal from '@/components/SearchModal';
import Link from 'next/link';
import PTDetails from '@/components/PTDetails';
import { Suspense } from 'react';
import { Pickticket } from '@/types/pickticket';
import { useAuth } from '@/components/AuthProvider';
import { buildSyncDetailSections, buildSyncPrimarySection, normalizeSyncSummaryData, type SyncSummarySection } from '@/lib/syncSummary';
export const dynamic = 'force-dynamic';

type SyncSummaryModalState = {
  title: string;
  success: boolean;
  primaryLines: string[];
  detailSections: SyncSummarySection[];
} | null;

export default function Home() {
  const { session, isGuest } = useAuth();
  const [showSearch, setShowSearch] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [viewingPTDetails, setViewingPTDetails] = useState<Pickticket | null>(null);
  const [syncSummary, setSyncSummary] = useState<SyncSummaryModalState>(null);

  const checkLastSync = useCallback(async () => {
    const { data } = await supabase
      .from('picktickets')
      .select('last_synced_at')  // CHANGE from 'created_at' to 'last_synced_at'
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .single();

    if (data) {
      setLastSync(new Date(data.last_synced_at));  // CHANGE to last_synced_at
    }
  }, []);

  function openSyncSummary(raw: unknown, fallbackTitle: string) {
    const summary = normalizeSyncSummaryData(raw);
    setSyncSummary({
      title: fallbackTitle,
      success: summary.success,
      primaryLines: buildSyncPrimarySection(summary),
      detailSections: buildSyncDetailSections(summary)
    });
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkLastSync();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [checkLastSync]);

  async function handleSync() {
    // Add confirmation
    const confirmed = confirm('🔄 Sync data from Google Sheets?\n\nThis will update all pickticket information.');
    if (!confirmed) return;

    setSyncing(true);
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session?.access_token || ''}`
        }
      });
      const data = await response.json();

      if (data.success) {
        await checkLastSync();
        openSyncSummary(data, 'Sync Completed');
      } else {
        openSyncSummary({
          ...data,
          success: false,
          message: data.error || data.details || data.message || 'Sync failed'
        }, 'Sync Completed With Errors');
      }
    } catch (error) {
      console.error('Sync error:', error);
      openSyncSummary({
        success: false,
        message: error instanceof Error ? error.message : 'Sync failed',
        count: 0,
        skipped: 0,
        errors: 1
      }, 'Sync Failed');
    }
    setSyncing(false);
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Mobile-optimized header */}
      <div className="bg-gray-800 border-b border-gray-700 p-3 md:p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h1 className="text-xl md:text-3xl font-bold ml-8 md:ml-0">Lane Management System</h1>
            {isGuest && (
              <div className="text-xs md:text-sm text-yellow-300">Guest mode: read-only</div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowSearch(true)}
                className="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-sm md:text-base"
              >
                🔍 Search
              </button>
              <Link
                href="/printer"
                className="flex-1 sm:flex-none bg-orange-600 hover:bg-orange-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-center text-sm md:text-base"
              >
                🖨️ Labels
              </Link>
              <Link
                href="/shipments"
                className="flex-1 sm:flex-none bg-purple-600 hover:bg-purple-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-center text-sm md:text-base"
              >
                📦 Shipments
              </Link>
              <Link
                href="/pu-watch"
                className="flex-1 sm:flex-none bg-cyan-600 hover:bg-cyan-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-center text-sm md:text-base"
              >
                🚚 PU Watch
              </Link>
              <Link
                href="/samples"
                className="flex-1 sm:flex-none bg-yellow-600 hover:bg-yellow-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-center text-sm md:text-base"
              >
                📋 Samples
              </Link>
              <button
                onClick={handleSync}
                disabled={syncing || isGuest}
                className="flex-1 sm:flex-none bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-sm md:text-base"
              >
                {syncing ? '⏳ Syncing...' : isGuest ? '🔒 Sync (Guest)' : '🔄 Sync'}
              </button>
            </div>
          </div>
          {lastSync && (
            <div className="text-xs md:text-sm text-gray-400 mt-2">
              Last sync: {lastSync.toLocaleString()}
            </div>
          )}
        </div>
      </div>

      <div className="p-2 md:p-6">
        <Suspense>
          <LaneGrid readOnly={isGuest} />
        </Suspense>
      </div>

      {showSearch && <SearchModal onClose={() => setShowSearch(false)} mostRecentSync={lastSync} />}

      {/* PT Details Modal */}
      {viewingPTDetails && (
        <PTDetails
          pt={viewingPTDetails}
          onClose={() => setViewingPTDetails(null)}
        />
      )}

      {syncSummary && (
        <div className="fixed inset-0 z-[140] bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
            <div className={`px-5 py-4 border-b ${syncSummary.success ? 'bg-green-900/40 border-green-700' : 'bg-red-900/40 border-red-700'}`}>
              <div className="text-xl font-bold">{syncSummary.title}</div>
              <div className={`text-sm mt-1 ${syncSummary.success ? 'text-green-200' : 'text-red-200'}`}>
                {syncSummary.success ? 'Sync finished successfully.' : 'Sync finished with errors or requires attention.'}
              </div>
            </div>

            <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
              <div className="rounded-xl border border-gray-700 bg-gray-800/70 p-4">
                <div className="text-sm font-semibold text-gray-200 uppercase tracking-wide mb-3">Summary</div>
                <div className="space-y-2">
                  {syncSummary.primaryLines.map((line) => (
                    <div key={line} className="text-sm text-gray-100">
                      {line}
                    </div>
                  ))}
                </div>
              </div>

              {syncSummary.detailSections.map((section) => (
                <div key={section.title} className="rounded-xl border border-gray-700 bg-gray-800/50 p-4">
                  <div className="text-sm font-semibold text-blue-200 uppercase tracking-wide mb-3">{section.title}</div>
                  <div className="space-y-2">
                    {section.lines.map((line) => (
                      <div key={`${section.title}-${line}`} className="text-sm text-gray-200">
                        {line}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-4 border-t border-gray-700 flex justify-end">
              <button
                onClick={() => setSyncSummary(null)}
                className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-semibold"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
