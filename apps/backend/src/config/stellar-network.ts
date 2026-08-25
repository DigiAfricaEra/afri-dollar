import { Networks } from '@stellar/stellar-sdk';

import { AppError } from '../types';

export type StellarNetwork = 'testnet' | 'mainnet';

/**
 * Normalizes STELLAR_NETWORK and rejects missing or unknown values.
 * Accepts case-insensitive, whitespace-padded `testnet` or `mainnet`.
 */
export function parseStellarNetwork(
  raw: string | undefined = process.env.STELLAR_NETWORK
): StellarNetwork {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value.length === 0) {
    throw new AppError(500, 'STELLAR_NETWORK is not set');
  }
  if (value !== 'testnet' && value !== 'mainnet') {
    throw new AppError(500, `Unsupported STELLAR_NETWORK: ${raw}`);
  }
  return value;
}

export function getNetworkPassphrase(network: StellarNetwork = parseStellarNetwork()): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

const DEFAULT_HORIZON: Record<StellarNetwork, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
};

/**
 * Horizon URL for the selected network. STELLAR_HORIZON_URL wins when set;
 * otherwise the public Horizon endpoint for that network is used.
 */
export function getDefaultHorizonUrl(network: StellarNetwork = parseStellarNetwork()): string {
  const override = process.env.STELLAR_HORIZON_URL?.trim();
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return DEFAULT_HORIZON[network];
}
