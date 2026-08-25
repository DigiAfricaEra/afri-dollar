import { Keypair, StrKey } from '@stellar/stellar-sdk';

import { AppError } from '../types';
import type { Sep24AssetConfig } from '../types/sep.types';

import {
  getDefaultHorizonUrl,
  getNetworkPassphrase,
  parseStellarNetwork,
  type StellarNetwork,
} from './stellar-network';

const DEFAULT_TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export interface SepRuntimeConfig {
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  horizonUrl: string;
  frontendBaseUrl: string;
  apiPublicUrl: string;
  signingKeypair: Keypair;
  signingPublicKey: string;
  jwtSecret: string;
  stateHmacSecret: string;
  hotWalletPublicKey?: string;
  assets: Sep24AssetConfig[];
}

export interface Sep24NumericLimits {
  minAmount: number;
  maxAmount: number;
  feeFixed: number;
  feePercent: number;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new AppError(500, `Server configuration error: ${name} is not set`);
  }
  return value;
}

function parseSigningKeypair(): Keypair {
  const tomlKey = process.env.STELLAR_TOML_SIGNING_KEY?.trim();
  const secretKey = process.env.STELLAR_SECRET_KEY?.trim();

  if (tomlKey !== undefined && tomlKey.length > 0 && StrKey.isValidEd25519SecretSeed(tomlKey)) {
    const keypair = Keypair.fromSecret(tomlKey);
    if (
      secretKey !== undefined &&
      secretKey.length > 0 &&
      secretKey !== tomlKey &&
      StrKey.isValidEd25519SecretSeed(secretKey)
    ) {
      const other = Keypair.fromSecret(secretKey);
      if (other.publicKey() !== keypair.publicKey()) {
        throw new AppError(500, 'STELLAR_SECRET_KEY does not match STELLAR_TOML_SIGNING_KEY');
      }
    }
    return keypair;
  }

  if (
    secretKey !== undefined &&
    secretKey.length > 0 &&
    StrKey.isValidEd25519SecretSeed(secretKey)
  ) {
    const keypair = Keypair.fromSecret(secretKey);
    if (
      tomlKey !== undefined &&
      tomlKey.length > 0 &&
      StrKey.isValidEd25519PublicKey(tomlKey) &&
      tomlKey !== keypair.publicKey()
    ) {
      throw new AppError(500, 'STELLAR_TOML_SIGNING_KEY does not match STELLAR_SECRET_KEY');
    }
    return keypair;
  }

  throw new AppError(
    500,
    'STELLAR_TOML_SIGNING_KEY or STELLAR_SECRET_KEY must be a valid secret seed'
  );
}

function parseFiniteNumber(name: string, raw: string | undefined, fallback: string): number {
  const source = (raw ?? fallback).trim();
  const value = Number(source);
  if (!Number.isFinite(value)) {
    throw new AppError(500, `${name} must be a finite number`);
  }
  return value;
}

export function parseSep24NumericLimits(env?: {
  SEP24_MIN_AMOUNT?: string;
  SEP24_MAX_AMOUNT?: string;
  SEP24_FEE_FIXED?: string;
  SEP24_FEE_PERCENT?: string;
}): Sep24NumericLimits {
  const source = env ?? process.env;
  const minAmount = parseFiniteNumber('SEP24_MIN_AMOUNT', source.SEP24_MIN_AMOUNT, '1');
  const maxAmount = parseFiniteNumber('SEP24_MAX_AMOUNT', source.SEP24_MAX_AMOUNT, '100000');
  const feeFixed = parseFiniteNumber('SEP24_FEE_FIXED', source.SEP24_FEE_FIXED, '0');
  const feePercent = parseFiniteNumber('SEP24_FEE_PERCENT', source.SEP24_FEE_PERCENT, '0.5');

  if (minAmount <= 0) {
    throw new AppError(500, 'SEP24_MIN_AMOUNT must be greater than 0');
  }
  if (maxAmount < minAmount) {
    throw new AppError(500, 'SEP24_MAX_AMOUNT must be greater than or equal to SEP24_MIN_AMOUNT');
  }
  if (feeFixed < 0) {
    throw new AppError(500, 'SEP24_FEE_FIXED must be greater than or equal to 0');
  }
  if (feePercent < 0) {
    throw new AppError(500, 'SEP24_FEE_PERCENT must be greater than or equal to 0');
  }

  return { minAmount, maxAmount, feeFixed, feePercent };
}

function parseAssets(network: StellarNetwork): Sep24AssetConfig[] {
  const configuredIssuer = process.env.SEP24_USDC_ISSUER?.trim();
  let issuer: string;
  if (configuredIssuer !== undefined && configuredIssuer.length > 0) {
    issuer = configuredIssuer;
  } else if (network === 'mainnet') {
    throw new AppError(500, 'SEP24_USDC_ISSUER is required on mainnet');
  } else {
    issuer = DEFAULT_TESTNET_USDC_ISSUER;
  }

  const limits = parseSep24NumericLimits();

  return [
    {
      code: 'USDC',
      issuer,
      ...limits,
    },
    {
      code: 'XLM',
      ...limits,
    },
  ];
}

export function getSepConfig(): SepRuntimeConfig {
  const network = parseStellarNetwork();
  const homeDomain = requireEnv('SEP10_HOME_DOMAIN').replace(/^https?:\/\//, '');
  const webAuthDomain = (process.env.SEP10_WEB_AUTH_DOMAIN || homeDomain)
    .trim()
    .replace(/^https?:\/\//, '');
  const signingKeypair = parseSigningKeypair();
  const apiPublicUrl = trimSlash(process.env.SEP_API_PUBLIC_URL?.trim() || `https://${homeDomain}`);
  const frontendBaseUrl = trimSlash(
    process.env.SEP24_INTERACTIVE_FRONTEND_BASE_URL?.trim() || apiPublicUrl
  );
  const jwtSecret = requireEnv('SEP10_JWT_SECRET');
  const appJwtSecret = process.env.JWT_SECRET?.trim();
  if (appJwtSecret !== undefined && appJwtSecret.length > 0 && jwtSecret === appJwtSecret) {
    throw new AppError(500, 'SEP10_JWT_SECRET must be different from JWT_SECRET');
  }

  return {
    homeDomain,
    webAuthDomain,
    networkPassphrase: getNetworkPassphrase(network),
    horizonUrl: getDefaultHorizonUrl(network),
    frontendBaseUrl,
    apiPublicUrl,
    signingKeypair,
    signingPublicKey: signingKeypair.publicKey(),
    jwtSecret,
    stateHmacSecret: process.env.SEP24_STATE_HMAC_SECRET?.trim() || jwtSecret,
    hotWalletPublicKey: process.env.SEP24_HOT_WALLET_PUBLIC_KEY?.trim() || undefined,
    assets: parseAssets(network),
  };
}

export function findSepAsset(assetCode: string): Sep24AssetConfig | undefined {
  const code = assetCode.trim().toUpperCase();
  return getSepConfig().assets.find((asset) => asset.code === code);
}
