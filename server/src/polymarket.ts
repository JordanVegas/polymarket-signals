import { config } from "./config.js";
import { encryptSecret } from "./secrets.js";
import WebSocket from "ws";
import { Agent } from "undici";
import { SignalStorage, type PersistedCluster, type PersistedTrackedTrader } from "./storage.js";
import type {
  AppSnapshot,
  MarketAggregate,
  MarketPageResponse,
  MarketRecord,
  MarketSortOption,
  StrategyPosition,
  TradeRecord,
  TraderSummary,
  UserProfileResponse,
  WatchMarketResult,
  WhaleSignal,
} from "./types.js";

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
  asset?: string;
  size?: number | string;
  title?: string;
  slug?: string;
  icon?: string;
  outcome?: string;
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
  market?: string;
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

type PendingMarketTradeFetch = {
  marketConditionId: string;
  assetId: string;
  timestampSec: number;
};

type RequestMetric = {
  total: number;
  success: number;
  failure: number;
  recentTimestamps: number[];
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

const positiveOutcomeKeywords = ["yes", "up", "above", "over", "higher", "more", "long"];
const negativeOutcomeKeywords = ["no", "down", "below", "under", "lower", "less", "short"];
const TRADER_MEMORY_CACHE_TTL_MS = 5 * 60_000;
const TRADER_DB_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const REQUEST_STATS_WINDOW_MS = 10 * 60_000;

type IngestResult = "ingested" | "queued";

export class PolymarketSignalService {
  private readonly marketsByAssetId = new Map<string, MarketRecord>();
  private readonly activeAssetIds = new Set<string>();
  private readonly initialActiveConditionIds = new Set<string>();
  private readonly websocketAssetSeenAt = new Map<string, number>();
  private readonly accumulators = new Map<string, SignalAccumulator>();
  private readonly traderCache = new Map<string, { summary: TraderSummary; fetchedAt: number }>();
  private readonly storage = new SignalStorage();
  private readonly fetchDispatcher = new Agent({
    connectTimeout: config.fetchConnectTimeoutMs,
  });
  private readonly pendingUnknownAssetTrades = new Map<string, TradeRecord[]>();
  private readonly marketSocketShards = new Map<number, MarketSocketShard>();
  private readonly marketTradeFetchInFlight = new Map<string, Promise<void>>();
  private readonly queuedMarketTradeFetches = new Map<string, PendingMarketTradeFetch>();
  private readonly lastMarketTradeFetchAt = new Map<string, number>();
  private readonly trackedTraderPollInFlight = new Set<string>();
  private readonly strategyUserReconcilesInFlight = new Set<string>();
  private readonly requestMetrics = new Map<string, RequestMetric>();
  private marketTradeFetchDrainTimer: NodeJS.Timeout | null = null;
  private trackedTraderPollDrainTimer: NodeJS.Timeout | null = null;
  private activeMarketTradeFetchCount = 0;
  private marketSyncTimer: NodeJS.Timeout | null = null;
  private tradePollTimer: NodeJS.Timeout | null = null;
  private portfolioSyncTimer: NodeJS.Timeout | null = null;
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
    this.runBackgroundTask("market aggregate refresh", this.refreshMarketAggregates());
    this.runBackgroundTask("strategy position refresh", this.reconcileAllStrategyPositions());
    this.startTradePolling();
    this.runBackgroundTask("recent catch-up", this.catchUpRecentTrades());
    if (config.historicalFetchEnabled && config.startupHistoricalBackfillEnabled) {
      this.runBackgroundTask("historical backfill", this.backfillHistoricalSignals());
    }
    this.marketSyncTimer = setInterval(() => {
      this.runBackgroundTask("scheduled market sync", this.syncMarkets());
    }, config.marketRefreshMs);
    this.portfolioSyncTimer = setInterval(() => {
      this.runBackgroundTask("portfolio watch sync", this.syncTrackedWalletWatches());
    }, 3 * 60_000);
    this.runBackgroundTask("initial portfolio watch sync", this.syncTrackedWalletWatches());
    this.drainTrackedTraderPollQueue();
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
    if (this.portfolioSyncTimer) {
      clearInterval(this.portfolioSyncTimer);
    }
    if (this.marketTradeFetchDrainTimer) {
      clearTimeout(this.marketTradeFetchDrainTimer);
    }
    if (this.trackedTraderPollDrainTimer) {
      clearTimeout(this.trackedTraderPollDrainTimer);
    }
    this.teardownAllMarketSockets();
  }

  onSignal(listener: (payload: WhaleSignal) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getSnapshot(): Promise<AppSnapshot> {
    const recentCutoff = Date.now() - 15 * 60_000;
    let websocketAssetsSeenRecentlyCount = 0;
    let websocketConnectedShardCount = 0;
    const trackedTraderCount = await this.storage.countTrackedTraders();

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
        trackedTraderCount,
        trackedTraderPollInFlight: this.trackedTraderPollInFlight.size,
        requestStats: this.getRequestStats(),
      },
    };
  }

  async getMarketPage(
    sort: MarketSortOption,
    search: string,
    view: "monitor" | "best",
    page: number,
    pageSize: number,
    username?: string,
  ): Promise<MarketPageResponse> {
    const activeMarketSlugs = Array.from(
      new Set(Array.from(this.marketsByAssetId.values(), (market) => market.slug)),
    );
    const aggregates = await this.storage.loadMarketAggregates(activeMarketSlugs);
    const watchedOutcomesByMarket = username
      ? await this.storage.loadWatchedOutcomesByMarket(username)
      : new Map<string, Set<string>>();
    const filteredMarkets = applyViewFilter(
      applyWatchState(aggregates, watchedOutcomesByMarket),
      view,
    );
    const markets = filterMarkets(sortMarkets(filteredMarkets, sort), search);
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 100));
    const start = (safePage - 1) * safePageSize;
    const items = markets.slice(start, start + safePageSize);

    return {
      items,
      total: markets.length,
      page: safePage,
      pageSize: safePageSize,
      hasMore: start + safePageSize < markets.length,
    };
  }

  async watchMarket(
    username: string,
    marketSlug: string,
    outcome: string,
  ): Promise<WatchMarketResult> {
    const normalizedUsername = username.trim();
    const normalizedMarketSlug = marketSlug.trim();
    const normalizedOutcome = outcome.trim();
    if (!normalizedUsername || !normalizedMarketSlug || !normalizedOutcome) {
      throw new Error("Username, market slug, and outcome are required");
    }

    const { webhookUrl: savedWebhookUrl } = await this.storage.getUserSettings(normalizedUsername);
    if (!savedWebhookUrl) {
      throw new Error("Add your Discord webhook URL in Profile before enabling sell alerts");
    }

    await this.storage.watchMarket(normalizedUsername, normalizedMarketSlug, normalizedOutcome);
    return {
      isWatched: true,
      webhookConfigured: true,
    };
  }

  async unwatchMarket(username: string, marketSlug: string, outcome: string): Promise<WatchMarketResult> {
    const normalizedUsername = username.trim();
    const normalizedMarketSlug = marketSlug.trim();
    const normalizedOutcome = outcome.trim();
    if (!normalizedUsername || !normalizedMarketSlug || !normalizedOutcome) {
      throw new Error("Username, market slug, and outcome are required");
    }

    await this.storage.unwatchMarket(normalizedUsername, normalizedMarketSlug, normalizedOutcome);
    const { webhookUrl: savedWebhookUrl } = await this.storage.getUserSettings(normalizedUsername);
    return {
      isWatched: false,
      webhookConfigured: Boolean(savedWebhookUrl),
    };
  }

  async getUserProfile(username: string): Promise<UserProfileResponse> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      throw new Error("Username is required");
    }

    const watchedMarkets = await this.storage.loadWatchedMarkets(normalizedUsername);
    const activeMarketsBySlug = new Map(
      Array.from(this.marketsByAssetId.values(), (market) => [market.slug, market] as const),
    );
    const settings = await this.storage.getUserSettings(normalizedUsername);

    return {
      username: normalizedUsername,
      webhookUrl: settings.webhookUrl ?? "",
      monitoredWallet: settings.monitoredWallet ?? "",
      paperTradingEnabled: settings.autoTradeEnabled ?? false,
      startingBalanceUsd: settings.startingBalanceUsd ?? 1_000,
      currentBalanceUsd: settings.currentBalanceUsd ?? settings.startingBalanceUsd ?? 1_000,
      riskPercent: settings.riskPercent ?? 5,
      tradingWalletAddress: settings.tradingWalletAddress ?? "",
      tradingSignatureType: settings.tradingSignatureType ?? "EOA",
      hasTradingCredentials: Boolean(
        settings.encryptedPrivateKey &&
          settings.encryptedApiKey &&
          settings.encryptedApiSecret &&
          settings.encryptedApiPassphrase,
      ),
      watches: watchedMarkets.map((watch) => {
        const market = activeMarketsBySlug.get(watch.marketSlug);
        return {
          marketSlug: watch.marketSlug,
          outcome: watch.outcome,
          marketQuestion: market?.question ?? watch.marketSlug,
          marketUrl: market ? `https://polymarket.com/event/${market.slug}` : `https://polymarket.com/event/${watch.marketSlug}`,
          source: watch.source,
        };
      }),
    };
  }

  async getStrategyPositions(username: string): Promise<StrategyPosition[]> {
    this.scheduleStrategyReconcileForUser(username);
    return this.storage.loadStrategyPositions(username, 200);
  }

  async updateUserProfile(
    username: string,
    updates: {
      webhookUrl: string;
      monitoredWallet: string;
      paperTradingEnabled: boolean;
      startingBalanceUsd: number;
      riskPercent: number;
      tradingWalletAddress: string;
      tradingSignatureType: "EOA" | "POLY_PROXY";
      privateKey: string;
      apiKey: string;
      apiSecret: string;
      apiPassphrase: string;
      clearTradingCredentials: boolean;
    },
  ): Promise<UserProfileResponse> {
    const normalizedUsername = username.trim();
    const normalizedWebhookUrl = updates.webhookUrl.trim();
    const normalizedMonitoredWallet = updates.monitoredWallet.trim();
    const normalizedTradingWalletAddress = updates.tradingWalletAddress.trim();
    const normalizedPrivateKey = updates.privateKey.trim();
    const normalizedApiKey = updates.apiKey.trim();
    const normalizedApiSecret = updates.apiSecret.trim();
    const normalizedApiPassphrase = updates.apiPassphrase.trim();
    if (!normalizedUsername) {
      throw new Error("Username is required");
    }

    if (normalizedWebhookUrl && !isValidDiscordWebhookUrl(normalizedWebhookUrl)) {
      throw new Error("Please enter a valid Discord webhook URL");
    }

    if (normalizedMonitoredWallet && !/^0x[a-fA-F0-9]{40}$/.test(normalizedMonitoredWallet)) {
      throw new Error("Please enter a valid public Polymarket wallet");
    }

    if (normalizedTradingWalletAddress && !/^0x[a-fA-F0-9]{40}$/.test(normalizedTradingWalletAddress)) {
      throw new Error("Please enter a valid trading wallet address");
    }

    if (!Number.isFinite(updates.startingBalanceUsd) || updates.startingBalanceUsd <= 0) {
      throw new Error("Starting balance must be greater than 0");
    }

    if (!Number.isFinite(updates.riskPercent) || updates.riskPercent <= 0 || updates.riskPercent > 100) {
      throw new Error("Risk percent must be between 0 and 100");
    }

    const signatureType = updates.tradingSignatureType === "POLY_PROXY" ? "POLY_PROXY" : "EOA";
    const hasNewTradingSecrets = Boolean(
      normalizedPrivateKey || normalizedApiKey || normalizedApiSecret || normalizedApiPassphrase,
    );

    if (
      hasNewTradingSecrets &&
      (!normalizedPrivateKey || !normalizedApiKey || !normalizedApiSecret || !normalizedApiPassphrase)
    ) {
      throw new Error("Private key, API key, API secret, and API passphrase are all required together");
    }

    if (normalizedPrivateKey && !isLikelyPrivateKey(normalizedPrivateKey)) {
      throw new Error("Please enter a valid private key");
    }

    const existingSettings = await this.storage.getUserSettings(normalizedUsername);
    await this.storage.updateUserSettings(normalizedUsername, {
      webhookUrl: normalizedWebhookUrl,
      monitoredWallet: normalizedMonitoredWallet,
      autoTradeEnabled: updates.paperTradingEnabled,
      startingBalanceUsd: updates.startingBalanceUsd,
      currentBalanceUsd:
        existingSettings.currentBalanceUsd == null
          ? updates.startingBalanceUsd
          : Math.max(0, existingSettings.currentBalanceUsd),
      riskPercent: updates.riskPercent,
      tradingWalletAddress: normalizedTradingWalletAddress,
      tradingSignatureType: signatureType,
      ...(hasNewTradingSecrets
        ? {
            encryptedPrivateKey: encryptSecret(normalizedPrivateKey, config.tradingEncryptionSecret),
            encryptedApiKey: encryptSecret(normalizedApiKey, config.tradingEncryptionSecret),
            encryptedApiSecret: encryptSecret(normalizedApiSecret, config.tradingEncryptionSecret),
            encryptedApiPassphrase: encryptSecret(
              normalizedApiPassphrase,
              config.tradingEncryptionSecret,
            ),
          }
        : {}),
      clearTradingCredentials: updates.clearTradingCredentials,
    });
    await this.syncTrackedWalletWatchesForUser(normalizedUsername, normalizedMonitoredWallet);
    this.scheduleStrategyReconcileForUser(normalizedUsername);
    return this.getUserProfile(normalizedUsername);
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

    const price = Number(message.price);
    const size = Number(message.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price * size < 8_000) {
      return;
    }

    this.lastTradeAt = Date.now();
    const seenAt = Date.now();
    this.lastWebsocketMessageAt = seenAt;
    this.websocketAssetSeenAt.set(message.asset_id, seenAt);
    this.scheduleMarketTradeFetch(message);
  }

  private startTradePolling(): void {
    this.runBackgroundTask("initial fallback trade poll", this.pollRecentTrades());
    this.tradePollTimer = setInterval(() => {
      this.runBackgroundTask("fallback trade poll", this.pollRecentTrades());
    }, config.tradePollMs);
  }

  private async pollRecentTrades(): Promise<void> {
    if (
      this.lastWebsocketMessageAt &&
      Date.now() - this.lastWebsocketMessageAt < Math.max(config.tradePollMs * 4, 15_000)
    ) {
      return;
    }

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
      await this.persistAndIngestTrade(trade);
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
      await this.persistAndIngestTrade(trade);
    }
  }

  private async backfillHistoricalSignals(): Promise<void> {
    if (!config.historicalFetchEnabled || !config.startupHistoricalBackfillEnabled) {
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
    if (!config.historicalFetchEnabled || !config.marketHistoryCatchupEnabled) {
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
    if (!config.historicalFetchEnabled || !config.traderHistoryCatchupEnabled) {
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

  private scheduleMarketTradeFetch(message: MarketTradeMessage): void {
    const marketConditionId = String(message.market || "").trim();
    const assetId = String(message.asset_id || "").trim();
    const timestampMs = Number(message.timestamp);
    const timestampSec = Math.floor(timestampMs / 1000);
    if (!marketConditionId || !assetId || !Number.isFinite(timestampSec)) {
      return;
    }

    const nextRequest: PendingMarketTradeFetch = {
      marketConditionId,
      assetId,
      timestampSec,
    };
    const lastFetchAt = this.lastMarketTradeFetchAt.get(marketConditionId) ?? 0;
    if (
      Date.now() - lastFetchAt < 10_000 ||
      this.marketTradeFetchInFlight.has(marketConditionId) ||
      this.activeMarketTradeFetchCount >= config.marketTradeFetchConcurrency
    ) {
      this.queueMarketTradeFetch(nextRequest);
      return;
    }

    this.startMarketTradeFetch(nextRequest);
  }

  private queueMarketTradeFetch(request: PendingMarketTradeFetch): void {
    const existing = this.queuedMarketTradeFetches.get(request.marketConditionId);
    if (!existing || request.timestampSec >= existing.timestampSec) {
      this.queuedMarketTradeFetches.set(request.marketConditionId, request);
    }

    this.scheduleMarketTradeFetchDrain();
  }

  private startMarketTradeFetch(request: PendingMarketTradeFetch): void {
    this.lastMarketTradeFetchAt.set(request.marketConditionId, Date.now());
    this.activeMarketTradeFetchCount += 1;

    const task = this.fetchRecentTradesForMarket(
      request.marketConditionId,
      request.assetId,
      request.timestampSec,
    )
      .catch((error) => {
        logFetchFailure(`market trade recovery ${request.marketConditionId}`, error);
      })
      .finally(() => {
        this.marketTradeFetchInFlight.delete(request.marketConditionId);
        this.activeMarketTradeFetchCount = Math.max(0, this.activeMarketTradeFetchCount - 1);
        this.scheduleMarketTradeFetchDrain();
      });

    this.marketTradeFetchInFlight.set(request.marketConditionId, task);
  }

  private scheduleMarketTradeFetchDrain(): void {
    if (this.marketTradeFetchDrainTimer) {
      clearTimeout(this.marketTradeFetchDrainTimer);
      this.marketTradeFetchDrainTimer = null;
    }

    if (this.queuedMarketTradeFetches.size === 0) {
      return;
    }

    const now = Date.now();
    let nextDelayMs = 10_000;

    for (const marketConditionId of this.queuedMarketTradeFetches.keys()) {
      const lastFetchAt = this.lastMarketTradeFetchAt.get(marketConditionId) ?? 0;
      const delayMs = Math.max(0, 10_000 - (now - lastFetchAt));
      nextDelayMs = Math.min(nextDelayMs, delayMs);
    }

    this.marketTradeFetchDrainTimer = setTimeout(() => {
      this.marketTradeFetchDrainTimer = null;
      this.drainMarketTradeFetchQueue();
    }, nextDelayMs);
  }

  private drainMarketTradeFetchQueue(): void {
    if (this.activeMarketTradeFetchCount >= config.marketTradeFetchConcurrency) {
      this.scheduleMarketTradeFetchDrain();
      return;
    }

    const now = Date.now();
    const queuedRequests = Array.from(this.queuedMarketTradeFetches.values()).sort(
      (left, right) => right.timestampSec - left.timestampSec,
    );

    for (const request of queuedRequests) {
      if (this.activeMarketTradeFetchCount >= config.marketTradeFetchConcurrency) {
        break;
      }

      if (this.marketTradeFetchInFlight.has(request.marketConditionId)) {
        continue;
      }

      const lastFetchAt = this.lastMarketTradeFetchAt.get(request.marketConditionId) ?? 0;
      if (now - lastFetchAt < 10_000) {
        continue;
      }

      this.queuedMarketTradeFetches.delete(request.marketConditionId);
      this.startMarketTradeFetch(request);
    }

    if (this.queuedMarketTradeFetches.size > 0) {
      this.scheduleMarketTradeFetchDrain();
    }
  }

  private async fetchRecentTradesForMarket(
    marketConditionId: string,
    assetId: string,
    timestampSec: number,
  ): Promise<void> {
    const url = new URL(`${DATA_API_URL}/trades`);
    url.searchParams.set("market", marketConditionId);
    url.searchParams.set("limit", "200");

    const response = await this.safeFetch(url, `market trades ${marketConditionId}`);
    if (!response || !response.ok) {
      return;
    }

    const payload = (await response.json()) as TradeRecord[];
    const trades = dedupeTrades(payload)
      .filter((trade) => trade.asset === assetId)
      .filter((trade) => trade.timestamp >= timestampSec - Math.ceil(config.tradeWindowMs / 1000))
      .sort((left, right) => left.timestamp - right.timestamp);

    for (const trade of trades) {
      await this.persistAndIngestTrade(trade);
    }
  }

  private async persistAndIngestTrade(trade: TradeRecord): Promise<void> {
    const tradeId = getTradeId(trade);
    await this.storage.saveObservedTrade({
      ...trade,
      tradeId,
      createdAt: new Date(),
    });
    if (await this.storage.hasProcessedTrade(tradeId)) {
      return;
    }

    const result = await this.ingestTrade(trade);
    if (result === "ingested") {
      await this.markTradeProcessed(trade);
    }
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
    await this.refreshMarketAggregate(accumulator.market.slug);
      const autoTradeUsers = await this.storage.loadAutoTradeUsers();
      for (const user of autoTradeUsers) {
        await this.reconcileStrategyPosition(accumulator.market.slug, user);
      }

    if (config.marketHistoryCatchupEnabled && this.initialActiveConditionIds.has(accumulator.market.conditionId)) {
      this.runBackgroundTask(
        `market catch-up ${accumulator.market.slug}`,
        this.backfillMarketHistory(accumulator.market),
      );
    }

    if (trader.tier === "whale" || trader.tier === "shark") {
      this.runBackgroundTask(`trader catch-up ${trader.wallet}`, this.backfillTraderHistory(trader));
    }

    if (!wasAlreadyEmitted && styledSignal.side === "SELL") {
      this.runBackgroundTask(
        `sell alert ${styledSignal.marketSlug}`,
        this.sendSellSignalAlerts(styledSignal),
      );
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
    if (cached && Date.now() - cached.fetchedAt < TRADER_MEMORY_CACHE_TTL_MS) {
      return cached.summary;
    }

    const persisted = await this.storage.loadTraderSummary(wallet);
    if (persisted && Date.now() - persisted.updatedAt < TRADER_DB_CACHE_TTL_MS) {
      const summary = {
        ...persisted.summary,
        displayName: persisted.summary.displayName || fallbackName || wallet,
        profileImage: persisted.summary.profileImage ?? fallbackProfileImage,
      };
      this.traderCache.set(wallet, { summary, fetchedAt: Date.now() });
      return summary;
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
    await this.storage.saveTraderSummary(summary);
    if (summary.tier !== "none") {
      await this.storage.upsertTrackedTrader(summary);
    }
    return summary;
  }

  private async pollTrackedTrader(trader: PersistedTrackedTrader): Promise<void> {
    let latestSeenTimestamp = trader.lastSeenActivityTimestamp ?? 0;
    const batchSize = 50;

    for (let offset = 0; offset <= 200; offset += batchSize) {
      const response = await this.safeFetch(
        `${DATA_API_URL}/activity?user=${trader.wallet}&limit=${batchSize}&offset=${offset}`,
        `tracked trader ${trader.wallet}`,
      );
      if (!response || !response.ok) {
        break;
      }

      const rows = (await response.json()) as RawActivity[] | { error?: string };
      if (!Array.isArray(rows) || rows.length === 0) {
        break;
      }

      let reachedKnownActivity = false;
      for (const row of rows) {
        const timestamp = Number(row.timestamp ?? 0);
        if (Number.isFinite(timestamp) && timestamp > latestSeenTimestamp) {
          latestSeenTimestamp = timestamp;
        }

        if (!Number.isFinite(timestamp) || timestamp <= (trader.lastSeenActivityTimestamp ?? 0)) {
          reachedKnownActivity = true;
          continue;
        }

        if (row.type !== "TRADE") {
          continue;
        }

        const trade = this.toTradeRecord(row);
        if (!trade || !this.activeAssetIds.has(trade.asset)) {
          continue;
        }

        await this.persistAndIngestTrade(trade);
      }

      if (rows.length < batchSize || reachedKnownActivity) {
        break;
      }
    }

    await this.storage.updateTrackedTraderPollState(trader.wallet, latestSeenTimestamp);
  }

  private async refreshMarketAggregates(): Promise<void> {
    const activeMarketSlugs = Array.from(
      new Set(Array.from(this.marketsByAssetId.values(), (market) => market.slug)),
    );
    const signals = (await this.storage.loadSignalsForMarketSlugs(activeMarketSlugs)).map(applySignalLabelStyle);
    const activeSignals = resolveActiveBuySignals(signals);
    const aggregates = aggregateMarkets(activeSignals);
    const aggregateBySlug = new Map(aggregates.map((aggregate) => [aggregate.marketSlug, aggregate] as const));

    for (const marketSlug of activeMarketSlugs) {
      const aggregate = aggregateBySlug.get(marketSlug);
      if (aggregate) {
        await this.storage.saveMarketAggregate(aggregate);
      } else {
        await this.storage.deleteMarketAggregate(marketSlug);
      }
    }
  }

  private async refreshMarketAggregate(marketSlug: string): Promise<void> {
    const signals = (await this.storage.loadSignalsForMarketSlugs([marketSlug])).map(applySignalLabelStyle);
    const activeSignals = resolveActiveBuySignals(signals);
    const aggregate = aggregateMarkets(activeSignals)[0];

    if (aggregate) {
      await this.storage.saveMarketAggregate(aggregate);
      return;
    }

    await this.storage.deleteMarketAggregate(marketSlug);
  }

  private async reconcileAllStrategyPositions(): Promise<void> {
    const activeMarketSlugs = Array.from(
      new Set(Array.from(this.marketsByAssetId.values(), (market) => market.slug)),
    );
    const autoTradeUsers = await this.storage.loadAutoTradeUsers();

    for (const marketSlug of activeMarketSlugs) {
      for (const user of autoTradeUsers) {
        await this.reconcileStrategyPosition(marketSlug, user);
      }
    }
  }

  private scheduleStrategyReconcileForUser(username: string): void {
    const normalizedUsername = username.trim();
    if (!normalizedUsername || this.strategyUserReconcilesInFlight.has(normalizedUsername)) {
      return;
    }

    this.strategyUserReconcilesInFlight.add(normalizedUsername);
    this.runBackgroundTask(
      `strategy reconcile ${normalizedUsername}`,
      this.reconcileStrategyPositionsForUser(normalizedUsername).finally(() => {
        this.strategyUserReconcilesInFlight.delete(normalizedUsername);
      }),
    );
  }

  private async reconcileStrategyPositionsForUser(username: string): Promise<void> {
    const activeMarketSlugs = Array.from(
      new Set(Array.from(this.marketsByAssetId.values(), (market) => market.slug)),
    );
    const autoTradeUser = (await this.storage.loadAutoTradeUsers()).find((user) => user.username === username);
    if (!autoTradeUser) {
      return;
    }

    for (const marketSlug of activeMarketSlugs) {
      await this.reconcileStrategyPosition(marketSlug, autoTradeUser);
    }
  }

  private async reconcileStrategyPosition(
    marketSlug: string,
    user: { username: string; currentBalanceUsd: number; riskPercent: number },
  ): Promise<void> {
    const aggregate = (await this.storage.loadMarketAggregates([marketSlug]))[0];
    if (!aggregate) {
      return;
    }

    const edgeOutcome = aggregate.outcomeWeights[0]?.outcome ?? aggregate.latestSignal.outcome;
    const setupQuality = getSetupQualityScore(aggregate);
    const currentPrice = aggregate.latestSignal.averagePrice;
    const currentParticipants =
      aggregate.outcomeParticipants?.filter((participant) => participant.outcome === edgeOutcome) ?? [];
    const currentWeightByWallet = new Map(
      currentParticipants.map((participant) => [participant.wallet, participant.weight] as const),
    );
    const position = await this.storage.loadOpenStrategyPosition(user.username, marketSlug, edgeOutcome);

    if (!position) {
      if (!isBestTradeMarket(aggregate)) {
        return;
      }

      const originalParticipants = currentParticipants.map((participant) => ({
        wallet: participant.wallet,
        weight: participant.weight,
        tier: participant.tier,
      }));
      const originalSmartMoneyWeight = originalParticipants.reduce(
        (sum, participant) => sum + participant.weight,
        0,
      );
      if (originalSmartMoneyWeight <= 0) {
        return;
      }

      const entryNotionalUsd = Math.max(
        0,
        Math.min(user.currentBalanceUsd, user.currentBalanceUsd * (Math.max(0, user.riskPercent) / 100)),
      );
      if (entryNotionalUsd <= 0 || currentPrice <= 0) {
        return;
      }

      const nextPosition: StrategyPosition = {
        id: `${user.username}:${marketSlug}:${edgeOutcome}`,
        username: user.username,
        marketSlug,
        marketQuestion: aggregate.marketQuestion,
        marketUrl: aggregate.marketUrl,
        marketImage: aggregate.marketImage,
        outcome: edgeOutcome,
        status: "open",
        openedAt: Date.now(),
        updatedAt: Date.now(),
        entryPrice: currentPrice,
        lastPrice: currentPrice,
        entryNotionalUsd,
        remainingShares: entryNotionalUsd / currentPrice,
        realizedUsd: 0,
        originalSmartMoneyWeight,
        remainingSmartMoneyWeight: originalSmartMoneyWeight,
        soldPercent: 0,
        trim90Hit: false,
        trim93Hit: false,
        setupQuality,
        originalParticipants,
      };
      await this.storage.saveStrategyPosition(nextPosition);
      await this.storage.updateUserSettings(user.username, {
        currentBalanceUsd: Math.max(0, user.currentBalanceUsd - entryNotionalUsd),
      });
      return;
    }

    const remainingSmartMoneyWeight = position.originalParticipants.reduce(
      (sum, participant) => sum + (currentWeightByWallet.get(participant.wallet) ?? 0),
      0,
    );
    const exitedWeight = Math.max(0, position.originalSmartMoneyWeight - remainingSmartMoneyWeight);
    const exitedRatio =
      position.originalSmartMoneyWeight > 0 ? exitedWeight / position.originalSmartMoneyWeight : 0;
    const qualifiesIgnoringPriceCap = isBestTradeMarket(aggregate, { ignorePriceCap: true });

    let nextPosition: StrategyPosition = {
      ...position,
      updatedAt: Date.now(),
      lastPrice: currentPrice,
      remainingSmartMoneyWeight,
      setupQuality,
    };

    if (!nextPosition.trim90Hit && currentPrice >= 0.9) {
      const sharesToSell = position.remainingShares * 0.5;
      const realizedUsd = sharesToSell * currentPrice;
      nextPosition = {
        ...nextPosition,
        remainingShares: Math.max(0, nextPosition.remainingShares - sharesToSell),
        realizedUsd: nextPosition.realizedUsd + realizedUsd,
        soldPercent: Math.max(nextPosition.soldPercent, 25),
        trim90Hit: true,
      };
      await this.storage.updateUserSettings(user.username, {
        currentBalanceUsd: user.currentBalanceUsd + realizedUsd,
      });
      user.currentBalanceUsd += realizedUsd;
    }

    if (!nextPosition.trim93Hit && currentPrice >= 0.93) {
      const sharesToSell = nextPosition.remainingShares / 3;
      const realizedUsd = sharesToSell * currentPrice;
      nextPosition = {
        ...nextPosition,
        remainingShares: Math.max(0, nextPosition.remainingShares - sharesToSell),
        realizedUsd: nextPosition.realizedUsd + realizedUsd,
        soldPercent: Math.max(nextPosition.soldPercent, 50),
        trim93Hit: true,
      };
      await this.storage.updateUserSettings(user.username, {
        currentBalanceUsd: user.currentBalanceUsd + realizedUsd,
      });
      user.currentBalanceUsd += realizedUsd;
    }

    let exitReason: string | undefined;
    if (!qualifiesIgnoringPriceCap) {
      exitReason = "Thesis break";
    } else if (currentPrice >= 0.995) {
      exitReason = "Take profit 0.995";
    } else if (exitedRatio >= 0.5) {
      exitReason = "50% smart-money weight exited";
    }

    if (exitReason) {
      const realizedUsd = nextPosition.remainingShares * currentPrice;
      nextPosition = {
        ...nextPosition,
        status: "closed",
        remainingShares: 0,
        realizedUsd: nextPosition.realizedUsd + realizedUsd,
        soldPercent: 100,
        exitReason,
      };
      await this.storage.updateUserSettings(user.username, {
        currentBalanceUsd: user.currentBalanceUsd + realizedUsd,
      });
    }

    await this.storage.saveStrategyPosition(nextPosition);
  }

  private async drainTrackedTraderPollQueue(): Promise<void> {
    if (this.trackedTraderPollInFlight.size >= config.trackedTraderPollConcurrency) {
      return;
    }

    const trackedTraders = await this.storage.loadTrackedTraders(
      config.trackedTraderPollConcurrency * 4,
    );

    let started = 0;
    for (const trader of trackedTraders) {
      if (this.trackedTraderPollInFlight.size >= config.trackedTraderPollConcurrency) {
        break;
      }

      if (this.trackedTraderPollInFlight.has(trader.wallet)) {
        continue;
      }

      started += 1;
      this.trackedTraderPollInFlight.add(trader.wallet);
      this.runBackgroundTask(`tracked trader ${trader.wallet}`, this.runTrackedTraderPoll(trader));
    }

    if (started === 0 && this.trackedTraderPollInFlight.size === 0) {
      this.scheduleTrackedTraderPollDrain(5_000);
    }
  }

  private async runTrackedTraderPoll(trader: PersistedTrackedTrader): Promise<void> {
    try {
      await this.pollTrackedTrader(trader);
    } finally {
      this.trackedTraderPollInFlight.delete(trader.wallet);
      this.scheduleTrackedTraderPollDrain(0);
    }
  }

  private scheduleTrackedTraderPollDrain(delayMs: number): void {
    if (this.trackedTraderPollDrainTimer) {
      clearTimeout(this.trackedTraderPollDrainTimer);
    }

    this.trackedTraderPollDrainTimer = setTimeout(() => {
      this.trackedTraderPollDrainTimer = null;
      this.runBackgroundTask("tracked trader drain", this.drainTrackedTraderPollQueue());
    }, delayMs);
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
    const endpoint = this.getRequestMetricKey(input);
    try {
      const response = await fetch(input, {
        dispatcher: this.fetchDispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
      });
      this.recordRequestMetric(endpoint, response.ok);
      return response;
    } catch (error) {
      this.recordRequestMetric(endpoint, false);
      logFetchFailure(context, error);
      return null;
    }
  }

  private getRequestMetricKey(input: string | URL): string {
    const raw = typeof input === "string" ? input : input.toString();

    try {
      const url = new URL(raw);
      if (url.hostname.includes("gamma-api.polymarket.com")) {
        return "gamma_markets";
      }

      if (!url.hostname.includes("polymarket.com")) {
        return `${url.hostname}${url.pathname}`;
      }

      if (url.pathname === "/markets") {
        return "gamma_markets";
      }

      if (url.pathname === "/trades") {
        return url.searchParams.has("market") ? "market_trades" : "global_trades";
      }

      if (url.pathname === "/activity") {
        return "activity";
      }

      if (url.pathname === "/positions") {
        return "positions";
      }

      if (url.pathname === "/closed-positions") {
        return "closed_positions";
      }

      if (url.pathname === "/value") {
        return "value";
      }

      return `${url.hostname}${url.pathname}`;
    } catch {
      return "unknown";
    }
  }

  private recordRequestMetric(endpoint: string, wasSuccessful: boolean): void {
    const now = Date.now();
    const metric = this.requestMetrics.get(endpoint) ?? {
      total: 0,
      success: 0,
      failure: 0,
      recentTimestamps: [],
    };

    metric.total += 1;
    if (wasSuccessful) {
      metric.success += 1;
    } else {
      metric.failure += 1;
    }
    metric.recentTimestamps.push(now);
    metric.recentTimestamps = metric.recentTimestamps.filter(
      (timestamp) => now - timestamp <= REQUEST_STATS_WINDOW_MS,
    );

    this.requestMetrics.set(endpoint, metric);
  }

  private getRequestStats(): AppSnapshot["status"]["requestStats"] {
    const now = Date.now();
    const endpoints = Array.from(this.requestMetrics.entries())
      .map(([endpoint, metric]) => {
        const recent = metric.recentTimestamps.filter(
          (timestamp) => now - timestamp <= REQUEST_STATS_WINDOW_MS,
        );
        metric.recentTimestamps = recent;
        return {
          endpoint,
          total: metric.total,
          success: metric.success,
          failure: metric.failure,
          recent: recent.length,
        };
      })
      .sort((left, right) => right.recent - left.recent || right.total - left.total);

    return {
      windowMinutes: REQUEST_STATS_WINDOW_MS / 60_000,
      endpoints,
    };
  }

  private runBackgroundTask(context: string, task: Promise<unknown>): void {
    void task.catch((error) => {
      logFetchFailure(context, error);
    });
  }

  private async sendSellSignalAlerts(signal: WhaleSignal): Promise<void> {
    const watchers = await this.storage.loadWatchersForMarket(signal.marketSlug, signal.outcome);
    if (watchers.length === 0) {
      return;
    }

    for (const watcher of watchers) {
      const shouldSend = await this.storage.markAlertDelivered(
        watcher.username,
        signal.marketSlug,
        signal.outcome,
        signal.id,
      );
      if (!shouldSend) {
        continue;
      }

      const payload = {
        content: [
          `Sell signal for **${signal.marketQuestion}**`,
          `${signal.label} by **${signal.displayName}** on **${signal.outcome}**`,
          `Flow: ${formatUsd(signal.totalUsd)} across ${signal.fillCount} fills at avg ${signal.averagePrice.toFixed(3)}`,
          `Market: ${signal.marketUrl}`,
          `Trader: ${signal.profileUrl}`,
        ].join("\n"),
      };

      try {
        const response = await fetch(watcher.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`Discord webhook returned ${response.status}`);
        }
      } catch (error) {
        logFetchFailure(`discord webhook ${watcher.username} ${signal.marketSlug}`, error);
      }
    }
  }

  private async syncTrackedWalletWatches(): Promise<void> {
    const users = await this.storage.loadUsersWithMonitoredWallets();
    for (const user of users) {
      await this.syncTrackedWalletWatchesForUser(user.username, user.monitoredWallet);
    }
  }

  private async syncTrackedWalletWatchesForUser(username: string, monitoredWallet: string): Promise<void> {
    const normalizedWallet = monitoredWallet.trim();
    if (!normalizedWallet) {
      await this.storage.syncPortfolioWatches(username, []);
      return;
    }

    const response = await this.safeFetch(
      `${DATA_API_URL}/positions?user=${normalizedWallet}&sizeThreshold=.1`,
      `portfolio sync ${username}`,
    );
    if (!response || !response.ok) {
      return;
    }

    const positions = ((await response.json()) as RawPosition[]) ?? [];
    const activeMarketSlugs = new Set(Array.from(this.marketsByAssetId.values(), (market) => market.slug));
    const watches = positions
      .map((position) => this.toPortfolioWatch(position))
      .filter((watch): watch is { marketSlug: string; outcome: string } => Boolean(watch))
      .filter((watch) => activeMarketSlugs.has(watch.marketSlug));

    const deduped = Array.from(
      new Map(watches.map((watch) => [`${watch.marketSlug}:${watch.outcome}`, watch])).values(),
    );

    await this.storage.syncPortfolioWatches(username, deduped);
  }

  private toPortfolioWatch(position: RawPosition): { marketSlug: string; outcome: string } | null {
    const marketSlug = String(position.slug || "").trim();
    const outcome = String(position.outcome || "").trim();
    const size = Number(position.size ?? 0);

    if (!marketSlug || !outcome || !Number.isFinite(size) || size <= 0) {
      return null;
    }

    return { marketSlug, outcome };
  }
}

const aggregateMarkets = (signals: WhaleSignal[]): MarketAggregate[] => {
  const markets = new Map<string, MarketAggregate>();
  const traderSpendByMarket = new Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>();
  const outcomeTotalsByMarket = new Map<string, Map<string, { totalUsd: number; totalShares: number }>>();
  const traderOutcomeSpendByMarket = new Map<
    string,
    Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>
  >();

  for (const signal of signals) {
    const existing = markets.get(signal.marketSlug);
    if (!existing) {
      markets.set(signal.marketSlug, {
        marketSlug: signal.marketSlug,
        marketQuestion: signal.marketQuestion,
        marketUrl: signal.marketUrl,
        marketImage: signal.marketImage,
        latestTimestamp: signal.timestamp,
        totalUsd: signal.totalUsd,
        totalFillCount: signal.fillCount,
        whales: 0,
        sharks: 0,
        pros: 0,
        weightedScore: 0,
        outcomeWeights: [],
        observedAvgEntry: null,
        participantCount: 0,
        isWatched: false,
        latestSignal: signal,
      });
    } else {
      existing.totalUsd += signal.totalUsd;
      existing.totalFillCount += signal.fillCount;
      if (signal.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = signal.timestamp;
        existing.latestSignal = signal;
      }
    }

    const marketTraders =
      traderSpendByMarket.get(signal.marketSlug) ?? new Map<string, { totalUsd: number; trader: TraderSummary }>();
    const traderEntry = marketTraders.get(signal.wallet);
    if (traderEntry) {
      traderEntry.totalUsd += signal.totalUsd;
      if (signal.trader.weight > traderEntry.trader.weight) {
        traderEntry.trader = signal.trader;
      }
    } else {
      marketTraders.set(signal.wallet, { totalUsd: signal.totalUsd, trader: signal.trader });
    }
    traderSpendByMarket.set(signal.marketSlug, marketTraders);

    const marketOutcomeTotals =
      outcomeTotalsByMarket.get(signal.marketSlug) ?? new Map<string, { totalUsd: number; totalShares: number }>();
    const outcomeTotals = marketOutcomeTotals.get(signal.outcome) ?? { totalUsd: 0, totalShares: 0 };
    outcomeTotals.totalUsd += signal.totalUsd;
    outcomeTotals.totalShares += signal.totalShares;
    marketOutcomeTotals.set(signal.outcome, outcomeTotals);
    outcomeTotalsByMarket.set(signal.marketSlug, marketOutcomeTotals);

    const marketOutcomeTraders =
      traderOutcomeSpendByMarket.get(signal.marketSlug) ??
      new Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>();
    const traderOutcomes =
      marketOutcomeTraders.get(signal.wallet) ??
      new Map<string, { totalUsd: number; trader: TraderSummary }>();
    const outcomeEntry = traderOutcomes.get(signal.outcome);
    if (outcomeEntry) {
      outcomeEntry.totalUsd += signal.totalUsd;
      if (signal.trader.weight > outcomeEntry.trader.weight) {
        outcomeEntry.trader = signal.trader;
      }
    } else {
      traderOutcomes.set(signal.outcome, { totalUsd: signal.totalUsd, trader: signal.trader });
    }
    marketOutcomeTraders.set(signal.wallet, traderOutcomes);
    traderOutcomeSpendByMarket.set(signal.marketSlug, marketOutcomeTraders);
  }

  for (const [marketSlug, aggregate] of markets) {
    const traders = traderSpendByMarket.get(marketSlug);
    const outcomeTotals = outcomeTotalsByMarket.get(marketSlug);
    const outcomeTraders = traderOutcomeSpendByMarket.get(marketSlug);
    if (!traders) {
      continue;
    }

    let whales = 0;
    let sharks = 0;
    let pros = 0;
    let weightedScore = 0;
    let participantCount = 0;
    const outcomeWeights = new Map<string, number>();

    for (const { totalUsd, trader } of traders.values()) {
      if (totalUsd < 1_000 || trader.tier === "none") {
        continue;
      }

      participantCount += 1;
      weightedScore += trader.weight;
      if (trader.tier === "whale") {
        whales += 1;
      } else if (trader.tier === "shark") {
        sharks += 1;
      } else if (trader.tier === "pro") {
        pros += 1;
      }
    }

    if (outcomeTraders) {
      for (const traderOutcomes of outcomeTraders.values()) {
        let leadingOutcome: string | null = null;
        let leadingUsd = 0;
        let leadingWeight = 0;

        for (const [outcome, { totalUsd, trader }] of traderOutcomes.entries()) {
          if (totalUsd < 1_000 || trader.tier === "none") {
            continue;
          }

          if (totalUsd > leadingUsd) {
            leadingOutcome = outcome;
            leadingUsd = totalUsd;
            leadingWeight = trader.weight;
          }
        }

        if (leadingOutcome) {
          outcomeWeights.set(leadingOutcome, (outcomeWeights.get(leadingOutcome) ?? 0) + leadingWeight);
        }
      }
    }

    aggregate.whales = whales;
    aggregate.sharks = sharks;
    aggregate.pros = pros;
    aggregate.weightedScore = weightedScore;
    aggregate.outcomeWeights = Array.from(outcomeWeights.entries())
      .map(([outcome, weight]) => ({ outcome, weight }))
      .sort((left, right) => right.weight - left.weight);
    aggregate.outcomeParticipants = Array.from(outcomeTraders?.entries() ?? [])
      .flatMap(([wallet, traderOutcomes]) =>
        Array.from(traderOutcomes.entries()).flatMap(([outcome, { totalUsd, trader }]) => {
          if (totalUsd < 1_000 || trader.tier === "none") {
            return [];
          }

          return [
            {
              wallet,
              outcome,
              weight: trader.weight,
              tier: trader.tier,
              totalUsd,
            },
          ];
        }),
      )
      .sort((left, right) => right.weight - left.weight || right.totalUsd - left.totalUsd);
    const leadingOutcome = aggregate.outcomeWeights[0]?.outcome;
    const leadingOutcomeTotals = leadingOutcome ? outcomeTotals?.get(leadingOutcome) : undefined;
    aggregate.observedAvgEntry =
      leadingOutcomeTotals && leadingOutcomeTotals.totalShares > 0
        ? leadingOutcomeTotals.totalUsd / leadingOutcomeTotals.totalShares
        : null;
    aggregate.participantCount = participantCount;
  }

  return Array.from(markets.values());
};

const applyWatchState = (
  markets: MarketAggregate[],
  watchedOutcomesByMarket: Map<string, Set<string>>,
): MarketAggregate[] =>
  markets.map((market) => ({
    ...market,
    isWatched: Boolean(
      getMarketWatchOutcome(market) &&
        watchedOutcomesByMarket.get(market.marketSlug)?.has(getMarketWatchOutcome(market)!),
    ),
  }));

const sortMarkets = (markets: MarketAggregate[], sort: MarketSortOption): MarketAggregate[] => {
  const sorted = [...markets];

  sorted.sort((left, right) => {
    if (sort === "weighted") {
      return (
        right.weightedScore - left.weightedScore ||
        (right.outcomeWeights[0]?.weight ?? 0) - (left.outcomeWeights[0]?.weight ?? 0) ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    if (sort === "buyWeight") {
      return (
        (right.outcomeWeights[0]?.weight ?? 0) - (left.outcomeWeights[0]?.weight ?? 0) ||
        right.weightedScore - left.weightedScore ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    if (sort === "flow") {
      return (
        right.totalUsd - left.totalUsd ||
        right.weightedScore - left.weightedScore ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    if (sort === "participants") {
      return (
        right.participantCount - left.participantCount ||
        right.weightedScore - left.weightedScore ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    return right.latestTimestamp - left.latestTimestamp;
  });

  return sorted;
};

const resolveActiveBuySignals = (signals: WhaleSignal[]): WhaleSignal[] => {
  const orderedSignals = [...signals].sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }

    return left.id.localeCompare(right.id);
  });
  const activeSignalsByPosition = new Map<string, WhaleSignal[]>();

  for (const signal of orderedSignals) {
    const positionKey = `${signal.wallet}:${signal.marketSlug}:${signal.outcome}`;

    if (signal.side === "SELL") {
      activeSignalsByPosition.delete(positionKey);
      continue;
    }

    const currentSignals = activeSignalsByPosition.get(positionKey) ?? [];
    currentSignals.push(signal);
    activeSignalsByPosition.set(positionKey, currentSignals);
  }

  return Array.from(activeSignalsByPosition.values())
    .flat()
    .sort((left, right) => right.timestamp - left.timestamp);
};

const filterMarkets = (markets: MarketAggregate[], query: string): MarketAggregate[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return markets;
  }

  return markets.filter((market) => {
    const haystack = [
      market.marketQuestion,
      market.marketSlug,
      market.latestSignal.displayName,
      market.latestSignal.outcome,
      ...market.outcomeWeights.map((entry) => entry.outcome),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
};

const applyViewFilter = (
  markets: MarketAggregate[],
  view: "monitor" | "best",
): MarketAggregate[] => {
  if (view !== "best") {
    return markets;
  }

  return markets.filter((market) => isBestTradeMarket(market));
};

const isBestTradeMarket = (
  market: MarketAggregate,
  options?: { ignorePriceCap?: boolean },
): boolean => {
  const leadingOutcomeWeight = market.outcomeWeights[0]?.weight ?? 0;
  if (market.weightedScore < 70) {
    return false;
  }

  if (leadingOutcomeWeight < market.weightedScore * 0.7) {
    return false;
  }

  if (market.participantCount < 3) {
    return false;
  }

  if (Date.now() - market.latestTimestamp > 24 * 60 * 60_000) {
    return false;
  }

  if (market.observedAvgEntry === null || market.observedAvgEntry <= 0) {
    return false;
  }

  const currentDisplayedPrice = market.latestSignal.averagePrice;
  if (!options?.ignorePriceCap && currentDisplayedPrice >= 0.9) {
    return false;
  }

  const priceDeviation = Math.abs(currentDisplayedPrice - market.observedAvgEntry) / market.observedAvgEntry;
  return priceDeviation <= 0.05;
};

const getSetupQualityScore = (market: MarketAggregate): number => {
  const totalWeight = Math.max(0, market.weightedScore);
  const leadingWeight = Math.max(0, market.outcomeWeights[0]?.weight ?? 0);
  const dominanceRatio = totalWeight > 0 ? leadingWeight / totalWeight : 0;
  const participantCount = Math.max(0, market.participantCount);
  const lastPrice = market.latestSignal.averagePrice;
  const avgEntry = market.observedAvgEntry;
  const ageMinutes = Math.max(0, (Date.now() - market.latestTimestamp) / 60_000);

  const weightScore = Math.min(100, (totalWeight / 120) * 100);
  const dominanceScore = Math.max(0, Math.min(100, ((dominanceRatio - 0.5) / 0.5) * 100));
  const participantScore = Math.min(100, (participantCount / 10) * 100);
  const proximityScore =
    avgEntry && avgEntry > 0
      ? Math.max(0, 100 - (Math.abs(lastPrice - avgEntry) / avgEntry) * 2000)
      : 0;
  const freshnessScore = Math.max(0, 100 - ageMinutes / 14.4);
  const priceScore = lastPrice < 0.9 ? Math.max(0, Math.min(100, ((0.9 - lastPrice) / 0.9) * 100)) : 0;

  return Math.max(
    1,
    Math.min(
      99,
      Math.round(
        weightScore * 0.3 +
          dominanceScore * 0.25 +
          participantScore * 0.15 +
          proximityScore * 0.15 +
          freshnessScore * 0.1 +
          priceScore * 0.05,
      ),
    ),
  );
};

const getMarketWatchOutcome = (market: MarketAggregate): string =>
  market.outcomeWeights[0]?.outcome ?? market.latestSignal.outcome;

const isValidDiscordWebhookUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "discord.com" || url.hostname.endsWith(".discord.com")) &&
      url.pathname.startsWith("/api/webhooks/")
    );
  } catch {
    return false;
  }
};

const isLikelyPrivateKey = (value: string): boolean => {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return /^[a-fA-F0-9]{64}$/.test(normalized);
};

const formatUsd = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
