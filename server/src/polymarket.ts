import { config } from "./config.js";
import WebSocket from "ws";
import { SignalStorage } from "./storage.js";
import type { MarketRecord, TradeRecord, TraderSummary, WhaleSignal } from "./types.js";

const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type RawMarket = {
  id: string;
  question: string;
  slug: string;
  image?: string;
  endDate?: string;
  liquidityNum?: number;
  volume24hr?: number;
  clobTokenIds?: string;
  outcomes?: string;
};

type RawPosition = {
  cashPnl?: number;
  realizedPnl?: number;
};

type RawClosedPosition = {
  realizedPnl?: number;
};

type RawValue = {
  value?: number;
};

type MarketTradeMessage = {
  event_type?: string;
  asset_id?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
  timestamp?: string;
  transaction_hash?: string;
};

type SignalAccumulator = {
  wallet: string;
  assetId: string;
  side: "BUY" | "SELL";
  outcome: string;
  market: MarketRecord;
  displayName: string;
  profileImage?: string;
  profileUrl: string;
  startedAt: number;
  updatedAt: number;
  totalUsd: number;
  totalShares: number;
  weightedPriceSum: number;
  fills: TradeRecord[];
  emitted: boolean;
  signalId?: string;
};

const chunk = <T,>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const dedupeTrades = (trades: TradeRecord[]): TradeRecord[] => {
  const seen = new Set<string>();
  return trades.filter((trade) => {
    const key = `${trade.transactionHash}:${trade.proxyWallet}:${trade.asset}:${trade.side}:${trade.size}:${trade.price}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export class PolymarketSignalService {
  private readonly marketsByAssetId = new Map<string, MarketRecord>();
  private readonly activeAssetIds = new Set<string>();
  private readonly signals: WhaleSignal[] = [];
  private readonly recentTradeIds = new Set<string>();
  private readonly accumulators = new Map<string, SignalAccumulator>();
  private readonly traderCache = new Map<string, { summary: TraderSummary; fetchedAt: number }>();
  private readonly storage = new SignalStorage();
  private ws: WebSocket | null = null;
  private marketSyncTimer: NodeJS.Timeout | null = null;
  private tradePollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastTradeTimestampSec = 0;
  private websocketConnected = false;
  private lastMarketSyncAt: number | null = null;
  private lastTradeAt: number | null = null;
  private listeners = new Set<(payload: WhaleSignal) => void>();

  async start(): Promise<void> {
    try {
      const storageEnabled = await this.storage.connect();
      if (storageEnabled) {
        const persistedSignals = await this.storage.loadRecentSignals(config.maxSignals);
        this.signals.splice(0, this.signals.length, ...persistedSignals);
      }
    } catch (error) {
      console.error("Failed to initialize Mongo storage", error);
    }

    await this.syncMarkets();
    this.connectMarketSocket();
    this.startTradePolling();
    this.marketSyncTimer = setInterval(() => {
      void this.syncMarkets();
    }, config.marketRefreshMs);
  }

  stop(): void {
    if (this.marketSyncTimer) {
      clearInterval(this.marketSyncTimer);
    }
    if (this.tradePollTimer) {
      clearInterval(this.tradePollTimer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.ws?.close();
  }

  onSignal(listener: (payload: WhaleSignal) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot() {
    return {
      status: {
        marketCount: this.activeAssetIds.size,
        websocketConnected: this.websocketConnected,
        lastMarketSyncAt: this.lastMarketSyncAt,
        lastTradeAt: this.lastTradeAt,
      },
      signals: this.signals,
    };
  }

  private async syncMarkets(): Promise<void> {
    const nextMarketsByAssetId = new Map<string, MarketRecord>();
    let offset = 0;
    const pageSize = 500;

    for (;;) {
      const url = new URL(GAMMA_MARKETS_URL);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to sync markets: ${response.status}`);
      }

      const markets = (await response.json()) as RawMarket[];
      if (markets.length === 0) {
        break;
      }

      for (const market of markets) {
        const assetIds = this.safeJsonParse<string[]>(market.clobTokenIds, []);
        const outcomes = this.safeJsonParse<string[]>(market.outcomes, []);
        if (assetIds.length === 0) {
          continue;
        }

        const outcomeByAssetId: Record<string, string> = {};
        assetIds.forEach((assetId, index) => {
          outcomeByAssetId[assetId] = outcomes[index] ?? `Outcome ${index + 1}`;
        });

        const record: MarketRecord = {
          id: market.id,
          question: market.question,
          slug: market.slug,
          image: market.image ?? "",
          endDate: market.endDate ?? "",
          liquidity: Number(market.liquidityNum ?? 0),
          volume24hr: Number(market.volume24hr ?? 0),
          outcomeByAssetId,
        };

        assetIds.forEach((assetId) => {
          nextMarketsByAssetId.set(assetId, record);
        });
      }

      offset += pageSize;
    }

    this.marketsByAssetId.clear();
    this.activeAssetIds.clear();

    for (const [assetId, market] of nextMarketsByAssetId) {
      this.marketsByAssetId.set(assetId, market);
      this.activeAssetIds.add(assetId);
    }

    this.lastMarketSyncAt = Date.now();
    this.resubscribeToActiveAssets();
  }

  private safeJsonParse<T>(value: string | undefined, fallback: T): T {
    if (!value) {
      return fallback;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private connectMarketSocket(): void {
    this.ws?.close();
    this.ws = new WebSocket(CLOB_WS_URL);

    this.ws.addEventListener("open", () => {
      this.websocketConnected = true;
      const initialAssets = Array.from(this.activeAssetIds).slice(0, 800);
      this.ws?.send(
        JSON.stringify({
          type: "market",
          assets_ids: initialAssets,
        }),
      );
      this.heartbeatTimer = setInterval(() => {
        this.ws?.send("{}");
      }, 10_000);
    });

    this.ws.addEventListener("message", (event) => {
      this.handleSocketMessage(String(event.data));
    });

    this.ws.addEventListener("close", () => {
      this.websocketConnected = false;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
      }
      this.heartbeatTimer = null;
      setTimeout(() => this.connectMarketSocket(), 3_000);
    });

    this.ws.addEventListener("error", () => {
      this.websocketConnected = false;
    });
  }

  private resubscribeToActiveAssets(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const assets = Array.from(this.activeAssetIds);
    const batches = chunk(assets, 800);
    batches.forEach((batch, index) => {
      const payload =
        index === 0
          ? { type: "market", assets_ids: batch }
          : { operation: "subscribe", assets_ids: batch };
      this.ws?.send(JSON.stringify(payload));
    });
  }

  private handleSocketMessage(rawMessage: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        this.processSocketEvent(item as MarketTradeMessage);
      }
      return;
    }

    this.processSocketEvent(parsed as MarketTradeMessage);
  }

  private processSocketEvent(message: MarketTradeMessage): void {
    if (message.event_type !== "last_trade_price" || !message.asset_id || !message.timestamp) {
      return;
    }

    this.lastTradeAt = Date.now();
    const timestampSec = Math.floor(Number(message.timestamp) / 1000);
    if (Number.isFinite(timestampSec)) {
      this.lastTradeTimestampSec = Math.max(this.lastTradeTimestampSec, timestampSec - 1);
    }
  }

  private startTradePolling(): void {
    void this.pollRecentTrades();
    this.tradePollTimer = setInterval(() => {
      void this.pollRecentTrades();
    }, config.tradePollMs);
  }

  private async pollRecentTrades(): Promise<void> {
    const url = new URL(`${DATA_API_URL}/trades`);
    url.searchParams.set("limit", "250");

    const response = await fetch(url);
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as TradeRecord[];
    const trades = dedupeTrades(payload)
      .filter((trade) => trade.timestamp >= this.lastTradeTimestampSec)
      .sort((left, right) => left.timestamp - right.timestamp);

    for (const trade of trades) {
      const tradeId = `${trade.transactionHash}:${trade.proxyWallet}:${trade.asset}:${trade.side}:${trade.size}`;
      if (this.recentTradeIds.has(tradeId)) {
        continue;
      }

      this.recentTradeIds.add(tradeId);
      if (this.recentTradeIds.size > 5000) {
        const recentIds = Array.from(this.recentTradeIds).slice(-2500);
        this.recentTradeIds.clear();
        recentIds.forEach((id) => this.recentTradeIds.add(id));
      }

      this.lastTradeTimestampSec = Math.max(this.lastTradeTimestampSec, trade.timestamp);
      await this.ingestTrade(trade);
    }
  }

  private async ingestTrade(trade: TradeRecord): Promise<void> {
    const market = this.marketsByAssetId.get(trade.asset);
    if (!market) {
      return;
    }

    const totalUsd = trade.price * trade.size;
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      return;
    }

    const accumulatorKey = `${trade.proxyWallet}:${trade.asset}:${trade.side}`;
    const outcome = market.outcomeByAssetId[trade.asset] ?? trade.outcome;
    const displayName =
      trade.name && !trade.name.startsWith("0x") ? trade.name : trade.pseudonym || trade.proxyWallet;

    const existing = this.accumulators.get(accumulatorKey);
    const now = Date.now();

    if (
      existing &&
      now - existing.updatedAt <= config.tradeWindowMs &&
      existing.outcome === outcome
    ) {
      existing.updatedAt = now;
      existing.totalUsd += totalUsd;
      existing.totalShares += trade.size;
      existing.weightedPriceSum += trade.size * trade.price;
      existing.fills.push(trade);
      await this.tryEmitSignal(existing);
      return;
    }

    const nextAccumulator: SignalAccumulator = {
      wallet: trade.proxyWallet,
      assetId: trade.asset,
      side: trade.side,
      outcome,
      market,
      displayName,
      profileImage: trade.profileImage,
      profileUrl: `https://polymarket.com/profile/${trade.proxyWallet}`,
      startedAt: now,
      updatedAt: now,
      totalUsd,
      totalShares: trade.size,
      weightedPriceSum: trade.size * trade.price,
      fills: [trade],
      emitted: false,
    };

    this.accumulators.set(accumulatorKey, nextAccumulator);
    await this.tryEmitSignal(nextAccumulator);
    this.pruneAccumulators();
  }

  private async tryEmitSignal(accumulator: SignalAccumulator): Promise<void> {
    if (!accumulator.emitted && accumulator.totalUsd < config.whaleThresholdUsd) {
      return;
    }

    const trader = await this.getTraderSummary(accumulator.wallet, accumulator.displayName, accumulator.profileImage);
    const signalId = accumulator.signalId ?? `${accumulator.wallet}:${accumulator.assetId}:${accumulator.startedAt}`;
    const signal: WhaleSignal = {
      id: signalId,
      wallet: accumulator.wallet,
      displayName: trader.displayName,
      marketQuestion: accumulator.market.question,
      marketSlug: accumulator.market.slug,
      marketUrl: `https://polymarket.com/event/${accumulator.market.slug}`,
      marketImage: accumulator.market.image,
      outcome: accumulator.outcome,
      side: accumulator.side,
      label: trader.isVeryProfitable ? "Profitable whale buy" : "Whale buy",
      labelTone: trader.isVeryProfitable ? "green" : "blue",
      totalUsd: accumulator.totalUsd,
      fillCount: accumulator.fills.length,
      totalShares: accumulator.totalShares,
      averagePrice: accumulator.weightedPriceSum / accumulator.totalShares,
      timestamp: accumulator.updatedAt,
      profileUrl: accumulator.profileUrl,
      profileImage: trader.profileImage ?? accumulator.profileImage,
      trader,
    };

    accumulator.emitted = true;
    accumulator.signalId = signalId;

    const existingIndex = this.signals.findIndex((entry) => entry.id === signal.id);
    if (existingIndex >= 0) {
      this.signals.splice(existingIndex, 1);
    }
    this.signals.unshift(signal);
    if (this.signals.length > config.maxSignals) {
      this.signals.length = config.maxSignals;
    }

    try {
      await this.storage.saveSignal(signal);
    } catch (error) {
      console.error("Failed to persist signal", error);
    }

    for (const listener of this.listeners) {
      listener(signal);
    }
  }

  private pruneAccumulators(): void {
    const now = Date.now();
    for (const [key, accumulator] of this.accumulators) {
      if (now - accumulator.updatedAt > config.tradeWindowMs * 2) {
        this.accumulators.delete(key);
      }
    }
  }

  private async getTraderSummary(
    wallet: string,
    fallbackName: string,
    fallbackProfileImage?: string,
  ): Promise<TraderSummary> {
    const cached = this.traderCache.get(wallet);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) {
      return cached.summary;
    }

    const [positionsRes, closedPositionsRes, valueRes] = await Promise.all([
      fetch(`${DATA_API_URL}/positions?user=${wallet}&sizeThreshold=.1`),
      fetch(`${DATA_API_URL}/closed-positions?user=${wallet}&limit=500`),
      fetch(`${DATA_API_URL}/value?user=${wallet}`),
    ]);

    const positions = positionsRes.ok ? (((await positionsRes.json()) as RawPosition[]) ?? []) : [];
    const closedPositions = closedPositionsRes.ok
      ? (((await closedPositionsRes.json()) as RawClosedPosition[]) ?? [])
      : [];
    const valueRows = valueRes.ok ? (((await valueRes.json()) as RawValue[]) ?? []) : [];

    const openPnl = positions.reduce((sum, position) => sum + Number(position.cashPnl ?? 0), 0);
    const openRealized = positions.reduce(
      (sum, position) => sum + Number(position.realizedPnl ?? 0),
      0,
    );
    const closedRealized = closedPositions.reduce(
      (sum, position) => sum + Number(position.realizedPnl ?? 0),
      0,
    );
    const realizedPnl = openRealized + closedRealized;
    const totalValue = Number(valueRows[0]?.value ?? 0);
    const totalPnl = openPnl + realizedPnl;

    const summary: TraderSummary = {
      wallet,
      displayName: fallbackName || wallet,
      profileImage: fallbackProfileImage,
      openPnl,
      realizedPnl,
      totalValue,
      totalPnl,
      isVeryProfitable: totalPnl >= config.profitableWhaleThresholdUsd,
    };

    this.traderCache.set(wallet, { summary, fetchedAt: Date.now() });
    return summary;
  }
}
