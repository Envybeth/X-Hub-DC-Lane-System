'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';

export default function AppAuthMenu() {
  const pathname = usePathname();
  const { loading, isAuthenticated, isAdmin, isGuest, profile, signOut } = useAuth();
  const displayName = profile?.display_name || profile?.username || 'user';
  const username = profile?.username || displayName;

  if (loading || !isAuthenticated || pathname === '/login') {
    return null;
  }

  return (
    <>
      <div className="hidden md:block fixed right-0 top-20 z-[130]">
        <div className="group">
          <div className="flex items-stretch translate-x-[calc(100%-2.5rem)] group-hover:translate-x-0 transition-transform duration-300 ease-out">
            <div className="w-10 bg-gray-900/95 border border-r-0 border-gray-700 rounded-l-lg shadow-xl flex items-center justify-center">
              <span className="text-[11px] font-semibold text-gray-200 tracking-wide [writing-mode:vertical-rl] rotate-180">
                {username}
              </span>
            </div>

            <div className="w-56 bg-gray-900/95 border border-gray-700 rounded-l-lg rounded-r-none shadow-xl px-3 py-3">
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

      <div className="md:hidden fixed top-2 right-2 z-[130] bg-gray-900/95 border border-gray-700 rounded-lg shadow-xl px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-200 font-semibold max-w-[8.5rem] truncate">
            {username}
          </span>
          {isAdmin && (
            <Link
              href="/accounts"
              className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-[11px] font-semibold"
            >
              Accounts
            </Link>
          )}
          <button
            onClick={() => void signOut()}
            className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-[11px] font-semibold"
          >
            Logout
          </button>
        </div>
      </div>
    </>
  );
}
