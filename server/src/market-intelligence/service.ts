import { PolymarketSignalService } from "../polymarket.js";

export class MarketIntelligenceService extends PolymarketSignalService {
  async start(): Promise<void> {
    await this.startMarketIntelligence();
  }
}
