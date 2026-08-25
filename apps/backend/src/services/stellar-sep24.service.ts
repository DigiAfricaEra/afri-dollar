import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { Prisma } from '@afri-dollar/database';
import type { UserRole } from '@prisma/client';
import { StrKey } from '@stellar/stellar-sdk';

import prisma from '../config/database';
import { findSepAsset, getSepConfig } from '../config/sep.config';
import { AppError } from '../types';
import type {
  Sep24CompleteInteractiveRequest,
  Sep24CompleteInteractiveResult,
  Sep24InfoResponse,
  Sep24InteractiveRequest,
  Sep24InteractiveStartResult,
  Sep24TransactionFilters,
  Sep24TransactionRecord,
  Sep24TransactionsResponse,
  SepJwtPayload,
  SEPSessionType,
  SEPTransactionStatus,
} from '../types/sep.types';
import { SEP24_ALLOWED_ROLES, SEP24_JWT_TTL_SECONDS } from '../types/sep.types';
import { decrypt, encrypt } from '../utils/crypto';
import { signSep24State } from '../utils/sep-cookie';

import { StellarPaymentSubmitError, StellarService } from './stellar.service';
import { WebhookService } from './webhook.service';

type SessionMetadata = {
  clientAccount?: string;
  assetCode?: string;
  assetIssuer?: string;
  memo?: string;
  methodType?: string;
  payoutDetailsEncrypted?: string;
  interactiveTokenHash?: string;
  interactiveTokenExp?: number;
  submittedTxHash?: string;
  error?: string;
};

function isSessionMetadata(value: unknown): value is SessionMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asMetadata(value: unknown): SessionMetadata {
  return isSessionMetadata(value) ? value : {};
}

function assertSepRole(
  jwt?: SepJwtPayload
): asserts jwt is SepJwtPayload & { userId: string; role: UserRole } {
  if (jwt === undefined) {
    throw new AppError(401, 'SEP-10 token is required');
  }
  if (
    jwt.userId === undefined ||
    jwt.role === undefined ||
    !SEP24_ALLOWED_ROLES.includes(jwt.role)
  ) {
    throw new AppError(403, 'Insufficient permissions');
  }
}

function toSep24Transaction(session: {
  id: string;
  type: string;
  status: string;
  amount: string | null;
  stellarTxId: string | null;
  externalRef: string | null;
  metadata: unknown;
  createdAt: Date;
  completedAt: Date | null;
}): Sep24TransactionRecord {
  const metadata = asMetadata(session.metadata);
  const record: Sep24TransactionRecord = {
    id: session.id,
    kind: session.type as SEPSessionType,
    status: session.status as SEPTransactionStatus,
    started_at: session.createdAt.toISOString(),
  };

  if (session.amount) {
    record.amount_in = session.amount;
  }
  if (session.completedAt) {
    record.completed_at = session.completedAt.toISOString();
  }
  if (session.stellarTxId) {
    record.stellar_transaction_id = session.stellarTxId;
  }
  if (session.externalRef) {
    record.external_transaction_id = session.externalRef;
  }
  if (metadata.memo) {
    record.memo = metadata.memo;
    record.memo_type = 'text';
  }
  if (metadata.clientAccount) {
    if (session.type === 'deposit') {
      record.to = metadata.clientAccount;
    } else {
      record.from = metadata.clientAccount;
    }
  }

  return record;
}

function asJson(value: SessionMetadata): Prisma.InputJsonValue {
  return value;
}

function hashInteractiveToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokensMatch(expectedHex: string, provided: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(hashInteractiveToken(provided), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function encryptPayoutDetails(details: Sep24CompleteInteractiveRequest): string {
  return encrypt(
    JSON.stringify({
      bankName: details.bankName,
      accountName: details.accountName,
      accountNumber: details.accountNumber,
      routingNumber: details.routingNumber,
    })
  );
}

function sessionMemo(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 28);
}

function buildInteractiveUrl(kind: SEPSessionType, sessionId: string, token: string): string {
  const config = getSepConfig();
  return `${config.apiPublicUrl}/sep24/interactive/${kind}/${sessionId}/${token}`;
}

async function emitStatusUpdate(session: {
  id: string;
  userId: string;
  type: string;
  status: string;
  stellarTxId: string | null;
}): Promise<void> {
  await WebhookService.emitEvent({
    eventType: 'sep24.transaction.status_update',
    payload: {
      id: session.id,
      kind: session.type,
      status: session.status,
      stellar_transaction_id: session.stellarTxId,
    },
    userId: session.userId,
  });
}

async function resolveHotWalletPublicKey(): Promise<string> {
  const configured = getSepConfig().hotWalletPublicKey;
  if (configured) {
    return configured;
  }

  const treasury = await prisma.wallet.findFirst({
    where: { walletType: 'treasury', isActive: true },
    select: { publicKey: true },
  });

  if (!treasury) {
    throw new AppError(500, 'Hot wallet is not configured');
  }

  return treasury.publicKey;
}

async function resolveTreasuryWallet(): Promise<{ publicKey: string; secretKeyEncrypted: string }> {
  const publicKey = getSepConfig().hotWalletPublicKey;
  const treasury = await prisma.wallet.findFirst({
    where: publicKey
      ? { publicKey, walletType: 'treasury', isActive: true }
      : { walletType: 'treasury', isActive: true },
    select: { publicKey: true, secretKeyEncrypted: true },
  });

  if (!treasury) {
    throw new AppError(500, 'Platform treasury wallet is not configured');
  }

  return treasury;
}

const DEPOSIT_SETTLE_STATUSES = ['pending_anchor', 'pending_external', 'pending_stellar_unknown'];
const WITHDRAW_FINALIZE_STATUSES = ['pending_external', 'pending_anchor'];
const WATCH_PENDING_STATUSES = [
  'pending_user_transfer_start',
  'pending_stellar',
  'pending_stellar_unknown',
  'incomplete',
];

type HorizonPaymentRecord = {
  type: string;
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  transaction_hash?: string;
  paging_token?: string;
  transaction?: () => Promise<{ memo?: string | null; hash?: string }>;
};

function paymentMatchesSession(
  session: { amount: string | null; asset: string; metadata: unknown; stellarTxId: string | null },
  payment: HorizonPaymentRecord
): boolean {
  const metadata = asMetadata(session.metadata);
  const expectedAmount = session.amount;
  if (
    expectedAmount !== null &&
    expectedAmount.length > 0 &&
    payment.amount !== undefined &&
    Number(payment.amount) !== Number(expectedAmount)
  ) {
    return false;
  }

  const expectedCode = (metadata.assetCode ?? session.asset).toUpperCase();
  if (expectedCode === 'XLM' || expectedCode === 'NATIVE') {
    return payment.asset_type === 'native';
  }
  return payment.asset_code === expectedCode;
}

async function loadWatchCursor(): Promise<string | undefined> {
  const row = await prisma.sepWatchCursor.findUnique({ where: { id: 'payments' } });
  return row?.pagingToken;
}

async function saveWatchCursor(pagingToken: string): Promise<void> {
  await prisma.sepWatchCursor.upsert({
    where: { id: 'payments' },
    create: { id: 'payments', pagingToken },
    update: { pagingToken },
  });
}

export const StellarSep24Service = {
  getInfo(_jwt?: SepJwtPayload): Sep24InfoResponse {
    const deposit: Sep24InfoResponse['deposit'] = {};
    const withdraw: Sep24InfoResponse['withdraw'] = {};

    for (const asset of getSepConfig().assets) {
      const info = {
        enabled: true,
        min_amount: asset.minAmount,
        max_amount: asset.maxAmount,
        fee_fixed: asset.feeFixed,
        fee_percent: asset.feePercent,
        authentication_required: true,
      };
      deposit[asset.code] = info;
      withdraw[asset.code] = { ...info };
    }

    return {
      deposit,
      withdraw,
      fee: { enabled: false },
      features: {
        account_creation: true,
        claimable_balances: false,
      },
    };
  },

  async startInteractiveDeposit(
    jwt: SepJwtPayload,
    request: Sep24InteractiveRequest
  ): Promise<Sep24InteractiveStartResult> {
    return this.startInteractive(jwt, 'deposit', request);
  },

  async startInteractiveWithdrawal(
    jwt: SepJwtPayload,
    request: Sep24InteractiveRequest
  ): Promise<Sep24InteractiveStartResult> {
    return this.startInteractive(jwt, 'withdraw', request);
  },

  async startInteractive(
    jwt: SepJwtPayload,
    kind: SEPSessionType,
    request: Sep24InteractiveRequest
  ): Promise<Sep24InteractiveStartResult> {
    assertSepRole(jwt);

    const assetCode = request.asset_code?.trim();
    if (!assetCode) {
      throw new AppError(400, 'asset_code is required');
    }

    const asset = findSepAsset(assetCode);
    if (!asset) {
      throw new AppError(400, `Unsupported asset: ${assetCode}`);
    }

    if (request.amount) {
      const amount = Number(request.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new AppError(400, 'amount must be a positive number');
      }
      if (amount < asset.minAmount || amount > asset.maxAmount) {
        throw new AppError(400, `amount must be between ${asset.minAmount} and ${asset.maxAmount}`);
      }
    }

    const requestedAccount = request.account?.trim();
    if (requestedAccount !== undefined && requestedAccount.length > 0) {
      if (!StrKey.isValidEd25519PublicKey(requestedAccount)) {
        throw new AppError(400, 'account must be a valid Stellar public key');
      }
      if (requestedAccount !== jwt.sub) {
        throw new AppError(403, 'account must match the authenticated SEP-10 subject');
      }
    }
    const clientAccount = requestedAccount ?? jwt.sub;
    const interactiveToken = randomBytes(32).toString('hex');
    const session = await prisma.sepSession.create({
      data: {
        userId: jwt.userId,
        type: kind,
        asset: asset.code,
        amount: request.amount ?? null,
        status: 'incomplete',
        metadata: {
          clientAccount,
          assetCode: asset.code,
          assetIssuer: asset.issuer,
          methodType: request.type,
        },
      },
    });

    const sessionMemoValue = sessionMemo(session.id);
    const interactiveTokenExp = Math.floor(Date.now() / 1000) + SEP24_JWT_TTL_SECONDS;
    await prisma.sepSession.update({
      where: { id: session.id },
      data: {
        metadata: {
          clientAccount,
          assetCode: asset.code,
          assetIssuer: asset.issuer,
          methodType: request.type,
          memo: sessionMemoValue,
          interactiveTokenHash: hashInteractiveToken(interactiveToken),
          interactiveTokenExp,
        },
      },
    });

    const exp = interactiveTokenExp;
    const cookieValue = signSep24State(session.id, clientAccount, exp);

    return {
      type: 'interactive_customer_info_needed',
      url: buildInteractiveUrl(kind, session.id, interactiveToken),
      id: session.id,
      sessionId: session.id,
      cookieValue,
    };
  },

  async getTransaction(jwt: SepJwtPayload, id: string): Promise<Sep24TransactionRecord> {
    assertSepRole(jwt);

    if (!id) {
      throw new AppError(400, 'id is required');
    }

    const session = await prisma.sepSession.findFirst({
      where: { id, userId: jwt.userId },
    });

    if (!session) {
      throw new AppError(404, 'Transaction not found');
    }

    return toSep24Transaction(session);
  },

  async getTransactions(
    jwt: SepJwtPayload,
    filters: Sep24TransactionFilters = {}
  ): Promise<Sep24TransactionsResponse> {
    assertSepRole(jwt);

    const limit = Math.min(Math.max(filters.limit ?? 20, 1), 200);
    let noOlderThan: Date | undefined;
    if (filters.no_older_than !== undefined && filters.no_older_than.length > 0) {
      noOlderThan = new Date(filters.no_older_than);
      if (Number.isNaN(noOlderThan.getTime())) {
        throw new AppError(400, 'no_older_than must be a valid timestamp');
      }
    }

    const sessions = await prisma.sepSession.findMany({
      where: {
        userId: jwt.userId,
        ...(filters.asset_code ? { asset: filters.asset_code.toUpperCase() } : {}),
        ...(filters.kind ? { type: filters.kind } : {}),
        ...(noOlderThan ? { createdAt: { gte: noOlderThan } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(filters.paging_id ? { cursor: { id: filters.paging_id }, skip: 1 } : {}),
    });

    return { transactions: sessions.map(toSep24Transaction) };
  },

  async completeInteractive(
    sessionId: string,
    clientAccount: string,
    details: Sep24CompleteInteractiveRequest
  ): Promise<Sep24CompleteInteractiveResult> {
    const session = await prisma.sepSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new AppError(404, 'Session not found');
    }

    const metadata = asMetadata(session.metadata);
    if (metadata.clientAccount !== clientAccount) {
      throw new AppError(403, 'Session does not belong to this account');
    }

    if (session.status === 'completed') {
      throw new AppError(409, 'Session is already completed');
    }

    const amount = details.amount ?? session.amount;
    const nextMetadata: SessionMetadata = {
      clientAccount: metadata.clientAccount,
      assetCode: metadata.assetCode,
      assetIssuer: metadata.assetIssuer,
      memo: metadata.memo,
      methodType: metadata.methodType,
      payoutDetailsEncrypted: encryptPayoutDetails(details),
      error: metadata.error,
    };

    if (session.type === 'deposit') {
      const updated = await prisma.sepSession.update({
        where: { id: session.id },
        data: {
          status: 'pending_anchor',
          amount,
          metadata: asJson(nextMetadata),
        },
      });
      await emitStatusUpdate(updated);
      return {
        id: updated.id,
        status: 'pending_anchor',
        kind: 'deposit',
      };
    }

    const sendTo = await resolveHotWalletPublicKey();
    const updated = await prisma.sepSession.update({
      where: { id: session.id },
      data: {
        status: 'pending_user_transfer_start',
        amount,
        metadata: asJson(nextMetadata),
      },
    });

    await emitStatusUpdate(updated);

    return {
      id: updated.id,
      status: updated.status as SEPTransactionStatus,
      kind: 'withdraw',
      sendTo,
      memo: nextMetadata.memo,
    };
  },

  /**
   * After fiat receipt is confirmed, send Stellar funds from the platform treasury.
   */
  async completeDeposit(sessionId: string): Promise<Sep24CompleteInteractiveResult> {
    const session = await prisma.sepSession.findUnique({ where: { id: sessionId } });
    if (!session || session.type !== 'deposit') {
      throw new AppError(404, 'Deposit session not found');
    }

    const metadata = asMetadata(session.metadata);
    const destination = metadata.clientAccount;
    const amount = session.amount;
    if (destination === undefined || destination.length === 0 || !amount) {
      throw new AppError(400, 'Deposit is missing destination account or amount');
    }

    const claimed = await prisma.sepSession.updateMany({
      where: {
        id: sessionId,
        type: 'deposit',
        status: { in: DEPOSIT_SETTLE_STATUSES },
      },
      data: { status: 'pending_stellar' },
    });

    if (claimed.count === 0) {
      throw new AppError(409, 'Deposit is not ready to settle or is already in progress');
    }

    const treasury = await resolveTreasuryWallet();
    let sourceSecret: string;
    try {
      sourceSecret = decrypt(treasury.secretKeyEncrypted);
    } catch {
      throw new AppError(500, 'Failed to decrypt treasury wallet');
    }

    try {
      const submitted = await StellarService.submitPayment({
        sourceSecret,
        destination,
        amount,
        assetCode: metadata.assetCode || session.asset,
        assetIssuer: metadata.assetIssuer,
        memo: metadata.memo,
        beforeSubmit: async (hash: string): Promise<void> => {
          await prisma.sepSession.update({
            where: { id: session.id },
            data: {
              stellarTxId: hash,
              metadata: asJson({ ...metadata, submittedTxHash: hash }),
            },
          });
        },
      });

      const updated = await prisma.sepSession.update({
        where: { id: session.id },
        data: {
          status: 'completed',
          stellarTxId: submitted.hash,
          completedAt: new Date(),
        },
      });

      await emitStatusUpdate(updated);

      return {
        id: updated.id,
        status: 'completed',
        kind: 'deposit',
        stellarTxId: submitted.hash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const submittedHash =
        error instanceof StellarPaymentSubmitError
          ? error.transactionHash
          : metadata.submittedTxHash;

      if (submittedHash !== undefined && submittedHash.length > 0) {
        await prisma.sepSession.update({
          where: { id: session.id },
          data: {
            status: 'pending_stellar_unknown',
            stellarTxId: submittedHash,
            metadata: asJson({ ...metadata, submittedTxHash: submittedHash, error: message }),
          },
        });
      } else {
        await prisma.sepSession.update({
          where: { id: session.id },
          data: {
            status: 'error',
            metadata: asJson({ ...metadata, error: message }),
          },
        });
      }
      throw error;
    }
  },

  async markPendingFundsTransfer(sessionId: string, stellarTxId?: string): Promise<void> {
    const session = await prisma.sepSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new AppError(404, 'Session not found');
    }

    const updated = await prisma.sepSession.update({
      where: { id: sessionId },
      data: {
        status: 'pending_external',
        stellarTxId: stellarTxId || session.stellarTxId,
      },
    });

    await emitStatusUpdate(updated);
  },

  async finalizeWithdrawal(
    sessionId: string,
    externalRef?: string
  ): Promise<Sep24CompleteInteractiveResult> {
    const session = await prisma.sepSession.findUnique({ where: { id: sessionId } });
    if (!session || session.type !== 'withdraw') {
      throw new AppError(404, 'Withdrawal session not found');
    }

    if (session.status === 'completed') {
      return {
        id: session.id,
        status: 'completed',
        kind: 'withdraw',
        stellarTxId: session.stellarTxId ?? undefined,
      };
    }

    const claimed = await prisma.sepSession.updateMany({
      where: {
        id: sessionId,
        type: 'withdraw',
        status: { in: WITHDRAW_FINALIZE_STATUSES },
      },
      data: {
        status: 'completed',
        externalRef: externalRef ?? session.externalRef,
        completedAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      const current = await prisma.sepSession.findUnique({ where: { id: sessionId } });
      if (current?.status === 'completed') {
        return {
          id: current.id,
          status: 'completed',
          kind: 'withdraw',
          stellarTxId: current.stellarTxId ?? undefined,
        };
      }
      throw new AppError(409, 'Withdrawal is not ready to finalize');
    }

    const updated = await prisma.sepSession.findUniqueOrThrow({ where: { id: sessionId } });
    await emitStatusUpdate(updated);

    return {
      id: updated.id,
      status: 'completed',
      kind: 'withdraw',
      stellarTxId: updated.stellarTxId ?? undefined,
    };
  },

  /**
   * Poll Horizon for incoming credits to the hot wallet and complete matching sessions.
   */
  async watchDeposits(): Promise<void> {
    const hotWallet = await resolveHotWalletPublicKey();
    const server = StellarService.getHorizonServer();
    const pending = await prisma.sepSession.findMany({
      where: {
        status: { in: WATCH_PENDING_STATUSES },
      },
    });

    const storedCursor = await loadWatchCursor();
    const records: HorizonPaymentRecord[] = [];
    let newestToken = storedCursor;

    if (storedCursor === undefined) {
      const page = await server.payments().forAccount(hotWallet).order('desc').limit(200).call();
      records.push(...(page.records as HorizonPaymentRecord[]));
      newestToken = page.records[0]?.paging_token;
    } else {
      let page = await server
        .payments()
        .forAccount(hotWallet)
        .cursor(storedCursor)
        .order('asc')
        .limit(200)
        .call();

      while (page.records.length > 0) {
        records.push(...(page.records as HorizonPaymentRecord[]));
        newestToken = page.records[page.records.length - 1]?.paging_token;
        if (typeof page.next !== 'function') {
          break;
        }
        const nextPage = await page.next();
        if (nextPage.records.length === 0) {
          break;
        }
        page = nextPage;
      }
    }

    for (const paymentRecord of records) {
      const paymentType = String(paymentRecord.type);
      if (paymentType !== 'payment' && paymentType !== 'path_payment_strict_receive') {
        continue;
      }
      if (paymentRecord.to !== hotWallet) {
        continue;
      }

      let memo: string | undefined;
      try {
        const tx = paymentRecord.transaction ? await paymentRecord.transaction() : undefined;
        memo = tx?.memo ?? undefined;
      } catch {
        memo = undefined;
      }

      const stellarTxId = paymentRecord.transaction_hash;
      const matchIndex = pending.findIndex((session) => {
        if (session.status === 'completed') {
          return false;
        }
        const metadata = asMetadata(session.metadata);
        const memoOrHash =
          (stellarTxId !== undefined &&
            stellarTxId.length > 0 &&
            session.stellarTxId === stellarTxId) ||
          (memo !== undefined && metadata.memo !== undefined && memo === metadata.memo);
        return memoOrHash && paymentMatchesSession(session, paymentRecord);
      });

      if (matchIndex < 0) {
        continue;
      }

      const match = pending[matchIndex];
      pending.splice(matchIndex, 1);

      if (match.type === 'withdraw' && match.status === 'pending_user_transfer_start') {
        await this.markPendingFundsTransfer(match.id, stellarTxId);
      } else {
        const updated = await prisma.sepSession.update({
          where: { id: match.id },
          data: {
            status: 'completed',
            stellarTxId: stellarTxId || match.stellarTxId,
            completedAt: new Date(),
          },
        });
        await emitStatusUpdate(updated);
      }
    }

    if (newestToken !== undefined && newestToken.length > 0) {
      await saveWatchCursor(newestToken);
    }
  },

  frontendRedirectUrl(kind: SEPSessionType, sessionId: string): string {
    return `${getSepConfig().frontendBaseUrl}/sep24/interactive/${kind}/${sessionId}`;
  },

  async issueInteractiveCookie(
    sessionId: string,
    kind: SEPSessionType,
    token: string
  ): Promise<string> {
    const session = await prisma.sepSession.findUnique({ where: { id: sessionId } });
    if (!session || session.type !== kind) {
      throw new AppError(404, 'Session not found');
    }

    const metadata = asMetadata(session.metadata);
    if (
      metadata.interactiveTokenHash === undefined ||
      metadata.interactiveTokenHash.length === 0 ||
      metadata.interactiveTokenExp === undefined
    ) {
      throw new AppError(401, 'Interactive session token is invalid or already used');
    }

    if (metadata.interactiveTokenExp < Math.floor(Date.now() / 1000)) {
      throw new AppError(401, 'Interactive session token expired');
    }

    if (!tokensMatch(metadata.interactiveTokenHash, token)) {
      throw new AppError(401, 'Interactive session token is invalid or already used');
    }

    if (metadata.clientAccount === undefined || metadata.clientAccount.length === 0) {
      throw new AppError(400, 'Session is missing client account');
    }

    const consumedMetadata: SessionMetadata = {
      clientAccount: metadata.clientAccount,
      assetCode: metadata.assetCode,
      assetIssuer: metadata.assetIssuer,
      memo: metadata.memo,
      methodType: metadata.methodType,
      payoutDetailsEncrypted: metadata.payoutDetailsEncrypted,
      submittedTxHash: metadata.submittedTxHash,
      error: metadata.error,
    };

    const claimed = await prisma.sepSession.updateMany({
      where: {
        id: session.id,
        type: kind,
        metadata: {
          path: ['interactiveTokenHash'],
          equals: metadata.interactiveTokenHash,
        },
      },
      data: { metadata: asJson(consumedMetadata) },
    });

    if (claimed.count === 0) {
      throw new AppError(401, 'Interactive session token is invalid or already used');
    }

    const exp = Math.floor(Date.now() / 1000) + SEP24_JWT_TTL_SECONDS;
    return signSep24State(session.id, metadata.clientAccount, exp);
  },
};
