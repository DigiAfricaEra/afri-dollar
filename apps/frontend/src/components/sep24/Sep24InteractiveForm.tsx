'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';

interface Sep24InteractiveFormProps {
  sessionId: string;
  kind: 'deposit' | 'withdraw';
}

interface CompleteResponse {
  id: string;
  status: string;
  kind: string;
  sendTo?: string;
  memo?: string;
  stellarTxId?: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === 'object' && 'error' in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) {
      return error;
    }
  }
  return fallback;
}

export function Sep24InteractiveForm({ sessionId, kind }: Sep24InteractiveFormProps): JSX.Element {
  const [bankName, setBankName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResponse | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const title = kind === 'deposit' ? 'Anchor deposit' : 'Anchor withdrawal';
  const description =
    kind === 'deposit'
      ? 'Submit your bank details. USDC is sent to your Stellar wallet after the bank transfer is confirmed.'
      : 'Submit payout details. You will then send Stellar funds to the anchor hot wallet.';

  useEffect(() => {
    if (result !== null) {
      resultRef.current?.focus();
    }
  }, [result]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    void (async (): Promise<void> => {
      try {
        const response = await fetch(
          `${API_BASE}/sep24/interactive/complete/${encodeURIComponent(sessionId)}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bankName,
              accountName,
              accountNumber,
              amount: amount.length > 0 ? amount : undefined,
            }),
          }
        );

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
          throw new Error(`Unable to complete this transfer (${response.status})`);
        }

        const payload = (await response.json()) as CompleteResponse & { error?: string };
        if (!response.ok) {
          throw new Error(
            readErrorMessage(payload, `Unable to complete this transfer (${response.status})`)
          );
        }

        setResult(payload);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Unable to complete this transfer');
      } finally {
        setLoading(false);
      }
    })();
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div
              role="alert"
              className="mb-4 rounded border border-red-400 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          {result ? (
            <div
              ref={resultRef}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              className="space-y-2 text-sm outline-none"
            >
              <p>
                Status: <strong>{result.status}</strong>
              </p>
              {result.stellarTxId && <p>Stellar transaction: {result.stellarTxId}</p>}
              {result.sendTo && (
                <p>
                  Send funds to <code className="break-all">{result.sendTo}</code>
                  {result.memo ? ` with memo ${result.memo}` : ''}
                </p>
              )}
            </div>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
              <Input
                label="Bank name"
                value={bankName}
                onChange={(event) => setBankName(event.target.value)}
                required
              />
              <Input
                label="Account name"
                value={accountName}
                onChange={(event) => setAccountName(event.target.value)}
                required
              />
              <Input
                label="Account number"
                value={accountNumber}
                onChange={(event) => setAccountNumber(event.target.value)}
                required
              />
              <Input
                label="Amount"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="100.00"
              />
              <Button type="submit" loading={loading}>
                Continue
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
