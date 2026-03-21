import { PolymarketSignalService } from "../polymarket.js";

export class AppExecutionService extends PolymarketSignalService {
  async start(): Promise<void> {
    await this.startAppExecution();
  }
}
