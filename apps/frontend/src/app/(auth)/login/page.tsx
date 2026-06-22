'use client';

import { useRouter } from 'next/navigation';
import React, { useState } from 'react';

import { setAuthToken } from '../../../lib/auth';
import { useStore } from '../../../store/useStore';

const COMMUNITY_URL = 'https://t.me/DigiAfrcaEra/1';

/**
 * LoginPage renders the user sign-in screen.
 * It provides email and password inputs, error validation feedback,
 * and handles mock authentication with redirecting to dashboard.
 */
export default function LoginPage(): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { setWallet } = useStore();

  /**
   * Handles sign-in form submission.
   * Performs basic validation, triggers a mock network delay,
   * stores authentication token, updates local store state,
   * and redirects user to dashboard.
   *
   * @param e React form submission event
   */
  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    void (async (): Promise<void> => {
      try {
        // Simple validation first
        if (!email || password.length < 6) {
          throw new Error('Please enter a valid email and a password of at least 6 characters.');
        }

        // Mock API call validation/delay
        await new Promise((resolve) => setTimeout(resolve, 800));

        // Store mock token & update global wallet state
        setAuthToken('mock-auth-token-xyz123');
        setWallet('GBXXSAMPLEWALLET34ND', 124500.0);

        // Redirect to dashboard
        router.push('/dashboard');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Login failed. Please try again.';
        setError(message);
        setLoading(false);
      }
    })();
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-md w-full items-center justify-center font-mono text-sm border p-8 rounded-lg shadow-md">
        <h1 className="text-3xl font-bold mb-6 text-center">Login to AfriDollar</h1>
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className="bg-red-100 border border-red-400 text-red-700 px-4 py-2 rounded mb-4 text-xs"
          >
            {error}
          </div>
        )}
        <form method="post" onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                setEmail(e.target.value);
              }}
              className="p-2 border rounded"
              required
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                setPassword(e.target.value);
              }}
              className="p-2 border rounded"
              required
              disabled={loading}
            />
          </div>
          <button
            type="submit"
            className="bg-blue-600 text-white p-2 rounded hover:bg-blue-700 disabled:bg-blue-300"
            disabled={loading}
          >
            {loading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>
        <div className="mt-6 text-center text-xs text-gray-600">
          <p className="mb-1">Join the project community</p>
          <a
            href={COMMUNITY_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            https://t.me/DigiAfrcaEra/1
          </a>
        </div>
      </div>
    </div>
  );
}
