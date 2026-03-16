import { config } from "./config.js";
import WebSocket from "ws";
import { SignalStorage, type PersistedCluster } from "./storage.js";
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

type RawActivity = {
  type?: string;
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
  clusterKey: string;
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
  fillCount: number;
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
    const key = getTradeId(trade);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const getTradeId = (trade: TradeRecord) =>
  `${trade.transactionHash}:${trade.proxyWallet}:${trade.asset}:${trade.side}:${trade.size}:${trade.price}`;

const classifyTrader = (
  totalPnl: number,
  tradeCount: number,
): Pick<TraderSummary, "tier" | "weight"> => {
  if (totalPnl >= 100_000 && tradeCount >= 100) {
    return { tier: "whale", weight: 20 };
  }

  if (totalPnl >= 10_000 && tradeCount >= 50) {
    return { tier: "shark", weight: 10 };
  }

  if (totalPnl >= 2_000 && tradeCount >= 20) {
    return { tier: "pro", weight: 3 };
  }

  return { tier: "none", weight: 1 };
};

const buildSignalLabel = (
  tier: TraderSummary["tier"],
  side: "BUY" | "SELL",
): Pick<WhaleSignal, "label" | "labelTone"> => {
  const action = side === "BUY" ? "buy" : "sell";

  if (tier === "whale") {
    return { label: `Whale ${action}`, labelTone: "green" };
  }

  if (tier === "shark") {
    return { label: `Shark ${action}`, labelTone: "blue" };
  }

  if (tier === "pro") {
    return { label: `Pro ${action}`, labelTone: "blue" };
  }

  return { label: `Large ${action}`, labelTone: "neutral" };
};

export class PolymarketSignalService {
  private readonly marketsByAssetId = new Map<string, MarketRecord>();
  private readonly activeAssetIds = new Set<string>();
  private readonly accumulators = new Map<string, SignalAccumulator>();
  private readonly traderCache = new Map<string, { summary: TraderSummary; fetchedAt: number }>();
  private readonly storage = new SignalStorage();
  private readonly pendingUnknownAssetTrades = new Map<string, TradeRecord[]>();
  private ws: WebSocket | null = null;
  private marketSyncTimer: NodeJS.Timeout | null = null;
  private tradePollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastTradeTimestampSec = 0;
  private websocketConnected = false;
  private lastMarketSyncAt: number | null = null;
  private lastTradeAt: number | null = null;
  private lastForcedMarketSyncAt = 0;
  private forcingMarketSync: Promise<void> | null = null;
  private listeners = new Set<(payload: WhaleSignal) => void>();

  async start(): Promise<void> {
    await this.storage.connect();
    await this.restoreActiveClusters();
    await this.syncMarkets();
    await this.backfillHistoricalSignals();
    this.connectMarketSocket();
    this.startTradePolling();
    this.marketSyncTimer = setInterval(() => {
      void this.syncMarkets();
    }, config.marketRefreshMs);
  }

  private async restoreActiveClusters(): Promise<void> {
    const cutoffMs = Date.now() - config.tradeWindowMs * 2;
    const clusters = await this.storage.loadActiveClusters(cutoffMs);
    this.accumulators.clear();

    for (const cluster of clusters) {
      this.accumulators.set(cluster.clusterKey, this.fromPersistedCluster(cluster));
    }
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

  async getSnapshot() {
    return {
      status: {
        marketCount: this.activeAssetIds.size,
        websocketConnected: this.websocketConnected,
        lastMarketSyncAt: this.lastMarketSyncAt,
        lastTradeAt: this.lastTradeAt,
      },
      signals: await this.storage.loadRecentSignals(config.maxSignals),
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
      const tradeId = getTradeId(trade);
      const inserted = await this.storage.markTradeProcessed({
        tradeId,
        proxyWallet: trade.proxyWallet,
        asset: trade.asset,
        side: trade.side,
        timestamp: trade.timestamp,
        totalUsd: trade.price * trade.size,
        createdAt: new Date(),
      });
      if (!inserted) {
        continue;
      }

      this.lastTradeTimestampSec = Math.max(this.lastTradeTimestampSec, trade.timestamp);
      await this.ingestTrade(trade);
    }
  }

  private async backfillHistoricalSignals(): Promise<void> {
    const limit = Math.max(0, Math.min(config.historicalBackfillLimit, 50_000));
    if (limit === 0) {
      return;
    }

    const lookbackCutoffSec =
      Math.floor(Date.now() / 1000) - config.historicalBackfillLookbackHours * 60 * 60;
    const batchSize = 500;
    const trades: TradeRecord[] = [];

    for (let offset = 0; offset < limit; offset += batchSize) {
      const url = new URL(`${DATA_API_URL}/trades`);
      url.searchParams.set("limit", String(Math.min(batchSize, limit - offset)));
      url.searchParams.set("offset", String(offset));

      const response = await fetch(url);
      if (!response.ok) {
        break;
      }

      const batch = (await response.json()) as TradeRecord[];
      if (batch.length === 0) {
        break;
      }

      trades.push(...batch);
      const oldestTrade = batch[batch.length - 1];
      if (!oldestTrade || oldestTrade.timestamp < lookbackCutoffSec) {
        break;
      }
    }

    const historicalTrades = dedupeTrades(trades)
      .filter((trade) => trade.timestamp >= lookbackCutoffSec)
      .sort((left, right) => left.timestamp - right.timestamp);

    for (const trade of historicalTrades) {
      const inserted = await this.storage.markTradeProcessed({
        tradeId: getTradeId(trade),
        proxyWallet: trade.proxyWallet,
        asset: trade.asset,
        side: trade.side,
        timestamp: trade.timestamp,
        totalUsd: trade.price * trade.size,
        createdAt: new Date(),
      });
      if (!inserted) {
        continue;
      }

      this.lastTradeTimestampSec = Math.max(this.lastTradeTimestampSec, trade.timestamp);
      await this.ingestTrade(trade);
    }
  }

  private async ingestTrade(trade: TradeRecord): Promise<boolean> {
    if (!this.marketsByAssetId.has(trade.asset)) {
      this.queueUnknownAssetTrade(trade);
      await this.ensureMarketForAsset(trade.asset);
      return false;
    }

    return this.ingestKnownTrade(trade);
  }

  private queueUnknownAssetTrade(trade: TradeRecord): void {
    const pendingTrades = this.pendingUnknownAssetTrades.get(trade.asset) ?? [];
    pendingTrades.push(trade);
    pendingTrades.sort((left, right) => left.timestamp - right.timestamp);
    this.pendingUnknownAssetTrades.set(trade.asset, pendingTrades.slice(-50));
  }

  private async ensureMarketForAsset(assetId: string): Promise<void> {
    if (this.marketsByAssetId.has(assetId)) {
      await this.flushPendingTradesForAsset(assetId);
      return;
    }

    const now = Date.now();
    if (
      this.forcingMarketSync &&
      now - this.lastForcedMarketSyncAt < 60_000
    ) {
      await this.forcingMarketSync;
      await this.flushPendingTradesForAsset(assetId);
      return;
    }

    if (now - this.lastForcedMarketSyncAt < 60_000) {
      return;
    }

    this.lastForcedMarketSyncAt = now;
    this.forcingMarketSync = (async () => {
      try {
        await this.syncMarkets();
      } finally {
        this.forcingMarketSync = null;
      }
    })();

    await this.forcingMarketSync;
    await this.flushPendingTradesForAsset(assetId);
  }

  private async flushPendingTradesForAsset(assetId: string): Promise<void> {
    if (!this.marketsByAssetId.has(assetId)) {
      return;
    }

    const pendingTrades = this.pendingUnknownAssetTrades.get(assetId);
    if (!pendingTrades || pendingTrades.length === 0) {
      return;
    }

    this.pendingUnknownAssetTrades.delete(assetId);

    for (const trade of pendingTrades) {
      await this.ingestKnownTrade(trade);
    }
  }

  private async ingestKnownTrade(trade: TradeRecord): Promise<boolean> {
    const market = this.marketsByAssetId.get(trade.asset);
    if (!market) {
      return false;
    }

    const totalUsd = trade.price * trade.size;
    if (!Number.isFinite(totalUsd) || totalUsd <= 0) {
      return false;
    }

    const accumulatorKey = `${trade.proxyWallet}:${trade.asset}:${trade.side}`;
    const outcome = market.outcomeByAssetId[trade.asset] ?? trade.outcome;
    const displayName =
      trade.name && !trade.name.startsWith("0x") ? trade.name : trade.pseudonym || trade.proxyWallet;

    const existing = this.accumulators.get(accumulatorKey);
    const tradeTimestampMs = trade.timestamp * 1000;

    if (
      existing &&
      tradeTimestampMs - existing.updatedAt <= config.tradeWindowMs &&
      existing.outcome === outcome
    ) {
      existing.updatedAt = tradeTimestampMs;
      existing.totalUsd += totalUsd;
      existing.totalShares += trade.size;
      existing.weightedPriceSum += trade.size * trade.price;
      existing.fillCount += 1;
      await this.storage.saveCluster(this.toPersistedCluster(existing));
      return this.tryEmitSignal(existing);
    }

    const nextAccumulator: SignalAccumulator = {
      clusterKey: accumulatorKey,
      wallet: trade.proxyWallet,
      assetId: trade.asset,
      side: trade.side,
      outcome,
      market,
      displayName,
      profileImage: trade.profileImage,
      profileUrl: `https://polymarket.com/profile/${trade.proxyWallet}`,
      startedAt: tradeTimestampMs,
      updatedAt: tradeTimestampMs,
      totalUsd,
      totalShares: trade.size,
      weightedPriceSum: trade.size * trade.price,
      fillCount: 1,
      emitted: false,
    };

    this.accumulators.set(accumulatorKey, nextAccumulator);
    await this.storage.saveCluster(this.toPersistedCluster(nextAccumulator));
    const emitted = await this.tryEmitSignal(nextAccumulator);
    this.pruneAccumulators();
    return emitted;
  }

  private async tryEmitSignal(accumulator: SignalAccumulator): Promise<boolean> {
    const wasAlreadyEmitted = accumulator.emitted;
    if (accumulator.totalUsd < config.minSignalClusterUsd) {
      return false;
    }

    const trader = await this.getTraderSummary(accumulator.wallet, accumulator.displayName, accumulator.profileImage);
    if (trader.tier === "none") {
      return false;
    }
    const signalId = accumulator.signalId ?? `${accumulator.wallet}:${accumulator.assetId}:${accumulator.startedAt}`;
    const signalLabel = buildSignalLabel(trader.tier, accumulator.side);
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
      label: signalLabel.label,
      labelTone: signalLabel.labelTone,
      totalUsd: accumulator.totalUsd,
      fillCount: accumulator.fillCount,
      totalShares: accumulator.totalShares,
      averagePrice: accumulator.weightedPriceSum / accumulator.totalShares,
      timestamp: accumulator.updatedAt,
      profileUrl: accumulator.profileUrl,
      profileImage: trader.profileImage ?? accumulator.profileImage,
      trader,
    };

    accumulator.emitted = true;
    accumulator.signalId = signalId;
    await this.storage.saveCluster(this.toPersistedCluster(accumulator));
    await this.storage.saveSignal(signal);

    for (const listener of this.listeners) {
      listener(signal);
    }

    return !wasAlreadyEmitted;
  }

  private pruneAccumulators(): void {
    const now = Date.now();
    for (const [key, accumulator] of this.accumulators) {
      if (now - accumulator.updatedAt > config.tradeWindowMs * 2) {
        this.accumulators.delete(key);
        void this.storage.deleteCluster(key);
      }
    }
  }

  private toPersistedCluster(accumulator: SignalAccumulator): PersistedCluster {
    return {
      clusterKey: accumulator.clusterKey,
      wallet: accumulator.wallet,
      assetId: accumulator.assetId,
      side: accumulator.side,
      outcome: accumulator.outcome,
      market: accumulator.market,
      displayName: accumulator.displayName,
      profileImage: accumulator.profileImage,
      profileUrl: accumulator.profileUrl,
      startedAt: accumulator.startedAt,
      updatedAt: accumulator.updatedAt,
      totalUsd: accumulator.totalUsd,
      totalShares: accumulator.totalShares,
      weightedPriceSum: accumulator.weightedPriceSum,
      fillCount: accumulator.fillCount,
      emitted: accumulator.emitted,
      signalId: accumulator.signalId,
      expiresAt: new Date(accumulator.updatedAt + config.tradeWindowMs * 2),
    };
  }

  private fromPersistedCluster(cluster: PersistedCluster): SignalAccumulator {
    return {
      clusterKey: cluster.clusterKey,
      wallet: cluster.wallet,
      assetId: cluster.assetId,
      side: cluster.side,
      outcome: cluster.outcome,
      market: cluster.market,
      displayName: cluster.displayName,
      profileImage: cluster.profileImage,
      profileUrl: cluster.profileUrl,
      startedAt: cluster.startedAt,
      updatedAt: cluster.updatedAt,
      totalUsd: cluster.totalUsd,
      totalShares: cluster.totalShares,
      weightedPriceSum: cluster.weightedPriceSum,
      fillCount: cluster.fillCount,
      emitted: cluster.emitted,
      signalId: cluster.signalId,
    };
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
    const tradeCount = await this.getTradeCount(wallet);
    const classification = classifyTrader(totalPnl, tradeCount);

    const summary: TraderSummary = {
      wallet,
      displayName: fallbackName || wallet,
      profileImage: fallbackProfileImage,
      openPnl,
      realizedPnl,
      totalValue,
      totalPnl,
      tradeCount,
      tier: classification.tier,
      weight: classification.weight,
    };

    this.traderCache.set(wallet, { summary, fetchedAt: Date.now() });
    return summary;
  }

  private async getTradeCount(wallet: string): Promise<number> {
    let count = 0;

    for (let offset = 0; offset <= 100; offset += 50) {
      const response = await fetch(`${DATA_API_URL}/activity?user=${wallet}&limit=50&offset=${offset}`);
      if (!response.ok) {
        break;
      }

      const rows = (await response.json()) as RawActivity[];
      const tradeRows = rows.filter((row) => row.type === "TRADE");
      count += tradeRows.length;

      if (count >= 100 || rows.length < 50) {
        break;
      }
    }

    return count;
  }
}
