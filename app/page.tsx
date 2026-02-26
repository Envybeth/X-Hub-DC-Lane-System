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
export const dynamic = 'force-dynamic';

export default function Home() {
  const { session, isGuest } = useAuth();
  const [showSearch, setShowSearch] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [viewingPTDetails, setViewingPTDetails] = useState<Pickticket | null>(null);

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

      const skippedBreakdown = typeof data.skipped_breakdown === 'object' && data.skipped_breakdown !== null
        ? data.skipped_breakdown as {
          picked_up?: number;
          paper?: number;
          missing_pt_or_po?: number;
        }
        : null;
      const skippedDetails = skippedBreakdown
        ? `\n- picked up: ${skippedBreakdown.picked_up || 0}\n- PAPER: ${skippedBreakdown.paper || 0}\n- missing PT/PO: ${skippedBreakdown.missing_pt_or_po || 0}`
        : '';

      if (data.success) {
        const sourceText = data.sourceSheet ? ` from "${data.sourceSheet}"` : '';
        const skippedText = typeof data.skipped === 'number' ? `\nSkipped: ${data.skipped}` : '';
        alert(`✅ Synced ${data.count} picktickets${sourceText}${skippedText}${skippedDetails ? `\nSkip reasons:${skippedDetails}` : ''}`);
        setLastSync(new Date());
        window.location.reload();
      } else {
        const errorText = data.error || data.details || data.message || 'Sync failed';
        const sourceText = data.sourceSheet ? `\nSource sheet: ${data.sourceSheet}` : '';
        const syncedText = typeof data.count === 'number' ? `\nSynced: ${data.count}` : '';
        const skippedText = typeof data.skipped === 'number' ? `\nSkipped: ${data.skipped}` : '';
        const errorsText = typeof data.errors === 'number' ? `\nRow errors: ${data.errors}` : '';
        alert(`❌ ${errorText}${sourceText}${syncedText}${skippedText}${errorsText}${skippedDetails ? `\nSkip reasons:${skippedDetails}` : ''}`);
      }
    } catch (error) {
      console.error('Sync error:', error);
      alert('❌ Sync failed');
    }
    setSyncing(false);
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Mobile-optimized header */}
      <div className="bg-gray-800 border-b border-gray-700 p-3 md:p-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h1 className="text-xl md:text-3xl font-bold">Lane Management System</h1>
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
    </div>
  );
}
