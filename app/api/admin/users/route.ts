import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/serverAuth';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { AppRole, isValidUsername, normalizeUsername } from '@/lib/auth';
import { UserProfile } from '@/types/auth';

type CreateUserBody = {
  username?: string;
  display_name?: string | null;
  password?: string;
  role?: AppRole;
  active?: boolean;
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

export async function GET(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (!authResult.ok) {
    return authResult.response;
  }
  const supabaseAdmin = getSupabaseAdmin();

  const profilesResponse = await supabaseAdmin
    .from('user_profiles')
    .select('id, username, display_name, role, active, created_at, updated_at')
    .order('username', { ascending: true });

  if (profilesResponse.error) {
    return NextResponse.json(
      { error: profilesResponse.error.message },
      { status: 500 }
    );
  }

  const profiles = (profilesResponse.data || []) as UserProfile[];
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));

  const allUsers: Array<{ id: string; email: string | null; last_sign_in_at: string | null }> = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const users = data.users || [];
    users.forEach((user) => {
      allUsers.push({
        id: user.id,
        email: user.email || null,
        last_sign_in_at: user.last_sign_in_at || null
      });
    });

    if (users.length < perPage) break;
    page += 1;
  }

  const merged = allUsers
    .map((user) => {
      const profile = profilesById.get(user.id);
      if (!profile) return null;
      return {
        ...user,
        ...profile
      };
    })
    .filter(Boolean);

  return NextResponse.json({ users: merged });
}

export async function POST(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (!authResult.ok) {
    return authResult.response;
  }
  const supabaseAdmin = getSupabaseAdmin();

  let body: CreateUserBody;
  try {
    body = (await request.json()) as CreateUserBody;
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const username = normalizeUsername(body.username || '');
  const password = (body.password || '').trim();
  const role = body.role || 'guest';
  const active = body.active ?? true;
  const displayName = body.display_name?.trim() || null;

  if (!isValidUsername(username)) {
    return NextResponse.json(
      { error: 'Username must be 3-30 chars and contain only a-z, 0-9, dot, underscore, hyphen.' },
      { status: 400 }
    );
  }

  if (password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters.' },
      { status: 400 }
    );
  }

  if (!isRole(role)) {
    return NextResponse.json({ error: 'Invalid role.' }, { status: 400 });
  }

  const existingProfile = await supabaseAdmin
    .from('user_profiles')
    .select('id')
    .ilike('username', username)
    .maybeSingle();

  if (existingProfile.data) {
    return NextResponse.json({ error: 'Username already exists.' }, { status: 409 });
  }

  const email = usernameToServerEmail(username);
  const { data: createdUserResult, error: createUserError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      username,
      display_name: displayName
    }
  });

  if (createUserError || !createdUserResult.user) {
    return NextResponse.json(
      { error: createUserError?.message || 'Failed to create auth user.' },
      { status: 500 }
    );
  }

  const createdUser = createdUserResult.user;
  const { error: profileError } = await supabaseAdmin
    .from('user_profiles')
    .insert({
      id: createdUser.id,
      username,
      display_name: displayName,
      role,
      active
    });

  if (profileError) {
    await supabaseAdmin.auth.admin.deleteUser(createdUser.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({
    user: {
      id: createdUser.id,
      email: createdUser.email || null,
      username,
      display_name: displayName,
      role,
      active
    }
  });
}
