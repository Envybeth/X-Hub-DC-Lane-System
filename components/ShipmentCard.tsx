'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import ConfirmModal from './ConfirmModal';
import PTDetails from './PTDetails';

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
  status?: string;
  ctn?: string;
}

export interface Shipment {
  pu_number: string;
  pu_date: string;
  carrier: string;
  pts: ShipmentPT[];
  staging_lane: string | null;
  status: 'not_started' | 'in_process' | 'finalized';
  archived?: boolean;
}

export interface ShipmentCardProps {
  shipment: Shipment;
  onUpdate: () => void;
}

export default function ShipmentCard({ shipment, onUpdate }: ShipmentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectingLane, setSelectingLane] = useState(false);
  const [selectedLaneInput, setSelectedLaneInput] = useState('');
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

  // THE WATCHDOG: Automatically syncs any PT placed into the staging lane into a "ready_to_ship" state.
  useEffect(() => {
    const unsyncedPTs = shipment.pts.filter(pt =>
      pt.assigned_lane === shipment.staging_lane &&
      (!pt.moved_to_staging || pt.removed_from_staging)
    );

    if (unsyncedPTs.length > 0 && shipment.staging_lane) {
      autoSyncPTs(unsyncedPTs);
    }
  }, [shipment.pts, shipment.staging_lane]);

  async function autoSyncPTs(ptsToSync: ShipmentPT[]) {
    try {
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id')
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date)
        .single();

      if (!shipmentData) return;

      let syncedCount = 0;
      for (const pt of ptsToSync) {
        await supabase
          .from('shipment_pts')
          .upsert({
            shipment_id: shipmentData.id,
            pt_id: pt.id,
            original_lane: pt.assigned_lane,
            removed_from_staging: false
          }, { onConflict: 'shipment_id,pt_id' });

        await supabase
          .from('picktickets')
          .update({ status: 'ready_to_ship' })
          .eq('id', pt.id);

        syncedCount++;
      }
      if (syncedCount > 0) {
        onUpdate();
        showToast(`${syncedCount} rogue PT(s) auto-staged`, 'success');
      }
    } catch (error) {
      console.error('Auto-sync failed:', error);
    }
  }

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

  async function handleSetStagingLane() {
    if (!selectedLaneInput.trim()) {
      showToast('Please enter a lane number', 'error');
      return;
    }

    const laneNumber = parseInt(selectedLaneInput.trim());
    if (isNaN(laneNumber)) {
      showToast('Please enter a valid lane number', 'error');
      return;
    }

    // Check if lane has existing PTs
    const { data: existingPTs } = await supabase
      .from('lane_assignments')
      .select('id, pt_id')
      .eq('lane_number', laneNumber);

    if (existingPTs && existingPTs.length > 0) {
      showConfirm(
        'Lane Has PTs',
        `⚠️ Warning: Lane ${laneNumber} has ${existingPTs.length} PT(s) assigned.\n\nAre you sure you want to use this lane for staging?`,
        async () => {
          await performSetStagingLane(laneNumber, existingPTs.map(pt => pt.pt_id));
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    } else {
      await performSetStagingLane(laneNumber, []);
    }
  }

  async function performSetStagingLane(laneNumber: number, existingPTIds: number[]) {
    try {
      // Create/update shipment
      const { data: shipmentData, error: shipmentError } = await supabase
        .from('shipments')
        .upsert({
          pu_number: shipment.pu_number,
          pu_date: shipment.pu_date,
          carrier: shipment.carrier,
          staging_lane: laneNumber.toString(),
          status: 'in_process',
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'pu_number,pu_date'
        })
        .select()
        .single();

      if (shipmentError) throw shipmentError;

      // Automatically stage any PTs that belong to this shipment AND are already in the target lane
      const shipmentPTIds = shipment.pts.map(pt => pt.id);
      const ptsToMarkAsStaged = new Set<number>();

      shipment.pts.forEach(pt => {
        if (pt.assigned_lane === laneNumber.toString()) {
          ptsToMarkAsStaged.add(pt.id);
        }
      });
      existingPTIds.forEach(id => {
        if (shipmentPTIds.includes(id)) {
          ptsToMarkAsStaged.add(id);
        }
      });

      const ptsArray = Array.from(ptsToMarkAsStaged);

      for (const ptId of ptsArray) {
        await supabase
          .from('shipment_pts')
          .upsert({
            shipment_id: shipmentData.id,
            pt_id: ptId,
            original_lane: null,
            removed_from_staging: false
          }, {
            onConflict: 'shipment_id,pt_id'
          });

        await supabase
          .from('picktickets')
          .update({ status: 'ready_to_ship', assigned_lane: laneNumber.toString() })
          .eq('id', ptId);
      }

      if (ptsArray.length > 0) {
        showToast(`Staging lane ${laneNumber} set (${ptsArray.length} PTs swept into staging)`, 'success');
      } else {
        showToast(`Staging lane ${laneNumber} set`, 'success');
      }

      setSelectingLane(false);
      setSelectedLaneInput('');
      onUpdate();
    } catch (error) {
      console.error('Error setting staging lane:', error);
      showToast('Failed to set staging lane', 'error');
    }
  }

  async function handleChangeStagingLane() {
    if (!newStagingLane.trim() || !shipment.staging_lane) return;

    const targetLaneNumber = parseInt(newStagingLane.trim());

    if (isNaN(targetLaneNumber)) {
      setStagingLaneError('Invalid lane number');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    if (targetLaneNumber.toString() === shipment.staging_lane) {
      setStagingLaneError('Already staging lane');
      setTimeout(() => setStagingLaneError(''), 3000);
      return;
    }

    const { data: existingPTs } = await supabase
      .from('lane_assignments')
      .select('id')
      .eq('lane_number', targetLaneNumber);

    if (existingPTs && existingPTs.length > 0) {
      showConfirm(
        'Lane Has PTs',
        `⚠️ Warning: Lane ${targetLaneNumber} has ${existingPTs.length} PT(s) assigned.\n\nMove staging lane anyway?`,
        async () => {
          await performChangeStagingLane(targetLaneNumber);
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    } else {
      showConfirm(
        'Change Staging Lane',
        `Move all PTs from Lane ${shipment.staging_lane} to Lane ${targetLaneNumber}?`,
        async () => {
          await performChangeStagingLane(targetLaneNumber);
          setConfirmModal({ ...confirmModal, isOpen: false });
        }
      );
    }
  }

  async function performChangeStagingLane(targetLaneNumber: number) {
    try {
      const stagedPTs = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging);

      await supabase
        .from('shipments')
        .update({
          staging_lane: targetLaneNumber.toString(),
          updated_at: new Date().toISOString()
        })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      for (const pt of stagedPTs) {
        await supabase
          .from('picktickets')
          .update({ assigned_lane: targetLaneNumber.toString() })
          .eq('id', pt.id);

        await supabase
          .from('lane_assignments')
          .update({ lane_number: targetLaneNumber.toString() })
          .eq('pt_id', pt.id)
          .eq('lane_number', shipment.staging_lane);
      }

      showToast(`Moved to Lane ${targetLaneNumber}`, 'success');
      setChangingStagingLane(false);
      setNewStagingLane('');
      setStagingLaneError('');
      onUpdate();
    } catch (error) {
      console.error('Error changing staging lane:', error);
      showToast('Failed to change lane', 'error');
    }
  }

  async function handleDeleteStagingData() {
    if (deleteConfirmText !== 'DELETE') {
      showToast('Type DELETE to confirm', 'error');
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

      const stagedPTs = shipment.pts.filter(pt => pt.moved_to_staging && !pt.removed_from_staging);

      for (const pt of stagedPTs) {
        await supabase
          .from('lane_assignments')
          .delete()
          .eq('pt_id', pt.id)
          .eq('lane_number', shipment.staging_lane);

        await supabase
          .from('picktickets')
          .update({
            assigned_lane: null,
            actual_pallet_count: null,
            status: 'labeled'
          })
          .eq('id', pt.id);
      }

      await supabase
        .from('shipment_pts')
        .delete()
        .eq('shipment_id', shipmentData.id);

      await supabase
        .from('shipments')
        .update({
          status: 'not_started',
          staging_lane: null,
          updated_at: new Date().toISOString()
        })
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date);

      showToast('Staging data cleared', 'success');
      setDeletingShipment(false);
      setDeleteConfirmText('');
      onUpdate();
    } catch (error) {
      console.error('Error deleting staging data:', error);
      showToast('Failed to clear data', 'error');
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

      showToast('Status updated', 'success');
      setEditingStatus(false);
      onUpdate();
    } catch (error) {
      console.error('Error updating status:', error);
      showToast('Failed to update', 'error');
    }
  }

  async function handleMovePT(pt: ShipmentPT) {
    if (!shipment.staging_lane) {
      showToast('Select staging lane first', 'error');
      return;
    }

    try {
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id, status')
        .eq('pu_number', shipment.pu_number)
        .eq('pu_date', shipment.pu_date)
        .single();

      if (!shipmentData) throw new Error('Shipment not found');

      // Add to shipment_pts
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

      // Determine status based on shipment state
      const ptStatus = shipmentData.status === 'finalized' ? 'ready_to_ship' : 'staged';

      // Update PT
      await supabase
        .from('picktickets')
        .update({
          assigned_lane: shipment.staging_lane,
          status: ptStatus
        })
        .eq('id', pt.id);

      // Remove old lane assignment if exists
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

      // Get next position in staging lane
      const { data: existingAssignments } = await supabase
        .from('lane_assignments')
        .select('order_position')
        .eq('lane_number', shipment.staging_lane)
        .order('order_position', { ascending: false })
        .limit(1);

      const newPosition = existingAssignments && existingAssignments.length > 0
        ? existingAssignments[0].order_position + 1
        : 1;

      // Add to staging lane
      await supabase
        .from('lane_assignments')
        .insert({
          lane_number: shipment.staging_lane,
          pt_id: pt.id,
          pallet_count: pt.actual_pallet_count,
          order_position: newPosition
        });

      showToast(`PT moved to staging`, 'success');
      onUpdate();
    } catch (error) {
      console.error('Error moving PT:', error);
      showToast('Failed to move PT', 'error');
    }
  }

  async function handleFinalizeShipment() {
    const allMoved = shipment.pts.every(pt => pt.moved_to_staging && !pt.removed_from_staging);

    if (!allMoved) {
      showConfirm(
        'Finalize Shipment',
        'Not all PTs moved to staging. Finalize anyway?',
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

      // UPDATE ALL STAGED PTs TO ready_to_ship
      const stagedPTIds = shipment.pts
        .filter(pt => pt.moved_to_staging && !pt.removed_from_staging)
        .map(pt => pt.id);

      if (stagedPTIds.length > 0) {
        await supabase
          .from('picktickets')
          .update({ status: 'ready_to_ship' })
          .in('id', stagedPTIds);
      }

      showToast('Shipment finalized!', 'success');
      onUpdate();
    } catch (error) {
      console.error('Error finalizing shipment:', error);
      showToast('Failed to finalize', 'error');
    }
  }

  return (
    <>
      <div className="bg-gray-800 rounded-lg border-2 border-gray-600">
        {/* Header - mobile responsive */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full p-3 md:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between hover:bg-gray-750 transition-colors gap-3"
        >
          <div className="flex items-center gap-3 md:gap-6 w-full sm:w-auto">
            <div className="text-xl md:text-2xl text-blue-400">
              {expanded ? '▼' : '▶'}
            </div>
            <div className="text-left flex-1">
              <div className="text-lg md:text-2xl font-bold break-all">PU #{shipment.pu_number}</div>
              <div className="text-xs md:text-sm text-gray-400 mt-1 break-all">
                {shipment.carrier} | {shipment.pu_date} | {shipment.pts.length} PTs | {totalPallets}p
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <div className={`px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-xs md:text-base ${statusConfig[shipment.status].color}`}>
              {statusConfig[shipment.status].label}
            </div>
            {shipment.staging_lane && (
              <div className="bg-purple-700 px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-xs md:text-base">
                Staging: L{shipment.staging_lane}
              </div>
            )}
          </div>
        </button>

        {/* Expanded content */}
        {expanded && (
          <div className="p-3 md:p-6 border-t-2 border-gray-600 space-y-4 md:space-y-6">
            {/* Action buttons - wrap on mobile */}
            {/* Only show action buttons if NOT archived */}
            {!shipment.archived && shipment.staging_lane && (
              <>
                {/* Clear Data Button - Always Visible */}
                {!deletingShipment ? (
                  <button
                    onClick={() => setDeletingShipment(true)}
                    className="bg-red-600 hover:bg-red-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                  >
                    Reset Shipment
                  </button>
                ) : (
                  <div className="w-full bg-red-900 border-2 border-red-600 p-3 md:p-4 rounded-lg">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 md:gap-3">
                      <label className="font-semibold text-white text-sm md:text-base whitespace-nowrap">Type DELETE:</label>
                      <input
                        type="text"
                        value={deleteConfirmText}
                        onChange={(e) => setDeleteConfirmText(e.target.value)}
                        placeholder="DELETE"
                        className="bg-gray-900 text-white p-2 rounded flex-1 w-full uppercase text-sm md:text-base"
                      />
                      <div className="flex gap-2 w-full sm:w-auto">
                        <button
                          onClick={handleDeleteStagingData}
                          disabled={deleteConfirmText !== 'DELETE'}
                          className="flex-1 sm:flex-none bg-red-700 hover:bg-red-800 disabled:bg-gray-600 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => {
                            setDeletingShipment(false);
                            setDeleteConfirmText('');
                          }}
                          className="flex-1 sm:flex-none bg-gray-600 hover:bg-gray-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Change Lane Button */}
                {shipment.staging_lane && !changingStagingLane && (
                  <button
                    onClick={() => setChangingStagingLane(true)}
                    className="bg-purple-600 hover:bg-purple-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                  >
                    Change Lane
                  </button>
                )}

                {changingStagingLane && (
                  <div className="w-full bg-gray-700 p-3 md:p-4 rounded-lg relative">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 md:gap-3">
                      <label className="font-semibold text-sm md:text-base whitespace-nowrap">New Lane:</label>
                      <input
                        type="text"
                        value={newStagingLane}
                        onChange={(e) => {
                          setNewStagingLane(e.target.value);
                          setStagingLaneError('');
                        }}
                        placeholder="Enter lane number"
                        className={`bg-gray-900 text-white p-2 rounded flex-1 w-full text-sm md:text-base ${stagingLaneError ? 'border-2 border-red-500' : ''}`}
                      />
                      <div className="flex gap-2 w-full sm:w-auto">
                        <button
                          onClick={handleChangeStagingLane}
                          className="flex-1 sm:flex-none bg-green-600 hover:bg-green-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Move
                        </button>
                        <button
                          onClick={() => {
                            setChangingStagingLane(false);
                            setNewStagingLane('');
                            setStagingLaneError('');
                          }}
                          className="flex-1 sm:flex-none bg-gray-600 hover:bg-gray-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    {stagingLaneError && (
                      <div className="mt-2 text-red-500 text-xs md:text-sm animate-fade-in">
                        {stagingLaneError}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Staging lane selection - TEXT INPUT */}
            {!shipment.staging_lane && !shipment.archived ? (
              <div className="bg-yellow-900 border-2 border-yellow-600 p-3 md:p-4 rounded-lg">
                <div className="font-bold text-base md:text-xl mb-2 md:mb-3">⚠️ Select Staging Lane</div>
                <p className="text-xs md:text-sm mb-3 md:mb-4">Enter a lane number to consolidate all PTs</p>
                {!selectingLane ? (
                  <button
                    onClick={() => setSelectingLane(true)}
                    className="bg-blue-600 hover:bg-blue-700 px-4 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base"
                  >
                    Select Lane
                  </button>
                ) : (
                  <div className="flex flex-col sm:flex-row gap-2 md:gap-3">
                    <input
                      type="text"
                      value={selectedLaneInput}
                      onChange={(e) => setSelectedLaneInput(e.target.value)}
                      placeholder="Enter lane number (e.g., 101)"
                      className="flex-1 bg-gray-900 text-white p-2 md:p-3 rounded-lg text-sm md:text-base"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleSetStagingLane}
                        className="flex-1 sm:flex-none bg-green-600 hover:bg-green-700 px-4 md:px-6 py-2 rounded-lg font-bold text-sm md:text-base"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => {
                          setSelectingLane(false);
                          setSelectedLaneInput('');
                        }}
                        className="flex-1 sm:flex-none bg-gray-600 hover:bg-gray-700 px-4 md:px-6 py-2 rounded-lg text-sm md:text-base"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : shipment.staging_lane && !shipment.archived ? (
              <div className="bg-gray-700 p-3 md:p-4 rounded-lg">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                  <div>
                    <div className="font-bold text-sm md:text-lg">Staging Progress</div>
                    <div className="text-xs md:text-sm text-gray-400 mt-1">
                      {movedCount} of {shipment.pts.length} PTs → Lane {shipment.staging_lane}
                    </div>
                  </div>
                  {shipment.status !== 'finalized' && (
                    <button
                      onClick={handleFinalizeShipment}
                      className="w-full sm:w-auto bg-green-600 hover:bg-green-700 px-4 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base"
                    >
                      Finalize
                    </button>
                  )}
                  {shipment.status === 'finalized' && !shipment.archived && (
                    <button
                      onClick={() => showConfirm(
                        'Mark as Shipped',
                        'This will clear the staging lane and archive this shipment. Continue?',
                        async () => {
                          try {
                            // Archive shipment AND clear staging lane
                            await supabase
                              .from('shipments')
                              .update({
                                archived: true,
                                staging_lane: null,
                                updated_at: new Date().toISOString()
                              })
                              .eq('pu_number', shipment.pu_number)
                              .eq('pu_date', shipment.pu_date);

                            // Get PT IDs directly from picktickets by pu_number and pu_date
                            const { data: ptsToShip } = await supabase
                              .from('picktickets')
                              .select('id')
                              .eq('pu_number', shipment.pu_number)
                              .eq('pu_date', shipment.pu_date);

                            const ptIds = ptsToShip?.map(pt => pt.id) || [];

                            if (ptIds.length === 0) {
                              showToast('No PTs found to ship', 'error');
                              return;
                            }

                            // Clear lane assignments
                            await supabase
                              .from('lane_assignments')
                              .delete()
                              .in('pt_id', ptIds);

                            // Update PTs to shipped status
                            await supabase
                              .from('picktickets')
                              .update({
                                assigned_lane: null,
                                actual_pallet_count: null,
                                status: 'shipped'
                              })
                              .in('id', ptIds);

                            console.log(`✅ Marked ${ptIds.length} PTs as shipped`);

                            showToast('Shipment marked as shipped!', 'success');
                            onUpdate();
                          } catch (error) {
                            console.error('Error marking as shipped:', error);
                            showToast('Failed to mark as shipped', 'error');
                          }
                          setConfirmModal({ ...confirmModal, isOpen: false });
                        }
                      )}
                      className="bg-green-600 hover:bg-green-700 px-3 md:px-6 py-2 md:py-3 rounded-lg font-bold text-sm md:text-base whitespace-nowrap"
                    >
                      ✈️ Mark as Shipped
                    </button>
                  )}
                </div>
              </div>
            ) : null}

            {/* PT List */}
            <div className="space-y-4 md:space-y-6">
              <h3 className="text-base md:text-xl font-bold">Picktickets</h3>
              {sortedLanes.map(laneKey => {
                const isStaging = laneKey.startsWith('staging_');
                const actualLaneNumber = isStaging ? laneKey.replace('staging_', '') : laneKey;

                return (
                  <div key={laneKey} className="space-y-2 md:space-y-3">
                    {isStaging ? (
                      <h4 className="text-lg md:text-2xl font-bold text-purple-400 border-b-2 border-purple-700 pb-2">
                        📦 STAGING (L{actualLaneNumber}) - {ptsByLane[laneKey].length}
                      </h4>
                    ) : (
                      <h4 className="text-sm md:text-lg font-semibold text-blue-400 border-b border-blue-700 pb-2">
                        {laneKey === 'unassigned' ? '⚠️ Unassigned' : `L${laneKey} (${ptsByLane[laneKey].length})`}
                      </h4>
                    )}
                    {ptsByLane[laneKey].map(pt => {
                      const depthInfo = ptDepthInfo[pt.id];
                      const depthColor = depthInfo
                        ? getDepthColor(depthInfo.palletsInFront, depthInfo.maxCapacity)
                        : '';

                      const hasLaneAssigned = pt.assigned_lane && pt.assigned_lane !== shipment.staging_lane;
                      const isCurrentlyStaged = pt.moved_to_staging && !pt.removed_from_staging;
                      const canMoveToStaging = hasLaneAssigned && !isCurrentlyStaged && shipment.staging_lane && shipment.status !== 'finalized';
                      const isShipped = pt.status === 'shipped';
                      return (
                        <div
                          key={pt.id}
                          className={`p-2 md:p-4 rounded-lg border-2 ${isCurrentlyStaged
                            ? 'bg-green-900 border-green-600'
                            : !pt.assigned_lane
                              ? 'bg-gray-700 border-gray-600'
                              : 'bg-gray-700 border-gray-600'
                            }`}
                        >
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start gap-2">
                                {isCurrentlyStaged && (
                                  <div className="text-lg md:text-2xl text-green-400 flex-shrink-0">✓</div>
                                )}
                                {!pt.assigned_lane && (
                                  <div className="text-lg md:text-2xl text-yellow-400 flex-shrink-0">⚠️</div>
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="text-lg md:text-lg font-bold break-all">
                                    PT #{pt.pt_number} | PO: {pt.po_number}
                                  </div>
                                  <div className="text-xs md:text-sm text-gray-300 break-all">
                                    {pt.customer} | {pt.actual_pallet_count}p
                                  </div>
                                  {pt.assigned_lane && (
                                    <div className="flex flex-wrap items-center gap-2 mt-1 md:mt-2">
                                      <div className="text-base md:text-xl font-bold text-white">
                                        L{pt.assigned_lane}
                                      </div>
                                      {depthInfo && (
                                        <span className={`px-2 py-0.5 md:px-3 md:py-1 rounded-full text-[10px] md:text-xs font-bold ${depthColor}`}>
                                          {depthInfo.palletsInFront}p ({Math.round((depthInfo.palletsInFront / depthInfo.maxCapacity) * 100)}%)
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {!pt.assigned_lane && (
                                    <div className="text-xs md:text-sm text-gray-400 mt-1">
                                      NOT ASSIGNED
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => setSelectedPTDetails(pt)}
                                className="bg-blue-600 hover:bg-blue-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg font-semibold text-xs md:text-base"
                              >
                                Details
                              </button>
                              {canMoveToStaging && (
                                <button
                                  onClick={() => handleMovePT(pt)}
                                  className="bg-green-600 hover:bg-green-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg font-semibold text-xs md:text-base whitespace-nowrap"
                                >
                                  ✓ Stage
                                </button>
                              )}
                              {!pt.assigned_lane && !isShipped && (
                                <div className="bg-yellow-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg text-xs md:text-sm font-semibold whitespace-nowrap">
                                  Assign first
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

        {/* PT Details Modal */}
        {selectedPTDetails && (
          <PTDetails
            pt={selectedPTDetails}
            onClose={() => setSelectedPTDetails(null)}
          />
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-[110] px-4 md:px-6 py-2 md:py-3 rounded-lg font-semibold shadow-lg animate-fade-in text-sm md:text-base ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
          }`}>
          {toast.message}
        </div>
      )}

      {/* Confirm Modal */}
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