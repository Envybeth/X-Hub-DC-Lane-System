'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import LaneGrid from '@/components/LaneGrid';
import SearchModal from '@/components/SearchModal';
import Link from 'next/link';

export default function Home() {
  const [showSearch, setShowSearch] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    checkLastSync();
  }, []);

  async function checkLastSync() {
    const { data } = await supabase
      .from('picktickets')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (data) {
      setLastSync(new Date(data.created_at));
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const response = await fetch('/api/sync', { method: 'POST' });
      const data = await response.json();
      
      if (data.success) {
        alert(`✅ Synced ${data.count} picktickets`);
        setLastSync(new Date());
        window.location.reload();
      } else {
        alert('❌ Sync failed');
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
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowSearch(true)}
                className="flex-1 sm:flex-none bg-blue-600 hover:bg-blue-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-sm md:text-base"
              >
                🔍 Search
              </button>
              <Link 
                href="/shipments"
                className="flex-1 sm:flex-none bg-purple-600 hover:bg-purple-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-center text-sm md:text-base"
              >
                📦 Shipments
              </Link>
              <button
                onClick={handleSync}
                disabled={syncing}
                className="flex-1 sm:flex-none bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-3 md:px-6 py-2 md:py-3 rounded-lg font-semibold text-sm md:text-base"
              >
                {syncing ? '⏳ Syncing...' : '🔄 Sync'}
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
        <LaneGrid />
      </div>

      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}
    </div>
  );
}