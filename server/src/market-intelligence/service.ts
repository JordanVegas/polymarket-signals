import { PolymarketSignalService } from "../polymarket.js";

export class MarketIntelligenceService extends PolymarketSignalService {
  protected isExecutionRuntime(): boolean {
    return false;
  }

  async start(): Promise<void> {
    await this.startMarketIntelligence();
  }
}
