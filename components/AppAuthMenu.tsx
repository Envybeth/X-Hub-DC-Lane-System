'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';
import { supabase } from '@/lib/supabase';
import { useRealtimeCoordinator } from './RealtimeProvider';

type NotificationItem = {
  id: string;
  message: string;
  createdAt: string;
};

export default function AppAuthMenu() {
  const pathname = usePathname();
  const { loading, isAuthenticated, isAdmin, isGuest, profile, signOut } = useAuth();
  const { subscribeScope } = useRealtimeCoordinator();
  const displayName = profile?.display_name || profile?.username || 'user';
  const username = profile?.username || displayName;
  const profileId = profile?.id || null;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [creatorAdminId, setCreatorAdminId] = useState<string | null>(null);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [seenById, setSeenById] = useState<Record<string, true>>({});
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const notificationMenuRef = useRef<HTMLDivElement | null>(null);
  const notificationButtonRef = useRef<HTMLButtonElement | null>(null);
  const notificationOpenRef = useRef(false);
  const isCreatorAdmin = Boolean(isAdmin && profileId && creatorAdminId && profileId === creatorAdminId);

  useEffect(() => {
    notificationOpenRef.current = notificationOpen;
  }, [notificationOpen]);

  useEffect(() => {
    if (!mobileMenuOpen && !notificationOpen) return;

    function handleOutsideInteraction(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      const insideMobileMenu = Boolean(mobileMenuRef.current?.contains(target));
      const insideNotificationMenu = Boolean(notificationMenuRef.current?.contains(target));
      const insideNotificationButton = Boolean(notificationButtonRef.current?.contains(target));

      if (!insideMobileMenu) {
        setMobileMenuOpen(false);
      }
      if (!insideNotificationMenu && !insideNotificationButton) {
        setNotificationOpen(false);
      }
    }

    function handleWindowScroll() {
      setMobileMenuOpen(false);
      setNotificationOpen(false);
    }

    document.addEventListener('mousedown', handleOutsideInteraction, true);
    document.addEventListener('touchstart', handleOutsideInteraction, true);
    window.addEventListener('scroll', handleWindowScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleOutsideInteraction, true);
      document.removeEventListener('touchstart', handleOutsideInteraction, true);
      window.removeEventListener('scroll', handleWindowScroll, true);
    };
  }, [mobileMenuOpen, notificationOpen]);

  useEffect(() => {
    if (!isAdmin || !profileId) return;

    let isActive = true;
    async function resolveCreatorAdmin() {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('role', 'admin')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!isActive) return;
      if (error) {
        console.error('Failed to resolve creator admin account:', error);
        return;
      }
      setCreatorAdminId(data?.id || null);
    }

    void resolveCreatorAdmin();

    return () => {
      isActive = false;
    };
  }, [isAdmin, profileId]);

  useEffect(() => {
    if (!isCreatorAdmin) return;

    const unsubscribe = subscribeScope('notifications', (payload) => {
      const id = typeof payload.id === 'string' ? payload.id.trim() : '';
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!id || !message) return;

      const createdAtCandidate = typeof payload.createdAt === 'string' ? payload.createdAt : '';
      const createdAt = Number.isFinite(Date.parse(createdAtCandidate))
        ? createdAtCandidate
        : new Date().toISOString();

      setNotifications((previous) => {
        if (previous.some((item) => item.id === id)) return previous;
        return [{ id, message, createdAt }, ...previous].slice(0, 80);
      });

      if (notificationOpenRef.current) {
        setSeenById((previous) => ({ ...previous, [id]: true }));
      }
    });

    return () => unsubscribe();
  }, [isCreatorAdmin, subscribeScope]);

  if (loading || !isAuthenticated || pathname === '/login') {
    return null;
  }

  const unreadCount = notifications.reduce((count, item) => (seenById[item.id] ? count : count + 1), 0);

  function handleToggleNotifications() {
    setNotificationOpen((previous) => {
      const nextOpen = !previous;
      if (nextOpen) {
        setSeenById((current) => {
          const next = { ...current };
          notifications.forEach((item) => {
            next[item.id] = true;
          });
          return next;
        });
      }
      return nextOpen;
    });
  }

  function handleClearAllNotifications() {
    setNotifications([]);
    setSeenById({});
  }

  return (
    <>
      {isCreatorAdmin && (
        <div className="fixed top-2.5 right-14 md:top-4 md:right-4 z-[131]">
          <button
            ref={notificationButtonRef}
            type="button"
            onClick={handleToggleNotifications}
            className="relative h-10 w-10 rounded-full bg-gray-900/95 border border-gray-700 shadow-xl hover:bg-gray-800 transition-colors"
            aria-label="Open shipment notifications"
            aria-expanded={notificationOpen}
          >
            <span aria-hidden className="text-lg leading-none">✉</span>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {notificationOpen && (
            <div
              ref={notificationMenuRef}
              className="absolute right-0 mt-2 w-[22rem] max-w-[90vw] max-h-[26rem] overflow-hidden bg-gray-900/95 border border-gray-700 rounded-xl shadow-2xl"
            >
              <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between gap-2">
                <span className="text-xs text-gray-300 font-semibold">Activity Notifications</span>
                <button
                  type="button"
                  onClick={handleClearAllNotifications}
                  className="text-[11px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
                >
                  Clear all
                </button>
              </div>
              <div className="max-h-[22rem] overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-gray-400">No notifications yet.</div>
                ) : (
                  notifications.map((item) => (
                    <div key={item.id} className="px-3 py-2 border-b border-gray-800 last:border-b-0">
                      <div className="text-[11px] text-gray-500 mb-1">
                        {new Date(item.createdAt).toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-100 leading-snug">{item.message}</div>
                      <div className="mt-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setNotifications((previous) => previous.filter((row) => row.id !== item.id));
                            setSeenById((previous) => {
                              const next = { ...previous };
                              delete next[item.id];
                              return next;
                            });
                          }}
                          className="text-[11px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="hidden md:block fixed right-0 top-20 z-[130]">
        <div className="group w-10 overflow-hidden hover:w-[16.5rem] transition-[width] duration-300 ease-out">
          <div className="flex items-stretch w-[16.5rem] shadow-xl">

            <div className="w-10 bg-gray-900/95 border  border-gray-700 rounded-l-lg flex items-center justify-center">
              <span className="text-[11px] font-semibold text-gray-200 tracking-wide [writing-mode:vertical-rl] rotate-180">
                {username}
              </span>
            </div>
            <div className="w-56 bg-gray-900/95 border border-r-0 border-gray-700 px-3 py-3">
              <div className="text-xs text-gray-300 mb-1">
                {displayName} ({profile?.role})
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <Link
                    href="/accounts"
                    className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-xs font-semibold"
                  >
                    Accounts
                  </Link>
                )}
                {isGuest && (
                  <span className="bg-yellow-700 px-2 py-1 rounded text-xs font-semibold">
                    Read-only
                  </span>
                )}
                <button
                  onClick={() => void signOut()}
                  className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs font-semibold"
                >
                  Logout
                </button>
              </div>
            </div>


          </div>
        </div>
      </div>

      <div ref={mobileMenuRef} className="md:hidden fixed top-2 right-2 z-[130]">
        <button
          onClick={() => setMobileMenuOpen((prev) => !prev)}
          className="bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl px-2 py-1.5 text-[11px] text-gray-200 font-semibold max-w-[9.5rem] truncate"
          aria-expanded={mobileMenuOpen}
        >
          {username}
        </button>

        {mobileMenuOpen && (
          <div className="mt-1 bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl px-2 py-2 min-w-[9.5rem]">
            <div className="text-[11px] text-gray-400 mb-2">
              {displayName} ({profile?.role})
            </div>
            <div className="flex flex-col gap-1.5">
              {isAdmin && (
                <Link
                  href="/accounts"
                  onClick={() => setMobileMenuOpen(false)}
                  className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-[11px] font-semibold text-center"
                >
                  Accounts
                </Link>
              )}
              {isGuest && (
                <span className="bg-yellow-700 px-2 py-1 rounded text-[11px] font-semibold text-center">
                  Read-only
                </span>
              )}
              <button
                onClick={() => void signOut()}
                className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-[11px] font-semibold"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
