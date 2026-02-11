'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import AssignModal from './AssignModal';

interface Lane {
  id: number;
  lane_number: string;
  max_capacity: number;
  lane_type: string;
  current_pallets?: number;
  isStaging?: boolean;
}

export default function LaneGrid() {
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [selectedLane, setSelectedLane] = useState<Lane | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);

  useEffect(() => {
    fetchLanes();
  }, []);

  async function fetchLanes() {
    const { data } = await supabase
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

          // Check if it's a staging lane
          const { data: pts } = await supabase
            .from('picktickets')
            .select('status')
            .eq('assigned_lane', lane.lane_number);

          const isStaging = pts && pts.length > 0 && pts.every(pt => pt.status === 'ready_to_ship');

          return { ...lane, current_pallets, isStaging };
        })
      );
      setLanes(lanesWithCapacity);
    }
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

  function getLaneColor(current: number, max: number, isStaging?: boolean) {
  if (isStaging) return 'bg-purple-700 border-purple-500';
  
  const percentage = (current / max) * 100;
  if (percentage >= 100) return 'bg-red-700 border-red-500';
  if (percentage >= 75) return 'bg-orange-700 border-orange-500';
  if (percentage >= 50) return 'bg-yellow-700 border-yellow-500';
  if (current === 0) return 'bg-gray-700 border-gray-500'; // ADD THIS LINE
  return 'bg-green-700 border-green-500';
}

  const lanesByType = {
    large: lanes.filter(l => l.max_capacity === 34),
    medium: lanes.filter(l => l.max_capacity === 25),
    small: lanes.filter(l => l.max_capacity === 15),
    mini: lanes.filter(l => l.max_capacity === 4)
  };

  return (
    <div className="space-y-6 md:space-y-8">
      {/* Large Lanes */}
      {lanesByType.large.length > 0 && (
        <div>
          <h2 className="text-lg md:text-2xl font-bold mb-3 md:mb-4 text-blue-400 border-b-2 border-blue-700 pb-2">
            Large Lanes (34 pallets)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 md:gap-4">
            {lanesByType.large.map(lane => (
              <button
                key={lane.id}
                onClick={() => handleLaneClick(lane)}
                className={`${getLaneColor(lane.current_pallets || 0, lane.max_capacity, lane.isStaging)} border-2 rounded-lg p-2 md:p-4 hover:opacity-80 transition-all`}
              >
                <div className="text-base md:text-2xl font-bold">
                  {lane.isStaging && '📦 '}
                  {lane.lane_number}
                </div>
                <div className="text-xs md:text-sm mt-1">
                  {lane.current_pallets || 0}/{lane.max_capacity}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Medium Lanes */}
      {lanesByType.medium.length > 0 && (
        <div>
          <h2 className="text-lg md:text-2xl font-bold mb-3 md:mb-4 text-green-400 border-b-2 border-green-700 pb-2">
            Medium Lanes (25 pallets)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 md:gap-4">
            {lanesByType.medium.map(lane => (
              <button
                key={lane.id}
                onClick={() => handleLaneClick(lane)}
                className={`${getLaneColor(lane.current_pallets || 0, lane.max_capacity, lane.isStaging)} border-2 rounded-lg p-2 md:p-4 hover:opacity-80 transition-all`}
              >
                <div className="text-base md:text-2xl font-bold">
                  {lane.isStaging && '📦 '}
                  {lane.lane_number}
                </div>
                <div className="text-xs md:text-sm mt-1">
                  {lane.current_pallets || 0}/{lane.max_capacity}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Small Lanes */}
      {lanesByType.small.length > 0 && (
        <div>
          <h2 className="text-lg md:text-2xl font-bold mb-3 md:mb-4 text-yellow-400 border-b-2 border-yellow-700 pb-2">
            Small Lanes (15 pallets)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 md:gap-4">
            {lanesByType.small.map(lane => (
              <button
                key={lane.id}
                onClick={() => handleLaneClick(lane)}
                className={`${getLaneColor(lane.current_pallets || 0, lane.max_capacity, lane.isStaging)} border-2 rounded-lg p-2 md:p-4 hover:opacity-80 transition-all`}
              >
                <div className="text-base md:text-2xl font-bold">
                  {lane.isStaging && '📦 '}
                  {lane.lane_number}
                </div>
                <div className="text-xs md:text-sm mt-1">
                  {lane.current_pallets || 0}/{lane.max_capacity}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mini Lanes */}
      {lanesByType.mini.length > 0 && (
        <div>
          <h2 className="text-lg md:text-2xl font-bold mb-3 md:mb-4 text-purple-400 border-b-2 border-purple-700 pb-2">
            Mini Lanes (4 pallets)
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 md:gap-4">
            {lanesByType.mini.map(lane => (
              <button
                key={lane.id}
                onClick={() => handleLaneClick(lane)}
                className={`${getLaneColor(lane.current_pallets || 0, lane.max_capacity, lane.isStaging)} border-2 rounded-lg p-2 md:p-4 hover:opacity-80 transition-all`}
              >
                <div className="text-base md:text-2xl font-bold">
                  {lane.isStaging && '📦 '}
                  {lane.lane_number}
                </div>
                <div className="text-xs md:text-sm mt-1">
                  {lane.current_pallets || 0}/{lane.max_capacity}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {showAssignModal && selectedLane && (
        <AssignModal
          lane={selectedLane}
          onClose={handleModalClose}
        />
      )}
    </div>
  );
}