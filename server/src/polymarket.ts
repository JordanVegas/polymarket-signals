import { config } from "./config.js";
import WebSocket from "ws";
import { SignalStorage, type PersistedCluster } from "./storage.js";
import type { MarketRecord, TradeRecord, TraderSummary, WhaleSignal } from "./types.js";

const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type RawMarket = {
  id: string;
  conditionId?: string;
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
  proxyWallet?: string;
  side?: "BUY" | "SELL";
  asset?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  slug?: string;
  icon?: string;
  outcome?: string;
  name?: string;
  pseudonym?: string;
  profileImage?: string;
  transactionHash?: string;
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

type MarketSocketShard = {
  id: number;
  assetIds: string[];
  ws: WebSocket | null;
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  connected: boolean;
  lastMessageAt: number | null;
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
    return { label: `🐋 Whale ${action}`, labelTone: "cyan" };
  }

  if (tier === "shark") {
    return { label: `🦈 Shark ${action}`, labelTone: "blue" };
  }

  if (tier === "pro") {
    return { label: `😎 Pro ${action}`, labelTone: "yellow" };
  }

  return { label: `Large ${action}`, labelTone: "neutral" };
};

const applySignalLabelStyle = (signal: WhaleSignal): WhaleSignal => ({
  ...signal,
  ...buildSignalLabel(signal.trader.tier, signal.side),
});

const logFetchFailure = (context: string, error: unknown) => {
  console.error(`[polysignals] ${context}`, error);
};

type IngestResult = "ingested" | "queued";

export class PolymarketSignalService {
  private readonly marketsByAssetId = new Map<string, MarketRecord>();
  private readonly activeAssetIds = new Set<string>();
  private readonly initialActiveConditionIds = new Set<string>();
  private readonly websocketAssetSeenAt = new Map<string, number>();
  private readonly accumulators = new Map<string, SignalAccumulator>();
  private readonly traderCache = new Map<string, { summary: TraderSummary; fetchedAt: number }>();
  private readonly storage = new SignalStorage();
  private readonly pendingUnknownAssetTrades = new Map<string, TradeRecord[]>();
  private readonly marketSocketShards = new Map<number, MarketSocketShard>();
  private marketSyncTimer: NodeJS.Timeout | null = null;
  private tradePollTimer: NodeJS.Timeout | null = null;
  private lastTradeTimestampSec = 0;
  private websocketConnected = false;
  private lastMarketSyncAt: number | null = null;
  private lastTradeAt: number | null = null;
  private lastWebsocketMessageAt: number | null = null;
  private lastForcedMarketSyncAt = 0;
  private forcingMarketSync: Promise<void> | null = null;
  private nextShardId = 1;
  private listeners = new Set<(payload: WhaleSignal) => void>();

  async start(): Promise<void> {
    await this.storage.connect();
    await this.restoreActiveClusters();
    await this.syncMarkets();
    this.captureInitialActiveMarkets();
    this.startTradePolling();
    this.runBackgroundTask("recent catch-up", this.catchUpRecentTrades());
    if (config.historicalFetchEnabled) {
      this.runBackgroundTask("historical backfill", this.backfillHistoricalSignals());
    }
    this.marketSyncTimer = setInterval(() => {
      this.runBackgroundTask("scheduled market sync", this.syncMarkets());
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
    this.teardownAllMarketSockets();
  }

  onSignal(listener: (payload: WhaleSignal) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getSnapshot() {
    const recentCutoff = Date.now() - 15 * 60_000;
    let websocketAssetsSeenRecentlyCount = 0;
    let websocketConnectedShardCount = 0;

    for (const seenAt of this.websocketAssetSeenAt.values()) {
      if (seenAt >= recentCutoff) {
        websocketAssetsSeenRecentlyCount += 1;
      }
    }

    for (const shard of this.marketSocketShards.values()) {
      if (shard.connected) {
        websocketConnectedShardCount += 1;
      }
    }

    const activeMarketSlugs = new Set(
      Array.from(this.marketsByAssetId.values(), (market) => market.slug),
    );
    const recentSignals = (await this.storage.loadRecentSignals(config.maxSignals)).map(applySignalLabelStyle);

    return {
      status: {
        marketCount: this.activeAssetIds.size,
        websocketConnected: this.websocketConnected,
        websocketShardCount: this.marketSocketShards.size,
        websocketConnectedShardCount,
        lastMarketSyncAt: this.lastMarketSyncAt,
        lastTradeAt: this.lastTradeAt,
        websocketSubscribedAssetCount: this.activeAssetIds.size,
        websocketAssetsSeenCount: this.websocketAssetSeenAt.size,
        websocketAssetsSeenRecentlyCount,
        lastWebsocketMessageAt: this.lastWebsocketMessageAt,
      },
      signals: recentSignals.filter((signal) => activeMarketSlugs.has(signal.marketSlug)),
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

      const response = await this.safeFetch(url, "sync markets");
      if (!response) {
        return;
      }
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
          conditionId: market.conditionId ?? market.id,
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
    this.rebuildMarketSockets();
  }

  private captureInitialActiveMarkets(): void {
    if (this.initialActiveConditionIds.size > 0) {
      return;
    }

    for (const market of this.marketsByAssetId.values()) {
      this.initialActiveConditionIds.add(market.conditionId);
    }
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

  private rebuildMarketSockets(): void {
    this.teardownAllMarketSockets();

    const assetChunks = chunk(Array.from(this.activeAssetIds), 800);
    for (const assetIds of assetChunks) {
      const shard: MarketSocketShard = {
        id: this.nextShardId++,
        assetIds,
        ws: null,
        heartbeatTimer: null,
        reconnectTimer: null,
        connected: false,
        lastMessageAt: null,
      };
      this.marketSocketShards.set(shard.id, shard);
      this.connectMarketSocketShard(shard);
    }

    this.updateWebsocketConnected();
  }

  private connectMarketSocketShard(shard: MarketSocketShard): void {
    if (shard.assetIds.length === 0) {
      return;
    }

    shard.ws?.close();
    shard.ws = new WebSocket(CLOB_WS_URL);

    shard.ws.addEventListener("open", () => {
      shard.connected = true;
      this.updateWebsocketConnected();
      shard.ws?.send(
        JSON.stringify({
          type: "market",
          assets_ids: shard.assetIds,
        }),
      );
      shard.heartbeatTimer = setInterval(() => {
        shard.ws?.send("{}");
      }, 10_000);
    });

    shard.ws.addEventListener("message", (event) => {
      shard.lastMessageAt = Date.now();
      this.handleSocketMessage(String(event.data));
    });

    shard.ws.addEventListener("close", () => {
      shard.connected = false;
      this.updateWebsocketConnected();
      if (shard.heartbeatTimer) {
        clearInterval(shard.heartbeatTimer);
      }
      shard.heartbeatTimer = null;
      if (!this.marketSocketShards.has(shard.id) || shard.reconnectTimer) {
        return;
      }
      shard.reconnectTimer = setTimeout(() => {
        shard.reconnectTimer = null;
        if (this.marketSocketShards.has(shard.id)) {
          this.connectMarketSocketShard(shard);
        }
      }, 3_000);
    });

    shard.ws.addEventListener("error", () => {
      shard.connected = false;
      this.updateWebsocketConnected();
    });
  }

  private teardownAllMarketSockets(): void {
    for (const shard of this.marketSocketShards.values()) {
      if (shard.heartbeatTimer) {
        clearInterval(shard.heartbeatTimer);
      }
      if (shard.reconnectTimer) {
        clearTimeout(shard.reconnectTimer);
      }
      shard.heartbeatTimer = null;
      shard.reconnectTimer = null;
      shard.connected = false;
      shard.ws?.close();
      shard.ws = null;
    }

    this.marketSocketShards.clear();
    this.updateWebsocketConnected();
  }

  private updateWebsocketConnected(): void {
    this.websocketConnected = Array.from(this.marketSocketShards.values()).some((shard) => shard.connected);
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

    const seenAt = Date.now();
    this.lastTradeAt = Date.now();
    this.lastWebsocketMessageAt = seenAt;
    this.websocketAssetSeenAt.set(message.asset_id, seenAt);
  }

  private startTradePolling(): void {
    this.runBackgroundTask("initial trade poll", this.pollRecentTrades());
    this.tradePollTimer = setInterval(() => {
      this.runBackgroundTask("trade poll", this.pollRecentTrades());
    }, config.tradePollMs);
  }

  private async pollRecentTrades(): Promise<void> {
    const url = new URL(`${DATA_API_URL}/trades`);
    url.searchParams.set("limit", "250");

    const response = await this.safeFetch(url, "poll recent trades");
    if (!response) {
      return;
    }
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as TradeRecord[];
    const trades = dedupeTrades(payload)
      .filter((trade) => trade.timestamp >= this.lastTradeTimestampSec)
      .sort((left, right) => left.timestamp - right.timestamp);

    for (const trade of trades) {
      const tradeId = getTradeId(trade);
      await this.storage.saveObservedTrade({
        ...trade,
        tradeId,
        createdAt: new Date(),
      });
      if (await this.storage.hasProcessedTrade(tradeId)) {
        continue;
      }

      const result = await this.ingestTrade(trade);
      if (result === "ingested") {
        await this.markTradeProcessed(trade);
      }
    }
  }

  private async catchUpRecentTrades(): Promise<void> {
    const lookbackCutoffSec =
      Math.floor(Date.now() / 1000) - config.recentCatchupLookbackMinutes * 60;
    const maxOffset = Math.max(0, config.recentCatchupMaxOffset);
    const batchSize = 500;
    const trades: TradeRecord[] = [];

    for (let offset = 0; offset <= maxOffset; offset += batchSize) {
      const url = new URL(`${DATA_API_URL}/trades`);
      url.searchParams.set("limit", String(batchSize));
      url.searchParams.set("offset", String(offset));

      const response = await this.safeFetch(url, "recent catch-up");
      if (!response || !response.ok) {
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

    const recentTrades = dedupeTrades(trades)
      .filter((trade) => trade.timestamp >= lookbackCutoffSec)
      .sort((left, right) => left.timestamp - right.timestamp);

    for (const trade of recentTrades) {
      const tradeId = getTradeId(trade);
      await this.storage.saveObservedTrade({
        ...trade,
        tradeId,
        createdAt: new Date(),
      });
      if (await this.storage.hasProcessedTrade(tradeId)) {
        continue;
      }

      const result = await this.ingestTrade(trade);
      if (result === "ingested") {
        await this.markTradeProcessed(trade);
      }
    }
  }

  private async backfillHistoricalSignals(): Promise<void> {
    if (!config.historicalFetchEnabled) {
      return;
    }

    const limit = Math.max(0, Math.min(config.historicalBackfillLimit, 50_000));
    if (limit === 0) {
      return;
    }

    const lookbackCutoffSec =
      Math.floor(Date.now() / 1000) - config.historicalBackfillLookbackHours * 60 * 60;
    const storedTrades = await this.storage.loadObservedTradesSince(lookbackCutoffSec, limit);
    if (storedTrades.length > 0) {
      await this.processHistoricalTrades(storedTrades);
      return;
    }

    const batchSize = 500;
    const trades: TradeRecord[] = [];

    for (let offset = 0; offset < limit; offset += batchSize) {
      const url = new URL(`${DATA_API_URL}/trades`);
      url.searchParams.set("limit", String(Math.min(batchSize, limit - offset)));
      url.searchParams.set("offset", String(offset));

      const response = await this.safeFetch(url, "historical backfill");
      if (!response) {
        break;
      }
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

    await this.processHistoricalTrades(historicalTrades, true);
  }

  private async backfillMarketHistory(market: MarketRecord): Promise<void> {
    if (!config.historicalFetchEnabled) {
      return;
    }

    const started = await this.storage.markMarketCatchupStarted(market.conditionId);
    if (!started) {
      return;
    }

    const batchSize = 500;
    const maxOffset = 10_000;
    const trades: TradeRecord[] = [];

    try {
      for (let offset = 0; offset <= maxOffset; offset += batchSize) {
        const url = new URL(`${DATA_API_URL}/trades`);
        url.searchParams.set("market", market.conditionId);
        url.searchParams.set("limit", String(batchSize));
        url.searchParams.set("offset", String(offset));

        const response = await this.safeFetch(url, `market catch-up ${market.slug}`);
        if (!response) {
          throw new Error(`Failed market catch-up fetch for ${market.slug}`);
        }
        if (!response.ok) {
          break;
        }

        const batch = (await response.json()) as TradeRecord[] | { error?: string };
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }

        trades.push(...batch);

        if (batch.length < batchSize) {
          break;
        }
      }

      const historicalTrades = dedupeTrades(trades).sort((left, right) => left.timestamp - right.timestamp);
      await this.processHistoricalTrades(historicalTrades, true);
      await this.storage.markMarketCatchupCompleted(market.conditionId);
    } catch (error) {
      await this.storage.clearMarketCatchup(market.conditionId);
      throw error;
    } finally {
    }
  }

  private async backfillTraderHistory(trader: TraderSummary): Promise<void> {
    if (!config.historicalFetchEnabled) {
      return;
    }

    if (trader.tier !== "whale" && trader.tier !== "shark") {
      return;
    }

    const started = await this.storage.markTraderCatchupStarted(trader.wallet);
    if (!started) {
      return;
    }

    const trades: TradeRecord[] = [];
    const batchSize = 50;
    const maxOffset = 3_000;

    try {
      for (let offset = 0; offset <= maxOffset; offset += batchSize) {
        const response = await this.safeFetch(
          `${DATA_API_URL}/activity?user=${trader.wallet}&limit=${batchSize}&offset=${offset}`,
          `trader catch-up ${trader.wallet}`,
        );
        if (!response) {
          throw new Error(`Failed trader catch-up fetch for ${trader.wallet}`);
        }
        if (!response.ok) {
          break;
        }

        const rows = (await response.json()) as RawActivity[] | { error?: string };
        if (!Array.isArray(rows) || rows.length === 0) {
          break;
        }

        const batch = rows
          .filter((row) => row.type === "TRADE")
          .map((row) => this.toTradeRecord(row))
          .filter((trade): trade is TradeRecord => Boolean(trade))
          .filter((trade) => this.activeAssetIds.has(trade.asset));

        trades.push(...batch);

        if (rows.length < batchSize) {
          break;
        }
      }

      const historicalTrades = dedupeTrades(trades).sort((left, right) => left.timestamp - right.timestamp);
      await this.processHistoricalTrades(historicalTrades, true);
      await this.storage.markTraderCatchupCompleted(trader.wallet);
    } catch (error) {
      await this.storage.clearTraderCatchup(trader.wallet);
      throw error;
    } finally {
    }
  }

  private async processHistoricalTrades(
    trades: TradeRecord[],
    persistObservedTrades = false,
  ): Promise<void> {
    for (const trade of trades) {
      const tradeId = getTradeId(trade);
      if (persistObservedTrades) {
        await this.storage.saveObservedTrade({
          ...trade,
          tradeId,
          createdAt: new Date(),
        });
      }

      if (await this.storage.hasProcessedTrade(tradeId)) {
        continue;
      }

      const result = await this.ingestTrade(trade);
      if (result === "ingested") {
        await this.markTradeProcessed(trade);
      }
    }
  }

  private async ingestTrade(trade: TradeRecord): Promise<IngestResult> {
    if (!this.marketsByAssetId.has(trade.asset)) {
      this.queueUnknownAssetTrade(trade);
      await this.ensureMarketForAsset(trade.asset);
      return "queued";
    }

    await this.ingestKnownTrade(trade);
    return "ingested";
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
      await this.markTradeProcessed(trade);
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

  private async markTradeProcessed(trade: TradeRecord): Promise<void> {
    const tradeId = getTradeId(trade);
    await this.storage.markTradeProcessed({
      tradeId,
      proxyWallet: trade.proxyWallet,
      asset: trade.asset,
      side: trade.side,
      timestamp: trade.timestamp,
      totalUsd: trade.price * trade.size,
      createdAt: new Date(),
    });
    this.lastTradeTimestampSec = Math.max(this.lastTradeTimestampSec, trade.timestamp);
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
    const styledSignal = applySignalLabelStyle(signal);

    accumulator.emitted = true;
    accumulator.signalId = signalId;
    await this.storage.saveCluster(this.toPersistedCluster(accumulator));
    await this.storage.saveSignal(styledSignal);

    if (this.initialActiveConditionIds.has(accumulator.market.conditionId)) {
      this.runBackgroundTask(
        `market catch-up ${accumulator.market.slug}`,
        this.backfillMarketHistory(accumulator.market),
      );
    }

    if (trader.tier === "whale" || trader.tier === "shark") {
      this.runBackgroundTask(`trader catch-up ${trader.wallet}`, this.backfillTraderHistory(trader));
    }

    for (const listener of this.listeners) {
      listener(styledSignal);
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
      market: {
        ...cluster.market,
        conditionId: cluster.market.conditionId ?? cluster.market.id,
      },
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
      this.safeFetch(`${DATA_API_URL}/positions?user=${wallet}&sizeThreshold=.1`, `positions ${wallet}`),
      this.safeFetch(`${DATA_API_URL}/closed-positions?user=${wallet}&limit=500`, `closed positions ${wallet}`),
      this.safeFetch(`${DATA_API_URL}/value?user=${wallet}`, `value ${wallet}`),
    ]);

    const positions = positionsRes?.ok ? (((await positionsRes.json()) as RawPosition[]) ?? []) : [];
    const closedPositions = closedPositionsRes?.ok
      ? (((await closedPositionsRes.json()) as RawClosedPosition[]) ?? [])
      : [];
    const valueRows = valueRes?.ok ? (((await valueRes.json()) as RawValue[]) ?? []) : [];

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
      const response = await this.safeFetch(
        `${DATA_API_URL}/activity?user=${wallet}&limit=50&offset=${offset}`,
        `trade count ${wallet}`,
      );
      if (!response) {
        break;
      }
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

  private toTradeRecord(activity: RawActivity): TradeRecord | null {
    const proxyWallet = String(activity.proxyWallet || "").trim();
    const asset = String(activity.asset || "").trim();
    const side = activity.side === "SELL" ? "SELL" : activity.side === "BUY" ? "BUY" : null;
    const size = Number(activity.size);
    const price = Number(activity.price);
    const timestamp = Number(activity.timestamp);
    const transactionHash = String(activity.transactionHash || "").trim();

    if (
      !proxyWallet ||
      !asset ||
      !side ||
      !Number.isFinite(size) ||
      !Number.isFinite(price) ||
      !Number.isFinite(timestamp) ||
      !transactionHash
    ) {
      return null;
    }

    return {
      proxyWallet,
      side,
      asset,
      size,
      price,
      timestamp,
      title: String(activity.title || ""),
      slug: String(activity.slug || ""),
      icon: activity.icon ? String(activity.icon) : undefined,
      outcome: String(activity.outcome || ""),
      pseudonym: activity.pseudonym ? String(activity.pseudonym) : undefined,
      name: activity.name ? String(activity.name) : undefined,
      profileImage: activity.profileImage ? String(activity.profileImage) : undefined,
      transactionHash,
    };
  }

  private async safeFetch(input: string | URL, context: string): Promise<Response | null> {
    try {
      return await fetch(input);
    } catch (error) {
      logFetchFailure(context, error);
      return null;
    }
  }

  private runBackgroundTask(context: string, task: Promise<unknown>): void {
    void task.catch((error) => {
      logFetchFailure(context, error);
    });
  }
}
