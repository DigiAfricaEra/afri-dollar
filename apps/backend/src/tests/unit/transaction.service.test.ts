/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
import {
  Account,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  Transaction,
} from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { env } from '../../config/env';
import { NotificationService } from '../../services/notification.service';
import {
  TransactionService,
  assertValidPaymentInputs,
  mapToPaymentRecord,
  parseResultXdr,
  AMOUNT_REGEX,
} from '../../services/transaction.service';
import { WebhookService } from '../../services/webhook.service';
import { encrypt } from '../../utils/crypto';

/** `env` is `as const`; tests need to point the treasury at the mock wallet. */
const mutableEnv = env as { TREASURY_WALLET_ID: string };

jest.mock('@stellar/stellar-sdk', () => {
  const original = jest.requireActual('@stellar/stellar-sdk');
  const mockLoadAccount = jest.fn();
  const mockSubmitTransaction = jest.fn();
  const mockFetchBaseFee = jest.fn();
  const mockTxCall = jest.fn();

  (global as Record<string, unknown>).__mockLoadAccount = mockLoadAccount;
  (global as Record<string, unknown>).__mockSubmitTransaction = mockSubmitTransaction;
  (global as Record<string, unknown>).__mockFetchBaseFee = mockFetchBaseFee;
  (global as Record<string, unknown>).__mockTxCall = mockTxCall;

  return {
    ...original,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
        fetchBaseFee: mockFetchBaseFee,
        transactions: () => ({
          transaction: () => ({ call: mockTxCall }),
        }),
      })),
    },
  };
});

const mockLoadAccount = (global as Record<string, unknown>).__mockLoadAccount as jest.Mock;
const mockSubmitTransaction = (global as Record<string, unknown>)
  .__mockSubmitTransaction as jest.Mock;
const mockFetchBaseFee = (global as Record<string, unknown>).__mockFetchBaseFee as jest.Mock;
const mockTxCall = (global as Record<string, unknown>).__mockTxCall as jest.Mock;

jest.mock('../../config/database', () => {
  const client: Record<string, unknown> = {
    wallet: {
      findUnique: jest.fn(),
    },
    transaction: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  client.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => Promise<unknown>)(client);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    throw new TypeError('Unsupported $transaction argument');
  });

  return {
    __esModule: true,
    default: client,
  };
});

jest.mock('../../services/notification.service', () => ({
  NotificationService: { notify: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../../services/webhook.service', () => ({
  WebhookService: { emitEvent: jest.fn().mockResolvedValue(undefined) },
}));

const mockWalletFindUnique = prisma.wallet.findUnique as jest.Mock;
const mockTransactionCreate = prisma.transaction.create as jest.Mock;
const mockTransactionFindUnique = prisma.transaction.findUnique as jest.Mock;
const mockTransactionUpdate = prisma.transaction.update as jest.Mock;
const mockTransactionUpdateMany = prisma.transaction.updateMany as jest.Mock;
const mockAuditLogCreate = prisma.auditLog.create as jest.Mock;
const mockNotify = NotificationService.notify as jest.Mock;
const mockEmitEvent = WebhookService.emitEvent as jest.Mock;

/** Builds a NetworkError-shaped rejection body like the real SDK throws. */
function horizonError(txCode?: string, opCodes?: string[]): Record<string, unknown> {
  return {
    response: {
      status: 400,
      data: {
        extras: {
          result_codes: {
            ...(txCode ? { transaction: txCode } : {}),
            ...(opCodes ? { operations: opCodes } : {}),
          },
        },
      },
    },
  };
}

describe('TransactionService', () => {
  const sourceKeypair = Keypair.random();
  const sourcePublicKey = sourceKeypair.publicKey();
  const destination = Keypair.random().publicKey();
  const issuerKeypair = Keypair.random();

  let originalEncryptionKey: string | undefined;
  let secretKeyEncrypted: string;

  beforeAll(() => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-octets-long-for-jest';
    secretKeyEncrypted = encrypt(sourceKeypair.secret());
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchBaseFee.mockResolvedValue(100);
    mockLoadAccount.mockResolvedValue(new Account(sourcePublicKey, '100'));
    mockSubmitTransaction.mockResolvedValue({
      hash: 'tx-hash-123',
      ledger: 42,
      successful: true,
      envelope_xdr: 'envelope',
      result_xdr: '',
    });
    mockAuditLogCreate.mockResolvedValue({});
    mockNotify.mockResolvedValue(undefined);
    mockEmitEvent.mockResolvedValue(undefined);
  });

  describe('AMOUNT_REGEX', () => {
    it.each(['100', '0.0000001', '12.5', '100.1234567'])('accepts %s', (amount) => {
      expect(amount).toMatch(AMOUNT_REGEX);
    });

    it.each(['-5', '0.12345678', '1e5', 'abc', ''])('rejects %s', (amount) => {
      expect(amount).not.toMatch(AMOUNT_REGEX);
    });
  });

  describe('assertValidPaymentInputs', () => {
    const valid = {
      destination,
      amount: '10.5',
      assetCode: 'XLM',
    };

    it('passes for a valid native payment', () => {
      expect(() => assertValidPaymentInputs(valid)).not.toThrow();
    });

    it('rejects an invalid destination address', () => {
      expect(() =>
        assertValidPaymentInputs({ ...valid, destination: 'not-a-real-address' })
      ).toThrow(expect.objectContaining({ code: 'INVALID_DESTINATION', status: 400 }));
    });

    it('rejects amounts with more than 7 decimals', () => {
      expect(() => assertValidPaymentInputs({ ...valid, amount: '1.12345678' })).toThrow(
        expect.objectContaining({ code: 'INVALID_AMOUNT' })
      );
    });

    it('rejects zero and negative amounts', () => {
      expect(() => assertValidPaymentInputs({ ...valid, amount: '0' })).toThrow(
        expect.objectContaining({ code: 'INVALID_AMOUNT' })
      );
    });

    it('rejects memos longer than 28 bytes', () => {
      expect(() => assertValidPaymentInputs({ ...valid, memo: 'x'.repeat(29) })).toThrow(
        expect.objectContaining({ status: 400 })
      );
    });

    it('rejects a 28-character memo that exceeds 28 UTF-8 bytes', () => {
      // 'é' is one UTF-16 code unit but two UTF-8 bytes: String.length says
      // 28 while Buffer.byteLength says 56 — MEMO_TEXT limits bytes.
      const memo = 'é'.repeat(28);
      expect(memo.length).toBe(28);
      expect(() => assertValidPaymentInputs({ ...valid, memo })).toThrow(
        expect.objectContaining({ status: 400 })
      );
    });

    it('accepts a memo of exactly 28 bytes', () => {
      expect(() => assertValidPaymentInputs({ ...valid, memo: 'x'.repeat(28) })).not.toThrow();
    });

    it('requires an issuer for non-XLM assets', () => {
      expect(() => assertValidPaymentInputs({ ...valid, assetCode: 'USDC' })).toThrow(
        expect.objectContaining({ message: 'Asset issuer is required for non-XLM assets' })
      );
    });

    it('rejects an issuer on native XLM payments', () => {
      expect(() =>
        assertValidPaymentInputs({ ...valid, assetIssuer: issuerKeypair.publicKey() })
      ).toThrow(
        expect.objectContaining({
          message: 'Asset issuer must not be provided for XLM (native asset)',
        })
      );
    });
  });

  describe('buildRawPaymentTransaction', () => {
    const params = {
      sourcePublicKey,
      destination,
      amount: '25.75',
      assetCode: 'XLM',
      memo: 'hello payout',
    };

    it('builds a valid unsigned XLM payment with fetched base fee and time bounds', async () => {
      const built = await TransactionService.buildRawPaymentTransaction(params);

      expect(mockFetchBaseFee).toHaveBeenCalledTimes(1);
      expect(built.baseFeeStroops).toBe(100);
      expect(built.maxFeeStroops).toBe(200); // baseFee × 2 headroom
      expect(built.sequence).toBe('100');

      const parsed = TransactionBuilder.fromXDR(built.xdr, built.networkPassphrase) as Transaction;
      expect(parsed.operations).toHaveLength(1);
      expect(parsed.operations[0].type).toBe('payment');
      const paymentOp = parsed.operations[0] as Operation.Payment;
      expect(paymentOp.destination).toBe(destination);
      expect(paymentOp.amount).toBe('25.7500000'); // SDK normalizes to 7 decimals
      expect(parsed.memo.type).toBe(Memo.text('').type);
      expect(parsed.memo.value?.toString()).toBe('hello payout');
      expect(parsed.timeBounds).toBeDefined();
      const timeoutSeconds =
        Number(parsed.timeBounds!.maxTime) - Number(parsed.timeBounds!.minTime);
      expect(timeoutSeconds).toBeGreaterThanOrEqual(290);
    });

    it('falls back to the default base fee when Horizon lookup fails', async () => {
      mockFetchBaseFee.mockRejectedValue(new Error('horizon down'));

      const built = await TransactionService.buildRawPaymentTransaction(params);

      expect(built.baseFeeStroops).toBe(100);
      expect(built.maxFeeStroops).toBe(200);
    });

    it('uses an issued asset when assetIssuer is provided', async () => {
      const built = await TransactionService.buildRawPaymentTransaction({
        ...params,
        assetCode: 'USDC',
        assetIssuer: issuerKeypair.publicKey(),
      });

      const parsed = TransactionBuilder.fromXDR(built.xdr, built.networkPassphrase) as Transaction;
      const paymentOp = parsed.operations[0] as Operation.Payment;
      expect(paymentOp.asset.getCode()).toBe('USDC');
      expect(paymentOp.asset.getIssuer()).toBe(issuerKeypair.publicKey());
    });

    it('maps a 404 account load to WALLET_NOT_FUNDED', async () => {
      mockLoadAccount.mockRejectedValue({ response: { status: 404 } });

      await expect(TransactionService.buildRawPaymentTransaction(params)).rejects.toThrow(
        expect.objectContaining({ code: 'WALLET_NOT_FUNDED', status: 400 })
      );
    });

    it('maps other account-load failures to a 502', async () => {
      mockLoadAccount.mockRejectedValue(new Error('connection refused'));

      await expect(TransactionService.buildRawPaymentTransaction(params)).rejects.toThrow(
        expect.objectContaining({ status: 502 })
      );
    });
  });

  describe('buildPaymentTransaction', () => {
    const options = {
      sourceWalletId: 'wallet-1',
      userId: 'user-1',
      destination,
      amount: '10',
      assetCode: 'XLM',
    };

    it('loads the wallet and builds the transaction', async () => {
      mockWalletFindUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        userId: 'user-1',
        publicKey: sourcePublicKey,
        secretKeyEncrypted,
        isActive: true,
      });

      const built = await TransactionService.buildPaymentTransaction(options);

      expect(built.sourceAccount).toBe(sourcePublicKey);
      expect(mockLoadAccount).toHaveBeenCalledWith(sourcePublicKey);
    });

    it('throws when the wallet does not exist', async () => {
      mockWalletFindUnique.mockResolvedValueOnce(null);

      await expect(TransactionService.buildPaymentTransaction(options)).rejects.toThrow(
        expect.objectContaining({ status: 404 })
      );
    });

    it('throws when the wallet belongs to another user', async () => {
      mockWalletFindUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        userId: 'someone-else',
        publicKey: sourcePublicKey,
        isActive: true,
      });

      await expect(TransactionService.buildPaymentTransaction(options)).rejects.toThrow(
        expect.objectContaining({ status: 403 })
      );
    });
  });

  describe('signTransaction', () => {
    let unsignedXdr: string;
    let expectedHash: string;

    beforeAll(async () => {
      // Built without DB access using the raw helper.
      mockFetchBaseFee.mockResolvedValue(100);
      mockLoadAccount.mockResolvedValue(new Account(sourcePublicKey, '7'));
      const built = await TransactionService.buildRawPaymentTransaction({
        sourcePublicKey,
        destination,
        amount: '5',
        assetCode: 'XLM',
      });
      unsignedXdr = built.xdr;
      expectedHash = built.hash;
    });

    it('signs the transaction with the decrypted key without exposing it', async () => {
      mockWalletFindUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        secretKeyEncrypted,
        isActive: true,
      });

      const signed = await TransactionService.signTransaction(unsignedXdr, 'wallet-1');

      expect(signed.hash).toBe(expectedHash);
      const reparsed = TransactionBuilder.fromXDR(
        signed.signedXdr,
        'Test SDF Network ; September 2015'
      ) as Transaction;
      expect(reparsed.signatures).toHaveLength(1);
    });

    it('throws 404 when the wallet is missing or inactive', async () => {
      mockWalletFindUnique.mockResolvedValueOnce(null);
      await expect(TransactionService.signTransaction(unsignedXdr, 'nope')).rejects.toThrow(
        expect.objectContaining({ status: 404 })
      );

      mockWalletFindUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        secretKeyEncrypted,
        isActive: false,
      });
      await expect(TransactionService.signTransaction(unsignedXdr, 'wallet-1')).rejects.toThrow(
        expect.objectContaining({ status: 404 })
      );
    });

    it('throws Wallet decryption failure without leaking details', async () => {
      mockWalletFindUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        secretKeyEncrypted: 'corrupted-ciphertext',
        isActive: true,
      });

      await expect(TransactionService.signTransaction(unsignedXdr, 'wallet-1')).rejects.toThrow(
        'Wallet decryption failure'
      );
    });

    it('never writes the secret key to audit logs or notifications', async () => {
      mockWalletFindUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        secretKeyEncrypted,
        isActive: true,
      });

      await TransactionService.signTransaction(unsignedXdr, 'wallet-1');

      const logged = JSON.stringify([
        mockAuditLogCreate.mock.calls,
        mockNotify.mock.calls,
        mockEmitEvent.mock.calls,
      ]);
      expect(logged).not.toContain(sourceKeypair.secret());
    });
  });

  describe('submitSignedTransaction', () => {
    let signedXdr: string;

    beforeAll(async () => {
      mockFetchBaseFee.mockResolvedValue(100);
      mockLoadAccount.mockResolvedValue(new Account(sourcePublicKey, '9'));
      const built = await TransactionService.buildRawPaymentTransaction({
        sourcePublicKey,
        destination,
        amount: '5',
        assetCode: 'XLM',
      });
      const parsed = TransactionBuilder.fromXDR(
        built.xdr,
        'Test SDF Network ; September 2015'
      ) as Transaction;
      parsed.sign(sourceKeypair);
      signedXdr = parsed.toXDR();
    });

    beforeEach(() => {
      mockFetchBaseFee.mockResolvedValue(100);
      mockLoadAccount.mockResolvedValue(new Account(sourcePublicKey, '9'));
    });

    it('returns the Horizon response on success', async () => {
      const response = await TransactionService.submitSignedTransaction(signedXdr);

      expect(response.hash).toBe('tx-hash-123');
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    });

    it('maps tx_too_late to TRANSACTION_EXPIRED without retrying', async () => {
      mockSubmitTransaction.mockRejectedValue(horizonError('tx_too_late'));

      await expect(TransactionService.submitSignedTransaction(signedXdr)).rejects.toThrow(
        expect.objectContaining({ code: 'TRANSACTION_EXPIRED', status: 408 })
      );
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    });

    it('maps op_underfunded to INSUFFICIENT_BALANCE', async () => {
      mockSubmitTransaction.mockRejectedValue(horizonError('tx_failed', ['op_underfunded']));

      await expect(TransactionService.submitSignedTransaction(signedXdr)).rejects.toThrow(
        expect.objectContaining({ code: 'INSUFFICIENT_BALANCE', status: 400 })
      );
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    });

    it('maps op_low_reserve to LOW_BASE_RESERVE', async () => {
      mockSubmitTransaction.mockRejectedValue(horizonError('tx_failed', ['op_low_reserve']));

      await expect(TransactionService.submitSignedTransaction(signedXdr)).rejects.toThrow(
        expect.objectContaining({ code: 'LOW_BASE_RESERVE' })
      );
    });

    it('retries transient network errors exactly once', async () => {
      mockSubmitTransaction
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({
          hash: 'tx-retry-ok',
          ledger: 43,
          successful: true,
          envelope_xdr: 'e',
          result_xdr: '',
        });

      const response = await TransactionService.submitSignedTransaction(signedXdr);

      expect(response.hash).toBe('tx-retry-ok');
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    });

    it('surfaces SUBMISSION_TIMEOUT after repeated timeouts', async () => {
      mockSubmitTransaction.mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
      );

      await expect(TransactionService.submitSignedTransaction(signedXdr)).rejects.toThrow(
        expect.objectContaining({ code: 'SUBMISSION_TIMEOUT', status: 504 })
      );
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
    });

    it('treats explicit successful:false responses as failures', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'bad-tx',
        ledger: 44,
        successful: false,
        envelope_xdr: 'e',
        result_xdr: 'garbage-xdr',
      });

      await expect(TransactionService.submitSignedTransaction(signedXdr)).rejects.toThrow(
        expect.objectContaining({ status: 400 })
      );
    });
  });

  describe('getTransactionStatus', () => {
    const dbRow = {
      id: 'payment-row-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      type: 'transfer',
      status: 'processing',
      amount: '10',
      assetCode: 'XLM',
      assetIssuer: null,
      memo: null,
      fromAddress: sourcePublicKey,
      toAddress: destination,
      stellarTxId: 'tx-hash-confirmed',
      errorCode: null,
      errorMessage: null,
      submittedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      mockTransactionFindUnique.mockResolvedValue(dbRow);
      mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
    });

    it('returns successful and syncs the local row', async () => {
      mockTxCall.mockResolvedValue({
        id: 'tx-hash-confirmed',
        successful: true,
        ledger_attr: 12345,
        created_at: '2026-08-23T10:00:00Z',
        result_xdr: '',
        fee_charged: 200,
      });

      const status = await TransactionService.getTransactionStatus('tx-hash-confirmed');

      expect(status.status).toBe('successful');
      expect(status.ledger).toBe(12345);
      expect(status.feeChargedStroops).toBe('200');
      expect(status.resultXdr).toBe('');
      expect(status.horizonUrl).toContain('/transactions/tx-hash-confirmed');
      // The transition is claimed conditionally so concurrent pollers cannot
      // double-fire notifications.
      expect(mockTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'payment-row-1',
            status: { notIn: ['successful', 'completed', 'failed', 'cancelled'] },
          },
          data: expect.objectContaining({ status: 'successful' }),
        })
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'user-1',
        'transaction-completed',
        expect.objectContaining({ transactionId: 'payment-row-1' })
      );
      expect(mockEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'transaction.completed' })
      );
    });

    it('returns pending when Horizon does not know the hash yet', async () => {
      mockTxCall.mockRejectedValue({ response: { status: 404 } });

      const status = await TransactionService.getTransactionStatus('unknown-hash');

      expect(status.status).toBe('pending');
      expect(mockTransactionUpdateMany).not.toHaveBeenCalled();
    });

    it('does not overwrite terminal rows', async () => {
      mockTransactionFindUnique.mockResolvedValue({ ...dbRow, status: 'successful' });
      mockTransactionUpdateMany.mockResolvedValue({ count: 0 });
      mockTxCall.mockResolvedValue({
        id: 'tx-hash-confirmed',
        successful: true,
        ledger_attr: 12346,
        result_xdr: '',
      });

      await TransactionService.getTransactionStatus('tx-hash-confirmed');

      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockEmitEvent).not.toHaveBeenCalled();
    });

    it('persists the mapped error code for on-chain failures', async () => {
      await TransactionService.syncLocalTransaction({
        id: 'tx-hash-confirmed',
        status: 'failed',
        resultCode: 'tx_too_late',
      });

      expect(mockTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'failed',
            errorCode: 'TRANSACTION_EXPIRED',
          }),
        })
      );
      expect(mockNotify).toHaveBeenCalledWith(
        'user-1',
        'transaction-failed',
        expect.objectContaining({ reason: 'TRANSACTION_EXPIRED' })
      );
    });

    it('parses a real failed payment result XDR into Horizon codes and maps INSUFFICIENT_BALANCE', async () => {
      // Built with the actual SDK: txFailed → opInner → payment → underfunded.
      const { xdr } = jest.requireActual('@stellar/stellar-sdk');
      const failedB64 = new xdr.TransactionResult({
        feeCharged: new xdr.Int64(100),
        result: xdr.TransactionResultResult.txFailed([
          xdr.OperationResult.opInner(
            xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded())
          ),
        ]),
        ext: new xdr.TransactionResultExt(0),
      }).toXDR('base64');

      await TransactionService.syncLocalTransaction({
        id: 'tx-hash-confirmed',
        status: 'failed',
        ...parseResultXdr(failedB64),
      });

      expect(mockTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ errorCode: 'INSUFFICIENT_BALANCE' }),
        })
      );
    });

    it('propagates non-404 Horizon query errors as a 502', async () => {
      mockTxCall.mockRejectedValue(new Error('gateway meltdown'));

      await expect(TransactionService.getTransactionStatus('any')).rejects.toThrow(
        expect.objectContaining({ status: 502 })
      );
    });
  });

  describe('buildAndSubmitPayment', () => {
    const options = {
      sourceWalletId: 'wallet-1',
      userId: 'user-1',
      destination,
      amount: '12.34',
      assetCode: 'XLM',
      memo: 'instant pay',
    };

    const walletRow = {
      id: 'wallet-1',
      userId: 'user-1',
      publicKey: sourcePublicKey,
      secretKeyEncrypted,
      isActive: true,
    };

    const createdRow = {
      id: 'row-1',
      userId: 'user-1',
      walletId: 'wallet-1',
      type: 'transfer',
      status: 'created',
      amount: '12.34',
      assetCode: 'XLM',
      assetIssuer: null,
      memo: 'instant pay',
      fromAddress: sourcePublicKey,
      toAddress: destination,
      stellarTxId: null,
      errorCode: null,
      errorMessage: null,
      submittedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      mockWalletFindUnique.mockImplementation(
        (args: { where: { id?: string }; select?: unknown }) => {
          if (args.select) {
            // signTransaction projection
            return Promise.resolve({
              id: walletRow.id,
              secretKeyEncrypted,
              isActive: true,
            });
          }
          return Promise.resolve(walletRow);
        }
      );

      mockTransactionCreate.mockResolvedValue(createdRow);
      mockTransactionUpdate.mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...createdRow,
          ...args.data,
          stellarTxId: (args.data.stellarTxId as string | null) ?? createdRow.stellarTxId,
        })
      );
      mockTransactionFindUnique.mockImplementation((args: { where: Record<string, unknown> }) => {
        if ('stellarTxId' in args.where) {
          return Promise.resolve({
            ...createdRow,
            status: 'processing',
            stellarTxId: 'tx-hash-123',
          });
        }
        return Promise.resolve(createdRow);
      });
      mockTxCall.mockRejectedValue({ response: { status: 404 } });
    });

    it('runs created → submitted → processing and returns a payment record', async () => {
      const record = await TransactionService.buildAndSubmitPayment(options);

      expect(record.status).toBe('processing');
      expect(record.stellarTxId).toBe('tx-hash-123');

      // The pre-submission hash association writes stellarTxId without a
      // status change — filter it out when asserting the transition order.
      const statuses = mockTransactionUpdate.mock.calls
        .map((call: [{ data: Record<string, unknown> }]) => call[0].data.status)
        .filter(Boolean);
      expect(statuses).toEqual(['submitted', 'processing']);

      const createData = mockTransactionCreate.mock.calls[0][0].data;
      expect(createData.status).toBe('created');
      expect(createData.metadata).toEqual({ paymentType: 'stellar_payment' });

      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'payment_submitted', success: true }),
        })
      );
    });

    it('associates the transaction hash with the payment row BEFORE submitting', async () => {
      await TransactionService.buildAndSubmitPayment(options);

      const hashPersist = mockTransactionUpdate.mock.calls.findIndex(
        (call: [{ data: { stellarTxId?: string } }]) => Boolean(call[0].data.stellarTxId)
      );
      expect(hashPersist).toBeGreaterThanOrEqual(0);

      const submitCall = mockSubmitTransaction.mock.invocationCallOrder[0];
      expect(mockTransactionUpdate.mock.invocationCallOrder[hashPersist]).toBeLessThan(submitCall);
    });

    it('marks the payment failed and persists the exact AppError code on insufficient balance', async () => {
      mockSubmitTransaction.mockRejectedValue(horizonError('tx_failed', ['op_underfunded']));

      await expect(TransactionService.buildAndSubmitPayment(options)).rejects.toThrow(
        expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' })
      );

      const failUpdate = mockTransactionUpdate.mock.calls.find(
        (call: [{ data: Record<string, unknown> }]) => call[0].data.status === 'failed'
      );
      expect(failUpdate).toBeDefined();
      expect(failUpdate![0].data.errorCode).toBe('INSUFFICIENT_BALANCE');
      // The envelope reached Horizon, so a submission time is recorded.
      expect(failUpdate![0].data.submittedAt).toBeDefined();

      expect(mockNotify).toHaveBeenCalledWith(
        'user-1',
        'transaction-failed',
        expect.objectContaining({ reason: 'INSUFFICIENT_BALANCE' })
      );
      expect(mockEmitEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'transaction.failed' })
      );
    });

    it('does not record submittedAt for failures that never reached Horizon', async () => {
      mockLoadAccount.mockRejectedValueOnce({ response: { status: 404 } });

      await expect(TransactionService.buildAndSubmitPayment(options)).rejects.toThrow(
        expect.objectContaining({ code: 'WALLET_NOT_FUNDED' })
      );

      const failUpdate = mockTransactionUpdate.mock.calls.find(
        (call: [{ data: Record<string, unknown> }]) => call[0].data.status === 'failed'
      );
      expect(failUpdate).toBeDefined();
      expect(failUpdate![0].data.submittedAt).toBeUndefined();
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
    });

    it('rejects payments from wallets owned by other users', async () => {
      mockWalletFindUnique.mockReset();
      mockWalletFindUnique.mockResolvedValue({ ...walletRow, userId: 'attacker' });
      mockTransactionCreate.mockResolvedValue(createdRow);

      await expect(TransactionService.buildAndSubmitPayment(options)).rejects.toThrow(
        expect.objectContaining({ status: 403 })
      );
    });

    it('rejects invalid input before any network or DB activity', async () => {
      await expect(
        TransactionService.buildAndSubmitPayment({ ...options, amount: '-3' })
      ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));

      expect(mockWalletFindUnique).not.toHaveBeenCalled();
      expect(mockTransactionCreate).not.toHaveBeenCalled();
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });
  });

  describe('executeBatchPayouts', () => {
    const treasuryWallet = {
      id: 'treasury-wallet',
      userId: 'admin-user',
      publicKey: sourcePublicKey,
      secretKeyEncrypted,
      isActive: true,
    };

    const payouts = [
      { destination, amount: '1', assetCode: 'XLM' },
      {
        destination: Keypair.random().publicKey(),
        amount: '2',
        assetCode: 'XLM',
        memo: 'batch-memo',
      },
      { destination: Keypair.random().publicKey(), amount: '3', assetCode: 'XLM' },
    ];

    beforeEach(() => {
      mutableEnv.TREASURY_WALLET_ID = treasuryWallet.id;
      mockWalletFindUnique.mockImplementation((args: { select?: unknown }) => {
        if (args.select) {
          return Promise.resolve({ id: treasuryWallet.id, secretKeyEncrypted, isActive: true });
        }
        return Promise.resolve(treasuryWallet);
      });

      let counter = 0;
      mockTransactionCreate.mockImplementation(() => {
        counter += 1;
        return Promise.resolve({
          id: `batch-row-${counter}`,
          userId: treasuryWallet.userId,
          walletId: treasuryWallet.id,
          status: 'submitted',
          amount: payouts[counter - 1].amount,
          assetCode: 'XLM',
        });
      });
      mockTransactionUpdate.mockImplementation((args: { where: { id: string }; data: object }) =>
        Promise.resolve({ id: args.where.id, ...args.data })
      );
      mockTxCall.mockRejectedValue({ response: { status: 404 } });
    });

    it('continues after one failing payout and reports partial success', async () => {
      mockSubmitTransaction
        .mockResolvedValueOnce({
          hash: 'hash-1',
          ledger: 1,
          successful: true,
          envelope_xdr: '',
          result_xdr: '',
        })
        .mockRejectedValueOnce(horizonError('tx_failed', ['op_underfunded']))
        .mockResolvedValueOnce({
          hash: 'hash-3',
          ledger: 2,
          successful: true,
          envelope_xdr: '',
          result_xdr: '',
        });

      const result = await TransactionService.executeBatchPayouts({
        sourceWalletId: 'treasury-wallet',
        adminUserId: 'admin-user',
        payouts,
      });

      expect(result.total).toBe(3);
      expect(result.successful).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results[0]).toMatchObject({ success: true, stellarTxId: 'hash-1' });
      expect(result.results[1]).toMatchObject({
        success: false,
        errorCode: 'INSUFFICIENT_BALANCE',
      });
      expect(result.results[2]).toMatchObject({ success: true, stellarTxId: 'hash-3' });

      // Each payout loads the account fresh so sequence numbers advance per op.
      expect(mockLoadAccount).toHaveBeenCalledTimes(3);
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(3);
    });

    it('passes the payout memo into the on-chain transaction', async () => {
      mockSubmitTransaction.mockResolvedValue({
        hash: 'hash-memo',
        ledger: 1,
        successful: true,
        envelope_xdr: '',
        result_xdr: '',
      });
      const buildSpy = jest.spyOn(TransactionService, 'buildRawPaymentTransaction');

      await TransactionService.executeBatchPayouts({
        sourceWalletId: 'treasury-wallet',
        adminUserId: 'admin-user',
        payouts: [payouts[1]],
      });

      expect(buildSpy).toHaveBeenCalledWith(expect.objectContaining({ memo: 'batch-memo' }));
      buildSpy.mockRestore();
    });

    it('refuses payouts from a wallet other than the configured treasury', async () => {
      mutableEnv.TREASURY_WALLET_ID = 'the-real-treasury';

      await expect(
        TransactionService.executeBatchPayouts({
          sourceWalletId: 'treasury-wallet',
          adminUserId: 'admin-user',
          payouts: [payouts[0]],
        })
      ).rejects.toThrow(expect.objectContaining({ status: 403 }));
    });

    it('throws when the treasury wallet cannot be found', async () => {
      mockWalletFindUnique.mockReset();
      mockWalletFindUnique.mockResolvedValue(null);

      await expect(
        TransactionService.executeBatchPayouts({
          sourceWalletId: 'missing',
          adminUserId: 'admin-user',
          payouts,
        })
      ).rejects.toThrow(expect.objectContaining({ status: 404 }));
    });

    it('requires a source wallet id', async () => {
      await expect(
        TransactionService.executeBatchPayouts({
          sourceWalletId: undefined,
          adminUserId: 'admin-user',
          payouts,
        })
      ).rejects.toThrow(expect.objectContaining({ status: 400 }));
    });

    afterEach(() => {
      mutableEnv.TREASURY_WALLET_ID = '';
    });
  });

  describe('rebuildFailedTransaction', () => {
    const failedRow = {
      id: 'row-failed',
      userId: 'user-1',
      walletId: 'wallet-1',
      type: 'transfer',
      status: 'failed',
      amount: '5',
      assetCode: 'XLM',
      assetIssuer: null,
      memo: null,
      fromAddress: sourcePublicKey,
      toAddress: destination,
      stellarTxId: null,
      errorCode: 'INSUFFICIENT_BALANCE',
      errorMessage: 'Stellar transaction failed',
      submittedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const walletRow = {
      id: 'wallet-1',
      userId: 'user-1',
      publicKey: sourcePublicKey,
      secretKeyEncrypted,
      isActive: true,
    };

    beforeEach(() => {
      mockTransactionFindUnique.mockImplementation((args: { where: Record<string, unknown> }) => {
        if ('stellarTxId' in args.where) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ ...failedRow });
      });
      mockWalletFindUnique.mockImplementation((args: { select?: unknown }) => {
        if (args.select) {
          return Promise.resolve({ id: walletRow.id, secretKeyEncrypted, isActive: true });
        }
        return Promise.resolve(walletRow);
      });
      mockTransactionCreate.mockResolvedValue(failedRow);
      mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
      mockTransactionUpdate.mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...failedRow, ...args.data })
      );
      mockSubmitTransaction.mockResolvedValue({
        hash: 'rebuild-hash',
        ledger: 9,
        successful: true,
        envelope_xdr: '',
        result_xdr: '',
      });
      mockTxCall.mockRejectedValue({ response: { status: 404 } });
    });

    it('rebuilds a failed payment and records the rebuild audit trail', async () => {
      const record = await TransactionService.rebuildFailedTransaction('row-failed', 'admin-1');

      expect(record.status).toBe('processing');
      // Stale attempt metadata must be cleared by the claim.
      expect(mockTransactionUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'row-failed', status: 'failed' },
          data: expect.objectContaining({ submittedAt: null, completedAt: null }),
        })
      );
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'admin_transaction_rebuild_started' }),
        })
      );
    });

    it('rejects payments that are not failed', async () => {
      mockTransactionFindUnique.mockResolvedValue({ ...failedRow, status: 'successful' });

      await expect(
        TransactionService.rebuildFailedTransaction('row-failed', 'admin-1')
      ).rejects.toThrow(expect.objectContaining({ status: 400 }));
    });

    it('refuses a concurrent rebuild that lost the conditional claim', async () => {
      // Another admin's rebuild already moved the row out of `failed`.
      mockTransactionUpdateMany.mockResolvedValue({ count: 0 });
      mockSubmitTransaction.mockClear();

      await expect(
        TransactionService.rebuildFailedTransaction('row-failed', 'admin-1')
      ).rejects.toThrow(expect.objectContaining({ status: 409 }));
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
    });

    it('refuses to double-pay when the original transaction settled on-chain', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        ...failedRow,
        stellarTxId: 'settled-hash',
      });
      mockTxCall.mockResolvedValue({
        id: 'settled-hash',
        successful: true,
        result_xdr: '',
      });

      await expect(
        TransactionService.rebuildFailedTransaction('row-failed', 'admin-1')
      ).rejects.toThrow(expect.objectContaining({ status: 409 }));
      expect(mockSubmitTransaction).not.toHaveBeenCalled();
    });

    it('allows the rebuild when the original never landed on-chain', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        ...failedRow,
        stellarTxId: 'lost-hash',
      });
      mockTxCall.mockRejectedValue({ response: { status: 404 } });

      const record = await TransactionService.rebuildFailedTransaction('row-failed', 'admin-1');
      expect(record.status).toBe('processing');
    });

    it('refuses and surfaces a 502 when Horizon cannot be reached for verification', async () => {
      mockTransactionFindUnique.mockResolvedValue({
        ...failedRow,
        stellarTxId: 'unknown-hash',
      });
      mockTxCall.mockRejectedValue(new Error('gateway down'));

      await expect(
        TransactionService.rebuildFailedTransaction('row-failed', 'admin-1')
      ).rejects.toThrow(expect.objectContaining({ status: 502 }));
    });
  });

  describe('mapToPaymentRecord', () => {
    const legacyRow = {
      id: 'r1',
      userId: 'u1',
      walletId: 'w1',
      type: 'transfer',
      status: 'pending',
      amount: '1.0000000',
      assetCode: 'XLM',
      assetIssuer: null,
      memo: null,
      fromAddress: sourcePublicKey,
      toAddress: destination,
      stellarTxId: null,
      errorCode: null,
      errorMessage: null,
      submittedAt: null,
      completedAt: null,
      isFlagged: false,
      flagReason: null,
      flaggedAt: null,
      flaggedBy: null,
      flagReviewAction: null,
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('maps legacy pending status onto created and keeps optional fields sparse', () => {
      const now = new Date();
      const record = mapToPaymentRecord({
        ...legacyRow,
        createdAt: now,
        updatedAt: now,
      });

      expect(record.status).toBe('created');
      expect(record.destination).toBe(destination);
      expect(record).not.toHaveProperty('stellarTxId');
      expect(record).not.toHaveProperty('errorCode');
    });

    it.each([
      ['completed', 'successful'],
      ['cancelled', 'failed'],
      ['pending', 'created'],
    ])('maps legacy status %s onto contract status %s', (dbStatus, expected) => {
      const record = mapToPaymentRecord({ ...legacyRow, status: dbStatus });
      expect(record.status).toBe(expected);
    });
  });
});
