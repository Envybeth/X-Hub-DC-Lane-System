'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import ConfirmModal from './ConfirmModal';

export interface ShipmentPT {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  assigned_lane: string | null;
  actual_pallet_count: number;
  moved_to_staging: boolean;
  container_number: string;
  store_dc: string;
  start_date: string;
  cancel_date: string;
  removed_from_staging?: boolean;
}

export interface Shipment {
  pu_number: string;
  pu_date: string;
  carrier: string;
  pts: ShipmentPT[];
  staging_lane: string | null;
  status: 'not_started' | 'in_process' | 'finalized';
}

export interface ShipmentCardProps {
  shipment: Shipment;
  onUpdate: () => void;
}

export default function ShipmentCard({ shipment, onUpdate }: ShipmentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectingLane, setSelectingLane] = useState(false);
  const [selectedLane, setSelectedLane] = useState(shipment.staging_lane || '');
  const [lanes, setLanes] = useState<{ lane_number: string; max_capacity: number; current_pallets: number }[]>([]);
  const [selectedPTDetails, setSelectedPTDetails] = useState<ShipmentPT | null>(null);
  const [ptDepthInfo, setPtDepthInfo] = useState<{ [key: number]: { palletsInFront: number; maxCapacity: number } }>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [editingStatus, setEditingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState<'not_started' | 'in_process' | 'finalized'>(shipment.status);
  const [changingStagingLane, setChangingStagingLane] = useState(false);
  const [newStagingLane, setNewStagingLane] = useState('');
  const [stagingLaneError, setStagingLaneError] = useState('');
  const [deletingShipment, setDeletingShipment] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => { }
  });

  const totalPallets = shipment.pts.reduce((sum, pt) => sum + pt.actual_pallet_count, 0);
  const movedCount = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging).length;

  const statusConfig = {
    not_started: { label: 'Not Started', color: 'bg-red-600', textColor: 'text-red-400' },
    in_process: { label: 'In Process', color: 'bg-orange-600', textColor: 'text-orange-400' },
    finalized: { label: 'Finalized', color: 'bg-green-600', textColor: 'text-green-400' }
  };

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type });
  }

  function showConfirm(title: string, message: string, onConfirm: () => void) {
    setConfirmModal({ isOpen: true, title, message, onConfirm });
  }

  const ptsByLane = shipment.pts.reduce((acc, pt) => {
    if (pt.moved_to_staging && !pt.removed_from_staging && shipment.staging_lane) {
      const stagingKey = `staging_${shipment.staging_lane}`;
      if (!acc[stagingKey]) acc[stagingKey] = [];
      acc[stagingKey].push(pt);
    } else {
      const laneKey = pt.assigned_lane || 'unassigned';
      if (!acc[laneKey]) acc[laneKey] = [];
      acc[laneKey].push(pt);
    }
    return acc;
  }, {} as Record<string, ShipmentPT[]>);

  const sortedLanes = Object.keys(ptsByLane).sort((a, b) => {
    if (a.startsWith('staging_')) return -1;
    if (b.startsWith('staging_')) return 1;
    if (a === 'unassigned') return 1;
    if (b === 'unassigned') return -1;
    return parseInt(a) - parseInt(b);
  });

  useEffect(() => {
    if (expanded) {
      fetchDepthInfo();
    }
  }, [expanded, shipment.pts]);

  async function fetchDepthInfo() {
    const depthMap: { [key: number]: { palletsInFront: number; maxCapacity: number } } = {};

    for (const pt of shipment.pts) {
      if (pt.assigned_lane) {
        const { data: laneData } = await supabase
          .from('lanes')
          .select('max_capacity')
          .eq('lane_number', pt.assigned_lane)
          .single();

        const { data: assignments } = await supabase
          .from('lane_assignments')
          .select('pt_id, pallet_count, order_position')
          .eq('lane_number', pt.assigned_lane)
          .order('order_position', { ascending: true });

        if (assignments && laneData) {
          let palletsInFront = 0;
          for (const assignment of assignments) {
            if (assignment.pt_id === pt.id) break;
            palletsInFront += assignment.pallet_count;
          }

          depthMap[pt.id] = {
            palletsInFront,
            maxCapacity: laneData.max_capacity
          };
        }
      }
    }

    setPtDepthInfo(depthMap);
  }

  function getDepthColor(palletsInFront: number, maxCapacity: number): string {
    const percentage = (palletsInFront / maxCapacity) * 100;

    if (percentage < 20) return 'bg-blue-400 text-blue-900';
    if (percentage < 40) return 'bg-cyan-400 text-cyan-900';
    if (percentage < 60) return 'bg-yellow-400 text-yellow-900';
    if (percentage < 80) return 'bg-orange-500 text-orange-900';
    return 'bg-red-600 text-white';
  }

  async function fetchAvailableLanes() {
    const { data } = await supabase
      .from('lanes')
      .select('lane_number, max_capacity, current_pallets')
      .order('lane_number');

    if (data) {
      setLanes(data);
    }
  }

  async function handleSetStagingLane() {
    if (!selectedLane) return;

    try {
      const { data: shipmentData, error: shipmentError } = await supabase
        .from('shipments')
        .upsert({
          pu_number: shipment.pu_number,
          pu_date: shipment.pu_date,
          carrier: shipment.carrier,
          staging_lane: selectedLane,
          status: 'in_process',
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'pu_number,pu_date'
        })
        .select()
        .single();

      if (shipmentError) throw shipmentError;

      showToast(`Staging lane ${selectedLane} set for shipment`, 'success');
      setSelectingLane(false);
      onUpdate();
    } catch (error) {
      console.error('Error setting staging lane:', error);
      showToast('Failed to set staging lane', 'error');
    }
  }

  async function handleChangeStagingLane() {
    if (!newStagingLane.trim() || !shipment.staging_lane) return;

    const targetLaneNumber = newStagingLane.trim();
    const targetLane = lanes.find(l => l.lane_number.toString() === targetLaneNumber);

    if (!targetLane) {
      setStagingLaneError('Invalid lane number');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    if (targetLane.current_pallets > 0) {
      setStagingLaneError('Lane must be empty');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    if (targetLane.lane_number.toString() === shipment.staging_lane) {
      setStagingLaneError('Already the staging lane');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    showConfirm(
      'Change Staging Lane',
      `Move all staged PTs from Lane ${shipment.staging_lane} to Lane ${targetLane.lane_number}?`,
      async () => {
        try {
          const stagedPTs = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging);

          await supabase
            .from('shipments')
            .update({
              staging_lane: targetLane.lane_number,
              updated_at: new Date().toISOString()
            })
            .eq('pu_number', shipment.pu_number)
            .eq('pu_date', shipment.pu_date);

          for (const pt of stagedPTs) {
            await supabase
              .from('picktickets')
              .update({ assigned_lane: targetLane.lane_number })
              .eq('id', pt.id);

            await supabase
              .from('lane_assignments')
              .update({ lane_number: targetLane.lane_number })
              .eq('pt_id', pt.id)
              .eq('lane_number', shipment.staging_lane);
          }

          showToast(`Staging lane changed to ${targetLane.lane_number}`, 'success');
          setChangingStagingLane(false);
          setNewStagingLane('');
          setStagingLaneError('');
          onUpdate();
        } catch (error) {
          console.error('Error changing staging lane:', error);
          showToast('Failed to change staging lane', 'error');
        }

        setConfirmModal({ ...confirmModal, isOpen: false });
      }
    );
  }

  async function handleDeleteStagingData() {
    if (deleteConfirmText !== 'DELETE') {
      showToast('Type DELETE to confirm', 'error');
      return;
    }

    try {
      // Get shipment ID
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id')
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date)
        .single();

      if (!shipmentData) throw new Error('Shipment not found');

      // Get all PTs that were moved to staging
      const stagedPTs = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging);

      for (const pt of stagedPTs) {
        // Remove from lane_assignments (staging lane)
        await supabase
          .from('lane_assignments')
          .delete()
          .eq('pt_id', pt.id)
          .eq('lane_number', shipment.staging_lane);

        // Update PT status back to labeled and remove staging lane
        await supabase
          .from('picktickets')
          .update({
            assigned_lane: null,
            status: 'labeled'
          })
          .eq('id', pt.id);
      }

      // Delete all shipment_pts records
      await supabase
        .from('shipment_pts')
        .delete()
        .eq('shipment_id', shipmentData.id);

      // Update shipment to not_started and clear staging lane
      await supabase
        .from('shipments')
        .update({
          status: 'not_started',
          staging_lane: null,
          updated_at: new Date().toISOString()
        })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      showToast('Staging data cleared successfully', 'success');
      setDeletingShipment(false);
      setDeleteConfirmText('');
      onUpdate();
    } catch (error) {
      console.error('Error deleting staging data:', error);
      showToast('Failed to clear staging data', 'error');
    }
  }

  async function handleUpdateStatus() {
    try {
      await supabase
        .from('shipments')
        .update({
          status: newStatus,
          updated_at: new Date().toISOString()
        })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      showToast('Shipment status updated', 'success');
      setEditingStatus(false);
      onUpdate();
    } catch (error) {
      console.error('Error updating status:', error);
      showToast('Failed to update status', 'error');
    }
  }

  async function handleMovePT(pt: ShipmentPT) {
    if (!shipment.staging_lane) {
      showToast('Please select a staging lane first', 'error');
      return;
    }

    try {
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id')
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date)
        .single();

      if (!shipmentData) throw new Error('Shipment not found');

      await supabase
        .from('shipment_pts')
        .upsert({
          shipment_id: shipmentData.id,
          pt_id: pt.id,
          original_lane: pt.assigned_lane,
          removed_from_staging: false
        }, {
          onConflict: 'shipment_id,pt_id'
        });

      await supabase
        .from('picktickets')
        .update({
          assigned_lane: shipment.staging_lane,
          status: 'ready_to_ship'
        })
        .eq('id', pt.id);

      if (pt.assigned_lane) {
        const { data: oldAssignment } = await supabase
          .from('lane_assignments')
          .select('id')
          .eq('pt_id', pt.id)
          .eq('lane_number', pt.assigned_lane)
          .maybeSingle();

        if (oldAssignment) {
          await supabase
            .from('lane_assignments')
            .delete()
            .eq('id', oldAssignment.id);
        }
      }

      const { data: existingAssignments } = await supabase
        .from('lane_assignments')
        .select('order_position')
        .eq('lane_number', shipment.staging_lane)
        .order('order_position', { ascending: false })
        .limit(1);

      const newPosition = existingAssignments && existingAssignments.length > 0
        ? existingAssignments[0].order_position + 1
        : 1;

      await supabase
        .from('lane_assignments')
        .insert({
          lane_number: shipment.staging_lane,
          pt_id: pt.id,
          pallet_count: pt.actual_pallet_count,
          order_position: newPosition
        });

      showToast(`PT ${pt.pt_number} moved to staging lane ${shipment.staging_lane}`, 'success');
      onUpdate();
    } catch (error) {
      console.error('Error moving PT:', error);
      showToast('Failed to move PT to staging', 'error');
    }
  }

  async function handleFinalizeShipment() {
    const allMoved = shipment.pts.every(pt => pt.moved_to_staging && !pt.removed_from_staging);

    if (!allMoved) {
      showConfirm(
        'Finalize Shipment',
        'Not all PTs have been moved to staging. Finalize anyway?',
        async () => {
          await finalizeShipmentAction();
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    } else {
      await finalizeShipmentAction();
    }
  }

  async function finalizeShipmentAction() {
    try {
      await supabase
        .from('shipments')
        .update({ status: 'finalized', updated_at: new Date().toISOString() })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      showToast('Shipment finalized!', 'success');
      onUpdate();
    } catch (error) {
      console.error('Error finalizing shipment:', error);
      showToast('Failed to finalize shipment', 'error');
    }
  }

  return (
    <>
      <div className="bg-gray-800 rounded-lg border-2 border-gray-600">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full p-5 flex items-center justify-between hover:bg-gray-750 transition-colors"
        >
          <div className="flex items-center gap-6">
            <div className="text-2xl text-blue-400">
              {expanded ? '▼' : '▶'}
            </div>
            <div className="text-left">
              <div className="text-2xl font-bold">PU #{shipment.pu_number}</div>
              <div className="text-sm text-gray-400 mt-1">
                {shipment.carrier} | {shipment.pu_date} | {shipment.pts.length} PTs | {totalPallets} pallets
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className={`px-4 py-2 rounded-lg font-bold ${statusConfig[shipment.status].color}`}>
              {statusConfig[shipment.status].label}
            </div>
            {shipment.staging_lane && (
              <div className="bg-purple-700 px-4 py-2 rounded-lg font-bold">
                Staging: Lane {shipment.staging_lane}
              </div>
            )}
          </div>
        </button>

        {expanded && (
          <div className="p-6 border-t-2 border-gray-600 space-y-6">
            <div className="flex gap-4 flex-wrap">
              {editingStatus ? (
                <div className="flex-1 bg-gray-700 p-4 rounded-lg">
                  <div className="flex items-center gap-3">
                    <label className="font-semibold">Status:</label>
                    <select
                      value={newStatus}
                      onChange={(e) => setNewStatus(e.target.value as any)}
                      className="bg-gray-900 text-white p-2 rounded flex-1"
                    >
                      <option value="not_started">Not Started</option>
                      <option value="in_process">In Process</option>
                      <option value="finalized">Finalized</option>
                    </select>
                    <button
                      onClick={handleUpdateStatus}
                      className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-semibold"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingStatus(false);
                        setNewStatus(shipment.status);
                      }}
                      className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded font-semibold"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setEditingStatus(true);
                    setNewStatus(shipment.status);
                  }}
                  className="bg-orange-600 hover:bg-orange-700 px-6 py-3 rounded-lg font-bold"
                >
                  Edit Status
                </button>
              )}

              {shipment.staging_lane && !changingStagingLane && (
                <button
                  onClick={() => {
                    setChangingStagingLane(true);
                    fetchAvailableLanes();
                  }}
                  className="bg-purple-600 hover:bg-purple-700 px-6 py-3 rounded-lg font-bold"
                >
                  Change Staging Lane
                </button>
              )}

              {changingStagingLane && (
                <div className="flex-1 bg-gray-700 p-4 rounded-lg relative">
                  <div className="flex items-center gap-3">
                    <label className="font-semibold">New Staging Lane:</label>
                    <input
                      type="text"
                      value={newStagingLane}
                      onChange={(e) => {
                        setNewStagingLane(e.target.value);
                        setStagingLaneError('');
                      }}
                      placeholder="Enter lane number"
                      className={`bg-gray-900 text-white p-2 rounded flex-1 ${stagingLaneError ? 'border-2 border-red-500' : ''}`}
                    />
                    <button
                      onClick={handleChangeStagingLane}
                      className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-semibold"
                    >
                      Move
                    </button>
                    <button
                      onClick={() => {
                        setChangingStagingLane(false);
                        setNewStagingLane('');
                        setStagingLaneError('');
                      }}
                      className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded font-semibold"
                    >
                      Cancel
                    </button>
                  </div>
                  {stagingLaneError && (
                    <div className="absolute -bottom-6 left-0 text-red-500 text-sm animate-fade-in">
                      {stagingLaneError}
                    </div>
                  )}
                </div>
              )}

              {shipment.staging_lane && movedCount > 0 && !deletingShipment && (
                <button
                  onClick={() => setDeletingShipment(true)}
                  className="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-lg font-bold"
                >
                  Clear Staging Data
                </button>
              )}

              {deletingShipment && (
                <div className="flex-1 bg-red-900 border-2 border-red-600 p-4 rounded-lg">
                  <div className="flex items-center gap-3">
                    <label className="font-semibold text-white">Type DELETE to confirm:</label>
                    <input
                      type="text"
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      placeholder="DELETE"
                      className="bg-gray-900 text-white p-2 rounded flex-1 uppercase"
                    />
                    <button
                      onClick={handleDeleteStagingData}
                      disabled={deleteConfirmText !== 'DELETE'}
                      className="bg-red-700 hover:bg-red-800 disabled:bg-gray-600 px-4 py-2 rounded font-semibold"
                    >
                      Confirm Delete
                    </button>
                    <button
                      onClick={() => {
                        setDeletingShipment(false);
                        setDeleteConfirmText('');
                      }}
                      className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded font-semibold"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {!shipment.staging_lane ? (
              <div className="bg-yellow-900 border-2 border-yellow-600 p-4 rounded-lg">
                <div className="font-bold text-xl mb-3">⚠️ Select Staging Lane</div>
                <p className="text-sm mb-4">Choose a single lane to consolidate all PTs for this shipment</p>
                {!selectingLane ? (
                  <button
                    onClick={() => {
                      setSelectingLane(true);
                      fetchAvailableLanes();
                    }}
                    className="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded-lg font-bold"
                  >
                    Select Staging Lane
                  </button>
                ) : (
                  <div className="flex gap-3">
                    <select
                      value={selectedLane}
                      onChange={(e) => setSelectedLane(e.target.value)}
                      className="flex-1 bg-gray-700 text-white p-3 rounded-lg"
                    >
                      <option value="">-- Choose Lane --</option>
                      {lanes.map(lane => (
                        <option key={lane.lane_number} value={lane.lane_number}>
                          Lane {lane.lane_number} (Capacity: {lane.max_capacity}, Current: {lane.current_pallets})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleSetStagingLane}
                      disabled={!selectedLane}
                      className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 px-6 py-2 rounded-lg font-bold"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setSelectingLane(false)}
                      className="bg-gray-600 hover:bg-gray-700 px-6 py-2 rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-700 p-4 rounded-lg">
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-bold text-lg">Staging Progress</div>
                    <div className="text-sm text-gray-400 mt-1">
                      {movedCount} of {shipment.pts.length} PTs moved to Lane {shipment.staging_lane}
                    </div>
                  </div>
                  {shipment.status !== 'finalized' && (
                    <button
                      onClick={handleFinalizeShipment}
                      className="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-lg font-bold"
                    >
                      Finalize Shipment
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-6">
              <h3 className="text-xl font-bold">Picktickets in Shipment</h3>
              {sortedLanes.map(laneKey => {
                const isStaging = laneKey.startsWith('staging_');
                const actualLaneNumber = isStaging ? laneKey.replace('staging_', '') : laneKey;

                return (
                  <div key={laneKey} className="space-y-3">
                    {isStaging ? (
                      <h4 className="text-2xl font-bold text-purple-400 border-b-2 border-purple-700 pb-2">
                        📦 STAGING LANE (Lane {actualLaneNumber}) - {ptsByLane[laneKey].length} PTs
                      </h4>
                    ) : (
                      <h4 className="text-lg font-semibold text-blue-400 border-b border-blue-700 pb-2">
                        {laneKey === 'unassigned' ? '⚠️ Unassigned PTs' : `Lane ${laneKey} (${ptsByLane[laneKey].length} PTs)`}
                      </h4>
                    )}
                    {ptsByLane[laneKey].map(pt => {
                      const depthInfo = ptDepthInfo[pt.id];
                      const depthColor = depthInfo
                        ? getDepthColor(depthInfo.palletsInFront, depthInfo.maxCapacity)
                        : '';

                      // FIX: Check if PT has a lane AND is not currently in staging
                      const hasLaneAssigned = pt.assigned_lane && pt.assigned_lane !== shipment.staging_lane;
                      const isCurrentlyStaged = pt.moved_to_staging && !pt.removed_from_staging;
                      const canMoveToStaging = hasLaneAssigned && !isCurrentlyStaged && shipment.staging_lane && shipment.status !== 'finalized';

                      return (
                        <div
                          key={pt.id}
                          className={`p-4 rounded-lg border-2 ${isCurrentlyStaged
                              ? 'bg-green-900 border-green-600'
                              : !pt.assigned_lane
                                ? 'bg-gray-700 border-gray-600'
                                : 'bg-gray-700 border-gray-600'
                            }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex-1">
                              <div className="flex items-center gap-3">
                                {isCurrentlyStaged && (
                                  <div className="text-2xl text-green-400">✓</div>
                                )}
                                {!pt.assigned_lane && (
                                  <div className="text-2xl text-yellow-400">⚠️</div>
                                )}
                                <div>
                                  <div className="text-lg font-bold">
                                    PT #{pt.pt_number} | PO: {pt.po_number}
                                  </div>
                                  <div className="text-sm text-gray-300">
                                    {pt.customer} | {pt.actual_pallet_count} pallets
                                  </div>
                                  {pt.assigned_lane && (
                                    <div className="flex items-center gap-3 mt-2">
                                      <div className="text-xl font-bold text-white">
                                        Lane {pt.assigned_lane}
                                      </div>
                                      {depthInfo && (
                                        <span className={`px-3 py-1 rounded-full text-xs font-bold ${depthColor}`}>
                                          {depthInfo.palletsInFront} pallets in front ({Math.round((depthInfo.palletsInFront / depthInfo.maxCapacity) * 100)}% deep)
                                        </span>
                                      )}
                                      <div className="text-xs text-gray-400">
                                        Current Location: Lane {pt.assigned_lane}
                                      </div>
                                    </div>
                                  )}
                                  {!pt.assigned_lane && (
                                    <div className="text-sm text-gray-400 mt-1">
                                      NOT ASSIGNED TO LANE YET
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex gap-3">
                              <button
                                onClick={() => setSelectedPTDetails(pt)}
                                className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-semibold"
                              >
                                Details
                              </button>
                              {canMoveToStaging && (
                                <button
                                  onClick={() => handleMovePT(pt)}
                                  className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-lg font-semibold"
                                >
                                  ✓ Move to Staging
                                </button>
                              )}
                              {!pt.assigned_lane && (
                                <div className="bg-yellow-700 px-4 py-2 rounded-lg text-sm font-semibold">
                                  Assign to lane first
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {selectedPTDetails && (
          <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-800 rounded-lg p-8 max-w-2xl w-full">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-2xl font-bold">Pickticket Details</h3>
                <button
                  onClick={() => setSelectedPTDetails(null)}
                  className="text-4xl hover:text-red-500"
                >
                  &times;
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-gray-400">Pickticket #</div>
                  <div className="text-xl font-bold">{selectedPTDetails.pt_number}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">PO #</div>
                  <div className="text-xl font-bold">{selectedPTDetails.po_number}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">Customer</div>
                  <div className="text-lg">{selectedPTDetails.customer}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">DC # (Store/DC)</div>
                  <div className="text-lg">{selectedPTDetails.store_dc || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">Container #</div>
                  <div className="text-lg">{selectedPTDetails.container_number}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">Pallet Count</div>
                  <div className="text-lg font-bold text-blue-400">
                    {selectedPTDetails.actual_pallet_count} pallets
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">Start Date</div>
                  <div className="text-lg">{selectedPTDetails.start_date || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">Cancel Date</div>
                  <div className="text-lg">{selectedPTDetails.cancel_date || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-400">Current Location</div>
                  <div className="text-lg font-bold text-blue-400">
                    {selectedPTDetails.assigned_lane ? `Lane ${selectedPTDetails.assigned_lane}` : 'Unassigned'}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-sm text-gray-400">Status</div>
                  <div className={`text-lg font-bold ${selectedPTDetails.moved_to_staging && !selectedPTDetails.removed_from_staging ? 'text-green-400' : 'text-yellow-400'}`}>
                    {selectedPTDetails.moved_to_staging && !selectedPTDetails.removed_from_staging ? 'Ready to Ship (In Staging)' : 'Awaiting Move'}
                  </div>
                </div>
              </div>

              <button
                onClick={() => setSelectedPTDetails(null)}
                className="w-full mt-6 bg-blue-600 hover:bg-blue-700 py-3 rounded-lg font-bold text-lg"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed top-4 right-4 z-[110] px-6 py-3 rounded-lg font-semibold shadow-lg animate-fade-in ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
          }`}>
          {toast.message}
        </div>
      )}

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        onConfirm={confirmModal.onConfirm}
        onCancel={() => setConfirmModal({ ...confirmModal, isOpen: false })}
      />
    </>
  );
}