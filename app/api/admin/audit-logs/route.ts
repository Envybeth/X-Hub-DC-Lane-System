import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/serverAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { AppRole } from '@/lib/auth';

type AuditLogRow = {
  id: number;
  user_id: string | null;
  action: string;
  target_table: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type UserProfileRow = {
  id: string;
  username: string;
  display_name: string | null;
  role: AppRole;
};

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (!authResult.ok) {
    return authResult.response;
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { searchParams } = new URL(request.url);

  const userId = searchParams.get('userId')?.trim() || '';
  const date = searchParams.get('date')?.trim() || '';
  const limitRaw = Number.parseInt(searchParams.get('limit') || '200', 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;

  let query = supabaseAdmin
    .from('user_action_logs')
    .select('id, user_id, action, target_table, target_id, details, created_at')
    .gte('created_at', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(limit);

  if (userId) {
    query = query.eq('user_id', userId);
  }

  if (date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    query = query.gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
  }

  const { data: logsData, error: logsError } = await query;
  if (logsError) {
    return NextResponse.json(
      { error: `Failed to load audit logs. If this is a new setup, run sql/user_action_logs.sql. (${logsError.message})` },
      { status: 500 }
    );
  }

  const logs = (logsData || []) as AuditLogRow[];
  const actorIds = Array.from(new Set(logs.map((row) => row.user_id).filter((id): id is string => Boolean(id))));

  let profilesById = new Map<string, UserProfileRow>();
  if (actorIds.length > 0) {
    const { data: profilesData } = await supabaseAdmin
      .from('user_profiles')
      .select('id, username, display_name, role')
      .in('id', actorIds);

    const profiles = (profilesData || []) as UserProfileRow[];
    profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  }

  const rows = logs.map((row) => {
    const actor = row.user_id ? profilesById.get(row.user_id) : null;
    return {
      ...row,
      actor_username: actor?.username || null,
      actor_display_name: actor?.display_name || null,
      actor_role: actor?.role || null
    };
  });

  return NextResponse.json({ logs: rows });
}
