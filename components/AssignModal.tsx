'use client';

import React, { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import ConfirmModal from './ConfirmModal';
import PTDetails from './PTDetails';
import { Pickticket } from '@/types/pickticket';

import { createCompiledPallet } from '@/lib/compiledPallets';
import { fetchCompiledPTInfo } from '@/lib/compiledPallets';

import { isPTDefunct } from '@/lib/utils';


interface Lane {
  lane_number: string;
  max_capacity: number;
  current_pallets?: number;
}

interface Container {
  container_number: string;
}

interface LaneAssignment {
  id: number;
  pallet_count: number;
  order_position: number;
  pickticket: Pickticket;
  compiled_pallet_id?: number | null;
}

interface AssignModalProps {
  lane: Lane;
  onClose: () => void;
}

export default function AssignModal({ lane, onClose }: AssignModalProps) {
  const [view, setView] = useState<'existing' | 'add'>('existing');
  const [searchMode, setSearchMode] = useState<'container' | 'pt'>('pt');
  const [existingPTs, setExistingPTs] = useState<LaneAssignment[]>([]);
  const [selectedPTDetails, setSelectedPTDetails] = useState<Pickticket | null>(null);
  const [editingPT, setEditingPT] = useState<{ id: number; count: string; assignmentId: number } | null>(null);
  const [movingPT, setMovingPT] = useState<{ id: number; assignmentId: number; ptId: number; ptNumber: string } | null>(null);
  const [moveLaneInput, setMoveLaneInput] = useState('');
  const [moveLaneError, setMoveLaneError] = useState('');
  const [draggedItem, setDraggedItem] = useState<number | null>(null);
  const [isStaging, setIsStaging] = useState(false);
  const [stagingPUs, setStagingPUs] = useState<string[]>([]);
  const [allUnassignedPTs, setAllUnassignedPTs] = useState<Pickticket[]>([]);

  const [containers, setContainers] = useState<Container[]>([]);
  const [selectedContainer, setSelectedContainer] = useState('');
  const [containerSearch, setContainerSearch] = useState('');

  const [ptSearchQuery, setPtSearchQuery] = useState('');
  const [allPicktickets, setAllPicktickets] = useState<Pickticket[]>([]);

  const [picktickets, setPicktickets] = useState<Pickticket[]>([]);
  const [selectedPTs, setSelectedPTs] = useState<{ [key: number]: string }>({});
  const [loading, setLoading] = useState(false);
  const [allLanes, setAllLanes] = useState<Lane[]>([]);

  const [viewingSearchPTDetails, setViewingSearchPTDetails] = useState<Pickticket | null>(null);

  //defunct pts
  const [mostRecentSync, setMostRecentSync] = useState<Date | null>(null);

  //compiling PTs
  const [compilingPTs, setCompilingPTs] = useState<Set<number>>(new Set());
  const [compilingConfirm, setCompilingConfirm] = useState<number | null>(null);
  const [compiledPalletCount, setCompiledPalletCount] = useState('');
  const [previewCompiledGroups, setPreviewCompiledGroups] = useState<Array<{
    id: number; // temp ID
    ptIds: number[];
    palletCount: number;
  }>>([]);

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

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    checkIfStagingLane();
    fetchExistingPTs();
    fetchContainers();
    fetchAllUnassignedPTs();
    fetchAllLanes();
    fetchMostRecentSync();
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

  useEffect(() => {
    // Refresh capacity display when existingPTs changes
    fetchExistingPTs();
  }, [selectedPTs]);

  async function handleCompile() {
    if (!compilingConfirm || compilingPTs.size === 0) return;

    const count = parseInt(compiledPalletCount);
    if (!count || count < 1) {
      showToast('Invalid pallet count', 'error');
      return;
    }

    if (compilingPTs.size < 2) {
      showToast('Select at least 2 PTs to compile', 'error');
      return;
    }

    const ptIdsArray = Array.from(compilingPTs);

    // Create preview group (don't add to lane yet)
    const newGroup = {
      id: Date.now(), // temp ID
      ptIds: ptIdsArray,
      palletCount: count
    };

    setPreviewCompiledGroups([...previewCompiledGroups, newGroup]);

    // Update pallet counts to the compiled count for display
    const newSelected = { ...selectedPTs };
    ptIdsArray.forEach(id => {
      newSelected[id] = count.toString(); // All PTs show same compiled count
    });
    setSelectedPTs(newSelected);

    setCompilingPTs(new Set());
    setCompilingConfirm(null);
    setCompiledPalletCount('');

    showToast(`✅ Compiled ${ptIdsArray.length} PTs (preview)`, 'success');
  }

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type });
  }

  function showConfirm(title: string, message: string, onConfirm: () => void) {
    setConfirmModal({ isOpen: true, title, message, onConfirm });
  }

  async function checkIfStagingLane() {
    const { data } = await supabase
      .from('shipments')
      .select('id, pu_number, staging_lane, status')
      .eq('staging_lane', lane.lane_number)
      .eq('archived', false)
      .maybeSingle();

    if (data) {
      setIsStaging(true);
      setStagingPUs([data.pu_number]);
      setView('existing'); // Force to existing view
    } else {
      // ALSO check if ANY PTs in this lane have staged/ready_to_ship status
      const { data: stagedPTs } = await supabase
        .from('picktickets')
        .select('pu_number, status')
        .eq('assigned_lane', lane.lane_number)
        .in('status', ['staged', 'ready_to_ship'])
        .limit(1);

      if (stagedPTs && stagedPTs.length > 0) {
        setIsStaging(true);
        setView('existing');
      } else {
        setIsStaging(false);
      }
    }
  }

  async function fetchAllLanes() {
    const { data } = await supabase
      .from('lanes')
      .select('lane_number, max_capacity') // REMOVE current_pallets
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
      compiled_pallet_id,
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
        assigned_lane,
        status,
        pu_number,
        ctn,
        qty,
        last_synced_at,
        compiled_pallet_id
      )
    `)
      .eq('lane_number', lane.lane_number)
      .order('order_position', { ascending: true });

    if (assignments) {
      const formattedAssignments = assignments.map(a => ({
        id: a.id,
        pallet_count: a.pallet_count,
        order_position: a.order_position || 1,
        compiled_pallet_id: a.compiled_pallet_id,
        pickticket: (Array.isArray(a.picktickets) ? a.picktickets[0] : a.picktickets) as any
      })).filter(a => a.pickticket);

      // Fetch compiled PT info
      const ptIds = formattedAssignments.map(a => a.pickticket.id);
      const compiledInfo = await fetchCompiledPTInfo(ptIds);

      // Attach compiled_with info to each PT
      formattedAssignments.forEach(assignment => {
        if (compiledInfo[assignment.pickticket.id]) {
          (assignment.pickticket as any).compiled_with = compiledInfo[assignment.pickticket.id];
        }
      });

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
    // Get most recent sync date first
    const { data: recentPT } = await supabase
      .from('picktickets')
      .select('last_synced_at')
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .single();

    const mostRecentSync = recentPT?.last_synced_at
      ? new Date(recentPT.last_synced_at)
      : null;

    const oneDayAgo = mostRecentSync
      ? new Date(mostRecentSync.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString()  // CHANGED from 2 days to 1 day
      : null;

    const { data } = await supabase
      .from('picktickets')
      .select('*')
      .is('assigned_lane', null)
      .neq('status', 'shipped')
      .neq('customer', 'PAPER')
      .order('pt_number');

    if (data) {
      setAllPicktickets(data);
      setAllUnassignedPTs(data);
    }
  }

  async function fetchPickticketsByContainer(containerNumber: string) {
    // Get most recent sync date first
    const { data: recentPT } = await supabase
      .from('picktickets')
      .select('last_synced_at')
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .single();

    const mostRecentSync = recentPT?.last_synced_at
      ? new Date(recentPT.last_synced_at)
      : null;

    const oneDayAgo = mostRecentSync
      ? new Date(mostRecentSync.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString()  // CHANGED from 2 days to 1 day
      : null;

    const { data } = await supabase
      .from('picktickets')
      .select('*')
      .eq('container_number', containerNumber)
      .is('assigned_lane', null)
      .neq('status', 'shipped')
      .neq('customer', 'PAPER')
      .order('pt_number');

    if (data) setPicktickets(data);
  }

  //fetch most recent sync
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

  function filterPickticketsBySearch() {
    if (!ptSearchQuery.trim()) {
      setPicktickets([]);
      return;
    }

    const searchTerm = ptSearchQuery.trim().toLowerCase();

    const filtered = allPicktickets.filter(pt =>
      (pt.pt_number || '').toLowerCase().includes(searchTerm) ||
      (pt.po_number || '').toLowerCase().includes(searchTerm) ||
      (pt.customer || '').toLowerCase().includes(searchTerm) ||
      (pt.container_number || '').toLowerCase().includes(searchTerm)
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
      showToast('Cannot add new PTs to a staging lane', 'error');
      return;
    }

    if (view === 'add' && ptSearchQuery.trim() !== '') {
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id, pu_number, staging_lane')
        .eq('staging_lane', lane.lane_number)
        .eq('archived', false)
        .maybeSingle();

      if (shipmentData) {
        showToast('Cannot add individual PTs to a staging lane. Use the Shipments page instead.', 'error');
        return;
      }
    }

    setLoading(true);

    try {
      // Check if this lane is a staging lane for any shipment
      const { data: shipmentData } = await supabase
        .from('shipments')
        .select('id, pu_number, staging_lane, status')
        .eq('staging_lane', lane.lane_number)
        .eq('archived', false)
        .maybeSingle();

      const isTargetLaneStaging = !!shipmentData;

      // STEP 1: Process preview compiled groups FIRST
      for (const group of previewCompiledGroups) {
        const result = await createCompiledPallet(group.ptIds, group.palletCount, lane.lane_number);

        if (!result.success) {
          showToast('Failed to create compiled pallet', 'error');
          setLoading(false);
          return;
        }

        // If adding to staging lane, add compiled group to shipment
        if (isTargetLaneStaging && result.compiledId) {
          for (const ptId of group.ptIds) {
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
          }

          // Update PT status for compiled group
          const compiledStatus = shipmentData.status === 'finalized' ? 'ready_to_ship' : 'staged';
          await supabase
            .from('picktickets')
            .update({ status: compiledStatus })
            .in('id', group.ptIds);
        }

        // Remove these PTs from selectedPTs since they're now compiled
        group.ptIds.forEach(id => {
          delete selectedPTs[id];
        });
      }

      // STEP 2: Process remaining individual PTs
      for (const [ptId, palletCountStr] of Object.entries(selectedPTs)) {
        const palletCount = parseInt(palletCountStr) || 1;
        if (palletCount === 0) continue;

        // Shift all existing PTs back by 1
        for (const pt of existingPTs) {
          await supabase
            .from('lane_assignments')
            .update({ order_position: pt.order_position + 1 })
            .eq('id', pt.id);
        }

        // Insert new PT at position 1 (front)
        await supabase
          .from('lane_assignments')
          .insert({
            lane_number: lane.lane_number,
            pt_id: parseInt(ptId),
            pallet_count: palletCount,
            order_position: 1
          });

        // Determine status based on whether it's a staging lane
        const ptStatus = isTargetLaneStaging
          ? (shipmentData.status === 'finalized' ? 'ready_to_ship' : 'staged')
          : 'labeled';

        await supabase
          .from('picktickets')
          .update({
            assigned_lane: lane.lane_number,
            actual_pallet_count: palletCount,
            status: ptStatus
          })
          .eq('id', parseInt(ptId));

        // If adding to a staging lane, add to shipment_pts
        if (isTargetLaneStaging) {
          await supabase
            .from('shipment_pts')
            .upsert({
              shipment_id: shipmentData.id,
              pt_id: parseInt(ptId),
              original_lane: null,
              removed_from_staging: false
            }, {
              onConflict: 'shipment_id,pt_id'
            });
        }
      }

      const totalAssigned = previewCompiledGroups.length + Object.keys(selectedPTs).length;
      showToast(`✅ Assigned ${totalAssigned} PT group(s)`, 'success');

      // Clear everything
      setSelectedPTs({});
      setPreviewCompiledGroups([]);
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
          // DELETE the shipment_pts record
          await supabase
            .from('shipment_pts')
            .delete()
            .eq('pt_id', ptId);

          await supabase
            .from('lane_assignments')
            .delete()
            .eq('id', assignmentId);

          // RESET pallet count and status
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
      showToast('Failed to update', 'error');
    }
  }

  async function handleMoveLane() {
    if (!movingPT || !moveLaneInput.trim()) return;

    const newLaneNumber = moveLaneInput.trim();

    if (allLanes.length === 0) {
      await fetchAllLanes();
      setTimeout(() => handleMoveLane(), 100);
      return;
    }

    const targetLane = allLanes.find(l =>
      String(l.lane_number).trim().toLowerCase() === String(newLaneNumber).trim().toLowerCase()
    );

    if (!targetLane) {
      setMoveLaneError(`Lane "${newLaneNumber}" not found`);
      setTimeout(() => setMoveLaneError(''), 3000);
      return;
    }

    if (String(targetLane.lane_number).trim() === String(lane.lane_number).trim()) {
      setMoveLaneError('Already in this lane');
      setTimeout(() => setMoveLaneError(''), 3000);
      return;
    }

    try {
      const ptToMove = existingPTs.find(pt => pt.id === movingPT.assignmentId);
      if (!ptToMove) return;

      // Calculate current capacity of target lane
      const { data: targetAssignments } = await supabase
        .from('lane_assignments')
        .select('pallet_count, order_position')
        .eq('lane_number', String(targetLane.lane_number));

      const targetCurrentPallets = targetAssignments?.reduce((sum, a) => sum + a.pallet_count, 0) || 0;

      if (targetCurrentPallets + ptToMove.pallet_count > targetLane.max_capacity) {
        setMoveLaneError('Target lane full');
        setTimeout(() => setMoveLaneError(''), 3000);
        return;
      }

      const newPosition = targetAssignments && targetAssignments.length > 0
        ? Math.max(...targetAssignments.map(a => a.order_position)) + 1
        : 1;

      // Update lane assignment
      await supabase
        .from('lane_assignments')
        .update({
          lane_number: String(targetLane.lane_number),
          order_position: newPosition
        })
        .eq('id', movingPT.assignmentId);

      // If compiled, update ALL PTs in the group
      if (ptToMove.compiled_pallet_id) {
        const { data: compiledLinks } = await supabase
          .from('compiled_pallet_pts')
          .select('pt_id')
          .eq('compiled_pallet_id', ptToMove.compiled_pallet_id);

        const ptIds = compiledLinks?.map(l => l.pt_id) || [];

        await supabase
          .from('picktickets')
          .update({ assigned_lane: String(targetLane.lane_number) })
          .in('id', ptIds);
      } else {
        // Single PT
        await supabase
          .from('picktickets')
          .update({ assigned_lane: String(targetLane.lane_number) })
          .eq('id', movingPT.ptId);
      }

      showToast(`PT moved to Lane ${targetLane.lane_number}`, 'success');
      setMovingPT(null);
      setMoveLaneInput('');
      setMoveLaneError('');
      await fetchExistingPTs();
      await checkIfStagingLane();

    } catch (error) {
      console.error('Error moving PT:', error);
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
    const searchTerm = containerSearch.trim().toLowerCase();
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
  const currentPallets = existingPTs.reduce((sum, pt) => sum + pt.pallet_count, 0);
  const totalNewPallets = Object.values(selectedPTs).reduce((sum, countStr) => sum + (parseInt(countStr) || 1), 0);
  const availableCapacity = lane.max_capacity - currentPallets;

  const selectedPTDetails_summary = Object.keys(selectedPTs).map(ptId => {
    // Try to find in current filtered results first
    let pt = picktickets.find(p => p.id === parseInt(ptId));

    // If not found, search in all unassigned PTs
    if (!pt) {
      pt = allUnassignedPTs.find(p => p.id === parseInt(ptId));
    }

    return pt ? { pt, pallets: parseInt(selectedPTs[parseInt(ptId)]) || 1 } : null;
  }).filter(Boolean);

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-2 md:p-4">
        <div className="bg-gray-800 rounded-lg p-3 md:p-6 max-w-7xl w-full max-h-[90vh] overflow-y-auto">
          {/* Header - mobile optimized */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4 md:mb-6">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl md:text-3xl font-bold">Lane {lane.lane_number}</h2>
              {isStaging && (
                <div className="flex flex-wrap items-center gap-2">
                  {existingPTs.every(pt => pt.pickticket.status === 'ready_to_ship') && existingPTs.length > 0 ? (
                    <h2 className="bg-yellow-600 border-2 border-yellow-400 px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-sm md:text-xl">
                      ✈️ Ready to Ship
                    </h2>
                  ) : (
                    <h2 className="bg-purple-700 border-2 border-purple-400 px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-sm md:text-xl">
                      📦 Staging
                    </h2>
                  )}
                  {stagingPUs.length > 0 && (
                    <span className="bg-blue-700 px-2 md:px-4 py-1 md:py-2 rounded-lg font-bold text-xs md:text-base">
                      PU: {stagingPUs.join(', ')}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button onClick={onClose} className="text-3xl md:text-4xl hover:text-red-500 self-end sm:self-auto">&times;</button>
          </div>

          {/* Tab switcher */}
          {existingPTs.length > 0 && !isStaging && (
            <div className="grid grid-cols-2 gap-2 md:gap-4 mb-4 md:mb-6">
              <button
                onClick={() => setView('existing')}
                className={`py-2 md:py-3 rounded-lg font-bold text-sm md:text-lg ${view === 'existing'
                  ? 'bg-blue-600'
                  : 'bg-gray-700 hover:bg-gray-600'
                  }`}
              >
                Current PTs ({existingPTs.length})
              </button>
              <button
                onClick={() => setView('add')}
                className={`py-2 md:py-3 rounded-lg font-bold text-sm md:text-lg ${view === 'add'
                  ? 'bg-green-600'
                  : 'bg-gray-700 hover:bg-gray-600'
                  }`}
              >
                + Add New PT
              </button>
            </div>
          )}

          {/* EXISTING PTs VIEW */}
          {(view === 'existing' || isStaging) && (
            <div>
              <div className="bg-gray-700 p-3 md:p-4 rounded-lg mb-3 md:mb-4">
                <div className="text-sm md:text-lg">
                  <span className="font-bold">Capacity:</span> {currentPallets} / {lane.max_capacity} pallets                </div>
              </div>

              <div className="space-y-2 md:space-y-3">
                {existingPTs.map((assignment, index) => {
                  const palletsInFront = calculatePalletsInFront(index);
                  const depthColor = getDepthColor(palletsInFront, lane.max_capacity);
                  const isCompiled = assignment.pickticket.compiled_with && assignment.pickticket.compiled_with.length > 0;
                  const compiledPTs = isCompiled ? [assignment.pickticket, ...assignment.pickticket.compiled_with!] : [assignment.pickticket];

                  return (
                    <div
                      key={assignment.id}
                      draggable
                      onDragStart={() => handleDragStart(index)}
                      onDragOver={(e) => handleDragOver(e, index)}
                      onDragEnd={handleDragEnd}
                      className={`bg-gray-700 p-2 md:p-4 rounded-lg border-2 cursor-move hover:border-blue-500 transition-all ${isCompiled ? 'border-orange-500' : 'border-gray-600'
                        }`}
                    >
                      <div className="flex items-stretch gap-2 md:gap-4">
                        {/* Position number */}
                        <div className="hidden md:flex flex-shrink-0 w-12 h-12 bg-blue-900 rounded-full items-center justify-center font-bold text-xl">
                          {index + 1}
                        </div>

                        {/* PT Info Container - Can be single or multiple */}
                        <div className="flex-1 flex flex-col gap-2 md:gap-4 min-w-0">
                          {isCompiled && (
                            <div className="bg-orange-600 px-3 py-1 rounded font-bold text-sm inline-block self-start">
                              COMPILED ({compiledPTs.length} PTs)
                            </div>
                          )}

                          {/* Render each PT in the compiled group */}
                          {compiledPTs.map((pt, ptIndex) => (
                            <div key={pt.id} className={`flex-1 ${ptIndex > 0 ? 'border-t-2 border-orange-400 pt-2' : ''}`}>
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <div className="text-base md:text-xl font-bold break-all">PT #{pt.pt_number}</div>
                                <span className={`px-2 py-0.5 md:px-3 md:py-1 rounded-full text-[10px] md:text-xs font-bold ${depthColor}`}>
                                  {palletsInFront} in front ({Math.round((palletsInFront / lane.max_capacity) * 100)}%)
                                </span>
                              </div>
                              <div className="text-xs md:text-sm text-gray-300 break-all">
                                {pt.customer} | PO: {pt.po_number}
                              </div>
                              <div className="text-xs text-gray-400 break-all">
                                Container: {pt.container_number}
                              </div>
                            </div>
                          ))}

                          {/* Edit/Move inputs */}
                          {editingPT && editingPT.id === assignment.id ? (
                            <div className="flex items-center gap-2 mt-2">
                              <input
                                type="text"
                                value={editingPT.count}
                                onChange={(e) => setEditingPT({ ...editingPT, count: e.target.value })}
                                onBlur={(e) => {
                                  if (!e.target.value) setEditingPT({ ...editingPT, count: '1' });
                                }}
                                className="bg-gray-900 text-white p-1 md:p-2 rounded w-16 md:w-20 text-center text-sm"
                              />
                              <button
                                onClick={handleEditPalletCount}
                                className="bg-green-600 hover:bg-green-700 px-2 md:px-3 py-1 rounded text-xs md:text-sm"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingPT(null)}
                                className="bg-gray-600 hover:bg-gray-700 px-2 md:px-3 py-1 rounded text-xs md:text-sm"
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
                                placeholder="Lane #"
                                className={`bg-gray-900 text-white p-1 md:p-2 rounded flex-1 text-sm ${moveLaneError ? 'border-2 border-red-500' : ''}`}
                              />
                              <button
                                onClick={handleMoveLane}
                                className="bg-green-600 hover:bg-green-700 px-2 md:px-4 py-1 md:py-2 rounded text-xs md:text-sm font-semibold"
                              >
                                Move
                              </button>
                              <button
                                onClick={() => {
                                  setMovingPT(null);
                                  setMoveLaneInput('');
                                  setMoveLaneError('');
                                }}
                                className="bg-gray-600 hover:bg-gray-700 px-2 md:px-3 py-1 md:py-2 rounded text-xs md:text-sm"
                              >
                                ✕
                              </button>
                              {moveLaneError && (
                                <div className="absolute -bottom-6 left-0 text-red-500 text-xs md:text-sm animate-fade-in">
                                  {moveLaneError}
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div className="text-sm md:text-lg text-blue-400 mt-1">
                                {assignment.pallet_count} pallet{assignment.pallet_count !== 1 ? 's' : ''}
                              </div>
                              {assignment.pickticket.status === 'ready_to_ship' && isStaging && (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <span className="bg-green-700 text-green-200 px-2 py-0.5 md:px-3 md:py-1 rounded-full text-[10px] md:text-sm font-semibold">
                                    📦 Ready
                                  </span>
                                </div>
                              )}
                            </>
                          )}
                        </div>

                        {/* Action buttons - ONE SET for entire compiled group */}
                        <div className="grid grid-cols-2 md:flex gap-1 md:gap-2">
                          <button
                            onClick={() => setEditingPT({ id: assignment.id, count: assignment.pallet_count.toString(), assignmentId: assignment.id })}
                            className="bg-orange-600 hover:bg-orange-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg font-semibold text-xs md:text-base whitespace-nowrap"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => {
                              setMovingPT({ id: assignment.id, assignmentId: assignment.id, ptId: assignment.pickticket.id, ptNumber: assignment.pickticket.pt_number });
                              fetchAllLanes();
                            }}
                            className="bg-yellow-600 hover:bg-yellow-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg font-semibold text-xs md:text-base whitespace-nowrap"
                          >
                            Move
                          </button>
                          <button
                            onClick={() => setSelectedPTDetails(assignment.pickticket)}
                            className="bg-blue-600 hover:bg-blue-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg font-semibold text-xs md:text-base whitespace-nowrap"
                          >
                            Details
                          </button>
                          <button
                            onClick={() => {
                              if (assignment.compiled_pallet_id) {
                                // Compiled PT - delete entire group
                                showConfirm(
                                  'Remove Compiled Pallet',
                                  `This will remove ALL ${compiledPTs.length} PTs in this compiled group. Continue?`,
                                  async () => {
                                    try {
                                      const { deleteCompiledPallet } = await import('@/lib/compiledPallets');
                                      const success = await deleteCompiledPallet(assignment.compiled_pallet_id!);

                                      if (success) {
                                        showToast('Compiled pallet removed', 'success');
                                        await fetchExistingPTs();
                                        await checkIfStagingLane();
                                      } else {
                                        showToast('Failed to remove', 'error');
                                      }
                                    } catch (error) {
                                      console.error('Error:', error);
                                      showToast('Failed to remove', 'error');
                                    }
                                    setConfirmModal({ ...confirmModal, isOpen: false });
                                  }
                                );
                              } else {
                                // Regular PT
                                handleRemovePT(assignment.id, assignment.pickticket.id);
                              }
                            }}
                            className="bg-red-600 hover:bg-red-700 px-2 md:px-4 py-1.5 md:py-2 rounded-lg font-semibold text-xs md:text-base whitespace-nowrap"
                          >
                            Remove
                          </button>
                        </div>

                        {/* Drag handle */}
                        <div className="flex flex-col justify-center items-center flex-shrink-0 bg-gray-600 cursor-move touch-none px-3 md:px-2 min-w-[40px] md:min-w-0 rounded">
                          <div className="text-gray-300 text-2xl leading-none">⋮</div>
                          <div className="text-gray-300 text-2xl leading-none">⋮</div>
                          <div className="text-gray-300 text-2xl leading-none">⋮</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ADD NEW PT VIEW */}
          {view === 'add' && !isStaging && (
            <div>
              {/* Search mode selector */}
              <div className="flex flex-col sm:flex-row gap-3 md:gap-6">
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
                    className="w-4 h-4 md:w-5 md:h-5"
                  />
                  <span className="text-sm md:text-lg">By PT/PO</span>
                </label>
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
                    className="w-4 h-4 md:w-5 md:h-5"
                  />
                  <span className="text-sm md:text-lg">By Container</span>
                </label>
              </div>

              {/* Container search */}
              {searchMode === 'container' && (
                <div className="mb-4 md:mb-6">
                  <label className="block text-sm md:text-lg font-semibold mb-2">Search Container</label>
                  <input
                    type="text"
                    placeholder="Search (last 4 digits)"
                    value={containerSearch}
                    onChange={(e) => setContainerSearch(e.target.value)}
                    className="w-full bg-gray-700 text-white p-2 md:p-3 rounded-lg text-sm md:text-lg mb-2"
                  />
                  <select
                    value={selectedContainer}
                    onChange={(e) => setSelectedContainer(e.target.value)}
                    className="w-full bg-gray-700 text-white p-2 md:p-3 rounded-lg text-sm md:text-lg"
                    size={6}
                  >
                    <option value="">-- Choose Container --</option>
                    {filteredContainers.map(c => (
                      <option key={c.container_number} value={c.container_number}>
                        {c.container_number}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* PT search */}
              {searchMode === 'pt' && (
                <div className="mb-4 md:mb-6">
                  <label className="block text-sm md:text-lg font-semibold mb-2">Search Picktickets</label>
                  <input
                    type="text"
                    placeholder="PT#, PO#, Customer..."
                    value={ptSearchQuery}
                    onChange={(e) => setPtSearchQuery(e.target.value)}
                    className="w-full bg-gray-700 text-white p-2 md:p-3 rounded-lg text-sm md:text-lg"
                  />
                </div>
              )}

              {/* PT selection grid */}
              {picktickets.length > 0 && (
                <div className="mb-4 md:mb-6">
                  <label className="block text-sm md:text-lg font-semibold mb-2">
                    Select PTs ({picktickets.length} found)
                  </label>

                  <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-6">                    {customers.map(customer => (
                    <div key={customer} className="bg-gray-700 p-3 md:p-4 rounded-lg">
                      <h3 className="text-sm md:text-xl font-bold mb-2 md:mb-4 text-center border-b border-gray-500 pb-2">
                        {customer}
                      </h3>
                      <div className="space-y-2 md:space-y-3">
                        {ptsByCustomer[customer].map(pt => {
                          const isSelected = selectedPTs[pt.id] !== undefined;
                          const isDefunct = isPTDefunct(pt, mostRecentSync); // ADD THIS

                          return (
                            <div
                              key={pt.id}
                              onClick={() => handlePTSelect(pt.id)}
                              className={`p-2 md:p-3 rounded-lg border-2 cursor-pointer transition-all ${isSelected
                                ? 'bg-blue-900 border-blue-500'
                                : 'bg-gray-800 border-gray-600 hover:border-gray-500'
                                }`}
                            >
                              <div className="flex items-start gap-2 md:gap-3">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => { }}
                                  className="w-4 h-4 md:w-5 md:h-5 cursor-pointer mt-0.5 md:mt-1 pointer-events-none"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <div className="font-bold text-sm md:text-base break-all">PT #{pt.pt_number}</div>
                                    {/* ADD DEFUNCT BADGE */}
                                    {isDefunct && (
                                      <span className="bg-red-600 px-1.5 py-0.5 rounded text-[8px] md:text-[10px] font-bold text-white">
                                        DEFUNCT
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] md:text-xs text-gray-300 break-all">
                                    PO: {pt.po_number}
                                  </div>
                                  <div className="text-[10px] md:text-xs text-gray-400 break-all">
                                    Cont: {pt.container_number}
                                  </div>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setViewingSearchPTDetails(pt);
                                    }}
                                    className="mt-1 text-[10px] md:text-xs text-blue-400 hover:text-blue-300 underline"
                                  >
                                    View Details
                                  </button>
                                  {isSelected && (
                                    <div className="flex items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                                      <label className="text-[10px] md:text-xs">Pallets:</label>
                                      <input
                                        type="text"
                                        value={selectedPTs[pt.id]}
                                        onChange={(e) => handlePalletCountChange(pt.id, e.target.value)}
                                        onBlur={(e) => {
                                          if (!e.target.value) handlePalletCountChange(pt.id, '1');
                                        }}
                                        className="bg-gray-900 text-white p-1 rounded w-12 md:w-16 text-center text-xs md:text-sm"
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

              {/* Selected summary - ALWAYS VISIBLE */}
              {/* Selected summary */}
              {view === 'add' && (
                <div className="bg-gray-700 p-3 md:p-4 rounded-lg mb-4 md:mb-6">
                  <h3 className="text-sm md:text-xl font-bold mb-2 md:mb-3">Selected ({selectedPTDetails_summary.length})</h3>
                  {selectedPTDetails_summary.length > 0 ? (
                    <>
                      <div className="space-y-1 md:space-y-2 max-h-48 overflow-y-auto">
                        {/* Group PTs that are in compiled groups */}
                        {(() => {
                          const renderedPTIds = new Set<number>();
                          const elements: React.ReactElement[] = [];

                          // Render compiled groups first
                          previewCompiledGroups.forEach(group => {
                            const groupPTs = selectedPTDetails_summary.filter(item =>
                              item && group.ptIds.includes(item.pt.id)
                            );

                            if (groupPTs.length === 0) return;

                            groupPTs.forEach(item => renderedPTIds.add(item!.pt.id));

                            elements.push(
                              <div key={`compiled-${group.id}`} className="bg-gray-800 p-2 rounded border-2 border-orange-500">
                                <div className="bg-orange-600 px-2 py-1 rounded text-xs font-bold mb-2 inline-block">
                                  COMPILED ({groupPTs.length} PTs)
                                </div>

                                {/* All PTs in the group */}
                                <div className="space-y-2">
                                  {groupPTs.map((item, idx) => {
                                    if (!item) return null;
                                    const isDefunct = isPTDefunct(item.pt, mostRecentSync);

                                    return (
                                      <div key={item.pt.id} className={`${idx > 0 ? 'border-t border-orange-400 pt-2' : ''}`}>
                                        <div className="flex justify-between items-center gap-2">
                                          <div className="text-xs md:text-sm min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <div className="font-bold break-all">PT #{item.pt.pt_number}</div>
                                              {isDefunct && (
                                                <span className="bg-red-600 px-1.5 py-0.5 rounded text-[8px] font-bold text-white">
                                                  DEFUNCT
                                                </span>
                                              )}
                                            </div>
                                            <div className="text-gray-400 break-all">
                                              {item.pt.customer} | PO: {item.pt.po_number}
                                            </div>
                                          </div>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setViewingSearchPTDetails(item.pt);
                                            }}
                                            className="text-[8px] md:text-[8px] text-blue-400 hover:text-blue-300 border rounded p-1"
                                          >
                                            Details
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                {/* Single remove button for entire group */}
                                <div className="flex justify-between items-center mt-2 pt-2 border-t border-orange-400">
                                  <div className="text-orange-400 font-bold text-xs md:text-base">
                                    {group.palletCount}p total
                                  </div>
                                  <button
                                    onClick={() => {
                                      // Remove entire group
                                      setPreviewCompiledGroups(previewCompiledGroups.filter(g => g.id !== group.id));
                                      group.ptIds.forEach(id => handlePTSelect(id));
                                    }}
                                    className="bg-red-600 hover:bg-red-700 px-2 py-1 rounded text-[10px] md:text-sm font-semibold"
                                  >
                                    ✕ Remove Group
                                  </button>
                                </div>
                              </div>
                            );
                          });

                          // Render non-compiled PTs
                          selectedPTDetails_summary.forEach((item, idx) => {
                            if (!item || renderedPTIds.has(item.pt.id)) return;

                            const isDefunct = isPTDefunct(item.pt, mostRecentSync);
                            const isInCompilingSet = compilingPTs.has(item.pt.id);

                            elements.push(
                              <div key={idx} className="bg-gray-800 p-2 rounded flex justify-between items-center gap-2">
                                <div className="text-xs md:text-sm min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <div className="font-bold break-all">PT #{item.pt.pt_number}</div>
                                    {isDefunct && (
                                      <span className="bg-red-600 px-1.5 py-0.5 rounded text-[8px] font-bold text-white">
                                        DEFUNCT
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-gray-400 break-all">
                                    {item.pt.customer} | PO: {item.pt.po_number}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setViewingSearchPTDetails(item.pt);
                                    }}
                                    className="text-[8px] md:text-[8px] text-blue-400 hover:text-blue-300 border rounded p-1"
                                  >
                                    Details
                                  </button>
                                  <div className="text-blue-400 font-bold text-xs md:text-base">{item.pallets}p</div>

                                  {/* Compile button */}
                                  {!compilingConfirm && (
                                    <button
                                      onClick={() => {
                                        if (compilingPTs.has(item.pt.id)) {
                                          const newSet = new Set(compilingPTs);
                                          newSet.delete(item.pt.id);
                                          setCompilingPTs(newSet);
                                        } else {
                                          setCompilingPTs(new Set([...compilingPTs, item.pt.id]));
                                        }
                                      }}
                                      className={`px-2 py-1 rounded text-[10px] md:text-sm font-semibold ${isInCompilingSet
                                        ? 'bg-orange-600 hover:bg-orange-700'
                                        : 'bg-gray-600 hover:bg-gray-500'
                                        }`}
                                    >
                                      {isInCompilingSet ? 'Selected' : 'Compile'}
                                    </button>
                                  )}

                                  {/* Compiled flat button */}
                                  {compilingConfirm && compilingPTs.has(item.pt.id) && (
                                    <div className="bg-orange-600 px-2 py-1 rounded text-[10px] md:text-sm font-semibold">
                                      Compiled
                                    </div>
                                  )}

                                  <button
                                    onClick={() => handlePTSelect(item.pt.id)}
                                    className="bg-red-600 hover:bg-red-700 px-2 py-1 rounded text-[10px] md:text-sm font-semibold"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </div>
                            );
                          });

                          return elements;
                        })()}
                      </div>

                      {/* Compile confirmation UI */}
                      {compilingPTs.size > 0 && !compilingConfirm && (
                        <button
                          onClick={() => setCompilingConfirm(Date.now())}
                          disabled={compilingPTs.size < 2}
                          className="mt-3 w-full bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 px-4 py-2 rounded-lg font-bold"
                        >
                          Confirm Compile ({compilingPTs.size} PTs)
                        </button>
                      )}

                      {compilingConfirm && (
                        <div className="mt-3 bg-orange-900 border-2 border-orange-600 p-3 rounded-lg">
                          <div className="flex flex-col gap-2">
                            <label className="font-semibold text-sm">Compiled Pallet Count:</label>
                            <div className="flex items-center gap-2">
                              <input
                                type="number"
                                min="1"
                                value={compiledPalletCount}
                                onChange={(e) => setCompiledPalletCount(e.target.value)}
                                placeholder="1"
                                className="bg-gray-900 text-white p-2 rounded w-20 md:flex-1 text-center"
                              />
                              <button
                                onClick={handleCompile}
                                className="flex-1 md:flex-none bg-green-600 hover:bg-green-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => {
                                  setCompilingConfirm(null);
                                  setCompilingPTs(new Set());
                                  setCompiledPalletCount('');
                                }}
                                className="flex-1 md:flex-none bg-gray-600 hover:bg-gray-700 px-3 md:px-4 py-2 rounded font-semibold text-sm md:text-base"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-gray-400 text-xs md:text-sm">No PTs selected yet</div>
                  )}
                </div>
              )}

              {/* Capacity warning */}
              {Object.keys(selectedPTs).length > 0 && (
                <div className="bg-gray-700 p-3 md:p-4 rounded-lg mb-4 md:mb-6">
                  <div className="flex flex-col sm:flex-row justify-between gap-2 text-sm md:text-lg">
                    <span>Selected: {Object.keys(selectedPTs).length} PTs</span>
                    <span>Pallets: {totalNewPallets} / {availableCapacity} available</span>
                  </div>
                  {totalNewPallets > availableCapacity && (
                    <div className="text-red-500 mt-2 text-xs md:text-base">⚠️ Exceeds capacity!</div>
                  )}
                </div>
              )}

              {/* Assign button */}
              <button
                onClick={handleAssign}
                disabled={loading || Object.keys(selectedPTs).length === 0 || totalNewPallets > availableCapacity}
                className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed py-3 md:py-4 rounded-lg font-bold text-base md:text-xl"
              >
                {loading ? 'Assigning...' : `Assign ${Object.keys(selectedPTs).length} PTs`}
              </button>
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
      {/* Search PT Details Modal */}
      {viewingSearchPTDetails && (
        <PTDetails
          pt={viewingSearchPTDetails}
          onClose={() => setViewingSearchPTDetails(null)}
        />
      )}
    </>
  );
}