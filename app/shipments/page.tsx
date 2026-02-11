'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import ShipmentCard, { Shipment, ShipmentPT } from '@/components/ShipmentCard';

// If these interfaces are not exported from ShipmentCard, uncomment them here:
/*
interface ShipmentPT {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  assigned_lane: string | null;
  actual_pallet_count: number;
  moved_to_staging: boolean;
  container_number?: string;
  store_dc?: string;
  cancel_date?: string;
}

interface Shipment {
  pu_number: string;
  pu_date: string;
  carrier: string;
  pts: ShipmentPT[];
  staging_lane: string | null;
  status: 'not_started' | 'in_process' | 'finalized';
}
*/

export default function ShipmentsPage() {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchShipments();
  }, []);

  async function fetchShipments() {
    setLoading(true);

    try {
      const { data: pts, error } = await supabase
        .from('picktickets')
        .select('id, pt_number, po_number, customer, assigned_lane, actual_pallet_count, container_number, store_dc, cancel_date, start_date, pu_number, pu_date')
        .not('pu_number', 'is', null)
        .not('pu_date', 'is', null);

      if (error) throw error;

      console.log('Found PTs with PU numbers:', pts?.length || 0);

      const groupedShipments: { [key: string]: Shipment } = {};

      pts?.forEach(pt => {
        const key = `${pt.pu_number}-${pt.pu_date}`;

        if (!groupedShipments[key]) {
          groupedShipments[key] = {
            pu_number: pt.pu_number!,
            pu_date: pt.pu_date!,
            carrier: '',
            pts: [],
            staging_lane: null,
            status: 'not_started'
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
          removed_from_staging: false
        });
      });

      for (const shipment of Object.values(groupedShipments)) {
        const { data: stagingData } = await supabase
          .from('shipments')
          .select('staging_lane, status, carrier, id')
          .eq('pu_number', shipment.pu_number)
          .eq('pu_date', shipment.pu_date)
          .single();

        if (stagingData) {
          shipment.staging_lane = stagingData.staging_lane;
          shipment.status = stagingData.status;
          shipment.carrier = stagingData.carrier || shipment.carrier;

          const { data: movedPTs } = await supabase
            .from('shipment_pts')
            .select('pt_id, removed_from_staging')
            .eq('shipment_id', stagingData.id);

          if (movedPTs) {
            shipment.pts.forEach(pt => {
              const movedRecord = movedPTs.find((m: any) => m.pt_id === pt.id);
              if (movedRecord) {
                // Only mark as moved if NOT removed
                pt.moved_to_staging = !movedRecord.removed_from_staging;
                pt.removed_from_staging = movedRecord.removed_from_staging;
              }
            });
          }
        }
      }

      const sortedShipments = Object.values(groupedShipments).sort((a, b) => {
        const dateA = new Date(a.pu_date);
        const dateB = new Date(b.pu_date);
        return dateB.getTime() - dateA.getTime();
      });

      console.log('Grouped shipments count:', sortedShipments.length);
      setShipments(sortedShipments);

    } catch (error) {
      console.error('Error fetching shipments:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 md:mb-8 gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold">Outbound Shipments</h1>
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
        ) : shipments.length === 0 ? (
          <div className="bg-gray-800 p-8 md:p-12 rounded-lg text-center">
            <div className="text-2xl mb-4">No shipments ready</div>
            <p className="text-gray-400">
              Shipments will appear here once PTs have PU numbers and dates assigned.
            </p>
            <p className="text-gray-500 text-sm mt-4">
              Check browser console (F12) for debug info
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {shipments.map((shipment) => (
              <ShipmentCard
                key={`${shipment.pu_number}-${shipment.pu_date}`}
                shipment={shipment}
                onUpdate={fetchShipments}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}