'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { AppRole } from '@/lib/auth';

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

export default function AccountsPage() {
  const { loading, isAdmin, session } = useAuth();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
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

  useEffect(() => {
    if (!loading && isAdmin) {
      void fetchAccounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isAdmin]);

  async function fetchAccounts() {
    if (!session?.access_token) return;

    setLoadingAccounts(true);
    setErrorText('');
    try {
      const response = await fetch('/api/admin/users', {
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      });
      const payload = await response.json();
      if (!response.ok) {
        setErrorText(payload.error || 'Failed to load accounts.');
        return;
      }

      const nextAccounts = payload.users as AccountRow[];
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

  async function handleCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.access_token) return;

    setErrorText('');
    setCreating(true);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify(createForm)
      });
      const payload = await response.json();
      if (!response.ok) {
        setErrorText(payload.error || 'Failed to create account.');
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
    if (!session?.access_token) return;
    const edits = editsById[accountId];
    if (!edits) return;

    setSavingId(accountId);
    setErrorText('');
    try {
      const response = await fetch(`/api/admin/users/${accountId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          username: edits.username,
          display_name: edits.display_name,
          role: edits.role,
          active: edits.active
        })
      });
      const payload = await response.json();
      if (!response.ok) {
        setErrorText(payload.error || 'Failed to save account.');
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
    if (!session?.access_token) return;

    const nextPassword = window.prompt('Enter new password (min 8 chars):');
    if (nextPassword === null) return;

    setSavingId(accountId);
    setErrorText('');
    try {
      const response = await fetch(`/api/admin/users/${accountId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ password: nextPassword })
      });
      const payload = await response.json();
      if (!response.ok) {
        setErrorText(payload.error || 'Failed to reset password.');
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
    if (!session?.access_token) return;
    const confirmed = window.confirm(`Delete account "${username}"? This cannot be undone.`);
    if (!confirmed) return;

    setSavingId(accountId);
    setErrorText('');
    try {
      const response = await fetch(`/api/admin/users/${accountId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${session.access_token}`
        }
      });
      const payload = await response.json();
      if (!response.ok) {
        setErrorText(payload.error || 'Failed to delete account.');
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

        {errorText && (
          <div className="bg-red-900 border border-red-600 rounded-lg p-3 text-sm">
            {errorText}
          </div>
        )}

        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 font-semibold">
            Accounts ({accounts.length})
          </div>
          {loadingAccounts ? (
            <div className="p-4 text-gray-300">Loading accounts...</div>
          ) : accounts.length === 0 ? (
            <div className="p-4 text-gray-400">No accounts found.</div>
          ) : (
            <div className="divide-y divide-gray-700">
              {accounts.map((account) => {
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
