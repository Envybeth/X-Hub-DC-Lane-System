export interface Pickticket {
  id: number;
  pt_number: string;
  po_number: string;
  customer: string;
  container_number: string;
  assigned_lane: string | null;
  store_dc: string;
  start_date: string;
  cancel_date: string;
  actual_pallet_count: number | null;
  status?: string;
  pu_number?: string;
  ctn?: string;
  sample_checked?: boolean;
  sample_labeled?: boolean;
  sample_shipped?: boolean;
  last_synced_at?: string;
  qty?: number | null;
}