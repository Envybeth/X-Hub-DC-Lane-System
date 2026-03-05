'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

const REALTIME_LEADER_KEY = 'site_realtime_leader_v1';
const REALTIME_BROADCAST_NAME = 'site-realtime-sync-v1';
const REALTIME_HEARTBEAT_MS = 2500;
const REALTIME_LEADER_STALE_MS = 7500;
const REALTIME_SIGNAL_STALE_MS = 12000;
const REALTIME_SIGNAL_DISCONNECTED_MS = 30000;

type RealtimeScope = 'shipments' | 'lane-grid';
type RealtimeHealth = 'live' | 'reconnecting' | 'disconnected';

type RealtimeMessage =
  | {
    type: 'realtime_heartbeat';
    leaderTabId: string;
    timestamp: number;
  }
  | {
    type: 'realtime_scope_event';
    scope: RealtimeScope;
    payload: Record<string, unknown>;
    leaderTabId: string;
    timestamp: number;
  };

type ScopeListener = (payload: Record<string, unknown>) => void;

interface RealtimeContextValue {
  isLeader: boolean;
  health: RealtimeHealth;
  subscribeScope: (scope: RealtimeScope, listener: ScopeListener) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

function normalizeMessage(data: unknown): RealtimeMessage | null {
  if (!data || typeof data !== 'object') return null;
  const candidate = data as Partial<RealtimeMessage>;
  if (candidate.type === 'realtime_heartbeat' && typeof candidate.leaderTabId === 'string') {
    return {
      type: 'realtime_heartbeat',
      leaderTabId: candidate.leaderTabId,
      timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now()
    };
  }
  if (
    candidate.type === 'realtime_scope_event' &&
    typeof candidate.leaderTabId === 'string' &&
    (candidate.scope === 'shipments' || candidate.scope === 'lane-grid')
  ) {
    return {
      type: 'realtime_scope_event',
      scope: candidate.scope,
      payload: candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {},
      leaderTabId: candidate.leaderTabId,
      timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now()
    };
  }
  return null;
}

function RealtimeStatusDot({ health }: { health: RealtimeHealth }) {
  const dotClasses = health === 'live'
    ? 'bg-green-400 shadow-[0_0_14px_rgba(74,222,128,0.95)]'
    : health === 'reconnecting'
      ? 'bg-orange-400 animate-pulse shadow-[0_0_12px_rgba(251,146,60,0.9)]'
      : 'bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.9)]';

  const label = health === 'live'
    ? 'Realtime: live'
    : health === 'reconnecting'
      ? 'Realtime: reconnecting'
      : 'Realtime: disconnected';

  return (
    <div className="fixed top-4 left-4 z-[140] pointer-events-none" title={label}>
      <div className={`h-3.5 w-3.5 rounded-full border border-black/40 ${dotClasses}`} />
    </div>
  );
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [isLeader, setIsLeader] = useState(false);
  const [health, setHealth] = useState<RealtimeHealth>('reconnecting');
  const tabIdRef = useRef('');
  const leaderRef = useRef(false);
  const signalAtRef = useRef(0);
  const broadcastRef = useRef<BroadcastChannel | null>(null);
  const listenersRef = useRef<Record<RealtimeScope, Set<ScopeListener>>>({
    shipments: new Set<ScopeListener>(),
    'lane-grid': new Set<ScopeListener>()
  });

  const markSignal = useCallback(() => {
    signalAtRef.current = Date.now();
  }, []);

  const notifyScopeListeners = useCallback((scope: RealtimeScope, payload: Record<string, unknown>) => {
    listenersRef.current[scope].forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error(`Failed ${scope} listener`, error);
      }
    });
  }, []);

  const broadcastScope = useCallback((scope: RealtimeScope, payload: Record<string, unknown>) => {
    if (!broadcastRef.current) return;
    try {
      broadcastRef.current.postMessage({
        type: 'realtime_scope_event',
        scope,
        payload,
        leaderTabId: tabIdRef.current,
        timestamp: Date.now()
      } satisfies RealtimeMessage);
    } catch (error) {
      console.warn('Failed to broadcast realtime scope event', error);
    }
  }, []);

  const emitScopeEvent = useCallback((scope: RealtimeScope, payload: Record<string, unknown>) => {
    markSignal();
    notifyScopeListeners(scope, payload);
    broadcastScope(scope, payload);
  }, [broadcastScope, markSignal, notifyScopeListeners]);

  const subscribeScope = useCallback((scope: RealtimeScope, listener: ScopeListener) => {
    listenersRef.current[scope].add(listener);
    return () => {
      listenersRef.current[scope].delete(listener);
    };
  }, []);

  useEffect(() => {
    leaderRef.current = isLeader;
  }, [isLeader]);

  useEffect(() => {
    if (!tabIdRef.current) {
      tabIdRef.current = `site-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    signalAtRef.current = Date.now();

    if (typeof window.BroadcastChannel === 'undefined') {
      leaderRef.current = true;
      const promoteLeaderTimer = window.setTimeout(() => {
        setIsLeader(true);
      }, 0);
      markSignal();
      return () => window.clearTimeout(promoteLeaderTimer);
    }

    const broadcast = new window.BroadcastChannel(REALTIME_BROADCAST_NAME);
    broadcastRef.current = broadcast;

    broadcast.onmessage = (event: MessageEvent) => {
      const payload = normalizeMessage(event.data);
      if (!payload || payload.leaderTabId === tabIdRef.current) return;
      markSignal();
      if (payload.type === 'realtime_scope_event') {
        notifyScopeListeners(payload.scope, payload.payload);
      }
    };

    const electLeader = () => {
      const now = Date.now();
      let currentLeader: { tabId: string; timestamp: number } | null = null;
      try {
        const raw = window.localStorage.getItem(REALTIME_LEADER_KEY);
        if (raw) currentLeader = JSON.parse(raw) as { tabId: string; timestamp: number };
      } catch {
        currentLeader = null;
      }

      const hasFreshLeader = Boolean(currentLeader && (now - currentLeader.timestamp) < REALTIME_LEADER_STALE_MS);
      const shouldLead = !hasFreshLeader || currentLeader?.tabId === tabIdRef.current;

      if (shouldLead) {
        window.localStorage.setItem(
          REALTIME_LEADER_KEY,
          JSON.stringify({ tabId: tabIdRef.current, timestamp: now })
        );
        if (!leaderRef.current) {
          leaderRef.current = true;
          setIsLeader(true);
        }
        markSignal();
        try {
          broadcast.postMessage({
            type: 'realtime_heartbeat',
            leaderTabId: tabIdRef.current,
            timestamp: now
          } satisfies RealtimeMessage);
        } catch {
          // no-op
        }
      } else if (leaderRef.current) {
        leaderRef.current = false;
        setIsLeader(false);
      }
    };

    electLeader();
    const heartbeatTimer = window.setInterval(electLeader, REALTIME_HEARTBEAT_MS);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== REALTIME_LEADER_KEY) return;
      electLeader();
    };
    window.addEventListener('storage', handleStorage);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.clearInterval(heartbeatTimer);

      try {
        const raw = window.localStorage.getItem(REALTIME_LEADER_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { tabId?: string };
          if (parsed.tabId === tabIdRef.current) {
            window.localStorage.removeItem(REALTIME_LEADER_KEY);
          }
        }
      } catch {
        // no-op
      }

      if (broadcastRef.current === broadcast) {
        broadcastRef.current = null;
      }
      broadcast.close();
      leaderRef.current = false;
      setIsLeader(false);
    };
  }, [markSignal, notifyScopeListeners]);

  useEffect(() => {
    if (!isLeader) return;

    const handleShipmentLikeChange = () => {
      emitScopeEvent('shipments', {});
      emitScopeEvent('lane-grid', {});
    };

    const handleStaleSnapshotChange = () => {
      emitScopeEvent('shipments', { includeStale: true });
    };

    const handleLaneLikeChange = () => {
      emitScopeEvent('lane-grid', {});
    };

    const channel = supabase
      .channel('sitewide-realtime-leader')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, handleShipmentLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipment_pts' }, handleShipmentLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picktickets' }, handleShipmentLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stale_shipment_snapshots' }, handleStaleSnapshotChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lanes' }, handleLaneLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lane_assignments' }, handleLaneLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'container_storage_assignments' }, handleLaneLikeChange)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          markSignal();
          setHealth('live');
          return;
        }
        if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') {
          setHealth('reconnecting');
          return;
        }
        if (status === 'CLOSED') {
          setHealth('disconnected');
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [emitScopeEvent, isLeader, markSignal]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const age = Date.now() - signalAtRef.current;
      if (age <= REALTIME_SIGNAL_STALE_MS) {
        setHealth('live');
        return;
      }
      if (age <= REALTIME_SIGNAL_DISCONNECTED_MS) {
        setHealth('reconnecting');
        return;
      }
      setHealth('disconnected');
    }, 2500);

    return () => window.clearInterval(timer);
  }, []);

  const value = useMemo<RealtimeContextValue>(() => ({
    isLeader,
    health,
    subscribeScope
  }), [health, isLeader, subscribeScope]);

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <RealtimeStatusDot health={health} />
    </RealtimeContext.Provider>
  );
}

export function useRealtimeCoordinator() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtimeCoordinator must be used within RealtimeProvider');
  }
  return context;
}
