'use client';

import { AuthProvider } from './AuthProvider';
import AuthGate from './AuthGate';
import AppAuthMenu from './AppAuthMenu';

interface AppClientShellProps {
  children: React.ReactNode;
}

export default function AppClientShell({ children }: AppClientShellProps) {
  return (
    <AuthProvider>
      <AuthGate>
        <AppAuthMenu />
        {children}
      </AuthGate>
    </AuthProvider>
  );
}
