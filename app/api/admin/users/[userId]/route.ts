import { NextRequest, NextResponse } from 'next/server';
import { getCreatorAdminId, requireAdmin } from '@/lib/serverAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { AppRole, isValidUsername, normalizeUsername } from '@/lib/auth';

type UpdateUserBody = {
  username?: string;
  display_name?: string | null;
  role?: AppRole;
  active?: boolean;
  password?: string;
};

function getServerAuthDomain(): string {
  return (process.env.AUTH_EMAIL_DOMAIN || process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || 'lane.local').trim().toLowerCase();
}

function usernameToServerEmail(username: string): string {
  return `${normalizeUsername(username)}@${getServerAuthDomain()}`;
}

function isRole(value: unknown): value is AppRole {
  return value === 'admin' || value === 'worker' || value === 'guest';
}

interface RouteContext {
  params: Promise<{ userId: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const authResult = await requireAdmin(request);
  if (!authResult.ok) {
    return authResult.response;
  }
  const supabaseAdmin = getSupabaseAdmin();

  const params = await context.params;
  const { userId } = params;
  if (!userId) {
    return NextResponse.json({ error: 'Missing user id.' }, { status: 400 });
  }

  let body: UpdateUserBody;
  try {
    body = (await request.json()) as UpdateUserBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { data: currentProfile, error: profileLookupError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, username, role')
    .eq('id', userId)
    .maybeSingle();

  if (profileLookupError || !currentProfile) {
    return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
  }

  const nextUsername = body.username !== undefined
    ? normalizeUsername(body.username)
    : currentProfile.username;

  if (!isValidUsername(nextUsername)) {
    return NextResponse.json(
      { error: 'Username must be 3-30 chars and contain only a-z, 0-9, dot, underscore, hyphen.' },
      { status: 400 }
    );
  }

  if (body.role !== undefined && !isRole(body.role)) {
    return NextResponse.json({ error: 'Invalid role.' }, { status: 400 });
  }

  const nextRole = body.role !== undefined ? body.role : currentProfile.role;
  const editingOtherAdminAccount = currentProfile.role === 'admin' && userId !== authResult.userId;
  const promotingToAdmin = currentProfile.role !== 'admin' && nextRole === 'admin';

  if (editingOtherAdminAccount || promotingToAdmin) {
    const { creatorAdminId, error: creatorLookupError } = await getCreatorAdminId();
    if (creatorLookupError) {
      return NextResponse.json({ error: creatorLookupError }, { status: 500 });
    }
    if (!creatorAdminId || creatorAdminId !== authResult.userId) {
      return NextResponse.json(
        { error: 'Only the creator account can edit other admin accounts.' },
        { status: 403 }
      );
    }
  }

  if (body.password !== undefined && body.password.trim() !== '' && body.password.trim().length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  if (nextUsername !== currentProfile.username) {
    const conflict = await supabaseAdmin
      .from('user_profiles')
      .select('id')
      .ilike('username', nextUsername)
      .neq('id', userId)
      .maybeSingle();

    if (conflict.data) {
      return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
    }
  }

  const authUpdatePayload: {
    email?: string;
    password?: string;
    user_metadata?: { username: string; display_name: string | null };
    email_confirm?: boolean;
  } = {};

  if (body.username !== undefined) {
    authUpdatePayload.email = usernameToServerEmail(nextUsername);
    authUpdatePayload.email_confirm = true;
  }

  if (body.password && body.password.trim() !== '') {
    authUpdatePayload.password = body.password.trim();
  }

  if (body.username !== undefined || body.display_name !== undefined) {
    authUpdatePayload.user_metadata = {
      username: nextUsername,
      display_name: body.display_name?.trim() || null
    };
  }

  if (Object.keys(authUpdatePayload).length > 0) {
    const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(userId, authUpdatePayload);
    if (authUpdateError) {
      return NextResponse.json({ error: authUpdateError.message }, { status: 500 });
    }
  }

  const profileUpdatePayload: {
    username?: string;
    display_name?: string | null;
    role?: AppRole;
    active?: boolean;
  } = {};

  if (body.username !== undefined) profileUpdatePayload.username = nextUsername;
  if (body.display_name !== undefined) profileUpdatePayload.display_name = body.display_name?.trim() || null;
  if (body.role !== undefined) profileUpdatePayload.role = body.role;
  if (body.active !== undefined) profileUpdatePayload.active = body.active;

  if (Object.keys(profileUpdatePayload).length > 0) {
    const { error: profileUpdateError } = await supabaseAdmin
      .from('user_profiles')
      .update(profileUpdatePayload)
      .eq('id', userId);

    if (profileUpdateError) {
      return NextResponse.json({ error: profileUpdateError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const authResult = await requireAdmin(request);
  if (!authResult.ok) {
    return authResult.response;
  }
  const supabaseAdmin = getSupabaseAdmin();

  const params = await context.params;
  const { userId } = params;
  if (!userId) {
    return NextResponse.json({ error: 'Missing user id.' }, { status: 400 });
  }

  if (userId === authResult.userId) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 });
  }

  const { data: targetProfile, error: targetProfileError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, role')
    .eq('id', userId)
    .maybeSingle();

  if (targetProfileError || !targetProfile) {
    return NextResponse.json({ error: 'User profile not found.' }, { status: 404 });
  }

  if (targetProfile.role === 'admin') {
    const { creatorAdminId, error: creatorLookupError } = await getCreatorAdminId();
    if (creatorLookupError) {
      return NextResponse.json({ error: creatorLookupError }, { status: 500 });
    }
    if (!creatorAdminId || creatorAdminId !== authResult.userId) {
      return NextResponse.json(
        { error: 'Only the creator account can delete admin accounts.' },
        { status: 403 }
      );
    }
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
