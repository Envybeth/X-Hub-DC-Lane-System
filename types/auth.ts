import { AppRole } from '@/lib/auth';

export interface UserProfile {
  id: string;
  username: string;
  display_name: string | null;
  role: AppRole;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}
