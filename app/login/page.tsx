'use client';

import { FormEvent, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';

export default function LoginPage() {
  const { signIn } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText('');

    const trimmedIdentifier = identifier.trim();
    if (!trimmedIdentifier || !password) {
      setErrorText('Enter username/email and password.');
      return;
    }

    setSubmitting(true);
    const { error } = await signIn(trimmedIdentifier, password);
    setSubmitting(false);

    if (error) {
      setErrorText(error);
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-800 border border-gray-700 rounded-xl p-6 md:p-8">
        <h1 className="text-2xl md:text-3xl font-bold mb-2">Sign In</h1>
        <p className="text-gray-400 text-sm md:text-base mb-6">
          Use your username (or email) and password.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Username or Email</label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2"
              autoComplete="username"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2"
              autoComplete="current-password"
              disabled={submitting}
            />
          </div>

          {errorText && (
            <div className="bg-red-900 border border-red-600 rounded-lg px-3 py-2 text-sm">
              {errorText}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg py-2.5 font-semibold"
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
