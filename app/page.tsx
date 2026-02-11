'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import LaneGrid from '@/components/LaneGrid';
import AssignModal from '@/components/AssignModal';
import SearchModal from '@/components/SearchModal';
import EditModal from '@/components/EditModal';

interface Lane {
  id: number;
  lane_number: string;
  max_capacity: number;
  lane_type: string;
  current_pallets?: number;
}

export default function Home() {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [selectedLane, setSelectedLane] = useState<Lane | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    fetchLanes();
  }, []);

  async function fetchLanes() {
    const { data, error } = await supabase
      .from('lanes')
      .select('*')
      .order('id');

    if (data) {
      const lanesWithCapacity = await Promise.all(
        data.map(async (lane) => {
          const { data: assignments } = await supabase
            .from('lane_assignments')
            .select('pallet_count')
            .eq('lane_number', lane.lane_number);

          const current_pallets = assignments?.reduce(
            (sum, a) => sum + a.pallet_count,
            0
          ) || 0;

          return { ...lane, current_pallets };
        })
      );
      setLanes(lanesWithCapacity);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const response = await fetch('/api/sync', { method: 'POST' });
      const result = await response.json();
      
      if (result.success) {
        alert(`✅ Synced ${result.count} picktickets!`);
      } else {
        alert('❌ Sync failed');
      }
    } catch (error) {
      alert('❌ Sync failed');
      console.error(error);
    }
    setSyncing(false);
  }

  function handleLaneClick(lane: Lane) {
    setSelectedLane(lane);
    setShowAssignModal(true);
  }

  function handleModalClose() {
    setShowAssignModal(false);
    setSelectedLane(null);
    fetchLanes();
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold">Envybeth Warehouse - Lane System</h1>
          <div className="flex gap-4">
            
            <Link
              href="/shipments"
              className="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-lg font-semibold"
            >
              📦 Outbound Shipments
            </Link>

            <button
              onClick={() => setShowEditModal(true)}
              className="bg-orange-600 hover:bg-orange-700 px-6 py-3 rounded-lg font-semibold"
            >
              ⚙️ Edit
            </button>
            <button
              onClick={() => setShowSearchModal(true)}
              className="bg-purple-600 hover:bg-purple-700 px-6 py-3 rounded-lg font-semibold"
            >
              🔍 Search
            </button>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-semibold disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : '🔄 Sync'}
            </button>
          </div>
        </div>

        <LaneGrid lanes={lanes} onLaneClick={handleLaneClick} />

        {showAssignModal && selectedLane && (
          <AssignModal
            lane={selectedLane}
            onClose={handleModalClose}
          />
        )}

        {showSearchModal && (
          <SearchModal onClose={() => setShowSearchModal(false)} />
        )}

        {showEditModal && (
          <EditModal onClose={() => setShowEditModal(false)} />
        )}
      </div>
    </div>
  );
}