'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

interface AuthGateProps {
  children: React.ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { loading, isAuthenticated } = useAuth();

  const isLoginPage = pathname === '/login';

  useEffect(() => {
    if (loading) return;

    if (!isAuthenticated && !isLoginPage) {
      router.replace('/login');
      return;
    }

    if (isAuthenticated && isLoginPage) {
      router.replace('/');
    }
  }, [loading, isAuthenticated, isLoginPage, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-lg md:text-xl animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated && !isLoginPage) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-lg md:text-xl">Redirecting to login...</div>
      </div>
    );
  }

  if (isAuthenticated && isLoginPage) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-lg md:text-xl">Redirecting...</div>
      </div>
    );
  }

  return <>{children}</>;
}
