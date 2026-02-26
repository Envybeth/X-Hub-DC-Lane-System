'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { AppRole } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

interface AccountRow {
  id: string;
  email: string | null;
  username: string;
  display_name: string | null;
  role: AppRole;
  active: boolean;
  last_sign_in_at: string | null;
}

interface EditableAccountState {
  username: string;
  display_name: string;
  role: AppRole;
  active: boolean;
}

interface AuditLogEntry {
  id: number;
  user_id: string | null;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  target_table: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  actor_username: string | null;
  actor_display_name: string | null;
  actor_role: AppRole | null;
}

export default function AccountsPage() {
  const { loading, isAdmin, session, signOut } = useAuth();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountSearch, setAccountSearch] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState('');
  const [createForm, setCreateForm] = useState({
    username: '',
    display_name: '',
    password: '',
    role: 'guest' as AppRole,
    active: true
  });
  const [creating, setCreating] = useState(false);
  const [editsById, setEditsById] = useState<Record<string, EditableAccountState>>({});
  const [historyRows, setHistoryRows] = useState<AuditLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyDate, setHistoryDate] = useState('');
  const [historyUserIdFilter, setHistoryUserIdFilter] = useState<'all' | string>('all');
  const [historyOpen, setHistoryOpen] = useState(true);

  useEffect(() => {
    if (!loading && isAdmin) {
      void fetchAccounts();
      void fetchHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isAdmin]);

  async function getAccessToken(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || session?.access_token || null;
  }

  async function requestAdminApi(url: string, init?: RequestInit) {
    const token = await getAccessToken();
    if (!token) {
      setErrorText('Session expired. Please sign in again.');
      await signOut();
      return { response: null as Response | null, payload: null as unknown };
    }

    const response = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`
      }
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const errorTextFromPayload =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : '';

    if (response.status === 401 && errorTextFromPayload.toLowerCase().includes('invalid session')) {
      setErrorText('Session expired. Please sign in again.');
      await signOut();
      return { response: null as Response | null, payload };
    }

    return { response, payload };
  }

  async function fetchAccounts() {
    setLoadingAccounts(true);
    setErrorText('');
    try {
      const { response, payload } = await requestAdminApi('/api/admin/users');
      if (!response) return;
      if (!response.ok) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'Failed to load accounts.';
        setErrorText(message);
        return;
      }

      const nextAccounts = (
        typeof payload === 'object' &&
        payload !== null &&
        'users' in payload
          ? (payload as { users: AccountRow[] }).users
          : []
      ) as AccountRow[];
      setAccounts(nextAccounts);

      const nextEdits: Record<string, EditableAccountState> = {};
      nextAccounts.forEach((account) => {
        nextEdits[account.id] = {
          username: account.username,
          display_name: account.display_name || '',
          role: account.role,
          active: account.active
        };
      });
      setEditsById(nextEdits);
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
      setErrorText('Failed to load accounts.');
    } finally {
      setLoadingAccounts(false);
    }
  }

  async function fetchHistory(nextUserId: 'all' | string = historyUserIdFilter, nextDate: string = historyDate) {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const params = new URLSearchParams();
      if (nextUserId !== 'all') params.set('userId', nextUserId);
      if (nextDate) params.set('date', nextDate);
      params.set('limit', '400');

      const { response, payload } = await requestAdminApi(`/api/admin/audit-logs?${params.toString()}`);
      if (!response) return;
      if (!response.ok) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'Failed to load history.';
        setHistoryError(message);
        return;
      }

      const rows = (
        typeof payload === 'object' &&
        payload !== null &&
        'logs' in payload
          ? (payload as { logs: AuditLogEntry[] }).logs
          : []
      ) as AuditLogEntry[];

      setHistoryRows(rows);
    } catch (error) {
      console.error('Failed to fetch history:', error);
      setHistoryError('Failed to load history.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function handleCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setErrorText('');
    setCreating(true);
    try {
      const { response, payload } = await requestAdminApi('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(createForm)
      });
      if (!response) return;
      if (!response.ok) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'Failed to create account.';
        setErrorText(message);
        return;
      }

      setCreateForm({
        username: '',
        display_name: '',
        password: '',
        role: 'guest',
        active: true
      });
      await fetchAccounts();
    } catch (error) {
      console.error('Failed to create account:', error);
      setErrorText('Failed to create account.');
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveAccount(accountId: string) {
    const edits = editsById[accountId];
    if (!edits) return;

    setSavingId(accountId);
    setErrorText('');
    try {
      const { response, payload } = await requestAdminApi(`/api/admin/users/${accountId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: edits.username,
          display_name: edits.display_name,
          role: edits.role,
          active: edits.active
        })
      });
      if (!response) return;
      if (!response.ok) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'Failed to save account.';
        setErrorText(message);
        return;
      }

      await fetchAccounts();
    } catch (error) {
      console.error('Failed to save account:', error);
      setErrorText('Failed to save account.');
    } finally {
      setSavingId(null);
    }
  }

  async function handleResetPassword(accountId: string) {
    const nextPassword = window.prompt('Enter new password (min 8 chars):');
    if (nextPassword === null) return;

    setSavingId(accountId);
    setErrorText('');
    try {
      const { response, payload } = await requestAdminApi(`/api/admin/users/${accountId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password: nextPassword })
      });
      if (!response) return;
      if (!response.ok) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'Failed to reset password.';
        setErrorText(message);
        return;
      }
    } catch (error) {
      console.error('Failed to reset password:', error);
      setErrorText('Failed to reset password.');
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteAccount(accountId: string, username: string) {
    const confirmed = window.confirm(`Delete account "${username}"? This cannot be undone.`);
    if (!confirmed) return;

    setSavingId(accountId);
    setErrorText('');
    try {
      const { response, payload } = await requestAdminApi(`/api/admin/users/${accountId}`, {
        method: 'DELETE'
      });
      if (!response) return;
      if (!response.ok) {
        const message =
          typeof payload === 'object' &&
          payload !== null &&
          'error' in payload &&
          typeof (payload as { error: unknown }).error === 'string'
            ? (payload as { error: string }).error
            : 'Failed to delete account.';
        setErrorText(message);
        return;
      }

      await fetchAccounts();
    } catch (error) {
      console.error('Failed to delete account:', error);
      setErrorText('Failed to delete account.');
    } finally {
      setSavingId(null);
    }
  }

  const normalizedSearch = accountSearch.trim().toLowerCase();
  const visibleAccounts = normalizedSearch
    ? accounts.filter((account) => {
      const username = account.username.toLowerCase();
      const displayName = (account.display_name || '').toLowerCase();
      return username.includes(normalizedSearch) || displayName.includes(normalizedSearch);
    })
    : accounts;
  const selectedHistoryAccount = historyUserIdFilter === 'all'
    ? null
    : accounts.find((account) => account.id === historyUserIdFilter) || null;

  function getActionLabel(action: string): string {
    if (action === 'INSERT') return 'Created';
    if (action === 'UPDATE') return 'Updated';
    if (action === 'DELETE') return 'Deleted';
    return action;
  }

  function formatHistoryTarget(row: AuditLogEntry): string {
    const details = row.details || {};
    const laneNumber = typeof details.lane_number === 'string' ? details.lane_number : null;
    const ptNumber = typeof details.pt_number === 'string' ? details.pt_number : null;
    const ptId = typeof details.pt_id === 'string' ? details.pt_id : null;
    const puNumber = typeof details.pu_number === 'string' ? details.pu_number : null;
    const containerNumber = typeof details.container_number === 'string' ? details.container_number : null;
    const status = typeof details.status === 'string' ? details.status : null;

    const parts: string[] = [];

    if (laneNumber) parts.push(`Lane ${laneNumber}`);
    if (ptNumber) parts.push(`PT ${ptNumber}`);
    if (!ptNumber && ptId) parts.push(`PT ID ${ptId}`);
    if (puNumber) parts.push(`PU ${puNumber}`);
    if (containerNumber) parts.push(`Container ${containerNumber}`);
    if (status) parts.push(`Status: ${status}`);

    if (parts.length > 0) {
      return `${row.target_table} · ${parts.join(' · ')}`;
    }

    return row.target_id
      ? `${row.target_table} #${row.target_id}`
      : row.target_table;
  }

  function formatRawDetails(details: Record<string, unknown> | null): string {
    if (!details) return '';
    return JSON.stringify(details, null, 2);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        Loading...
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6 md:p-10">
        <div className="max-w-3xl mx-auto bg-gray-800 border border-gray-700 rounded-xl p-6">
          <h1 className="text-2xl font-bold mb-2">Accounts</h1>
          <p className="text-red-300 mb-4">Admin access required.</p>
          <Link href="/" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-semibold inline-block">
            Back Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-bold">Account Management</h1>
          <Link href="/" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-semibold">
            Back Home
          </Link>
        </div>

        <form onSubmit={handleCreateAccount} className="bg-gray-800 border border-gray-700 rounded-xl p-4 md:p-5 space-y-3">
          <h2 className="text-lg md:text-xl font-bold">Create Account</h2>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <input
              name="new-account-username"
              autoComplete="off"
              value={createForm.username}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, username: e.target.value }))}
              placeholder="username"
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
            <input
              name="new-account-display-name"
              autoComplete="off"
              value={createForm.display_name}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, display_name: e.target.value }))}
              placeholder="display name"
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
            <input
              name="new-account-password"
              type="password"
              autoComplete="new-password"
              value={createForm.password}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
              placeholder="password"
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
            />
            <select
              value={createForm.role}
              onChange={(e) => setCreateForm((prev) => ({ ...prev, role: e.target.value as AppRole }))}
              className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
            >
              <option value="guest">guest</option>
              <option value="worker">worker</option>
              <option value="admin">admin</option>
            </select>
            <button
              type="submit"
              disabled={creating}
              className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded px-3 py-2 font-semibold"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>

        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 md:p-5 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <button
              onClick={() => setHistoryOpen((prev) => !prev)}
              className="text-left text-lg md:text-xl font-bold hover:text-gray-300"
            >
              {historyOpen ? '▼' : '▶'} User Activity History
            </button>
            {historyOpen && (
              <button
                onClick={() => void fetchHistory()}
                disabled={historyLoading}
                className="bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 rounded px-3 py-1.5 text-sm font-semibold"
              >
                {historyLoading ? 'Refreshing...' : 'Refresh'}
              </button>
            )}
          </div>

          {historyOpen && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <select
                  value={historyUserIdFilter}
                  onChange={(e) => {
                    const nextUser = e.target.value as 'all' | string;
                    setHistoryUserIdFilter(nextUser);
                    void fetchHistory(nextUser, historyDate);
                  }}
                  className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm"
                >
                  <option value="all">All accounts</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.username}
                    </option>
                  ))}
                </select>

                <input
                  type="date"
                  value={historyDate}
                  onChange={(e) => {
                    const nextDate = e.target.value;
                    setHistoryDate(nextDate);
                    void fetchHistory(historyUserIdFilter, nextDate);
                  }}
                  className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm"
                />

                <button
                  onClick={() => {
                    setHistoryDate('');
                    void fetchHistory(historyUserIdFilter, '');
                  }}
                  className="bg-gray-700 hover:bg-gray-600 rounded px-3 py-2 text-sm font-semibold"
                >
                  Show All Days
                </button>
              </div>

              <div className="text-xs text-gray-400">
                Viewing: {selectedHistoryAccount ? selectedHistoryAccount.username : 'all accounts'}{historyDate ? ` on ${historyDate}` : ' across all days'}
              </div>

              {historyError && (
                <div className="bg-red-900 border border-red-600 rounded-lg p-2 text-xs">
                  {historyError}
                </div>
              )}

              <div className="max-h-72 overflow-y-auto rounded border border-gray-700 bg-gray-900/50">
                {historyLoading ? (
                  <div className="p-3 text-sm text-gray-300">Loading history...</div>
                ) : historyRows.length === 0 ? (
                  <div className="p-3 text-sm text-gray-400">No history entries found for this filter.</div>
                ) : (
                  <div className="divide-y divide-gray-800">
                    {historyRows.map((row) => (
                      <div key={row.id} className="p-3 text-xs md:text-sm">
                        <div className="text-gray-300">
                          <span className="font-semibold">{getActionLabel(row.action)}</span>{' '}
                          <span className="text-gray-400">{formatHistoryTarget(row)}</span>
                        </div>
                        <div className="text-gray-500">
                          {new Date(row.created_at).toLocaleString()} · {row.actor_display_name || row.actor_username || 'system'}
                          {row.actor_role ? ` (${row.actor_role})` : ''}
                        </div>
                        <details className="mt-2 rounded border border-gray-700 bg-gray-900/70">
                          <summary className="cursor-pointer px-2 py-1 text-xs text-gray-400 hover:text-gray-200 select-none">
                            Raw details
                          </summary>
                          <pre className="max-h-48 overflow-auto border-t border-gray-700 px-2 py-2 text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap break-all">
                            {formatRawDetails(row.details) || 'No details'}
                          </pre>
                        </details>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {errorText && (
          <div className="bg-red-900 border border-red-600 rounded-lg p-3 text-sm">
            {errorText}
          </div>
        )}

        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 space-y-3">
            <div className="font-semibold">
              Accounts ({visibleAccounts.length}{visibleAccounts.length !== accounts.length ? ` / ${accounts.length}` : ''})
            </div>
            <input
              type="text"
              value={accountSearch}
              onChange={(e) => setAccountSearch(e.target.value)}
              placeholder="Search username or display name"
              className="w-full md:max-w-sm bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm"
            />
          </div>
          {loadingAccounts ? (
            <div className="p-4 text-gray-300">Loading accounts...</div>
          ) : visibleAccounts.length === 0 ? (
            <div className="p-4 text-gray-400">
              {accounts.length === 0 ? 'No accounts found.' : 'No matching accounts.'}
            </div>
          ) : (
            <div className="divide-y divide-gray-700">
              {visibleAccounts.map((account) => {
                const edits = editsById[account.id];
                if (!edits) return null;

                return (
                  <div key={account.id} className="p-4 space-y-2">
                    <div className="text-xs text-gray-400">{account.id}</div>
                    <div className="text-xs text-gray-500">
                      Last sign in: {account.last_sign_in_at ? new Date(account.last_sign_in_at).toLocaleString() : 'Never'}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                      <input
                        name={`edit-username-${account.id}`}
                        autoComplete="off"
                        value={edits.username}
                        onChange={(e) => setEditsById((prev) => ({
                          ...prev,
                          [account.id]: { ...prev[account.id], username: e.target.value }
                        }))}
                        className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
                      />
                      <input
                        name={`edit-display-${account.id}`}
                        autoComplete="off"
                        value={edits.display_name}
                        onChange={(e) => setEditsById((prev) => ({
                          ...prev,
                          [account.id]: { ...prev[account.id], display_name: e.target.value }
                        }))}
                        className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
                      />
                      <select
                        value={edits.role}
                        onChange={(e) => setEditsById((prev) => ({
                          ...prev,
                          [account.id]: { ...prev[account.id], role: e.target.value as AppRole }
                        }))}
                        className="bg-gray-700 border border-gray-600 rounded px-3 py-2"
                      >
                        <option value="guest">guest</option>
                        <option value="worker">worker</option>
                        <option value="admin">admin</option>
                      </select>
                      <label className="flex items-center gap-2 px-2">
                        <input
                          type="checkbox"
                          checked={edits.active}
                          onChange={(e) => setEditsById((prev) => ({
                            ...prev,
                            [account.id]: { ...prev[account.id], active: e.target.checked }
                          }))}
                        />
                        <span>Active</span>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => {
                          setHistoryUserIdFilter(account.id);
                          void fetchHistory(account.id, historyDate);
                        }}
                        className="bg-gray-600 hover:bg-gray-500 px-3 py-1.5 rounded font-semibold text-sm"
                      >
                        History
                      </button>
                      <button
                        onClick={() => void handleSaveAccount(account.id)}
                        disabled={savingId === account.id}
                        className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-sm"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => void handleResetPassword(account.id)}
                        disabled={savingId === account.id}
                        className="bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-sm"
                      >
                        Reset Password
                      </button>
                      <button
                        onClick={() => void handleDeleteAccount(account.id, account.username)}
                        disabled={savingId === account.id}
                        className="bg-red-600 hover:bg-red-700 disabled:bg-gray-600 px-3 py-1.5 rounded font-semibold text-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
