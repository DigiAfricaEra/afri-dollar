import { FXService } from '../fx.service';

export async function syncFxRates(): Promise<void> {
  await FXService.getCurrentRates();
}
