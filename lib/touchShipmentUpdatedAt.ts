import { supabase } from './supabase';

export async function touchShipmentUpdatedAtById(shipmentId: number | null | undefined) {
  const normalizedId = Number(shipmentId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) return;

  const { error } = await supabase
    .from('shipments')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', normalizedId);

  if (error) {
    console.warn(`Failed to touch shipment ${normalizedId} updated_at`, error);
  }
}

export async function touchShipmentUpdatedAtByLoad(puNumber: string, puDate: string) {
  const normalizedPuNumber = String(puNumber || '').trim();
  const normalizedPuDate = String(puDate || '').trim();
  if (!normalizedPuNumber || !normalizedPuDate) return;

  const { error } = await supabase
    .from('shipments')
    .update({ updated_at: new Date().toISOString() })
    .eq('pu_number', normalizedPuNumber)
    .eq('pu_date', normalizedPuDate);

  if (error) {
    console.warn(`Failed to touch shipment ${normalizedPuNumber} / ${normalizedPuDate} updated_at`, error);
  }
}
