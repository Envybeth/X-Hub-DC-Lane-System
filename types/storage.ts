export interface StorageAssignment {
  id: number;
  container_number: string;
  customer: string;
  lane_number: string;
  active: boolean;
  organized_to_label: boolean;
  organized_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface StorageGroup {
  container_number: string;
  customer: string;
  lane_numbers: string[];
  assignments: StorageAssignment[];
}
