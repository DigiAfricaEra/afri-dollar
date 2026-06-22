export * from './security';

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: 'USER' | 'ADMIN';
}

export interface Wallet {
  id: string;
  address: string;
  balance: number;
  userId: string;
}

export interface PayrollItem {
  id: string;
  employeeName: string;
  destinationWallet: string;
  amount: number;
}

export interface PayrollBatch {
  id: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  totalAmount: number;
  items: PayrollItem[];
  createdAt: string;
}
