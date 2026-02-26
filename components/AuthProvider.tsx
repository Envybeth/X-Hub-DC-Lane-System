'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { identifierToEmail } from '@/lib/auth';
import { UserProfile } from '@/types/auth';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isWorker: boolean;
  isStaff: boolean;
  isGuest: boolean;
  signIn: (identifier: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfileForUser = useCallback(async (targetUser: User | null) => {
    if (!targetUser) {
      setProfile(null);
      return;
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('id, username, display_name, role, active, created_at, updated_at')
      .eq('id', targetUser.id)
      .maybeSingle();

    if (error || !data) {
      setProfile(null);
      return;
    }

    setProfile(data as UserProfile);
  }, []);

  useEffect(() => {
    let alive = true;

    async function initializeAuth() {
      const { data } = await supabase.auth.getSession();
      const currentSession = data.session;
      const currentUser = currentSession?.user ?? null;

      if (!alive) return;

      setSession(currentSession);
      setUser(currentUser);
      await loadProfileForUser(currentUser);

      if (alive) {
        setLoading(false);
      }
    }

    void initializeAuth();

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextUser = nextSession?.user ?? null;
      setSession(nextSession);
      setUser(nextUser);
      void loadProfileForUser(nextUser);
      setLoading(false);
    });

    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
    };
  }, [loadProfileForUser]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const trimmedIdentifier = identifier.trim();
    const primaryEmail = identifierToEmail(trimmedIdentifier);
    let { error } = await supabase.auth.signInWithPassword({
      email: primaryEmail,
      password
    });

    if (error && !trimmedIdentifier.includes('@')) {
      try {
        const response = await fetch('/api/auth/resolve-identifier', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: trimmedIdentifier })
        });

        if (response.ok) {
          const payload = (await response.json()) as { email?: string | null };
          const fallbackEmail = payload.email?.trim().toLowerCase() || '';

          if (fallbackEmail && fallbackEmail !== primaryEmail) {
            const retryResult = await supabase.auth.signInWithPassword({
              email: fallbackEmail,
              password
            });
            error = retryResult.error;
          }
        }
      } catch {
        // Keep original auth error when fallback lookup fails.
      }
    }

    if (error) {
      return { error: error.message };
    }

    const { data: userResult } = await supabase.auth.getUser();
    const signedInUser = userResult.user;
    if (!signedInUser) {
      await supabase.auth.signOut();
      return { error: 'Unable to load account profile.' };
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id, active')
      .eq('id', signedInUser.id)
      .maybeSingle();

    if (!profile || !profile.active) {
      await supabase.auth.signOut();
      return { error: 'Account is not active or profile is missing. Contact an admin.' };
    }

    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
    setProfile(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    await loadProfileForUser(user);
  }, [loadProfileForUser, user]);

  const value = useMemo<AuthContextValue>(() => {
    const isAuthenticated = Boolean(session && profile && profile.active);
    const isAdmin = isAuthenticated && profile?.role === 'admin';
    const isWorker = isAuthenticated && profile?.role === 'worker';
    const isStaff = isAuthenticated && (profile?.role === 'admin' || profile?.role === 'worker');
    const isGuest = isAuthenticated && profile?.role === 'guest';

    return {
      session,
      user,
      profile,
      loading,
      isAuthenticated,
      isAdmin,
      isWorker,
      isStaff,
      isGuest,
      signIn,
      signOut,
      refreshProfile
    };
  }, [session, user, profile, loading, signIn, signOut, refreshProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
