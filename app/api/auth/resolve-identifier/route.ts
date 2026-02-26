import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { isValidUsername, normalizeUsername } from '@/lib/auth';

type ResolveIdentifierBody = {
  identifier?: string;
};

export async function POST(request: NextRequest) {
  let body: ResolveIdentifierBody;
  try {
    body = (await request.json()) as ResolveIdentifierBody;
  } catch {
    return NextResponse.json({ email: null });
  }

  const rawIdentifier = (body.identifier || '').trim().toLowerCase();
  if (!rawIdentifier || rawIdentifier.includes('@')) {
    return NextResponse.json({ email: null });
  }

  const username = normalizeUsername(rawIdentifier);
  if (!isValidUsername(username)) {
    return NextResponse.json({ email: null });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, active')
    .ilike('username', username)
    .maybeSingle();

  if (profileError || !profile || !profile.active) {
    return NextResponse.json({ email: null });
  }

  const { data: userResult, error: userError } = await supabaseAdmin.auth.admin.getUserById(profile.id);
  if (userError || !userResult.user) {
    return NextResponse.json({ email: null });
  }

  return NextResponse.json({
    email: userResult.user.email || null
  });
}
