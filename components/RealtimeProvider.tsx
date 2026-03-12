'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

const REALTIME_LEADER_KEY = 'site_realtime_leader_v1';
const REALTIME_BROADCAST_NAME = 'site-realtime-sync-v1';
const REALTIME_HEARTBEAT_MS = 2500;
const REALTIME_LEADER_STALE_MS = 7500;
const REALTIME_SIGNAL_STALE_MS = 12000;
const REALTIME_SIGNAL_DISCONNECTED_MS = 90000;
const REALTIME_LEADER_RECOVERY_RETRY_MS = 6000;

type RealtimeScope = 'shipments' | 'lane-grid' | 'notifications';
type RealtimeHealth = 'live' | 'reconnecting' | 'disconnected';

type RealtimeMessage =
  | {
    type: 'realtime_heartbeat';
    leaderTabId: string;
    leaderHealth: RealtimeHealth;
    leaderStateSince: number;
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
    const leaderHealth = candidate.leaderHealth === 'live' || candidate.leaderHealth === 'reconnecting' || candidate.leaderHealth === 'disconnected'
      ? candidate.leaderHealth
      : 'reconnecting';
    const timestamp = typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now();
    const leaderStateSince = typeof candidate.leaderStateSince === 'number' ? candidate.leaderStateSince : timestamp;
    return {
      type: 'realtime_heartbeat',
      leaderTabId: candidate.leaderTabId,
      leaderHealth,
      leaderStateSince,
      timestamp
    };
  }
  if (
    candidate.type === 'realtime_scope_event' &&
    typeof candidate.leaderTabId === 'string' &&
    (candidate.scope === 'shipments' || candidate.scope === 'lane-grid' || candidate.scope === 'notifications')
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

type RealtimeDbPayload = {
  eventType?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
  commit_timestamp?: string | null;
};

function asTrimmedText(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = asTrimmedText(value).toLowerCase();
  return normalized === 'true' || normalized === 't' || normalized === '1' || normalized === 'yes';
}

function safeIsoTimestamp(value: unknown): string {
  const candidate = asTrimmedText(value);
  if (candidate && Number.isFinite(Date.parse(candidate))) return candidate;
  return new Date().toISOString();
}

function RealtimeStatusDot({
  health,
  online,
  isLeader
}: {
  health: RealtimeHealth;
  online: boolean;
  isLeader: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [supportsHover, setSupportsHover] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const updateSupportsHover = () => setSupportsHover(mediaQuery.matches);
    updateSupportsHover();
    mediaQuery.addEventListener('change', updateSupportsHover);
    return () => mediaQuery.removeEventListener('change', updateSupportsHover);
  }, []);

  useEffect(() => {
    if (!isPopoverOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current?.contains(target)) return;
      setIsPopoverOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPopoverOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isPopoverOpen]);

  const dotClasses = health === 'live'
    ? 'bg-green-400 shadow-[0_0_14px_rgba(74,222,128,0.95)]'
    : health === 'reconnecting'
      ? 'bg-orange-400 animate-pulse shadow-[0_0_12px_rgba(251,146,60,0.9)]'
      : 'bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.9)]';

  const realtimeLabel = health === 'live'
    ? 'Realtime: live'
    : health === 'reconnecting'
      ? 'Realtime: reconnecting'
      : 'Realtime: disconnected';
  const networkLabel = online ? 'Network: online' : 'Network: offline';
  const modeLabel = isLeader ? 'Mode: leader tab' : 'Mode: follower tab';
  const progressionLabel = health === 'live'
    ? 'Events are flowing now.'
    : health === 'reconnecting'
      ? 'Trying to recover channel.'
      : 'No active realtime signal.';

  return (
    <div ref={containerRef} className="fixed top-4 left-4 z-[140]">
      <button
        type="button"
        aria-label="Realtime connection status"
        onClick={() => {
          if (supportsHover) return;
          setIsPopoverOpen((previous) => !previous);
        }}
        onMouseEnter={() => {
          if (!supportsHover) return;
          setIsPopoverOpen(true);
        }}
        onMouseLeave={() => {
          if (!supportsHover) return;
          setIsPopoverOpen(false);
        }}
        className={`h-3.5 w-3.5 rounded-full border border-black/40 ${dotClasses}`}
      />

      {isPopoverOpen && (
        <div
          className="absolute top-5 left-0 w-56 rounded-md border border-slate-600 bg-slate-950/96 px-3 py-2 text-xs text-slate-100 shadow-lg"
          onMouseEnter={() => {
            if (!supportsHover) return;
            setIsPopoverOpen(true);
          }}
          onMouseLeave={() => {
            if (!supportsHover) return;
            setIsPopoverOpen(false);
          }}
        >
          <div className="font-semibold text-cyan-200">Connection</div>
          <div className="mt-1 text-slate-200">{realtimeLabel}</div>
          <div className="text-slate-200">{networkLabel}</div>
          <div className="text-slate-200">{modeLabel}</div>
          <div className="mt-1 text-[11px] text-slate-400">Flow: disconnected - reconnecting - live</div>
          <div className="text-[11px] text-slate-400">{progressionLabel}</div>
        </div>
      )}
    </div>
  );
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [isLeader, setIsLeader] = useState(false);
  const initialOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  const [health, setHealth] = useState<RealtimeHealth>(initialOnline ? 'reconnecting' : 'disconnected');
  const [isOnline, setIsOnline] = useState<boolean>(initialOnline);
  const [channelRetryEpoch, setChannelRetryEpoch] = useState(0);
  const tabIdRef = useRef('');
  const leaderRef = useRef(false);
  const healthRef = useRef<RealtimeHealth>(initialOnline ? 'reconnecting' : 'disconnected');
  const signalAtRef = useRef(0);
  const onlineRef = useRef(initialOnline);
  const leaderChannelHealthRef = useRef<RealtimeHealth>('reconnecting');
  const leaderHealthSinceRef = useRef<number>(0);
  const observedLeaderHealthRef = useRef<RealtimeHealth>('reconnecting');
  const observedLeaderHealthSinceRef = useRef<number>(0);
  const observedLeaderHeartbeatAtRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const lastLeaderRecoveryRetryAtRef = useRef(0);
  const broadcastRef = useRef<BroadcastChannel | null>(null);
  const listenersRef = useRef<Record<RealtimeScope, Set<ScopeListener>>>({
    shipments: new Set<ScopeListener>(),
    'lane-grid': new Set<ScopeListener>(),
    notifications: new Set<ScopeListener>()
  });

  const markSignal = useCallback(() => {
    signalAtRef.current = Date.now();
  }, []);

  const setLeaderChannelHealth = useCallback((nextHealth: RealtimeHealth) => {
    if (leaderHealthSinceRef.current <= 0) {
      leaderHealthSinceRef.current = Date.now();
    }
    if (leaderChannelHealthRef.current === nextHealth) return;
    leaderChannelHealthRef.current = nextHealth;
    leaderHealthSinceRef.current = Date.now();
  }, []);

  const recomputeHealth = useCallback(() => {
    const now = Date.now();
    if (!onlineRef.current) {
      setHealth('disconnected');
      return;
    }

    if (leaderRef.current) {
      setHealth(leaderChannelHealthRef.current);
      return;
    }

    const heartbeatAge = now - observedLeaderHeartbeatAtRef.current;
    if (heartbeatAge > REALTIME_SIGNAL_DISCONNECTED_MS) {
      setHealth('disconnected');
      return;
    }

    if (heartbeatAge > REALTIME_SIGNAL_STALE_MS) {
      setHealth('reconnecting');
      return;
    }

    setHealth(observedLeaderHealthRef.current);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleChannelReconnect = useCallback((delayMs: number) => {
    if (!leaderRef.current || !onlineRef.current) return;
    if (reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      try {
        supabase.realtime.connect();
      } catch (error) {
        console.warn('Failed to trigger realtime socket reconnect', error);
      }
      setChannelRetryEpoch((previous) => previous + 1);
    }, Math.max(500, delayMs));
  }, []);

  const triggerLeaderRecovery = useCallback((force = false) => {
    if (!leaderRef.current || !onlineRef.current) return;
    const now = Date.now();
    if (!force && (now - lastLeaderRecoveryRetryAtRef.current) < REALTIME_LEADER_RECOVERY_RETRY_MS) {
      return;
    }
    lastLeaderRecoveryRetryAtRef.current = now;
    setLeaderChannelHealth('reconnecting');
    try {
      supabase.realtime.connect();
    } catch (error) {
      console.warn('Failed to trigger realtime socket reconnect', error);
    }
  }, [setLeaderChannelHealth]);

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
    healthRef.current = health;
  }, [health]);

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
      if (payload.type === 'realtime_heartbeat') {
        observedLeaderHeartbeatAtRef.current = Date.now();
        observedLeaderHealthRef.current = payload.leaderHealth;
        observedLeaderHealthSinceRef.current = payload.leaderStateSince;
        recomputeHealth();
      } else if (payload.type === 'realtime_scope_event') {
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
        observedLeaderHeartbeatAtRef.current = now;
        observedLeaderHealthRef.current = leaderChannelHealthRef.current;
        observedLeaderHealthSinceRef.current = leaderHealthSinceRef.current > 0 ? leaderHealthSinceRef.current : now;
        try {
          broadcast.postMessage({
            type: 'realtime_heartbeat',
            leaderTabId: tabIdRef.current,
            leaderHealth: leaderChannelHealthRef.current,
            leaderStateSince: leaderHealthSinceRef.current > 0 ? leaderHealthSinceRef.current : now,
            timestamp: now
          } satisfies RealtimeMessage);
        } catch {
          // no-op
        }
      } else if (leaderRef.current) {
        leaderRef.current = false;
        setIsLeader(false);
      }
      recomputeHealth();
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
      recomputeHealth();
    };
  }, [markSignal, notifyScopeListeners, recomputeHealth]);

  useEffect(() => {
    if (!isLeader) return;
    try {
      supabase.realtime.connect();
    } catch (error) {
      console.warn('Failed to open realtime socket for leader tab', error);
    }

    const emitNotification = (message: string, timestamp?: string | null) => {
      const createdAt = safeIsoTimestamp(timestamp);
      const id = `notif-${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
      emitScopeEvent('notifications', { id, message, createdAt });
    };

    const handleShipmentChange = (payload: RealtimeDbPayload) => {
      emitScopeEvent('shipments', {});
      emitScopeEvent('lane-grid', {});

      if (payload.eventType !== 'UPDATE') return;

      const wasArchived = asBoolean(payload.old?.archived);
      const isArchived = asBoolean(payload.new?.archived);
      if (!wasArchived && isArchived) {
        const puNumber = asTrimmedText(payload.new?.pu_number);
        const message = puNumber
          ? `PU ${puNumber} moved to archived/shipped.`
          : 'A shipment moved to archived/shipped.';
        emitNotification(message, payload.commit_timestamp);
      }
    };

    const handleShipmentPtChange = () => {
      emitScopeEvent('shipments', {});
      emitScopeEvent('lane-grid', {});
    };

    const handlePickticketChange = (payload: RealtimeDbPayload) => {
      const nextRow = payload.new || null;
      const previousRow = payload.old || null;
      const rawId = nextRow?.id ?? previousRow?.id;
      const parsedId = Number(rawId);
      const ptId = Number.isFinite(parsedId) ? parsedId : null;

      emitScopeEvent('shipments', {
        source: 'picktickets',
        eventType: payload.eventType || '',
        ptId,
        status: asTrimmedText(nextRow?.status),
        puDate: asTrimmedText(nextRow?.pu_date),
        puNumber: asTrimmedText(nextRow?.pu_number),
        containerNumber: asTrimmedText(nextRow?.container_number),
        lastSyncedAt: asTrimmedText(nextRow?.last_synced_at)
      });
      emitScopeEvent('lane-grid', {});
    };

    const handleStaleSnapshotChange = () => {
      emitScopeEvent('shipments', { includeStale: true });
    };

    const handleLaneLikeChange = () => {
      emitScopeEvent('lane-grid', {});
    };

    const handleSyncSummaryLogInsert = (payload: RealtimeDbPayload) => {
      const details = payload.new?.details;
      let errorCount = 0;
      if (details && typeof details === 'object') {
        const raw = (details as Record<string, unknown>).error_count;
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
          errorCount = parsed;
        }
      }
      emitNotification(
        errorCount > 0 ? 'A sync completed with errors.' : 'A sync completed.',
        payload.commit_timestamp || asTrimmedText(payload.new?.created_at)
      );
    };

    const channel = supabase
      .channel('sitewide-realtime-leader')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipments' }, handleShipmentChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shipment_pts' }, handleShipmentPtChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'picktickets' }, handlePickticketChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stale_shipment_snapshots' }, handleStaleSnapshotChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lanes' }, handleLaneLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lane_assignments' }, handleLaneLikeChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'container_storage_assignments' }, handleLaneLikeChange)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'user_action_logs', filter: 'target_table=eq.sync_jobs' },
        handleSyncSummaryLogInsert
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearReconnectTimer();
          markSignal();
          setLeaderChannelHealth('live');
          recomputeHealth();
          return;
        }
        if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') {
          setLeaderChannelHealth('reconnecting');
          recomputeHealth();
          try {
            supabase.realtime.connect();
          } catch (error) {
            console.warn('Failed to trigger realtime socket reconnect', error);
          }
          scheduleChannelReconnect(2000);
          return;
        }
        if (status === 'CLOSED') {
          setLeaderChannelHealth(onlineRef.current ? 'reconnecting' : 'disconnected');
          recomputeHealth();
          if (onlineRef.current) {
            try {
              supabase.realtime.connect();
            } catch (error) {
              console.warn('Failed to trigger realtime socket reconnect', error);
            }
            scheduleChannelReconnect(2400);
          }
        }
      });

    return () => {
      clearReconnectTimer();
      void supabase.removeChannel(channel);
    };
  }, [channelRetryEpoch, clearReconnectTimer, emitScopeEvent, isLeader, markSignal, recomputeHealth, scheduleChannelReconnect, setLeaderChannelHealth]);

  useEffect(() => {
    const triggerActiveRecovery = (forceLeaderReconnect = false) => {
      markSignal();
      recomputeHealth();
      if (forceLeaderReconnect || healthRef.current !== 'live') {
        triggerLeaderRecovery(forceLeaderReconnect);
      }
    };

    const handleOnline = () => {
      onlineRef.current = true;
      setIsOnline(true);
      triggerActiveRecovery(true);
    };
    const handleOffline = () => {
      onlineRef.current = false;
      setIsOnline(false);
      clearReconnectTimer();
      recomputeHealth();
    };
    const handleWindowFocus = () => {
      if (document.hidden) return;
      triggerActiveRecovery(false);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      triggerActiveRecovery(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const timer = window.setInterval(() => {
      recomputeHealth();
      if (document.hidden) return;
      if (!onlineRef.current) return;
      if (healthRef.current === 'live') return;
      triggerLeaderRecovery(false);
    }, 2500);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(timer);
      clearReconnectTimer();
    };
  }, [clearReconnectTimer, markSignal, recomputeHealth, triggerLeaderRecovery]);

  const value = useMemo<RealtimeContextValue>(() => ({
    isLeader,
    health,
    subscribeScope
  }), [health, isLeader, subscribeScope]);

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <RealtimeStatusDot health={health} online={isOnline} isLeader={isLeader} />
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
