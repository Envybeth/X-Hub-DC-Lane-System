import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { UserProfile } from '@/types/auth';
import { AppRole } from './auth';
import { getSupabaseAdmin } from './supabaseAdmin';

interface AdminAuthSuccess {
  ok: true;
  userId: string;
  profile: UserProfile;
}

interface AdminAuthFailure {
  ok: false;
  response: NextResponse;
}

export type AdminAuthResult = AdminAuthSuccess | AdminAuthFailure;

async function requireAnyRole(request: NextRequest, allowedRoles: AppRole[]): Promise<AdminAuthResult> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Supabase client env vars are missing.' }, { status: 500 })
    };
  }

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Missing bearer token.' }, { status: 401 })
    };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: userResult, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userResult.user) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid session.' }, { status: 401 })
    };
  }

  // Use service-role for profile lookup after token validation.
  // The previous anon client query could run as anonymous and miss rows behind RLS.
  const supabaseAdmin = getSupabaseAdmin();
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, username, display_name, role, active, created_at, updated_at')
    .eq('id', userResult.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `User profile not found for user id: ${userResult.user.id}` },
        { status: 403 }
      )
    };
  }

  const typedProfile = profile as UserProfile;
  if (!typedProfile.active || !allowedRoles.includes(typedProfile.role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Insufficient role permissions.' }, { status: 403 })
    };
  }

  return {
    ok: true,
    userId: userResult.user.id,
    profile: typedProfile
  };
}

export async function requireAdmin(request: NextRequest): Promise<AdminAuthResult> {
  return requireAnyRole(request, ['admin']);
}

export async function requireStaff(request: NextRequest): Promise<AdminAuthResult> {
  return requireAnyRole(request, ['admin', 'worker']);
}
