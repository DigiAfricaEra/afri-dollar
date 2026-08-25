import { StellarSep24Service } from '../stellar-sep24.service';

export async function watchSep24Deposits(): Promise<void> {
  await StellarSep24Service.watchDeposits();
}
