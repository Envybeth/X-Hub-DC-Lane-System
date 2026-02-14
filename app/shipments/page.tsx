'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import ShipmentCard, { Shipment, ShipmentPT } from '@/components/ShipmentCard';

export default function ShipmentsPage() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchShipments();
  }, []);

  async function fetchShipments() {
    setLoading(true);

    try {
      // Get all PTs with PU numbers from Excel sync
      const { data: pts, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date, status, ctn')
        .not('pu_number', 'is', null)
        .not('pu_date', 'is', null)
        .neq('status', 'shipped');

      if (error) throw error;

      console.log('Found PTs with PU numbers:', pts?.length || 0);

      const groupedShipments: { [key: string]: Shipment } = {};

      // Group PTs by PU number + date
      pts?.forEach(pt => {
        const key = `${pt.pu_number}-${pt.pu_date}`;

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: pt.pu_number!,
            pu_date: pt.pu_date!,
            carrier: '',
            pts: [],
            staging_lane: null,
            status: 'not_started',
            archived: false
          };
        }

        groupedShipments[key].pts.push({
          id: pt.id,
          pt_number: pt.pt_number,
          po_number: pt.po_number,
          customer: pt.customer,
          assigned_lane: pt.assigned_lane,
          actual_pallet_count: pt.actual_pallet_count || 0,
          moved_to_staging: false,
          container_number: pt.container_number,
          store_dc: pt.store_dc,
          cancel_date: pt.cancel_date,
          start_date: pt.start_date,
          removed_from_staging: false,
          status: pt.status,
          ctn: pt.ctn  // ADD THIS
        });
      });

      // Check shipments table for staging info and archived status
      for (const shipment of Object.values(groupedShipments)) {
        const { data: stagingData } = await supabase
          .from('shipments')
          .select('staging_lane, status, carrier, id, archived')
          .eq('pu_number', shipment.pu_number)
          .eq('pu_date', shipment.pu_date)
          .maybeSingle();

        if (stagingData) {
          shipment.staging_lane = stagingData.staging_lane;
          shipment.status = stagingData.status;
          shipment.carrier = stagingData.carrier || shipment.carrier;
          shipment.archived = stagingData.archived || false;

          const { data: movedPTs } = await supabase
            .from('shipment_pts')
            .select('pt_id, removed_from_staging')
            .eq('shipment_id', stagingData.id);

          if (movedPTs) {
            shipment.pts.forEach(pt => {
              const movedRecord = movedPTs.find((m: any) => m.pt_id === pt.id);
              if (movedRecord) {
                pt.moved_to_staging = !movedRecord.removed_from_staging;
                pt.removed_from_staging = movedRecord.removed_from_staging;
              }
            });
          }
        }
      }

      // Also get shipped PTs
      const { data: shippedPTs } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date, status, ctn')
        .eq('status', 'shipped')
        .not('pu_number', 'is', null)
        .not('pu_date', 'is', null);

      // Group shipped PTs
      shippedPTs?.forEach(pt => {
        const key = `${pt.pu_number}-${pt.pu_date}`;

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: pt.pu_number!,
            pu_date: pt.pu_date!,
            carrier: '',
            pts: [],
            staging_lane: null,
            status: 'finalized',
            archived: true
          };
        }

        groupedShipments[key].pts.push({
          id: pt.id,
          pt_number: pt.pt_number,
          po_number: pt.po_number,
          customer: pt.customer,
          assigned_lane: pt.assigned_lane,
          actual_pallet_count: pt.actual_pallet_count || 0,
          moved_to_staging: false,
          container_number: pt.container_number,
          store_dc: pt.store_dc,
          cancel_date: pt.cancel_date,
          start_date: pt.start_date,
          removed_from_staging: false,
          status: 'shipped',
          ctn: pt.ctn  // ADD THIS
        });

        groupedShipments[key].archived = true;
      });

      const sortedShipments = Object.values(groupedShipments).sort((a, b) => {
        const dateA = new Date(a.pu_date);
        const dateB = new Date(b.pu_date);
        return dateB.getTime() - dateA.getTime();
      });

      console.log('Total shipments:', sortedShipments.length);
      setShipments(sortedShipments);

    } catch (error) {
      console.error('Error fetching shipments:', error);
    } finally {
      setLoading(false);
    }
  }

  const activeShipments = shipments.filter(s => !s.archived);
  const shippedShipments = shipments.filter(s => s.archived);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 md:mb-8 gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold">📦 Shipment Management</h1>
            <p className="text-gray-400 mt-2 text-sm md:text-base">Manage pickup staging and consolidation</p>
          </div>

          <Link
            href="/"
            className="w-full md:w-auto text-center bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded-lg font-semibold transition-colors"
          >
            ← Back to Lanes
          </Link>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="text-2xl animate-pulse">Loading shipments...</div>
          </div>
        ) : (
          <>
            {/* Active Shipments */}
            <div className="mb-8">
              <h2 className="text-2xl font-bold mb-4">Active Shipments ({activeShipments.length})</h2>
              {activeShipments.length === 0 ? (
                <div className="bg-gray-800 p-8 rounded-lg text-center text-gray-400">
                  No active shipments found
                </div>
              ) : (
                <div className="space-y-4">
                  {activeShipments.map((shipment) => (
                    <ShipmentCard
                      key={`${shipment.pu_number}-${shipment.pu_date}`}
                      shipment={shipment}
                      onUpdate={fetchShipments}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Shipped Shipments */}
            {shippedShipments.length > 0 && (
              <div className="border-t-4 border-green-600 pt-8">
                <h2 className="text-2xl font-bold mb-4 text-green-400">✈️ Shipped ({shippedShipments.length})</h2>
                <div className="space-y-4 opacity-75">
                  {shippedShipments.map((shipment) => (
                    <ShipmentCard
                      key={`${shipment.pu_number}-${shipment.pu_date}`}
                      shipment={shipment}
                      onUpdate={fetchShipments}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}