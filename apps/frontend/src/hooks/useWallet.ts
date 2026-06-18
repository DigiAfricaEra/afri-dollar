import { useState, useEffect } from 'react';

import { loadStellarAccount } from '../lib/stellar';

interface WalletState {
  address: string | null;
  balance: number;
  loading: boolean;
  error: string | null;
}

/**
 * Custom hook to load and manage Stellar account state (address, balances, loading, and error).
 * It uses loadStellarAccount underneath to communicate with the network.
 *
 * @param publicKey Optional Stellar account public key address string
 * @returns WalletState containing the current state details
 */
export function useWallet(publicKey?: string): WalletState {
  const [state, setState] = useState<WalletState>({
    address: publicKey || null,
    balance: 0,
    loading: !!publicKey,
    error: null,
  });

  useEffect((): (() => void) | void => {
    if (!publicKey) return;

    let isMounted = true;
    setState((prev: WalletState): WalletState => ({ ...prev, loading: true, error: null }));

    void loadStellarAccount(publicKey)
      .then((data: { balances: Array<{ balance: string; asset_type: string }> }) => {
        if (!isMounted) return;
        const usdcBalance = data.balances.find((b) => b.asset_type === 'credit_alphanum4');
        setState({
          address: publicKey,
          balance: usdcBalance ? parseFloat(usdcBalance.balance) : 0,
          loading: false,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (!isMounted) return;
        setState({
          address: publicKey,
          balance: 0,
          loading: false,
          error: err.message,
        });
      });

    return (): void => {
      isMounted = false;
    };
  }, [publicKey]);

  return state;
}
