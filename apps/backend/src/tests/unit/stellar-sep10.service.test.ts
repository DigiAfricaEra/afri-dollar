/* eslint-disable @typescript-eslint/unbound-method */
import { Keypair, Transaction } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { StellarSep10Service } from '../../services/stellar-sep10.service';
import { resetOnceClaims } from '../../utils/once-claim';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    wallet: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  },
}));

const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;

const server = Keypair.random();
const client = Keypair.random();

describe('StellarSep10Service', () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.STELLAR_NETWORK = 'testnet';
    process.env.STELLAR_TOML_SIGNING_KEY = server.secret();
    process.env.SEP10_HOME_DOMAIN = 'localhost:3001';
    process.env.SEP10_WEB_AUTH_DOMAIN = 'localhost:3001';
    process.env.JWT_SECRET = 'app-jwt-secret';
    process.env.SEP10_JWT_SECRET = 'sep10-test-secret';
    process.env.SEP_API_PUBLIC_URL = 'http://localhost:3001';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetOnceClaims();
    mockWalletFindUnique.mockResolvedValue({
      publicKey: client.publicKey(),
      user: { id: 'user-1', role: 'USER' },
    });
    mockUserFindUnique.mockResolvedValue(null);
  });

  it('builds a challenge XDR with the client account manageData operation', () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    const firstOp = tx.operations[0];

    expect(challenge.network_passphrase).toContain('Test SDF Network');
    expect(firstOp.type).toBe('manageData');
    expect(firstOp.source).toBe(client.publicKey());
    expect((firstOp as { name: string }).name).toBe('localhost:3001 auth');
  });

  it('puts the configured web_auth_domain in the challenge and matches stellar.toml SIGNING_KEY', () => {
    const toml = StellarSep10Service.getStellarToml();
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    const webAuthOp = tx.operations.find(
      (op) => op.type === 'manageData' && (op as { name: string }).name === 'web_auth_domain'
    ) as { value?: Buffer | string } | undefined;

    expect(toml).toContain(`SIGNING_KEY="${server.publicKey()}"`);
    expect(webAuthOp).toBeDefined();
    expect(String(webAuthOp?.value)).toBe('localhost:3001');
  });

  it('issues a JWT when the client signs a valid challenge', async () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    tx.sign(client);

    const result = await StellarSep10Service.verifyChallenge(tx.toEnvelope().toXDR('base64'));
    const payload = StellarSep10Service.verifySepJwt(result.token);

    expect(payload.sub).toBe(client.publicKey());
    expect(payload.userId).toBe('user-1');
    expect(payload.role).toBe('USER');
  });

  it('rejects a challenge with a tampered signature', async () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    tx.sign(Keypair.random());

    await expect(
      StellarSep10Service.verifyChallenge(tx.toEnvelope().toXDR('base64'))
    ).rejects.toMatchObject({
      status: 401,
      message: 'Challenge signatures are invalid',
    });
  });

  it('rejects an expired challenge', async () => {
    jest.useFakeTimers();
    try {
      const challenge = StellarSep10Service.buildChallenge(client.publicKey());
      const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
      tx.sign(client);
      jest.setSystemTime(Date.now() + 6 * 60 * 1000);

      await expect(
        StellarSep10Service.verifyChallenge(tx.toEnvelope().toXDR('base64'))
      ).rejects.toMatchObject({
        status: 400,
        message: 'Challenge transaction has expired',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a challenge after the home_domain configuration changes', async () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    tx.sign(client);
    process.env.SEP10_HOME_DOMAIN = 'other.example';

    try {
      await expect(
        StellarSep10Service.verifyChallenge(tx.toEnvelope().toXDR('base64'))
      ).rejects.toMatchObject({
        status: 400,
        message: 'Challenge is missing home domain auth operation',
      });
    } finally {
      process.env.SEP10_HOME_DOMAIN = 'localhost:3001';
    }
  });

  it('rejects a challenge after the web_auth_domain configuration changes', async () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    tx.sign(client);
    process.env.SEP10_WEB_AUTH_DOMAIN = 'other.example';

    try {
      await expect(
        StellarSep10Service.verifyChallenge(tx.toEnvelope().toXDR('base64'))
      ).rejects.toMatchObject({
        status: 400,
        message: 'web_auth_domain does not match this anchor',
      });
    } finally {
      process.env.SEP10_WEB_AUTH_DOMAIN = 'localhost:3001';
    }
  });

  it('rejects a challenge whose source account is not the signing key', async () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    tx.sign(client);
    process.env.STELLAR_TOML_SIGNING_KEY = Keypair.random().secret();

    try {
      await expect(
        StellarSep10Service.verifyChallenge(tx.toEnvelope().toXDR('base64'))
      ).rejects.toMatchObject({
        status: 400,
        message: 'Challenge source account mismatch',
      });
    } finally {
      process.env.STELLAR_TOML_SIGNING_KEY = server.secret();
    }
  });

  it('rejects a reused challenge transaction', async () => {
    const challenge = StellarSep10Service.buildChallenge(client.publicKey());
    const tx = new Transaction(challenge.transaction, challenge.network_passphrase);
    tx.sign(client);
    const xdr = tx.toEnvelope().toXDR('base64');

    await expect(StellarSep10Service.verifyChallenge(xdr)).resolves.toHaveProperty('token');
    await expect(StellarSep10Service.verifyChallenge(xdr)).rejects.toMatchObject({
      status: 401,
      message: 'Challenge has already been used',
    });
  });
});
