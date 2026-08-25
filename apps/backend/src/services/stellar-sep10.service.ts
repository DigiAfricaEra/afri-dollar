import { createHash, randomBytes } from 'crypto';

import {
  Account,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { sign, verify } from 'jsonwebtoken';

import prisma from '../config/database';
import { getSepConfig } from '../config/sep.config';
import { AppError } from '../types';
import type { Sep10ChallengeResponse, Sep10TokenResponse, SepJwtPayload } from '../types/sep.types';
import { SEP10_CHALLENGE_TTL_SECONDS } from '../types/sep.types';
import { claimOnce } from '../utils/once-claim';

function isManageDataOp(
  op: Transaction['operations'][number]
): op is Transaction['operations'][number] & {
  type: 'manageData';
  name: string;
  value: Buffer | null;
} {
  return op.type === 'manageData';
}

function hasServerAndClientSignatures(
  tx: Transaction,
  serverPublicKey: string,
  clientAccount: string
): boolean {
  const txHash = tx.hash();
  const serverKey = Keypair.fromPublicKey(serverPublicKey);
  const clientKey = Keypair.fromPublicKey(clientAccount);

  let serverSigned = false;
  let clientSigned = false;

  for (const sig of tx.signatures) {
    const signature = sig.signature();
    if (!serverSigned && serverKey.verify(txHash, signature)) {
      serverSigned = true;
    }
    if (!clientSigned && clientKey.verify(txHash, signature)) {
      clientSigned = true;
    }
  }

  return serverSigned && clientSigned;
}

export const StellarSep10Service = {
  /**
   * Builds a SEP-10 challenge transaction for the given client account.
   */
  buildChallenge(
    clientAccount: string,
    homeDomain?: string,
    webAuthDomain?: string
  ): Sep10ChallengeResponse {
    const config = getSepConfig();

    if (!StrKey.isValidEd25519PublicKey(clientAccount)) {
      throw new AppError(400, 'Invalid Stellar account');
    }

    const resolvedHome = (homeDomain || config.homeDomain).replace(/^https?:\/\//, '');
    if (resolvedHome !== config.homeDomain) {
      throw new AppError(400, 'home_domain does not match this anchor');
    }

    const resolvedWebAuth = (webAuthDomain || config.webAuthDomain).replace(/^https?:\/\//, '');
    if (resolvedWebAuth !== config.webAuthDomain) {
      throw new AppError(400, 'web_auth_domain does not match this anchor');
    }

    const now = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(48).toString('base64');
    const serverAccount = new Account(config.signingPublicKey, '-1');

    const tx = new TransactionBuilder(serverAccount, {
      fee: '100',
      networkPassphrase: config.networkPassphrase,
      timebounds: { minTime: now, maxTime: now + SEP10_CHALLENGE_TTL_SECONDS },
    })
      .addOperation(
        Operation.manageData({
          source: clientAccount,
          name: `${config.homeDomain} auth`,
          value: nonce,
        })
      )
      .addOperation(
        Operation.manageData({
          source: config.signingPublicKey,
          name: 'web_auth_domain',
          value: config.webAuthDomain,
        })
      )
      .build();

    tx.sign(config.signingKeypair);

    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      network_passphrase: config.networkPassphrase,
    };
  },

  /**
   * Validates a signed SEP-10 challenge, resolves the client account, and issues a 24h JWT.
   */
  async verifyChallenge(xdr: string): Promise<Sep10TokenResponse> {
    if (!xdr || typeof xdr !== 'string') {
      throw new AppError(400, 'transaction XDR is required');
    }

    const config = getSepConfig();
    let tx: Transaction;

    try {
      tx = new Transaction(xdr, config.networkPassphrase);
    } catch {
      throw new AppError(400, 'Invalid challenge transaction');
    }

    if (tx.source !== config.signingPublicKey) {
      throw new AppError(400, 'Challenge source account mismatch');
    }

    if (String(tx.sequence) !== '0') {
      throw new AppError(400, 'Challenge sequence number must be 0');
    }

    const now = Math.floor(Date.now() / 1000);
    const minTime = Number(tx.timeBounds?.minTime ?? 0);
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    if (!tx.timeBounds || now < minTime || now > maxTime) {
      throw new AppError(400, 'Challenge transaction has expired');
    }

    const firstOp = tx.operations[0];
    if (!firstOp || !isManageDataOp(firstOp) || firstOp.name !== `${config.homeDomain} auth`) {
      throw new AppError(400, 'Challenge is missing home domain auth operation');
    }

    const clientAccount = firstOp.source;
    if (!clientAccount || !StrKey.isValidEd25519PublicKey(clientAccount)) {
      throw new AppError(400, 'Challenge is missing client account');
    }

    const webAuthOp = tx.operations.find(
      (op) => isManageDataOp(op) && op.name === 'web_auth_domain'
    );
    if (!webAuthOp || !isManageDataOp(webAuthOp)) {
      throw new AppError(400, 'Challenge is missing web_auth_domain');
    }

    const webAuthValue = webAuthOp.value ? webAuthOp.value.toString() : '';
    if (webAuthValue !== config.webAuthDomain) {
      throw new AppError(400, 'web_auth_domain does not match this anchor');
    }

    if (!hasServerAndClientSignatures(tx, config.signingPublicKey, clientAccount)) {
      throw new AppError(401, 'Challenge signatures are invalid');
    }

    const wallet = await prisma.wallet.findUnique({
      where: { publicKey: clientAccount },
      include: { user: { select: { id: true, role: true } } },
    });

    let userId = wallet?.user.id;
    let role = wallet?.user.role;

    if (!userId) {
      const user = await prisma.user.findUnique({
        where: { walletAddress: clientAccount },
        select: { id: true, role: true },
      });
      userId = user?.id;
      role = user?.role;
    }

    const jti = createHash('sha256').update(xdr).digest('hex');
    const claimed = await claimOnce(`sep10:challenge:${jti}`, SEP10_CHALLENGE_TTL_SECONDS);
    if (!claimed) {
      throw new AppError(401, 'Challenge has already been used');
    }

    const payload: Omit<SepJwtPayload, 'iat' | 'exp'> = {
      iss: `${config.apiPublicUrl}/auth`,
      sub: clientAccount,
      jti,
      home_domain: config.homeDomain,
      userId,
      role,
    };

    const token = sign(payload, config.jwtSecret, {
      expiresIn: '24h',
      algorithm: 'HS256',
    });

    return { token };
  },

  verifySepJwt(token: string): SepJwtPayload {
    const config = getSepConfig();
    try {
      const decoded = verify(token, config.jwtSecret, {
        algorithms: ['HS256'],
        issuer: `${config.apiPublicUrl}/auth`,
      }) as SepJwtPayload;
      if (!decoded.sub) {
        throw new AppError(401, 'Invalid or expired SEP-10 token');
      }
      return decoded;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(401, 'Invalid or expired SEP-10 token');
    }
  },

  getStellarToml(): string {
    const config = getSepConfig();
    const lines = [
      `NETWORK_PASSPHRASE="${config.networkPassphrase}"`,
      `HORIZON_URL="${config.horizonUrl}"`,
      `WEB_AUTH_ENDPOINT="${config.apiPublicUrl}/auth"`,
      `TRANSFER_SERVER_SEP0024="${config.apiPublicUrl}/sep24"`,
      `SIGNING_KEY="${config.signingPublicKey}"`,
      `ACCOUNTS=["${config.signingPublicKey}"]`,
      'VERSION="0.1.0"',
    ];

    return `${lines.join('\n')}\n`;
  },
};
