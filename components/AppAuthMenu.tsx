'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';

export default function AppAuthMenu() {
  const pathname = usePathname();
  const { loading, isAuthenticated, isAdmin, isGuest, profile, signOut } = useAuth();
  const displayName = profile?.display_name || profile?.username || 'user';
  const username = profile?.username || displayName;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mobileMenuOpen) return;

    function handleOutsideInteraction(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (mobileMenuRef.current?.contains(target)) return;
      setMobileMenuOpen(false);
    }

    function handleWindowScroll() {
      setMobileMenuOpen(false);
    }

    document.addEventListener('mousedown', handleOutsideInteraction, true);
    document.addEventListener('touchstart', handleOutsideInteraction, true);
    window.addEventListener('scroll', handleWindowScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleOutsideInteraction, true);
      document.removeEventListener('touchstart', handleOutsideInteraction, true);
      window.removeEventListener('scroll', handleWindowScroll, true);
    };
  }, [mobileMenuOpen]);

  if (loading || !isAuthenticated || pathname === '/login') {
    return null;
  }

  return (
    <>
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
