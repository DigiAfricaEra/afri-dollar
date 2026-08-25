import { Keypair } from '@stellar/stellar-sdk';

import { getSepConfig, parseSep24NumericLimits } from '../../config/sep.config';
import { getDefaultHorizonUrl, parseStellarNetwork } from '../../config/stellar-network';
import { AppError } from '../../types';

describe('parseStellarNetwork', () => {
  it('normalizes whitespace-padded and case-variant values', () => {
    expect(parseStellarNetwork(' TESTNET ')).toBe('testnet');
    expect(parseStellarNetwork('MainNet')).toBe('mainnet');
  });

  it('throws when the value is missing or blank', () => {
    const previous = process.env.STELLAR_NETWORK;
    delete process.env.STELLAR_NETWORK;
    try {
      expect(() => parseStellarNetwork()).toThrow(AppError);
      expect(() => parseStellarNetwork()).toThrow('STELLAR_NETWORK is not set');
    } finally {
      process.env.STELLAR_NETWORK = previous;
    }

    expect(() => parseStellarNetwork('   ')).toThrow('STELLAR_NETWORK is not set');
  });

  it('throws for unknown networks', () => {
    expect(() => parseStellarNetwork('futurenet')).toThrow('Unsupported STELLAR_NETWORK');
  });
});

describe('parseSep24NumericLimits', () => {
  it('accepts whitespace-padded numeric strings', () => {
    const limits = parseSep24NumericLimits({
      SEP24_MIN_AMOUNT: ' 2 ',
      SEP24_MAX_AMOUNT: ' 50 ',
      SEP24_FEE_FIXED: ' 0 ',
      SEP24_FEE_PERCENT: ' 1.5 ',
    });

    expect(limits).toEqual({
      minAmount: 2,
      maxAmount: 50,
      feeFixed: 0,
      feePercent: 1.5,
    });
  });

  it('rejects non-finite, negative, and reversed limits', () => {
    expect(() => parseSep24NumericLimits({ SEP24_MIN_AMOUNT: 'abc' })).toThrow(
      'SEP24_MIN_AMOUNT must be a finite number'
    );

    expect(() => parseSep24NumericLimits({ SEP24_MIN_AMOUNT: '-1' })).toThrow(
      'SEP24_MIN_AMOUNT must be greater than 0'
    );

    expect(() => parseSep24NumericLimits({ SEP24_MIN_AMOUNT: '0' })).toThrow(
      'SEP24_MIN_AMOUNT must be greater than 0'
    );

    expect(() =>
      parseSep24NumericLimits({
        SEP24_MIN_AMOUNT: '10',
        SEP24_MAX_AMOUNT: '5',
      })
    ).toThrow('SEP24_MAX_AMOUNT must be greater than or equal to SEP24_MIN_AMOUNT');

    expect(() => parseSep24NumericLimits({ SEP24_FEE_FIXED: '-0.1' })).toThrow(
      'SEP24_FEE_FIXED must be greater than or equal to 0'
    );
  });
});

describe('getSepConfig network defaults', () => {
  const originalEnv = { ...process.env };
  const signing = Keypair.random();

  beforeEach(() => {
    process.env.STELLAR_TOML_SIGNING_KEY = signing.secret();
    process.env.SEP10_HOME_DOMAIN = 'localhost:3001';
    process.env.SEP10_JWT_SECRET = 'sep10-secret';
    process.env.JWT_SECRET = 'app-secret';
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.SEP24_USDC_ISSUER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the testnet Horizon URL and USDC issuer by default', () => {
    process.env.STELLAR_NETWORK = 'testnet';
    const config = getSepConfig();

    expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    expect(config.assets.find((asset) => asset.code === 'USDC')?.issuer).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
    expect(getDefaultHorizonUrl('testnet')).toBe('https://horizon-testnet.stellar.org');
  });

  it('requires SEP24_USDC_ISSUER on mainnet and uses public Horizon', () => {
    process.env.STELLAR_NETWORK = 'mainnet';
    expect(() => getSepConfig()).toThrow('SEP24_USDC_ISSUER is required on mainnet');

    process.env.SEP24_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const config = getSepConfig();

    expect(config.horizonUrl).toBe('https://horizon.stellar.org');
    expect(config.assets.find((asset) => asset.code === 'USDC')?.issuer).toBe(
      'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    );
    expect(getDefaultHorizonUrl('mainnet')).toBe('https://horizon.stellar.org');
  });
});
