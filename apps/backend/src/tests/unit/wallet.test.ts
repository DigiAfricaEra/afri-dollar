/* eslint-disable */
import { Keypair } from '@stellar/stellar-sdk';

import prisma from '../../config/database';
import { WalletService } from '../../services/wallet.service';
import { encrypt } from '../../utils/crypto';

const mockPublicKey = 'GABC12345...';
const mockSecretKey = 'SABC12345...';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
    },
    wallet: {
      create: jest.fn(),
    },
  },
}));

jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: {
    random: jest.fn(),
  },
  Horizon: {
    Server: jest.fn(),
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('../../utils/crypto', () => ({
  encrypt: jest.fn(),
}));

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockWalletCreate = prisma.wallet.create as jest.Mock;

const originalFetch = global.fetch;

describe('WalletService', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long!!';
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();

    (Keypair.random as jest.Mock).mockReturnValue({
      publicKey: () => mockPublicKey,
      secret: () => mockSecretKey,
    });

    (encrypt as jest.Mock).mockReturnValue('encrypted:secret:key');
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('createWallet', () => {
    it('should generate keypair, encrypt secret, and persist wallet', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      mockWalletCreate.mockResolvedValue({
        id: 'wallet-1',
        publicKey: mockPublicKey,
        secretKeyEncrypted: 'encrypted:secret:key',
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
      });

      const result = await WalletService.createWallet({
        userId: 'user-1',
        walletType: 'business',
        network: 'testnet',
      });

      expect(Keypair.random).toHaveBeenCalledTimes(1);
      expect(encrypt).toHaveBeenCalledWith(mockSecretKey);
      expect(mockWalletCreate).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          publicKey: mockPublicKey,
          secretKeyEncrypted: 'encrypted:secret:key',
          walletType: 'business',
          network: 'testnet',
        },
      });
      expect(global.fetch).toHaveBeenCalledWith(
        `https://friendbot.stellar.org?addr=${mockPublicKey}`,
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(result).toEqual({
        id: 'wallet-1',
        publicKey: mockPublicKey,
        secretKey: mockSecretKey,
      });
    });

    it('should skip friendbot funding for mainnet wallets', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-2',
        email: 'test@example.com',
      });
      mockWalletCreate.mockResolvedValue({
        id: 'wallet-2',
        publicKey: mockPublicKey,
        secretKeyEncrypted: 'encrypted:secret:key',
        userId: 'user-2',
        walletType: 'treasury',
        network: 'mainnet',
      });

      const result = await WalletService.createWallet({
        userId: 'user-2',
        walletType: 'treasury',
        network: 'mainnet',
      });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'wallet-2',
        publicKey: mockPublicKey,
        secretKey: mockSecretKey,
      });
    });

    it('should throw when user does not exist', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(
        WalletService.createWallet({
          userId: 'nonexistent',
          walletType: 'payroll',
          network: 'testnet',
        })
      ).rejects.toThrow('User not found');

      expect(Keypair.random).not.toHaveBeenCalled();
      expect(mockWalletCreate).not.toHaveBeenCalled();
    });

    it('should throw when friendbot funding fails', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 503,
        text: jest.fn().mockResolvedValue('Service Unavailable'),
      });

      await expect(
        WalletService.createWallet({
          userId: 'user-1',
          walletType: 'business',
          network: 'testnet',
        })
      ).rejects.toThrow('Friendbot funding failed');

      expect(mockWalletCreate).not.toHaveBeenCalled();
    });

    it('should throw 504 on abort/timeout', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      (global.fetch as jest.Mock).mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError')
      );

      await expect(
        WalletService.createWallet({
          userId: 'user-1',
          walletType: 'payroll',
          network: 'testnet',
        })
      ).rejects.toMatchObject({ status: 504, message: 'Friendbot funding request timed out' });

      expect(mockWalletCreate).not.toHaveBeenCalled();
    });

    it('should throw 502 on network error', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      (global.fetch as jest.Mock).mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        WalletService.createWallet({
          userId: 'user-1',
          walletType: 'payroll',
          network: 'testnet',
        })
      ).rejects.toMatchObject({
        status: 502,
        message: 'Friendbot funding failed: fetch failed',
      });

      expect(mockWalletCreate).not.toHaveBeenCalled();
    });

    it('should throw 502 on unexpected error', async () => {
      mockUserFindUnique.mockResolvedValue({
        id: 'user-1',
        email: 'test@example.com',
      });
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Something unexpected'));

      await expect(
        WalletService.createWallet({
          userId: 'user-1',
          walletType: 'payroll',
          network: 'testnet',
        })
      ).rejects.toMatchObject({
        status: 502,
        message: 'Friendbot funding failed: Something unexpected',
      });

      expect(mockWalletCreate).not.toHaveBeenCalled();
    });
  });
});
