export interface CreateCrossBorderPaymentOptions {
  sourceWalletId: string;
  destinationAddress: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
  purpose: string;
  beneficiaryInfo?: {
    name: string;
    country: string;
  };
}

export interface PaymentStatus {
  id: string;
  status: 'created' | 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  stellarTxId?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

export interface CrossBorderPaymentResult {
  payment: PaymentStatus;
  sourceWalletId: string;
  destinationAddress: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string;
  memo?: string;
  purpose: string;
  beneficiaryInfo?: {
    name: string;
    country: string;
  };
  complianceChecks: ComplianceCheckResult;
}

export interface ComplianceCheckResult {
  sanctionsScreening: 'passed' | 'failed' | 'pending';
  travelRule: 'passed' | 'failed' | 'not_applicable';
  kycVerified: boolean;
  checkedAt: Date;
}
