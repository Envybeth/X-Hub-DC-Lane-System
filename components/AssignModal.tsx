'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import ConfirmModal from './ConfirmModal';

interface Lane {
  lane_number: string;
  max_capacity: number;
  current_pallets?: number;
}

interface Container {
  container_number: string;
}

interface Pickticket {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  container_number: string;
  assigned_lane: string | null;
  store_dc: string;
  start_date: string;
  cancel_date: string;
  actual_pallet_count: number;
  status?: string;
  pu_number?: string;
}

interface LaneAssignment {
  id: number;
  pallet_count: number;
  order_position: number;
  pickticket: Pickticket;
}

interface AssignModalProps {
  lane: Lane;
  onClose: () => void;
}

export default function AssignModal({ lane, onClose }: AssignModalProps) {
  const [view, setView] = useState<'existing' | 'add'>('existing');
  const [searchMode, setSearchMode] = useState<'container' | 'pt'>('container');
  const [existingPTs, setExistingPTs] = useState<LaneAssignment[]>([]);
  const [selectedPTDetails, setSelectedPTDetails] = useState<Pickticket | null>(null);
  const [editingPT, setEditingPT] = useState<{ id: number; count: string; assignmentId: number } | null>(null);
  const [movingPT, setMovingPT] = useState<{ id: number; assignmentId: number; ptId: number; ptNumber: string } | null>(null);
  const [moveLaneInput, setMoveLaneInput] = useState('');
  const [moveLaneError, setMoveLaneError] = useState('');
  const [draggedItem, setDraggedItem] = useState<number | null>(null);
  const [isStaging, setIsStaging] = useState(false);
  const [stagingPUs, setStagingPUs] = useState<string[]>([]);

  const [containers, setContainers] = useState<Container[]>([]);
  const [selectedContainer, setSelectedContainer] = useState('');
  const [containerSearch, setContainerSearch] = useState('');

  const [ptSearchQuery, setPtSearchQuery] = useState('');
  const [allPicktickets, setAllPicktickets] = useState<Pickticket[]>([]);

  const [picktickets, setPicktickets] = useState<Pickticket[]>([]);
  const [selectedPTs, setSelectedPTs] = useState<{ [key: number]: string }>({});
  const [loading, setLoading] = useState(false);
  const [allLanes, setAllLanes] = useState<Lane[]>([]);

  // Confirmation modal state
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

  // Success/Error toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    fetchExistingPTs();
    fetchContainers();
    fetchAllUnassignedPTs();
    checkIfStagingLane();
    fetchAllLanes();
  }, []);

  useEffect(() => {
    if (searchMode === 'container' && selectedContainer) {
      fetchPickticketsByContainer(selectedContainer);
    } else {
      setPicktickets([]);
      setSelectedPTs({});
    }
  }, [selectedContainer, searchMode]);

  useEffect(() => {
    if (searchMode === 'pt') {
      filterPickticketsBySearch();
    }
  }, [ptSearchQuery, searchMode]);

  useEffect(() => {
    if (existingPTs.length === 0 && !isStaging) {
      setView('add');
    }
  }, [existingPTs, isStaging]);

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

  async function checkIfStagingLane() {
    const { data: pts } = await supabase
      .from('picktickets')
      .select('status, pu_number')
      .eq('assigned_lane', lane.lane_number);

    if (pts && pts.length > 0) {
      const allReadyToShip = pts.every(pt => pt.status === 'ready_to_ship');
      setIsStaging(allReadyToShip);

      if (allReadyToShip) {
        const uniquePUs = [...new Set(pts.map(pt => pt.pu_number).filter(Boolean))];
        setStagingPUs(uniquePUs as string[]);
      }
    }
  }

  async function fetchAllLanes() {
    const { data } = await supabase
      .from('lanes')
      .select('lane_number, max_capacity, current_pallets')
      .order('lane_number');

    if (data) setAllLanes(data as Lane[]);
  }

  async function fetchExistingPTs() {
    const { data: assignments } = await supabase
      .from('lane_assignments')
      .select(`
        id,
        pallet_count,
        order_position,
        picktickets (
          id,
          pt_number,
          po_number,
          customer,
          container_number,
          store_dc,
          start_date,
          cancel_date,
          actual_pallet_count,
          status,
          pu_number
        )
      `)
      .eq('lane_number', lane.lane_number)
      .order('order_position', { ascending: true });

    if (assignments) {
      const formattedAssignments = assignments.map(a => ({
        id: a.id,
        pallet_count: a.pallet_count,
        order_position: a.order_position || 1,
        pickticket: Array.isArray(a.picktickets) ? a.picktickets[0] : a.picktickets
      })).filter(a => a.pickticket);

      setExistingPTs(formattedAssignments as LaneAssignment[]);
    }
  }

  async function fetchContainers() {
    const { data } = await supabase
      .from('containers')
      .select('container_number')
      .order('container_number');

    if (data) setContainers(data);
  }

  async function fetchAllUnassignedPTs() {
    const { data } = await supabase
      .from('picktickets')
      .select('*')
      .is('assigned_lane', null)
      .order('pt_number');

    if (data) setAllPicktickets(data);
  }

  async function fetchPickticketsByContainer(containerNumber: string) {
    const { data } = await supabase
      .from('picktickets')
      .select('*')
      .eq('container_number', containerNumber)
      .is('assigned_lane', null)
      .order('pt_number');

    if (data) setPicktickets(data);
  }

  function filterPickticketsBySearch() {
    if (!ptSearchQuery.trim()) {
      setPicktickets([]);
      return;
    }

    const searchTerm = ptSearchQuery.trim().toLowerCase();

    const filtered = allPicktickets.filter(pt =>
      pt.pt_number.toLowerCase().includes(ptSearchQuery.toLowerCase()) ||
      pt.po_number.toLowerCase().includes(ptSearchQuery.toLowerCase()) ||
      pt.customer.toLowerCase().includes(ptSearchQuery.toLowerCase()) ||
      pt.container_number.toLowerCase().includes(ptSearchQuery.toLowerCase())
    );

    setPicktickets(filtered);
  }

  function handlePTSelect(ptId: number) {
    setSelectedPTs(prev => {
      const newSelected = { ...prev };
      if (newSelected[ptId] !== undefined) {
        delete newSelected[ptId];
      } else {
        newSelected[ptId] = '1';
      }
      return newSelected;
    });
  }

  function handlePalletCountChange(ptId: number, value: string) {
    setSelectedPTs(prev => ({
      ...prev,
      [ptId]: value
    }));
  }

  async function handleAssign() {
    if (isStaging) {
      showToast('Cannot add new PTs to a staging lane. Only moved shipments can go here.', 'error');
      return;
    }

    setLoading(true);

    try {
      const maxPosition = existingPTs.length > 0
        ? Math.max(...existingPTs.map(pt => pt.order_position))
        : 0;

      let position = maxPosition + 1;

      for (const [ptId, palletCountStr] of Object.entries(selectedPTs)) {
        const palletCount = parseInt(palletCountStr) || 1;
        if (palletCount === 0) continue;

        await supabase
          .from('lane_assignments')
          .insert({
            lane_number: lane.lane_number,
            pt_id: parseInt(ptId),
            pallet_count: palletCount,
            order_position: position
          });

        await supabase
          .from('picktickets')
          .update({
            assigned_lane: lane.lane_number,
            actual_pallet_count: palletCount,
            status: 'labeled'
          })
          .eq('id', parseInt(ptId));

        position++;
      }

      showToast(`✅ Assigned ${Object.keys(selectedPTs).length} PTs to Lane ${lane.lane_number}`, 'success');

      setSelectedPTs({});
      setSelectedContainer('');
      setContainerSearch('');
      setPtSearchQuery('');
      await fetchExistingPTs();
      await fetchAllUnassignedPTs();
      setView('existing');

    } catch (error) {
      console.error('Error assigning PTs:', error);
      showToast('Failed to assign PTs', 'error');
    }

    setLoading(false);
  }

  async function handleRemovePT(assignmentId: number, ptId: number) {
    showConfirm(
      'Remove PT from Lane',
      'Are you sure you want to remove this PT from the lane?',
      async () => {
        try {
          // DELETE the shipment_pts record entirely (don't just mark as removed)
          await supabase
            .from('shipment_pts')
            .delete()
            .eq('pt_id', ptId);

          await supabase
            .from('lane_assignments')
            .delete()
            .eq('id', assignmentId);

          await supabase
            .from('picktickets')
            .update({
              assigned_lane: null,
              actual_pallet_count: null,
              status: 'unlabeled'
            })
            .eq('id', ptId);

          showToast('PT removed from lane', 'success');
          await fetchExistingPTs();
          await checkIfStagingLane();

        } catch (error) {
          console.error('Error removing PT:', error);
          showToast('Failed to remove PT', 'error');
        }

        setConfirmModal({ ...confirmModal, isOpen: false });
      }
    );
  }

  async function handleEditPalletCount() {
    if (!editingPT) return;

    const count = parseInt(editingPT.count) || 1;

    try {
      await supabase
        .from('lane_assignments')
        .update({ pallet_count: count })
        .eq('id', editingPT.assignmentId);

      await supabase
        .from('picktickets')
        .update({ actual_pallet_count: count })
        .eq('id', editingPT.id);

      showToast('Pallet count updated', 'success');
      setEditingPT(null);
      await fetchExistingPTs();

    } catch (error) {
      console.error('Error updating pallet count:', error);
      showToast('Failed to update pallet count', 'error');
    }
  }

  async function handleMoveLane() {
  if (!movingPT || !moveLaneInput.trim()) return;

  const newLaneNumber = moveLaneInput.trim();

  // Safety check: Fetch lanes if we don't have them yet
  if (allLanes.length === 0) {
    console.log('⚠️ allLanes is empty, fetching now...');
    await fetchAllLanes();
    // Give state a moment to update, then retry
    setTimeout(() => handleMoveLane(), 100);
    return;
  }

  console.log('=== DEBUG MOVE LANE ===');
  console.log('Input lane number:', newLaneNumber, typeof newLaneNumber);
  console.log('Current lane number:', lane.lane_number, typeof lane.lane_number);
  console.log('All lanes count:', allLanes.length);
  
  const targetLane = allLanes.find(l => String(l.lane_number).trim() === String(newLaneNumber).trim());
  
  console.log('Found target lane:', targetLane);
  
  if (!targetLane) {
    setMoveLaneError('Invalid lane number');
    setTimeout(() => setMoveLaneError(''), 3000);
    return;
  }

  if (String(newLaneNumber).trim() === String(lane.lane_number).trim()) {
    setMoveLaneError('PT is already in this lane');
    setTimeout(() => setMoveLaneError(''), 3000);
    return;
  }

  try {
    const ptToMove = existingPTs.find(pt => pt.id === movingPT.assignmentId);
    if (!ptToMove) return;

    if ((targetLane.current_pallets || 0) + ptToMove.pallet_count > targetLane.max_capacity) {
      setMoveLaneError('Target lane does not have enough capacity');
      setTimeout(() => setMoveLaneError(''), 3000);
      return;
    }

    const { data: targetAssignments } = await supabase
      .from('lane_assignments')
      .select('order_position')
      .eq('lane_number', String(newLaneNumber))
      .order('order_position', { ascending: false })
      .limit(1);

    const newPosition = targetAssignments && targetAssignments.length > 0 
      ? targetAssignments[0].order_position + 1 
      : 1;

    await supabase
      .from('lane_assignments')
      .update({ 
        lane_number: String(newLaneNumber),
        order_position: newPosition
      })
      .eq('id', movingPT.assignmentId);

    await supabase
      .from('picktickets')
      .update({ assigned_lane: String(newLaneNumber) })
      .eq('id', movingPT.ptId);

    showToast(`PT moved to Lane ${newLaneNumber}`, 'success');
    setMovingPT(null);
    setMoveLaneInput('');
    setMoveLaneError('');
    await fetchExistingPTs();
    await checkIfStagingLane();
    
  } catch (error) {
    console.error('Error moving PT to new lane:', error);
    showToast('Failed to move PT', 'error');
  }
}

  function handleDragStart(index: number) {
    setDraggedItem(index);
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    if (draggedItem === null || draggedItem === index) return;

    const newPTs = [...existingPTs];
    const draggedPT = newPTs[draggedItem];
    newPTs.splice(draggedItem, 1);
    newPTs.splice(index, 0, draggedPT);

    setExistingPTs(newPTs);
    setDraggedItem(index);
  }

  async function handleDragEnd() {
    if (draggedItem === null) return;

    try {
      for (let i = 0; i < existingPTs.length; i++) {
        await supabase
          .from('lane_assignments')
          .update({ order_position: i + 1 })
          .eq('id', existingPTs[i].id);
      }

      setDraggedItem(null);
      await fetchExistingPTs();
    } catch (error) {
      console.error('Error updating order:', error);
      showToast('Failed to update order', 'error');
    }
  }

  function calculatePalletsInFront(index: number): number {
    let total = 0;
    for (let i = 0; i < index; i++) {
      total += existingPTs[i].pallet_count;
    }
    return total;
  }

  function getDepthColor(palletsInFront: number, maxCapacity: number): string {
    const percentage = (palletsInFront / maxCapacity) * 100;

    if (percentage < 20) return 'bg-blue-400 text-blue-900';
    if (percentage < 40) return 'bg-cyan-400 text-cyan-900';
    if (percentage < 60) return 'bg-yellow-400 text-yellow-900';
    if (percentage < 80) return 'bg-orange-500 text-orange-900';
    return 'bg-red-600 text-white';
  }

  const filteredContainers = containers.filter(c => {
    const searchTerm = containerSearch.trim().toLowerCase(); // TRIM HERE
    return c.container_number.toLowerCase().includes(searchTerm) ||
      c.container_number.slice(-4).includes(searchTerm);
  });

  const ptsByCustomer = picktickets.reduce((acc, pt) => {
    const customer = pt.customer || 'OTHER';
    if (!acc[customer]) acc[customer] = [];
    acc[customer].push(pt);
    return acc;
  }, {} as Record<string, Pickticket[]>);

  const customers = Object.keys(ptsByCustomer).sort();
  const totalNewPallets = Object.values(selectedPTs).reduce((sum, countStr) => sum + (parseInt(countStr) || 1), 0);
  const availableCapacity = lane.max_capacity - (lane.current_pallets || 0);

  const selectedPTDetails_summary = Object.keys(selectedPTs).map(ptId => {
    const pt = picktickets.find(p => p.id === parseInt(ptId));
    return pt ? { pt, pallets: parseInt(selectedPTs[parseInt(ptId)]) || 1 } : null;
  }).filter(Boolean);

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-800 rounded-lg p-8 max-w-7xl w-full max-h-[90vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-6">
            <div className="flex items-center gap-4">
              <h2 className="text-3xl font-bold">Lane {lane.lane_number}</h2>
              {isStaging && (
                <div className="flex items-center gap-2">
                  <span className="bg-purple-700 px-4 py-2 rounded-lg font-bold text-xl">
                    📦 STAGING
                  </span>
                  {stagingPUs.length > 0 && (
                    <span className="bg-blue-700 px-4 py-2 rounded-lg font-bold">
                      PU: {stagingPUs.join(', ')}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button onClick={onClose} className="text-4xl hover:text-red-500">&times;</button>
          </div>

          {existingPTs.length > 0 && !isStaging && (
            <div className="flex gap-4 mb-6">
              <button
                onClick={() => setView('existing')}
                className={`flex-1 py-3 rounded-lg font-bold text-lg ${view === 'existing'
                  ? 'bg-blue-600'
                  : 'bg-gray-700 hover:bg-gray-600'
                  }`}
              >
                Current PTs ({existingPTs.length})
              </button>
              <button
                onClick={() => setView('add')}
                className={`flex-1 py-3 rounded-lg font-bold text-lg ${view === 'add'
                  ? 'bg-green-600'
                  : 'bg-gray-700 hover:bg-gray-600'
                  }`}
              >
                + Add New PT
              </button>
            </div>
          )}

          {(view === 'existing' || isStaging) && (
            <div>
              <div className="bg-gray-700 p-4 rounded-lg mb-4">
                <div className="text-lg">
                  <span className="font-bold">Capacity:</span> {lane.current_pallets} / {lane.max_capacity} pallets
                </div>
              </div>

              <div className="space-y-3">
                {existingPTs.map((assignment, index) => {
                  const palletsInFront = calculatePalletsInFront(index);
                  const depthColor = getDepthColor(palletsInFront, lane.max_capacity);

                  return (
                    <div
                      key={assignment.id}
                      draggable
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragEnd={handleDragEnd}
                      className="bg-gray-700 p-4 rounded-lg border-2 border-gray-600 cursor-move hover:border-blue-500 transition-all"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex-shrink-0 w-12 h-12 bg-blue-900 rounded-full flex items-center justify-center font-bold text-xl">
                          {index + 1}
                        </div>

                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2 flex-wrap">
                            <div className="text-xl font-bold">PT #{assignment.pickticket.pt_number}</div>
                            <span className={`px-3 py-1 rounded-full text-xs font-bold ${depthColor}`}>
                              {palletsInFront} pallets in front ({Math.round((palletsInFront / lane.max_capacity) * 100)}% deep)
                            </span>
                          </div>
                          <div className="text-sm text-gray-300">
                            {assignment.pickticket.customer} | PO: {assignment.pickticket.po_number} | Container: {assignment.pickticket.container_number}
                          </div>
                          {editingPT && editingPT.id === assignment.id ? (
                            <div className="flex items-center gap-2 mt-2">
                              <input
                                type="text"
                                value={editingPT.count}
                                onChange={(e) => setEditingPT({ ...editingPT, count: e.target.value })}
                                onBlur={(e) => {
                                  if (!e.target.value) {
                                    setEditingPT({ ...editingPT, count: '1' });
                                  }
                                }}
                                className="bg-gray-900 text-white p-2 rounded w-20 text-center"
                              />
                              <button
                                onClick={handleEditPalletCount}
                                className="bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-sm"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingPT(null)}
                                className="bg-gray-600 hover:bg-gray-700 px-3 py-1 rounded text-sm"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : movingPT && movingPT.id === assignment.id ? (
                            <div className="flex items-center gap-2 mt-2 relative">
                              <input
                                type="text"
                                value={moveLaneInput}
                                onChange={(e) => {
                                  setMoveLaneInput(e.target.value);
                                  setMoveLaneError('');
                                }}
                                placeholder="Enter lane number"
                                className={`bg-gray-900 text-white p-2 rounded flex-1 ${moveLaneError ? 'border-2 border-red-500' : ''}`}
                              />
                              <button
                                onClick={handleMoveLane}
                                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded text-sm font-semibold"
                              >
                                Move
                              </button>
                              <button
                                onClick={() => {
                                  setMovingPT(null);
                                  setMoveLaneInput('');
                                  setMoveLaneError('');
                                }}
                                className="bg-gray-600 hover:bg-gray-700 px-3 py-2 rounded text-sm"
                              >
                                Cancel
                              </button>
                              {moveLaneError && (
                                <div className="absolute -bottom-6 left-0 text-red-500 text-sm animate-fade-in">
                                  {moveLaneError}
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div className="text-lg text-blue-400 mt-1">
                                {assignment.pallet_count} pallets
                              </div>
                              {assignment.pickticket.status === 'ready_to_ship' && (
                                <div className="mt-2 flex items-center gap-2">
                                  <span className="bg-purple-700 text-purple-200 px-3 py-1 rounded-full text-sm font-semibold">
                                    📦 Preparing for Shipment
                                  </span>
                                  {assignment.pickticket.pu_number && (
                                    <span className="bg-blue-700 text-blue-200 px-3 py-1 rounded-full text-sm font-semibold">
                                      PU: {assignment.pickticket.pu_number}
                                    </span>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>

                        <div className="flex gap-3">
                          <button
                            onClick={() => setEditingPT({ id: assignment.id, count: assignment.pallet_count.toString(), assignmentId: assignment.id })}
                            className="bg-orange-600 hover:bg-orange-700 px-4 py-2 rounded-lg font-semibold"
                          >
                            Edit Pallets
                          </button>
                          <button
                            onClick={() => {
                              setMovingPT({ id: assignment.id, assignmentId: assignment.id, ptId: assignment.pickticket.id, ptNumber: assignment.pickticket.pt_number });
                              fetchAllLanes(); // ADD THIS LINE
                            }}

                            className="bg-yellow-600 hover:bg-yellow-700 px-4 py-2 rounded-lg font-semibold"
                          >
                            Move Lane
                          </button>
                          <button
                            onClick={() => setSelectedPTDetails(assignment.pickticket)}
                            className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg font-semibold"
                          >
                            Details
                          </button>
                          <button
                            onClick={() => handleRemovePT(assignment.id, assignment.pickticket.id)}
                            className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-lg font-semibold"
                          >
                            Remove
                          </button>
                        </div>

                        <div className="flex-shrink-0 text-gray-400 text-2xl cursor-move">
                          ⋮⋮
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {view === 'add' && !isStaging && (
            <div>
              <div className="mb-6 bg-gray-700 p-4 rounded-lg">
                <label className="block text-lg font-semibold mb-3">Search Method</label>
                <div className="flex gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="container"
                      checked={searchMode === 'container'}
                      onChange={() => {
                        setSearchMode('container');
                        setPicktickets([]);
                        setSelectedPTs({});
                        setPtSearchQuery('');
                      }}
                      className="w-5 h-5"
                    />
                    <span className="text-lg">Search by Container</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="pt"
                      checked={searchMode === 'pt'}
                      onChange={() => {
                        setSearchMode('pt');
                        setPicktickets([]);
                        setSelectedPTs({});
                        setSelectedContainer('');
                        setContainerSearch('');
                      }}
                      className="w-5 h-5"
                    />
                    <span className="text-lg">Search by PT/PO</span>
                  </label>
                </div>
              </div>

              {searchMode === 'container' && (
                <div className="mb-6">
                  <label className="block text-lg font-semibold mb-2">Search & Select Container</label>
                  <input
                    type="text"
                    placeholder="Search container (e.g., last 4 digits: 1234)"
                    value={containerSearch}
                    onChange={(e) => setContainerSearch(e.target.value)}
                    className="w-full bg-gray-700 text-white p-3 rounded-lg text-lg mb-2"
                  />
                  <select
                    value={selectedContainer}
                    onChange={(e) => setSelectedContainer(e.target.value)}
                    className="w-full bg-gray-700 text-white p-3 rounded-lg text-lg"
                    size={8}
                  >
                    <option value="">-- Choose Container --</option>
                    {filteredContainers.map(c => (
                      <option key={c.container_number} value={c.container_number}>
                        Container {c.container_number}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {searchMode === 'pt' && (
                <div className="mb-6">
                  <label className="block text-lg font-semibold mb-2">Search Picktickets</label>
                  <input
                    type="text"
                    placeholder="Search by PT#, PO#, Customer, or Container..."
                    value={ptSearchQuery}
                    onChange={(e) => setPtSearchQuery(e.target.value)}
                    className="w-full bg-gray-700 text-white p-3 rounded-lg text-lg"
                  />
                  <p className="text-sm text-gray-400 mt-2">
                    💡 Type to search across all unassigned picktickets
                  </p>
                </div>
              )}

              {picktickets.length > 0 && (
                <div className="mb-6">
                  <label className="block text-lg font-semibold mb-2">
                    Select Picktickets ({picktickets.length} found)
                  </label>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {customers.map(customer => (
                      <div key={customer} className="bg-gray-700 p-4 rounded-lg">
                        <h3 className="text-xl font-bold mb-4 text-center border-b border-gray-500 pb-2">
                          {customer}
                        </h3>
                        <div className="space-y-3">
                          {ptsByCustomer[customer].map(pt => {
                            const isSelected = selectedPTs[pt.id] !== undefined;

                            return (
                              <div
                                key={pt.id}
                                onClick={() => handlePTSelect(pt.id)}
                                className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${isSelected
                                  ? 'bg-blue-900 border-blue-500'
                                  : 'bg-gray-800 border-gray-600 hover:border-gray-500'
                                  }`}
                              >
                                <div className="flex items-start gap-3">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => { }}
                                    className="w-5 h-5 cursor-pointer mt-1 pointer-events-none"
                                  />
                                  <div className="flex-1">
                                    <div className="font-bold">PT #{pt.pt_number}</div>
                                    <div className="text-xs text-gray-300">
                                      PO: {pt.po_number}
                                    </div>
                                    <div className="text-xs text-gray-400">
                                      Container: {pt.container_number}
                                    </div>
                                    {isSelected && (
                                      <div className="flex items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                                        <label className="text-xs">Pallets:</label>
                                        <input
                                          type="text"
                                          value={selectedPTs[pt.id]}
                                          onChange={(e) => handlePalletCountChange(pt.id, e.target.value)}
                                          onBlur={(e) => {
                                            if (!e.target.value) {
                                              handlePalletCountChange(pt.id, '1');
                                            }
                                          }}
                                          className="bg-gray-900 text-white p-1 rounded w-16 text-center text-sm"
                                        />
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedPTDetails_summary.length > 0 && (
                <div className="bg-gray-700 p-4 rounded-lg mb-6">
                  <h3 className="text-xl font-bold mb-3">Selected PTs Summary</h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {selectedPTDetails_summary.map((item, idx) => (
                      item && (
                        <div key={idx} className="bg-gray-800 p-2 rounded flex justify-between items-center">
                          <div>
                            <span className="font-bold">PT #{item.pt.pt_number}</span>
                            <span className="text-sm text-gray-400 ml-2">
                              ({item.pt.customer} | PO: {item.pt.po_number} | Cont: {item.pt.container_number})
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-blue-400 font-bold">{item.pallets} pallets</div>
                            <button
                              onClick={() => handlePTSelect(item.pt.id)}
                              className="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm font-semibold"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )
                    ))}
                  </div>
                </div>
              )}

              {Object.keys(selectedPTs).length > 0 && (
                <div className="bg-gray-700 p-4 rounded-lg mb-6">
                  <div className="flex justify-between text-lg">
                    <span>Selected PTs: {Object.keys(selectedPTs).length}</span>
                    <span>Total New Pallets: {totalNewPallets} / {availableCapacity} available</span>
                  </div>
                  {totalNewPallets > availableCapacity && (
                    <div className="text-red-500 mt-2">⚠️ Would exceed lane capacity!</div>
                  )}
                </div>
              )}

              <button
                onClick={handleAssign}
                disabled={loading || Object.keys(selectedPTs).length === 0 || totalNewPallets > availableCapacity}
                className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed py-4 rounded-lg font-bold text-xl"
              >
                {loading ? 'Assigning...' : `Assign ${Object.keys(selectedPTs).length} PTs to Lane ${lane.lane_number}`}
              </button>
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

                <div className="space-y-4">
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
                        {selectedPTDetails.actual_pallet_count || 'TBD'}
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
                    {selectedPTDetails.status && (
                      <div className="col-span-2">
                        <div className="text-sm text-gray-400">Status</div>
                        <div className="text-lg">
                          {selectedPTDetails.status === 'ready_to_ship' ? (
                            <span className="bg-purple-700 text-purple-200 px-3 py-1 rounded-full text-sm font-semibold">
                              📦 Preparing for Shipment
                            </span>
                          ) : (
                            <span className="text-gray-300">{selectedPTDetails.status}</span>
                          )}
                        </div>
                      </div>
                    )}
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
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-[110] px-6 py-3 rounded-lg font-semibold shadow-lg animate-fade-in ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'
          }`}>
          {toast.message}
        </div>
      )}

      {/* Confirmation Modal */}
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