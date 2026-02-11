'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Lane {
  id: number;
  lane_number: string;
  max_capacity: number;
  lane_type: string;
  current_pallets?: number;
}

interface LaneGridProps {
  lanes: Lane[];
  onLaneClick: (lane: Lane) => void;
}

export default function LaneGrid({ lanes, onLaneClick }: LaneGridProps) {
  const [stagingLanes, setStagingLanes] = useState<Set<string>>(new Set());

  useEffect(() => {
    checkStagingLanes();
  }, [lanes]);

  async function checkStagingLanes() {
    const stagingSet = new Set<string>();

    for (const lane of lanes) {
      if (lane.current_pallets && lane.current_pallets > 0) {
        const { data: pts } = await supabase
          .from('picktickets')
          .select('status')
          .eq('assigned_lane', lane.lane_number);

        if (pts && pts.length > 0) {
          const allReadyToShip = pts.every(pt => pt.status === 'ready_to_ship');
          if (allReadyToShip) {
            stagingSet.add(lane.lane_number);
          }
        }
      }
    }

    setStagingLanes(stagingSet);
  }

  function getLaneColor(lane: Lane) {
    const percentage = lane.current_pallets && lane.max_capacity 
      ? (lane.current_pallets / lane.max_capacity) * 100 
      : 0;

    if (percentage === 0) return 'bg-gray-600';
    if (percentage < 50) return 'bg-green-600';
    if (percentage < 80) return 'bg-yellow-600';
    if (percentage < 100) return 'bg-orange-600';
    return 'bg-red-600';
  }

  // Group lanes by capacity
  const largeLanes = lanes.filter(l => l.max_capacity === 34);
  const mediumLanes = lanes.filter(l => l.max_capacity === 25);
  const smallLanes = lanes.filter(l => l.max_capacity === 15);
  const miniLanes = lanes.filter(l => l.max_capacity === 4);

  function LaneButton({ lane }: { lane: Lane }) {
    return (
      <button
        onClick={() => onLaneClick(lane)}
        className={`${getLaneColor(lane)} p-6 rounded-lg transition-all duration-200 cursor-pointer border-2 border-transparent hover:border-white hover:scale-105 relative shadow-lg`}
      >
        {stagingLanes.has(lane.lane_number) && (
          <div className="absolute -top-2 -right-2 bg-purple-600 text-white text-xs px-3 py-1 rounded-full font-bold shadow-lg z-10 animate-pulse">
            📦 STAGING
          </div>
        )}
        <div className="font-bold text-2xl mb-2">Lane {lane.lane_number}</div>
        <div className="text-sm opacity-90">
          {lane.current_pallets || 0} / {lane.max_capacity} pallets
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-8">
      {/* Large Lanes (34 pallets) - Lanes 1-16 */}
      {largeLanes.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold mb-4 text-blue-400">
            Large Lanes (34 pallets) - Lanes 1-16
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
            {largeLanes.map(lane => (
              <LaneButton key={lane.id} lane={lane} />
            ))}
          </div>
        </div>
      )}

      {/* Medium Lanes (25 pallets) - Lanes 23-53 */}
      {mediumLanes.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold mb-4 text-green-400">
            Medium Lanes (25 pallets) - Lanes 23-53
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
            {mediumLanes.map(lane => (
              <LaneButton key={lane.id} lane={lane} />
            ))}
          </div>
        </div>
      )}

      {/* Small Lanes (15 pallets) - Lanes 17-22 */}
      {smallLanes.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold mb-4 text-yellow-400">
            Small Lanes (15 pallets) - Lanes 17-22
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {smallLanes.map(lane => (
              <LaneButton key={lane.id} lane={lane} />
            ))}
          </div>
        </div>
      )}

      {/* Mini Lanes (4 pallets) - Lanes 27+, 54+ */}
      {miniLanes.length > 0 && (
        <div>
          <h2 className="text-2xl font-bold mb-4 text-purple-400">
            Mini Lanes (4 pallets) - Lanes 27+, 54+
          </h2>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
            {miniLanes.map(lane => (
              <LaneButton key={lane.id} lane={lane} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}