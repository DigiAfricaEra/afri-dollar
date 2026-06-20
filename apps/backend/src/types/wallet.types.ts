export interface CreateWalletOptions {
  userId: string;
  walletType: 'business' | 'treasury' | 'payroll';
  network: 'testnet' | 'mainnet';
}

export interface WalletWithKeys {
  id: string;
  publicKey: string;
  secretKey?: string;
}
