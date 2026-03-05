'use client';

import { AuthProvider } from './AuthProvider';
import AuthGate from './AuthGate';
import AppAuthMenu from './AppAuthMenu';
import { RealtimeProvider } from './RealtimeProvider';

interface AppClientShellProps {
  children: React.ReactNode;
}

export default function AppClientShell({ children }: AppClientShellProps) {
  return (
    <AuthProvider>
      <AuthGate>
        <RealtimeProvider>
          <AppAuthMenu />
          {children}
        </RealtimeProvider>
      </AuthGate>
    </AuthProvider>
  );
}
