import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { Wallet } from "@ethersproject/wallet";
import {
  AssetType,
  ClobClient,
  OrderType,
  Side as ClobSide,
  SignatureType,
  type ApiKeyCreds,
  type OrderBookSummary,
} from "@polymarket/clob-client";
import WebSocket from "ws";
import { Agent, ProxyAgent } from "undici";
import { SignalStorage, type PersistedCluster, type PersistedTrackedTrader } from "./storage.js";
import type {
  AppSnapshot,
  GapOpportunity,
  GapPageResponse,
  LiveStrategyDashboardResponse,
  MarketAggregate,
  MarketPageResponse,
  MarketRecord,
  MarketSortOption,
  StrategyDashboardResponse,
  StrategyPosition,
  StrategyTrade,
  TradeRecord,
  TraderSummary,
  UserProfileResponse,
  WatchMarketResult,
  WhaleSignal,
} from "./types.js";

const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const USDC_BASE_UNITS = 1_000_000;

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
  outcomePrices?: string;
  active?: boolean;
  closed?: boolean;
  updatedAt?: string;
  closedTime?: string;
  category?: string;
  events?: Array<{
    slug?: string;
    title?: string;
  }>;
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

type MarketBestBidAskMessage = {
  event_type?: string;
  asset_id?: string;
  market?: string;
  best_bid?: string;
  best_ask?: string;
  timestamp?: string;
};

type OrderBookResponse = {
  asks?: Array<{
    price?: string;
    size?: string;
  }>;
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

type GapCandidate = {
  id: string;
  eventSlug: string;
  eventTitle: string;
  pairType: "head_to_head_no_no" | "direct_market_pair";
  pairLabel: string;
  legs: [
    {
      marketSlug: string;
      marketQuestion: string;
      marketUrl: string;
      noAssetId: string;
    },
    {
      marketSlug: string;
      marketQuestion: string;
      marketUrl: string;
      noAssetId: string;
    },
  ];
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
  private readonly fetchDispatchers = config.apiProxyUrls.length
    ? config.apiProxyUrls.map(
        (proxyUrl) =>
          new ProxyAgent({
            uri: proxyUrl,
            requestTls: {
              family: 4,
              rejectUnauthorized: true,
            },
            proxyTls: {
              family: 4,
              rejectUnauthorized: true,
            },
          }),
      )
    : [
        new Agent({
          connect: {
            family: 4,
            timeout: config.fetchConnectTimeoutMs,
          },
        }),
      ];
  private readonly directFetchDispatcher = new Agent({
    connect: {
      family: 4,
      timeout: config.fetchConnectTimeoutMs,
    },
  });
  private readonly pendingUnknownAssetTrades = new Map<string, TradeRecord[]>();
  private readonly marketSocketShards = new Map<number, MarketSocketShard>();
  private readonly marketTradeFetchInFlight = new Map<string, Promise<void>>();
  private readonly queuedMarketTradeFetches = new Map<string, PendingMarketTradeFetch>();
  private readonly lastMarketTradeFetchAt = new Map<string, number>();
  private readonly trackedTraderPollInFlight = new Set<string>();
  private readonly strategyUserQueues = new Map<string, Promise<void>>();
  private readonly liveStrategyUserQueues = new Map<string, Promise<void>>();
  private readonly requestMetrics = new Map<string, RequestMetric>();
  private readonly bestAskByAssetId = new Map<string, { price: number; size: number | null; updatedAt: number }>();
  private readonly gapCandidatesById = new Map<string, GapCandidate>();
  private readonly gapCandidateIdsByAssetId = new Map<string, Set<string>>();
  private readonly liveTradingIssues = new Map<string, { message: string; blockedUntil: number }>();
  private marketTradeFetchDrainTimer: NodeJS.Timeout | null = null;
  private trackedTraderPollDrainTimer: NodeJS.Timeout | null = null;
  private activeMarketTradeFetchCount = 0;
  private marketSyncTimer: NodeJS.Timeout | null = null;
  private tradePollTimer: NodeJS.Timeout | null = null;
  private portfolioSyncTimer: NodeJS.Timeout | null = null;
  private bestTradeResolutionTimer: NodeJS.Timeout | null = null;
  private lastTradeTimestampSec = 0;
  private websocketConnected = false;
  private lastMarketSyncAt: number | null = null;
  private lastTradeAt: number | null = null;
  private lastWebsocketMessageAt: number | null = null;
  private lastForcedMarketSyncAt = 0;
  private forcingMarketSync: Promise<void> | null = null;
  private nextShardId = 1;
  private nextFetchDispatcherIndex = 0;
  private listeners = new Set<(payload: WhaleSignal) => void>();

  async start(): Promise<void> {
    await this.storage.connect();
    await this.restoreActiveClusters();
    this.runBackgroundTask("initial market sync", this.syncMarkets());
    this.runBackgroundTask("market aggregate refresh", this.refreshMarketAggregates());
    this.runBackgroundTask("best trade resolution sync", this.syncResolvedBestTradeCandidates());
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
    this.bestTradeResolutionTimer = setInterval(() => {
      this.runBackgroundTask("best trade resolution sync", this.syncResolvedBestTradeCandidates());
    }, 15 * 60_000);
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

    const bestTradeStats = view === "best" ? await this.storage.getBestTradeStats() : null;

    return {
      items,
      total: markets.length,
      page: safePage,
      pageSize: safePageSize,
      hasMore: start + safePageSize < markets.length,
      ...(bestTradeStats
        ? {
            bestTradeStats: {
              ...bestTradeStats,
              winRate:
                bestTradeStats.resolvedCount > 0
                  ? bestTradeStats.winCount / bestTradeStats.resolvedCount
                  : null,
            },
          }
        : {}),
    };
  }

  async getGapPage(page: number, pageSize: number): Promise<GapPageResponse> {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 100));
    const result = await this.storage.loadGapOpportunities(safePage, safePageSize);

    return {
      items: result.items,
      total: result.total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: safePage * safePageSize < result.total,
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
      liveTradingEnabled: settings.liveTradeEnabled ?? false,
      startingBalanceUsd: settings.startingBalanceUsd ?? 1_000,
      currentBalanceUsd: await this.calculatePaperCashBalance(normalizedUsername, settings.startingBalanceUsd ?? 1_000),
      riskPercent: settings.riskPercent ?? 5,
      tradingWalletAddress: settings.tradingWalletAddress ?? "",
      tradingSignatureType: settings.tradingSignatureType ?? "EOA",
      hasTradingCredentials: Boolean(
        settings.encryptedPrivateKey &&
          settings.encryptedApiKey &&
          settings.encryptedApiSecret &&
          settings.encryptedApiPassphrase,
      ),
      liveTradingReady: Boolean(
        settings.liveTradeEnabled &&
          settings.tradingWalletAddress &&
          settings.encryptedPrivateKey &&
          settings.encryptedApiKey &&
          settings.encryptedApiSecret &&
          settings.encryptedApiPassphrase,
      ),
      liveTradingError: this.getLiveTradingIssue(normalizedUsername),
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

  async getStrategyPositions(username: string): Promise<StrategyDashboardResponse> {
    const [positions, settings] = await Promise.all([
      this.storage.loadStrategyPositions(username, 200),
      this.storage.getUserSettings(username),
    ]);
    return buildStrategyDashboard(
      positions,
      await this.calculatePaperCashBalance(username, settings.startingBalanceUsd ?? 0),
    );
  }

  async getLiveStrategyPositions(username: string): Promise<LiveStrategyDashboardResponse> {
    const [positions, trades, settings] = await Promise.all([
      this.storage.loadLiveStrategyPositions(username, 200),
      this.storage.loadLiveStrategyTrades(username, 300),
      this.storage.getUserSettings(username),
    ]);

    const ready = Boolean(
      settings.liveTradeEnabled &&
        settings.tradingWalletAddress &&
        settings.encryptedPrivateKey &&
        settings.encryptedApiKey &&
        settings.encryptedApiSecret &&
        settings.encryptedApiPassphrase,
    );
    let cashBalanceUsd = 0;
    let error: string | null = this.getLiveTradingIssue(username);
    if (ready && !error) {
      try {
        cashBalanceUsd = await this.getLiveCollateralBalance(this.createLiveTradingClient(settings));
        this.clearLiveTradingIssue(username);
        error = null;
      } catch (caughtError) {
        this.recordLiveTradingIssue(username, caughtError);
        cashBalanceUsd = 0;
        error = this.getLiveTradingIssue(username);
      }
    }

    return {
      enabled: settings.liveTradeEnabled ?? false,
      ready: ready && !error,
      error,
      ...buildStoredStrategyDashboard(positions, trades, cashBalanceUsd),
    };
  }

  async updateUserProfile(
    username: string,
    updates: {
      webhookUrl: string;
      monitoredWallet: string;
      paperTradingEnabled: boolean;
      liveTradingEnabled: boolean;
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

      const signatureType: "EOA" | "POLY_PROXY" =
        updates.tradingSignatureType === "POLY_PROXY" ? "POLY_PROXY" : "EOA";
      const hasNewPrivateKey = Boolean(normalizedPrivateKey);
      const hasNewTradingSecrets = Boolean(
        normalizedPrivateKey || normalizedApiKey || normalizedApiSecret || normalizedApiPassphrase,
      );
      const shouldGenerateApiCreds =
        Boolean(normalizedTradingWalletAddress) &&
        (hasNewPrivateKey ||
          (!normalizedApiKey &&
            !normalizedApiSecret &&
            !normalizedApiPassphrase &&
            (updates.liveTradingEnabled || updates.clearTradingCredentials)));

      if (
        hasNewTradingSecrets &&
        !shouldGenerateApiCreds &&
        (!normalizedPrivateKey || !normalizedApiKey || !normalizedApiSecret || !normalizedApiPassphrase)
      ) {
        throw new Error("Private key, API key, API secret, and API passphrase are all required together");
      }

    if (normalizedPrivateKey && !isLikelyPrivateKey(normalizedPrivateKey)) {
      throw new Error("Please enter a valid private key");
    }

    const existingSettings = await this.storage.getUserSettings(normalizedUsername);

      if (
        updates.liveTradingEnabled &&
        !(
          normalizedTradingWalletAddress &&
          (hasNewPrivateKey ||
            hasNewTradingSecrets ||
            (existingSettings.encryptedPrivateKey &&
              ((existingSettings.encryptedApiKey &&
                existingSettings.encryptedApiSecret &&
                existingSettings.encryptedApiPassphrase) ||
                shouldGenerateApiCreds)))
        )
      ) {
        throw new Error("Live trading requires a trading wallet and saved trading credentials");
      }

      const effectiveEncryptedPrivateKey = hasNewPrivateKey
        ? encryptSecret(normalizedPrivateKey, config.tradingEncryptionSecret)
        : updates.clearTradingCredentials
          ? existingSettings.encryptedPrivateKey
          : existingSettings.encryptedPrivateKey;

      let effectiveApiKey = normalizedApiKey;
      let effectiveApiSecret = normalizedApiSecret;
      let effectiveApiPassphrase = normalizedApiPassphrase;

      if (shouldGenerateApiCreds) {
        const privateKeyForGeneration = hasNewPrivateKey
          ? normalizedPrivateKey
          : existingSettings.encryptedPrivateKey
            ? decryptSecret(existingSettings.encryptedPrivateKey, config.tradingEncryptionSecret)
            : "";
        if (!privateKeyForGeneration) {
          throw new Error("Live trading requires a private key");
        }

        const generatedCreds = await this.generateLiveTradingApiCreds(
          privateKeyForGeneration,
          signatureType,
          normalizedTradingWalletAddress,
        );
        effectiveApiKey = generatedCreds.key;
        effectiveApiSecret = generatedCreds.secret;
        effectiveApiPassphrase = generatedCreds.passphrase;
      }

      if (updates.liveTradingEnabled && normalizedTradingWalletAddress) {
        const validationSettings = {
          ...existingSettings,
          liveTradeEnabled: true,
          tradingWalletAddress: normalizedTradingWalletAddress,
          tradingSignatureType: signatureType,
          encryptedPrivateKey: effectiveEncryptedPrivateKey,
          encryptedApiKey: effectiveApiKey
            ? encryptSecret(effectiveApiKey, config.tradingEncryptionSecret)
            : existingSettings.encryptedApiKey,
          encryptedApiSecret: effectiveApiSecret
            ? encryptSecret(effectiveApiSecret, config.tradingEncryptionSecret)
            : existingSettings.encryptedApiSecret,
          encryptedApiPassphrase: effectiveApiPassphrase
            ? encryptSecret(effectiveApiPassphrase, config.tradingEncryptionSecret)
            : existingSettings.encryptedApiPassphrase,
        };

        try {
          await this.getLiveCollateralBalance(this.createLiveTradingClient(validationSettings));
          this.clearLiveTradingIssue(normalizedUsername);
        } catch (caughtError) {
          this.recordLiveTradingIssue(normalizedUsername, caughtError);
          throw new Error(this.extractLiveTradingErrorMessage(caughtError));
        }
      }

    await this.storage.updateUserSettings(normalizedUsername, {
      webhookUrl: normalizedWebhookUrl,
      monitoredWallet: normalizedMonitoredWallet,
      autoTradeEnabled: updates.paperTradingEnabled,
      liveTradeEnabled: updates.liveTradingEnabled,
      startingBalanceUsd: updates.startingBalanceUsd,
      currentBalanceUsd:
        existingSettings.currentBalanceUsd == null
          ? updates.startingBalanceUsd
          : Math.max(0, existingSettings.currentBalanceUsd),
      riskPercent: updates.riskPercent,
      tradingWalletAddress: normalizedTradingWalletAddress,
      tradingSignatureType: signatureType,
      ...(effectiveEncryptedPrivateKey
        ? {
            encryptedPrivateKey: effectiveEncryptedPrivateKey,
            ...(effectiveApiKey
              ? { encryptedApiKey: encryptSecret(effectiveApiKey, config.tradingEncryptionSecret) }
              : {}),
            ...(effectiveApiSecret
              ? { encryptedApiSecret: encryptSecret(effectiveApiSecret, config.tradingEncryptionSecret) }
              : {}),
            ...(effectiveApiPassphrase
              ? { encryptedApiPassphrase: encryptSecret(effectiveApiPassphrase, config.tradingEncryptionSecret) }
              : {}),
          }
        : {}),
      clearTradingCredentials: updates.clearTradingCredentials,
    });
    if (updates.liveTradingEnabled) {
      await this.queueCurrentBestTradeReconcilesForUser(normalizedUsername);
    }
    await this.syncTrackedWalletWatchesForUser(normalizedUsername, normalizedMonitoredWallet);
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
          category: market.category,
          eventSlug: market.events?.[0]?.slug ?? market.slug,
          eventTitle: market.events?.[0]?.title ?? market.question,
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
    this.captureInitialActiveMarkets();
    await this.refreshGapCandidates();
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
          custom_feature_enabled: true,
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
        this.processSocketEvent(item as MarketTradeMessage | MarketBestBidAskMessage);
      }
      return;
    }

    this.processSocketEvent(parsed as MarketTradeMessage | MarketBestBidAskMessage);
  }

  private processSocketEvent(message: MarketTradeMessage | MarketBestBidAskMessage): void {
    if (!message.asset_id || !message.timestamp) {
      return;
    }

    const seenAt = Date.now();
    this.lastWebsocketMessageAt = seenAt;
    this.websocketAssetSeenAt.set(message.asset_id, seenAt);

    if (message.event_type === "best_bid_ask") {
      this.processBestBidAskEvent(message as MarketBestBidAskMessage);
      return;
    }

    if (message.event_type !== "last_trade_price") {
      return;
    }

    const tradeMessage = message as MarketTradeMessage;
    const price = Number(tradeMessage.price);
    const size = Number(tradeMessage.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price * size < 10) {
      return;
    }

    this.lastTradeAt = Date.now();
    this.scheduleMarketTradeFetch(tradeMessage);
  }

  private processBestBidAskEvent(message: MarketBestBidAskMessage): void {
    if (!message.asset_id) {
      return;
    }

    const bestAsk = Number(message.best_ask);
    const bestBid = Number(message.best_bid);
    const price = Number.isFinite(bestAsk) && bestAsk > 0 ? bestAsk : Number.isFinite(bestBid) && bestBid > 0 ? bestBid : null;
    if (price === null) {
      return;
    }

    this.bestAskByAssetId.set(message.asset_id, {
      price,
      size: null,
      updatedAt: Date.now(),
    });
    void this.refreshGapCandidatesForAsset(message.asset_id);
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
      await this.queueStrategyReconcile(accumulator.market.slug, user.username);
    }
    const liveTradeUsers = await this.storage.loadLiveTradeUsers();
    for (const user of liveTradeUsers) {
      await this.queueLiveStrategyReconcile(accumulator.market.slug, user.username);
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
    await this.syncBestTradeCandidates(aggregates);

    for (const marketSlug of activeMarketSlugs) {
      const aggregate = aggregateBySlug.get(marketSlug);
      if (aggregate) {
        await this.storage.saveMarketAggregate(aggregate);
      } else {
        await this.storage.deleteMarketAggregate(marketSlug);
      }
    }

    await this.queueCurrentBestTradeReconciles();
  }

  private async refreshMarketAggregate(marketSlug: string): Promise<void> {
    const signals = (await this.storage.loadSignalsForMarketSlugs([marketSlug])).map(applySignalLabelStyle);
    const activeSignals = resolveActiveBuySignals(signals);
    const aggregate = aggregateMarkets(activeSignals)[0];

    if (aggregate) {
      await this.storage.saveMarketAggregate(aggregate);
      await this.syncBestTradeCandidates([aggregate]);
      return;
    }

    await this.storage.deleteMarketAggregate(marketSlug);
  }

  private async queueCurrentBestTradeReconciles(): Promise<void> {
    const [bestTradeSlugs, liveTradeUsers] = await Promise.all([
      this.storage.loadBestTradeMarketSlugs(),
      this.storage.loadLiveTradeUsers(),
    ]);

    if (bestTradeSlugs.length === 0 || liveTradeUsers.length === 0) {
      return;
    }

    for (const user of liveTradeUsers) {
      await this.queueCurrentBestTradeReconcilesForUser(user.username, bestTradeSlugs);
    }
  }

  private async queueCurrentBestTradeReconcilesForUser(
    username: string,
    bestTradeSlugs?: string[],
  ): Promise<void> {
    const marketSlugs = bestTradeSlugs ?? (await this.storage.loadBestTradeMarketSlugs());
    for (const marketSlug of marketSlugs) {
      await this.queueLiveStrategyReconcile(marketSlug, username);
    }
  }

  private async refreshGapCandidates(): Promise<void> {
    const nextCandidates = this.buildGapCandidates();
    const nextCandidateIds = nextCandidates.map((candidate) => candidate.id);
    await this.storage.pruneGapOpportunities(nextCandidateIds);
    const previousIds = new Set(this.gapCandidatesById.keys());
    this.gapCandidatesById.clear();
    this.gapCandidateIdsByAssetId.clear();

    for (const candidate of nextCandidates) {
      this.gapCandidatesById.set(candidate.id, candidate);
      for (const leg of candidate.legs) {
        const ids = this.gapCandidateIdsByAssetId.get(leg.noAssetId) ?? new Set<string>();
        ids.add(candidate.id);
        this.gapCandidateIdsByAssetId.set(leg.noAssetId, ids);
      }
      await this.refreshGapOpportunity(candidate);
      previousIds.delete(candidate.id);
    }

    for (const staleId of previousIds) {
      await this.storage.deleteGapOpportunity(staleId);
    }
  }

  private async refreshGapCandidatesForAsset(assetId: string): Promise<void> {
    const candidateIds = this.gapCandidateIdsByAssetId.get(assetId);
    if (!candidateIds?.size) {
      return;
    }

    for (const candidateId of candidateIds) {
      const candidate = this.gapCandidatesById.get(candidateId);
      if (!candidate) {
        continue;
      }
      await this.refreshGapOpportunity(candidate);
    }
  }

  private buildGapCandidates(): GapCandidate[] {
    const eventGroups = new Map<string, MarketRecord[]>();
    for (const market of new Map(Array.from(this.marketsByAssetId.values(), (market) => [market.slug, market] as const)).values()) {
      if (!isSportsMarket(market)) {
        continue;
      }

      const eventKey = market.eventSlug ?? market.slug;
      const group = eventGroups.get(eventKey) ?? [];
      group.push(market);
      eventGroups.set(eventKey, group);
    }

    const candidates: GapCandidate[] = [];
    for (const [eventSlug, markets] of eventGroups) {
      candidates.push(...buildDirectMarketGapCandidates(eventSlug, markets));
      const matchups = buildHeadToHeadGapCandidates(eventSlug, markets);
      if (matchups.length === 0) {
        continue;
      }

      candidates.push(...matchups);
    }

    return candidates;
  }

  private async refreshGapOpportunity(candidate: GapCandidate): Promise<void> {
    const [firstQuote, secondQuote] = await Promise.all([
      this.getBestAskQuote(candidate.legs[0].noAssetId),
      this.getBestAskQuote(candidate.legs[1].noAssetId),
    ]);

    const combinedNoAsk =
      firstQuote?.price != null && secondQuote?.price != null ? firstQuote.price + secondQuote.price : null;
    const grossEdge = combinedNoAsk != null ? 1 - combinedNoAsk : null;
    const executableStake =
      firstQuote?.size != null && secondQuote?.size != null
        ? Math.min(firstQuote.size * firstQuote.price, secondQuote.size * secondQuote.price)
        : null;

    const gap: GapOpportunity = {
      id: candidate.id,
      eventSlug: candidate.eventSlug,
      eventTitle: candidate.eventTitle,
      pairType: candidate.pairType,
      pairLabel: candidate.pairLabel,
      combinedNoAsk,
      grossEdge,
      executableStake,
      updatedAt: Date.now(),
      legs: [
        {
          marketSlug: candidate.legs[0].marketSlug,
          marketQuestion: candidate.legs[0].marketQuestion,
          marketUrl: candidate.legs[0].marketUrl,
          noAssetId: candidate.legs[0].noAssetId,
          noAsk: firstQuote?.price ?? null,
          noAskSize: firstQuote?.size ?? null,
        },
        {
          marketSlug: candidate.legs[1].marketSlug,
          marketQuestion: candidate.legs[1].marketQuestion,
          marketUrl: candidate.legs[1].marketUrl,
          noAssetId: candidate.legs[1].noAssetId,
          noAsk: secondQuote?.price ?? null,
          noAskSize: secondQuote?.size ?? null,
        },
      ],
    };

    await this.storage.saveGapOpportunity(gap);
  }

  private async getBestAskQuote(assetId: string): Promise<{ price: number; size: number | null } | null> {
    const cached = this.bestAskByAssetId.get(assetId);
    if (cached && Date.now() - cached.updatedAt < 60_000) {
      return { price: cached.price, size: cached.size };
    }

    const url = new URL(`${CLOB_API_URL}/book`);
    url.searchParams.set("token_id", assetId);
    const response = await this.safeFetch(url, `gap book ${assetId}`);
    if (!response?.ok) {
      return cached ? { price: cached.price, size: cached.size } : null;
    }

    const payload = (await response.json()) as OrderBookResponse;
    const bestAsk = payload.asks
      ?.map((entry) => ({ price: Number(entry.price), size: Number(entry.size) }))
      .filter((entry) => Number.isFinite(entry.price) && entry.price > 0)
      .sort((left, right) => left.price - right.price)[0];
    if (!bestAsk) {
      return cached ? { price: cached.price, size: cached.size } : null;
    }

    const quote = {
      price: bestAsk.price,
      size: Number.isFinite(bestAsk.size) && bestAsk.size > 0 ? bestAsk.size : null,
      updatedAt: Date.now(),
    };
    this.bestAskByAssetId.set(assetId, quote);
    return { price: quote.price, size: quote.size };
  }

  private async syncBestTradeCandidates(aggregates: MarketAggregate[]): Promise<void> {
    for (const aggregate of aggregates) {
      if (!isBestTradeMarket(aggregate)) {
        continue;
      }

      const outcome = aggregate.outcomeWeights[0]?.outcome?.trim();
      if (!outcome) {
        continue;
      }

      await this.storage.upsertBestTradeCandidate({
        marketSlug: aggregate.marketSlug,
        outcome,
        marketQuestion: aggregate.marketQuestion,
        marketUrl: aggregate.marketUrl,
        marketImage: aggregate.marketImage,
        firstQualifiedAt: aggregate.latestTimestamp,
        lastQualifiedAt: aggregate.latestTimestamp,
        weightedScore: aggregate.weightedScore,
        leadingOutcomeWeight: aggregate.outcomeWeights[0]?.weight ?? 0,
        participantCount: aggregate.participantCount,
        observedAvgEntry: aggregate.observedAvgEntry,
        lastPrice: aggregate.latestSignal.averagePrice,
      });
    }
  }

  private async syncResolvedBestTradeCandidates(): Promise<void> {
    const unresolved = await this.storage.loadUnresolvedBestTradeCandidates(250);
    for (const candidate of unresolved) {
      const market = await this.fetchMarketBySlug(candidate.marketSlug);
      if (!market?.closed) {
        continue;
      }

      const winningOutcome = this.getWinningOutcomeForClosedMarket(market);
      if (!winningOutcome) {
        continue;
      }

      await this.storage.resolveBestTradeCandidate(candidate.marketSlug, candidate.outcome, {
        resolvedAt: this.getClosedTimestamp(market) ?? Date.now(),
        winningOutcome,
        won: normalizeOutcomeName(winningOutcome) === normalizeOutcomeName(candidate.outcome),
      });
    }
  }

  private async fetchMarketBySlug(slug: string): Promise<RawMarket | null> {
    const url = new URL(GAMMA_MARKETS_URL);
    url.searchParams.set("slug", slug);
    const response = await this.safeFetch(url, `market lookup ${slug}`);
    if (!response || !response.ok) {
      return null;
    }

    const payload = (await response.json()) as RawMarket[];
    return payload.find((market) => market.slug === slug) ?? payload[0] ?? null;
  }

  private getWinningOutcomeForClosedMarket(market: RawMarket): string | null {
    const outcomes = this.safeJsonParse<string[]>(market.outcomes, []);
    const outcomePrices = this.safeJsonParse<Array<number | string>>(market.outcomePrices, []).map((value) =>
      Number(value),
    );
    if (outcomes.length === 0 || outcomePrices.length !== outcomes.length) {
      return null;
    }

    let winningIndex = -1;
    let winningPrice = Number.NEGATIVE_INFINITY;
    let tie = false;
    for (let index = 0; index < outcomePrices.length; index += 1) {
      const price = outcomePrices[index];
      if (!Number.isFinite(price)) {
        continue;
      }

      if (price > winningPrice) {
        winningPrice = price;
        winningIndex = index;
        tie = false;
      } else if (price === winningPrice) {
        tie = true;
      }
    }

    if (winningIndex < 0 || tie || winningPrice <= 0) {
      return null;
    }

    return outcomes[winningIndex] ?? null;
  }

  private getClosedTimestamp(market: RawMarket): number | null {
    const rawValue = market.closedTime ?? market.updatedAt ?? null;
    if (!rawValue) {
      return null;
    }

    const timestamp = Date.parse(rawValue);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private queueStrategyReconcile(marketSlug: string, username: string): Promise<void> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      return Promise.resolve();
    }

    const previous = this.strategyUserQueues.get(normalizedUsername) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.reconcileStrategyPosition(marketSlug, normalizedUsername));
    this.strategyUserQueues.set(normalizedUsername, next.finally(() => {
      if (this.strategyUserQueues.get(normalizedUsername) === next) {
        this.strategyUserQueues.delete(normalizedUsername);
      }
    }));
    return next;
  }

  private async reconcileStrategyPosition(
    marketSlug: string,
    username: string,
  ): Promise<void> {
    const aggregate = (await this.storage.loadMarketAggregates([marketSlug]))[0];
    if (!aggregate) {
      return;
    }

    const settings = await this.storage.getUserSettings(username);
    if (!settings.autoTradeEnabled) {
      return;
    }
    const startingBalanceUsd = settings.startingBalanceUsd ?? 1_000;
    const currentBalanceUsd = await this.calculatePaperCashBalance(username, startingBalanceUsd);
    const riskPercent = settings.riskPercent ?? 5;

    const edgeOutcome = aggregate.outcomeWeights[0]?.outcome ?? aggregate.latestSignal.outcome;
    const existingMarketPosition = await this.storage.loadOpenStrategyPositionForMarket(username, marketSlug);
    const trackedOutcome = existingMarketPosition?.outcome ?? edgeOutcome;
    const setupQuality = getSetupQualityScore(aggregate);
    const currentPrice = aggregate.latestSignal.averagePrice;
    const currentParticipants =
      aggregate.outcomeParticipants?.filter((participant) => participant.outcome === trackedOutcome) ?? [];
    const currentWeightByWallet = new Map(
      currentParticipants.map((participant) => [participant.wallet, participant.weight] as const),
    );
    const position = existingMarketPosition;

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
        Math.min(currentBalanceUsd, currentBalanceUsd * (Math.max(0, riskPercent) / 100)),
      );
      if (entryNotionalUsd <= 0 || currentPrice <= 0) {
        return;
      }

      const entryPrice = await this.getPaperEntryPrice(aggregate.marketSlug, edgeOutcome);
      if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) {
        return;
      }
      const nextPosition: StrategyPosition = {
        id: `${username}:${marketSlug}:${edgeOutcome}`,
        username,
        marketSlug,
        marketQuestion: aggregate.marketQuestion,
        marketUrl: aggregate.marketUrl,
        marketImage: aggregate.marketImage,
        outcome: edgeOutcome,
        status: "open",
        openedAt: Date.now(),
        updatedAt: Date.now(),
        entryPrice,
        lastPrice: currentPrice,
        entryNotionalUsd,
        remainingShares: entryNotionalUsd / entryPrice,
        realizedUsd: 0,
        originalSmartMoneyWeight,
        remainingSmartMoneyWeight: originalSmartMoneyWeight,
        soldPercent: 0,
        trim96Hit: false,
        setupQuality,
        originalParticipants,
      };
      await this.storage.saveStrategyPosition(nextPosition);
      return;
    }

    const remainingSmartMoneyWeight = position.originalParticipants.reduce(
      (sum, participant) => sum + (currentWeightByWallet.get(participant.wallet) ?? 0),
      0,
    );
    const exitedWeight = Math.max(0, position.originalSmartMoneyWeight - remainingSmartMoneyWeight);
    const exitedRatio =
      position.originalSmartMoneyWeight > 0 ? exitedWeight / position.originalSmartMoneyWeight : 0;
    const edgeFlipped = position.outcome !== edgeOutcome;
    const qualifiesIgnoringPriceCap = !edgeFlipped && isBestTradeMarket(aggregate, {
      ignorePriceCap: true,
      ignorePriceDeviation: true,
      minTotalWeight: 40,
      minOutcomeShare: 0.5,
    });

    let nextPosition: StrategyPosition = {
      ...position,
      updatedAt: Date.now(),
      lastPrice: currentPrice,
      remainingSmartMoneyWeight,
      setupQuality,
    };

    if (!nextPosition.trim96Hit && currentPrice >= 0.96) {
      const sharesToSell = Math.min(nextPosition.remainingShares, (position.entryNotionalUsd / position.entryPrice) * 0.5);
      const realizedUsd = sharesToSell * currentPrice;
      nextPosition = {
        ...nextPosition,
        remainingShares: Math.max(0, nextPosition.remainingShares - sharesToSell),
        realizedUsd: nextPosition.realizedUsd + realizedUsd,
        soldPercent: Math.max(nextPosition.soldPercent, 50),
        trim96Hit: true,
      };
    }

    let exitReason: string | undefined;
    if (!qualifiesIgnoringPriceCap) {
      const thesisBreakReasons = edgeFlipped
        ? [`leading outcome switched to ${edgeOutcome}`]
        : getBestTradeFailureReasons(aggregate, {
        ignorePriceCap: true,
        ignorePriceDeviation: true,
        minTotalWeight: 40,
        minOutcomeShare: 0.5,
      });
      exitReason = `Thesis break: ${thesisBreakReasons.join(", ")}`;
    } else if (currentPrice >= 0.995) {
      exitReason = "Take profit 0.995";
    } else if (exitedRatio >= 0.65) {
      exitReason = "65% smart-money weight exited";
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
    }

    await this.storage.saveStrategyPosition(nextPosition);
  }

  private queueLiveStrategyReconcile(marketSlug: string, username: string): Promise<void> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      return Promise.resolve();
    }

    const previous = this.liveStrategyUserQueues.get(normalizedUsername) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.reconcileLiveStrategyPosition(marketSlug, normalizedUsername))
      .catch((error) => {
        logFetchFailure(`live strategy ${normalizedUsername} ${marketSlug}`, error);
      });
    this.liveStrategyUserQueues.set(normalizedUsername, next.finally(() => {
      if (this.liveStrategyUserQueues.get(normalizedUsername) === next) {
        this.liveStrategyUserQueues.delete(normalizedUsername);
      }
    }));
    return next;
  }

  private async reconcileLiveStrategyPosition(marketSlug: string, username: string): Promise<void> {
    const aggregate = (await this.storage.loadMarketAggregates([marketSlug]))[0];
    if (!aggregate) {
      return;
    }

    const settings = await this.storage.getUserSettings(username);
    if (!settings.liveTradeEnabled) {
      return;
    }
    if (this.isLiveTradingBlocked(username)) {
      return;
    }

    const tradingWalletAddress = settings.tradingWalletAddress?.trim() ?? "";
    if (
      !tradingWalletAddress ||
      !settings.encryptedPrivateKey ||
      !settings.encryptedApiKey ||
      !settings.encryptedApiSecret ||
      !settings.encryptedApiPassphrase
    ) {
      return;
    }

    const edgeOutcome = aggregate.outcomeWeights[0]?.outcome ?? aggregate.latestSignal.outcome;
    const existingMarketPosition = await this.storage.loadOpenLiveStrategyPositionForMarket(username, marketSlug);
    const trackedOutcome = existingMarketPosition?.outcome ?? edgeOutcome;
    const tokenID = this.findAssetIdForMarketOutcome(marketSlug, trackedOutcome);
    if (!tokenID) {
      return;
    }

    const setupQuality = getSetupQualityScore(aggregate);
    const currentPrice = aggregate.latestSignal.averagePrice;
    const currentParticipants =
      aggregate.outcomeParticipants?.filter((participant) => participant.outcome === trackedOutcome) ?? [];
    const currentWeightByWallet = new Map(
      currentParticipants.map((participant) => [participant.wallet, participant.weight] as const),
    );
    const client = this.createLiveTradingClient(settings);
    const position = existingMarketPosition;

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

      const collateral = await this.getLiveCollateralBalance(client).catch((error) => {
        this.recordLiveTradingIssue(username, error);
        return 0;
      });
      const riskPercent = settings.riskPercent ?? 5;
      const entryNotionalUsd = Math.max(0, Math.min(collateral, collateral * (Math.max(0, riskPercent) / 100)));
      if (entryNotionalUsd <= 0) {
        return;
      }

      const options = await this.getLiveOrderOptions(client, tokenID).catch((error) => {
        this.recordLiveTradingIssue(username, error);
        return null;
      });
      if (!options) {
        return;
      }
      const allowanceReady = await this.ensureLiveAllowance(client, AssetType.COLLATERAL, entryNotionalUsd).then(
        () => true,
        (error) => {
          this.recordLiveTradingIssue(username, error);
          return false;
        },
      );
      if (!allowanceReady) {
        return;
      }
      const entryPrice = await client
        .calculateMarketPrice(tokenID, ClobSide.BUY, entryNotionalUsd, OrderType.FOK)
        .catch((error) => {
          if (error instanceof Error && error.message.includes("no match")) {
            return null;
          }
          this.recordLiveTradingIssue(username, error);
          return null;
        });
      if (entryPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
        return;
      }
      const safeEntryPrice = entryPrice;

      const response = await client
        .createAndPostMarketOrder(
          {
            tokenID,
            amount: entryNotionalUsd,
            side: ClobSide.BUY,
          },
          options,
          OrderType.FOK,
        )
        .catch((error) => {
          this.recordLiveTradingIssue(username, error);
          return null;
        });
      if (!response) {
        return;
      }

      const openedAt = Date.now();
      const remainingShares = entryNotionalUsd / safeEntryPrice;
      const nextPosition: StrategyPosition = {
        id: `${username}:${marketSlug}:${edgeOutcome}:live`,
        username,
        marketSlug,
        marketQuestion: aggregate.marketQuestion,
        marketUrl: aggregate.marketUrl,
        marketImage: aggregate.marketImage,
        outcome: edgeOutcome,
        status: "open",
        openedAt,
        updatedAt: openedAt,
        entryPrice: safeEntryPrice,
        lastPrice: currentPrice,
        entryNotionalUsd,
        remainingShares,
        realizedUsd: 0,
        originalSmartMoneyWeight,
        remainingSmartMoneyWeight: originalSmartMoneyWeight,
        soldPercent: 0,
        trim96Hit: false,
        setupQuality,
        originalParticipants,
      };
      await this.storage.saveLiveStrategyPosition(nextPosition);
      this.clearLiveTradingIssue(username);
      await this.storage.saveLiveStrategyTrade(
        username,
        this.buildLiveStrategyTrade(nextPosition, {
          id: `${nextPosition.id}:entry:${openedAt}`,
          side: "BUY",
          reason: "Entry",
          timestamp: openedAt,
            price: safeEntryPrice,
          shares: remainingShares,
          usd: entryNotionalUsd,
          response,
        }),
      );
      return;
    }

    const remainingSmartMoneyWeight = position.originalParticipants.reduce(
      (sum, participant) => sum + (currentWeightByWallet.get(participant.wallet) ?? 0),
      0,
    );
    const exitedWeight = Math.max(0, position.originalSmartMoneyWeight - remainingSmartMoneyWeight);
    const exitedRatio =
      position.originalSmartMoneyWeight > 0 ? exitedWeight / position.originalSmartMoneyWeight : 0;
    const edgeFlipped = position.outcome !== edgeOutcome;
    const qualifiesIgnoringPriceCap = !edgeFlipped && isBestTradeMarket(aggregate, {
      ignorePriceCap: true,
      ignorePriceDeviation: true,
      minTotalWeight: 40,
      minOutcomeShare: 0.5,
    });

    let nextPosition: StrategyPosition = {
      ...position,
      updatedAt: Date.now(),
      lastPrice: currentPrice,
      remainingSmartMoneyWeight,
      setupQuality,
    };

    const options = await this.getLiveOrderOptions(client, tokenID).catch((error) => {
      this.recordLiveTradingIssue(username, error);
      return null;
    });
    if (!options) {
      return;
    }

    if (!nextPosition.trim96Hit && currentPrice >= 0.96) {
      nextPosition = await this.executeLiveTrim(username, nextPosition, tokenID, options, 0.5, 0.96, "Trim 0.96");
    }

    let exitReason: string | undefined;
    if (!qualifiesIgnoringPriceCap) {
      const thesisBreakReasons = edgeFlipped
        ? [`leading outcome switched to ${edgeOutcome}`]
        : getBestTradeFailureReasons(aggregate, {
        ignorePriceCap: true,
        ignorePriceDeviation: true,
        minTotalWeight: 40,
        minOutcomeShare: 0.5,
      });
      exitReason = `Thesis break: ${thesisBreakReasons.join(", ")}`;
    } else if (currentPrice >= 0.995) {
      exitReason = "Take profit 0.995";
    } else if (exitedRatio >= 0.65) {
      exitReason = "65% smart-money weight exited";
    }

    if (exitReason && nextPosition.remainingShares > 0) {
      nextPosition = await this.executeLiveClose(username, nextPosition, tokenID, options, exitReason);
    }

    await this.storage.saveLiveStrategyPosition(nextPosition);
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
    const target = this.withCacheBust(input);
    const endpoint = this.getRequestMetricKey(target);
    try {
      const dispatcher = this.getFetchDispatcher(target);
      const signal = AbortSignal.timeout(config.fetchConnectTimeoutMs);
      const response = await fetch(target, {
        dispatcher: dispatcher as unknown as NonNullable<RequestInit["dispatcher"]>,
        signal,
      });
      this.recordRequestMetric(endpoint, response.ok);
      return response;
    } catch (error) {
      this.recordRequestMetric(endpoint, false);
      logFetchFailure(context, error);
      return null;
    }
  }

  private getNextFetchDispatcher(): Agent | ProxyAgent {
    const dispatcher =
      this.fetchDispatchers[this.nextFetchDispatcherIndex % this.fetchDispatchers.length]
      ?? this.fetchDispatchers[0];
    this.nextFetchDispatcherIndex = (this.nextFetchDispatcherIndex + 1) % this.fetchDispatchers.length;
    return dispatcher;
  }

  private getFetchDispatcher(input: string | URL): Agent | ProxyAgent {
    const raw = typeof input === "string" ? input : input.toString();

    try {
      const url = new URL(raw);
      if (url.hostname.includes("gamma-api.polymarket.com")) {
        return this.directFetchDispatcher;
      }
    } catch {
      // Fall through to the default rotating dispatcher.
    }

    return this.getNextFetchDispatcher();
  }

  private withCacheBust(input: string | URL): string | URL {
    const raw = typeof input === "string" ? input : input.toString();

    try {
      const url = new URL(raw);
      const isDynamicPolymarketEndpoint =
        url.hostname.includes("data-api.polymarket.com") ||
        url.hostname.includes("gamma-api.polymarket.com") ||
        (url.hostname.includes("clob.polymarket.com") && url.pathname === "/book");

      if (!isDynamicPolymarketEndpoint) {
        return input;
      }

      url.searchParams.set("_ts", String(Date.now()));
      return url;
    } catch {
      return input;
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

  private async calculatePaperCashBalance(
    username: string,
    startingBalanceUsd: number,
  ): Promise<number> {
    const positions = await this.storage.loadStrategyPositions(username, 1_000);
    return calculatePaperCashBalanceFromPositions(positions, startingBalanceUsd);
  }

  private async getPaperEntryPrice(
    marketSlug: string,
    outcome: string,
  ): Promise<number | null> {
    const assetId = this.findAssetIdForMarketOutcome(marketSlug, outcome);
    if (!assetId) {
      return null;
    }

    const url = new URL(`${CLOB_API_URL}/book`);
    url.searchParams.set("token_id", assetId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.safeFetch(url, `book ${marketSlug} ${outcome}`);
      if (response?.ok) {
        const payload = (await response.json()) as OrderBookResponse;
        const bestAsk = payload.asks
          ?.map((entry) => Number(entry.price))
          .filter((price) => Number.isFinite(price) && price > 0)
          .sort((left, right) => left - right)[0];

        if (bestAsk) {
          return bestAsk;
        }
      }

      if (attempt < 2) {
        await delay(250 * (attempt + 1));
      }
    }

    return null;
  }

  private createLiveTradingClient(
    settings: Awaited<ReturnType<SignalStorage["getUserSettings"]>>,
  ): ClobClient {
    const privateKey = decryptSecret(settings.encryptedPrivateKey!, config.tradingEncryptionSecret);
    const creds: ApiKeyCreds = {
      key: decryptSecret(settings.encryptedApiKey!, config.tradingEncryptionSecret),
      secret: decryptSecret(settings.encryptedApiSecret!, config.tradingEncryptionSecret),
      passphrase: decryptSecret(settings.encryptedApiPassphrase!, config.tradingEncryptionSecret),
    };
    const signer = new Wallet(privateKey);
    const signatureType =
      settings.tradingSignatureType === "POLY_PROXY" ? SignatureType.POLY_PROXY : SignatureType.EOA;

    return new ClobClient(
      CLOB_API_URL,
      137,
      signer,
      creds,
      signatureType,
      settings.tradingWalletAddress ?? undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
  }

  private async generateLiveTradingApiCreds(
    privateKey: string,
    signatureType: "EOA" | "POLY_PROXY",
    tradingWalletAddress: string,
  ): Promise<ApiKeyCreds> {
    const signer = new Wallet(privateKey);
    const authClient = new ClobClient(
      CLOB_API_URL,
      137,
      signer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    try {
      return await authClient.createApiKey();
    } catch {
      return authClient.deriveApiKey();
    }
  }

  private async getLiveCollateralBalance(client: ClobClient): Promise<number> {
    const response = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return Number(response.balance ?? 0) / USDC_BASE_UNITS;
  }

  private isLiveTradingBlocked(username: string): boolean {
    const issue = this.liveTradingIssues.get(username.trim());
    return Boolean(issue && issue.blockedUntil > Date.now());
  }

  private getLiveTradingIssue(username: string): string | null {
    const issue = this.liveTradingIssues.get(username.trim());
    if (!issue) {
      return null;
    }
    if (issue.blockedUntil <= Date.now()) {
      this.liveTradingIssues.delete(username.trim());
      return null;
    }
    return issue.message;
  }

  private clearLiveTradingIssue(username: string): void {
    this.liveTradingIssues.delete(username.trim());
  }

  private recordLiveTradingIssue(username: string, error: unknown): void {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      return;
    }
    this.liveTradingIssues.set(normalizedUsername, {
      message: this.extractLiveTradingErrorMessage(error),
      blockedUntil: Date.now() + 5 * 60_000,
    });
  }

  private extractLiveTradingErrorMessage(error: unknown): string {
    const message =
      typeof error === "object" && error && "message" in error && typeof error.message === "string"
        ? error.message
        : "";
    if (message.includes("Unauthorized/Invalid api key") || message.includes("401")) {
      return "Invalid Polymarket API credentials";
    }
    return message || "Live trading is temporarily unavailable";
  }

  private async ensureLiveAllowance(
    client: ClobClient,
    assetType: AssetType,
    minimumAmount: number,
    tokenID?: string,
  ): Promise<void> {
    const response = await client.getBalanceAllowance(
      assetType === AssetType.CONDITIONAL ? { asset_type: assetType, token_id: tokenID } : { asset_type: assetType },
    );
    const allowance =
      assetType === AssetType.COLLATERAL
        ? Number(response.allowance ?? 0) / USDC_BASE_UNITS
        : Number(response.allowance ?? 0);
    if (allowance >= minimumAmount) {
      return;
    }

    await client.updateBalanceAllowance(
      assetType === AssetType.CONDITIONAL ? { asset_type: assetType, token_id: tokenID } : { asset_type: assetType },
    );
  }

  private async getLiveOrderOptions(
    client: ClobClient,
    tokenID: string,
  ): Promise<{ tickSize: "0.1" | "0.01" | "0.001" | "0.0001"; negRisk?: boolean }> {
    const book = (await client.getOrderBook(tokenID)) as OrderBookSummary;
    return {
      tickSize: book.tick_size as "0.1" | "0.01" | "0.001" | "0.0001",
      negRisk: book.neg_risk,
    };
  }

  private async executeLiveTrim(
    username: string,
    position: StrategyPosition,
    tokenID: string,
    options: { tickSize: "0.1" | "0.01" | "0.001" | "0.0001"; negRisk?: boolean },
    fractionOfInitialShares: number,
    thresholdPrice: number,
    reason: string,
  ): Promise<StrategyPosition> {
    const settings = await this.storage.getUserSettings(username);
    const client = this.createLiveTradingClient(settings);
    const initialShares = position.entryPrice > 0 ? position.entryNotionalUsd / position.entryPrice : 0;
    const sharesToSell = Math.min(position.remainingShares, initialShares * fractionOfInitialShares);
    if (sharesToSell <= 0) {
      return position;
    }

    const allowanceReady = await this.ensureLiveAllowance(client, AssetType.CONDITIONAL, sharesToSell, tokenID).then(
      () => true,
      (error) => {
        this.recordLiveTradingIssue(username, error);
        return false;
      },
    );
    if (!allowanceReady) {
      return position;
    }
    const sellPrice = await client.calculateMarketPrice(tokenID, ClobSide.SELL, sharesToSell, OrderType.FOK).catch(
      (error) => {
        if (error instanceof Error && error.message.includes("no match")) {
          return null;
        }
        this.recordLiveTradingIssue(username, error);
        return null;
      },
    );
    if (sellPrice == null || !Number.isFinite(sellPrice) || sellPrice <= 0) {
      return position;
    }
    const safeSellPrice = sellPrice;

    const response = await client
      .createAndPostMarketOrder(
        {
          tokenID,
          amount: sharesToSell,
          side: ClobSide.SELL,
        },
        options,
        OrderType.FOK,
      )
      .catch((error) => {
        this.recordLiveTradingIssue(username, error);
        return null;
      });
    if (!response) {
      return position;
    }

    const realizedUsd = sharesToSell * safeSellPrice;
    const nextPosition: StrategyPosition = {
      ...position,
      updatedAt: Date.now(),
      lastPrice: Math.max(position.lastPrice, thresholdPrice),
      remainingShares: Math.max(0, position.remainingShares - sharesToSell),
      realizedUsd: position.realizedUsd + realizedUsd,
      soldPercent: Math.max(position.soldPercent, 50),
      trim96Hit: position.trim96Hit || thresholdPrice >= 0.96,
    };
    await this.storage.saveLiveStrategyTrade(
      username,
      this.buildLiveStrategyTrade(nextPosition, {
        id: `${position.id}:${reason}:${Date.now()}`,
        side: "SELL",
        reason,
        timestamp: Date.now(),
          price: safeSellPrice,
        shares: sharesToSell,
        usd: realizedUsd,
      response,
        }),
      );

    this.clearLiveTradingIssue(username);

    return nextPosition;
  }

  private async executeLiveClose(
    username: string,
    position: StrategyPosition,
    tokenID: string,
    options: { tickSize: "0.1" | "0.01" | "0.001" | "0.0001"; negRisk?: boolean },
    exitReason: string,
  ): Promise<StrategyPosition> {
    const settings = await this.storage.getUserSettings(username);
    const client = this.createLiveTradingClient(settings);
    if (position.remainingShares <= 0) {
      return {
        ...position,
        status: "closed",
        soldPercent: 100,
        exitReason,
      };
    }

    const allowanceReady = await this.ensureLiveAllowance(
      client,
      AssetType.CONDITIONAL,
      position.remainingShares,
      tokenID,
    ).then(
      () => true,
      (error) => {
        this.recordLiveTradingIssue(username, error);
        return false;
      },
    );
    if (!allowanceReady) {
      return position;
    }
    const sellPrice = await client.calculateMarketPrice(
      tokenID,
      ClobSide.SELL,
      position.remainingShares,
      OrderType.FOK,
    ).catch((error) => {
      if (error instanceof Error && error.message.includes("no match")) {
        return null;
      }
      this.recordLiveTradingIssue(username, error);
      return null;
    });
    if (sellPrice == null || !Number.isFinite(sellPrice) || sellPrice <= 0) {
      return position;
    }
    const safeSellPrice = sellPrice;

    const response = await client
      .createAndPostMarketOrder(
        {
          tokenID,
          amount: position.remainingShares,
          side: ClobSide.SELL,
        },
        options,
        OrderType.FOK,
      )
      .catch((error) => {
        this.recordLiveTradingIssue(username, error);
        return null;
      });
    if (!response) {
      return position;
    }

    const realizedUsd = position.remainingShares * safeSellPrice;
    const nextPosition: StrategyPosition = {
      ...position,
      updatedAt: Date.now(),
        lastPrice: safeSellPrice,
      remainingShares: 0,
      realizedUsd: position.realizedUsd + realizedUsd,
      soldPercent: 100,
      status: "closed",
      exitReason,
    };
    await this.storage.saveLiveStrategyTrade(
      username,
      this.buildLiveStrategyTrade(nextPosition, {
        id: `${position.id}:close:${Date.now()}`,
        side: "SELL",
        reason: exitReason,
        timestamp: Date.now(),
          price: safeSellPrice,
        shares: position.remainingShares,
        usd: realizedUsd,
      response,
        }),
      );

    this.clearLiveTradingIssue(username);

    return nextPosition;
  }

  private buildLiveStrategyTrade(
    position: StrategyPosition,
    trade: {
      id: string;
      side: "BUY" | "SELL";
      reason: string;
      timestamp: number;
      price: number;
      shares: number;
      usd: number;
      response: unknown;
    },
  ): StrategyTrade {
    return {
      id: trade.id,
      marketSlug: position.marketSlug,
      marketQuestion: position.marketQuestion,
      marketUrl: position.marketUrl,
      outcome: position.outcome,
      side: trade.side,
      reason: trade.reason,
      timestamp: trade.timestamp,
      price: trade.price,
      shares: trade.shares,
      usd: trade.usd,
      orderId: extractOrderId(trade.response),
      status: extractOrderStatus(trade.response),
      mode: "live",
    };
  }

  private findAssetIdForMarketOutcome(marketSlug: string, outcome: string): string | null {
    for (const [assetId, market] of this.marketsByAssetId.entries()) {
      if (market.slug !== marketSlug) {
        continue;
      }

      if ((market.outcomeByAssetId[assetId] ?? "").trim().toLowerCase() === outcome.trim().toLowerCase()) {
        return assetId;
      }
    }

    return null;
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
  options?: {
    ignorePriceCap?: boolean;
    ignorePriceDeviation?: boolean;
    minOutcomeShare?: number;
    minTotalWeight?: number;
  },
): boolean => {
  return getBestTradeFailureReasons(market, options).length === 0;
};

const getBestTradeFailureReasons = (
  market: MarketAggregate,
  options?: {
    ignorePriceCap?: boolean;
    ignorePriceDeviation?: boolean;
    minOutcomeShare?: number;
    minTotalWeight?: number;
  },
): string[] => {
  const reasons: string[] = [];
  const leadingOutcomeWeight = market.outcomeWeights[0]?.weight ?? 0;
  const minOutcomeShare = options?.minOutcomeShare ?? 0.7;
  const minTotalWeight = options?.minTotalWeight ?? 70;
  if (market.weightedScore < minTotalWeight) {
    reasons.push(`market weight ${market.weightedScore.toFixed(0)} < ${minTotalWeight}`);
  }

  if (leadingOutcomeWeight < market.weightedScore * minOutcomeShare) {
    reasons.push(
      `outcome weight share ${(market.weightedScore > 0 ? (leadingOutcomeWeight / market.weightedScore) * 100 : 0).toFixed(0)}% < ${(minOutcomeShare * 100).toFixed(0)}%`,
    );
  }

  if (market.participantCount < 3) {
    reasons.push(`participants ${market.participantCount} < 3`);
  }

  if (Date.now() - market.latestTimestamp > 24 * 60 * 60_000) {
    reasons.push("signal older than 24h");
  }

  if (market.observedAvgEntry === null || market.observedAvgEntry <= 0) {
    reasons.push("missing avg entry");
    return reasons;
  }

  const currentDisplayedPrice = market.latestSignal.averagePrice;
  if (!options?.ignorePriceCap && currentDisplayedPrice >= 0.9) {
    reasons.push(`price ${currentDisplayedPrice.toFixed(3)} >= 0.900`);
  }

  const priceDeviation = Math.abs(currentDisplayedPrice - market.observedAvgEntry) / market.observedAvgEntry;
  if (!options?.ignorePriceDeviation && priceDeviation > 0.05) {
    reasons.push(`price deviation ${(priceDeviation * 100).toFixed(1)}% > 5%`);
  }

  return reasons;
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

const buildStrategyDashboard = (
  positions: StrategyPosition[],
  cashBalanceUsd: number,
): StrategyDashboardResponse => {
  const openPositions = positions.filter((position) => position.status === "open");
  const closedPositions = positions.filter((position) => position.status === "closed");
  const openExposureUsd = openPositions.reduce(
    (sum, position) => sum + position.remainingShares * position.lastPrice,
    0,
  );
  const unrealizedUsd = openPositions.reduce(
    (sum, position) => sum + (position.remainingShares * position.lastPrice - position.remainingShares * position.entryPrice),
    0,
  );
  const trades = positions
    .flatMap((position) => buildStrategyTrades(position))
    .sort((left, right) => right.timestamp - left.timestamp);

  return {
    summary: {
      cashBalanceUsd,
      openPositionCount: openPositions.length,
      closedPositionCount: closedPositions.length,
      totalPositionCount: positions.length,
      openExposureUsd,
      unrealizedUsd,
      totalEquityUsd: cashBalanceUsd + openExposureUsd,
    },
    positions,
    trades,
  };
};

const buildStoredStrategyDashboard = (
  positions: StrategyPosition[],
  trades: StrategyTrade[],
  cashBalanceUsd: number,
): StrategyDashboardResponse => {
  const openPositions = positions.filter((position) => position.status === "open");
  const closedPositions = positions.filter((position) => position.status === "closed");
  const openExposureUsd = openPositions.reduce(
    (sum, position) => sum + position.remainingShares * position.lastPrice,
    0,
  );
  const unrealizedUsd = openPositions.reduce(
    (sum, position) => sum + (position.remainingShares * position.lastPrice - position.remainingShares * position.entryPrice),
    0,
  );

  return {
    summary: {
      cashBalanceUsd,
      openPositionCount: openPositions.length,
      closedPositionCount: closedPositions.length,
      totalPositionCount: positions.length,
      openExposureUsd,
      unrealizedUsd,
      totalEquityUsd: cashBalanceUsd + openExposureUsd,
    },
    positions,
    trades: [...trades].sort((left, right) => right.timestamp - left.timestamp),
  };
};

const calculatePaperCashBalanceFromPositions = (
  positions: StrategyPosition[],
  startingBalanceUsd: number,
): number =>
  Math.max(
    0,
    startingBalanceUsd -
      positions.reduce((sum, position) => sum + position.entryNotionalUsd, 0) +
      positions.reduce((sum, position) => sum + position.realizedUsd, 0),
  );

const normalizeOutcomeName = (value: string): string => value.trim().toLowerCase();

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isSportsMarket = (market: MarketRecord): boolean => {
  const category = market.category?.trim().toLowerCase() ?? "";
  if (category.includes("sport")) {
    return true;
  }

  const eventTitle = market.eventTitle?.trim().toLowerCase() ?? "";
  return ["mlb", "nba", "nfl", "nhl", "uefa", "soccer", "football", "baseball", "basketball", "tennis", "golf", "mma", "ufc", "lol", "esports", "cricket"].some(
    (keyword) => eventTitle.includes(keyword),
  );
};

const isBinaryYesNoMarket = (market: MarketRecord): boolean => {
  const outcomes = Object.values(market.outcomeByAssetId).map((value) => value.trim().toLowerCase());
  return outcomes.length === 2 && outcomes.includes("yes") && outcomes.includes("no");
};

const findAssetIdForOutcome = (market: MarketRecord, outcome: string): string | null => {
  const normalizedOutcome = outcome.trim().toLowerCase();
  for (const [assetId, assetOutcome] of Object.entries(market.outcomeByAssetId)) {
    if (assetOutcome.trim().toLowerCase() === normalizedOutcome) {
      return assetId;
    }
  }

  return null;
};

const buildHeadToHeadGapCandidates = (
  eventSlug: string,
  markets: MarketRecord[],
) : GapCandidate[] => {
  if (markets.length < 2) {
    return [];
  }

  const eventTitle = markets[0]?.eventTitle ?? markets[0]?.question ?? eventSlug;
  const teams = parseMatchupTeams(eventTitle);
  if (!teams) {
    return [];
  }

  const enrichedMarkets = markets
    .map((market) => {
      const teamIndex = identifyMentionedTeam(market.question, teams);
      const objective = deriveGapObjective(market.question, teams);
      const noAssetId = findAssetIdForOutcome(market, "No");
      if (teamIndex === null || !objective || !noAssetId) {
        return null;
      }

      return {
        market,
        teamIndex,
        objective,
        noAssetId,
      };
    })
    .filter((entry): entry is { market: MarketRecord; teamIndex: 0 | 1; objective: string; noAssetId: string } => Boolean(entry));

  const byObjective = new Map<string, { first?: typeof enrichedMarkets[number]; second?: typeof enrichedMarkets[number] }>();
  for (const entry of enrichedMarkets) {
    const objectiveGroup = byObjective.get(entry.objective) ?? {};
    if (entry.teamIndex === 0 && !objectiveGroup.first) {
      objectiveGroup.first = entry;
    } else if (entry.teamIndex === 1 && !objectiveGroup.second) {
      objectiveGroup.second = entry;
    }
    byObjective.set(entry.objective, objectiveGroup);
  }

  const candidates: GapCandidate[] = [];
  for (const [objective, pair] of byObjective.entries()) {
    if (!pair.first || !pair.second) {
      continue;
    }

    const [first, second] = [pair.first, pair.second].sort((left, right) =>
      left.market.slug.localeCompare(right.market.slug),
    );
    candidates.push({
      id: `${eventSlug}:${objective}:${first.market.slug}:${second.market.slug}`,
      eventSlug,
      eventTitle,
      pairType: "head_to_head_no_no",
      pairLabel: `Head-to-head no/no · ${formatGapObjectiveLabel(objective)}`,
      legs: [
        {
          marketSlug: first.market.slug,
          marketQuestion: first.market.question,
          marketUrl: `https://polymarket.com/event/${first.market.slug}`,
          noAssetId: first.noAssetId,
        },
        {
          marketSlug: second.market.slug,
          marketQuestion: second.market.question,
          marketUrl: `https://polymarket.com/event/${second.market.slug}`,
          noAssetId: second.noAssetId,
        },
      ],
    });
  }

  return candidates;
};

const buildDirectMarketGapCandidates = (
  eventSlug: string,
  markets: MarketRecord[],
): GapCandidate[] => {
  const candidates: GapCandidate[] = [];

  for (const market of markets) {
    if (isBinaryYesNoMarket(market)) {
      continue;
    }

    const outcomeEntries = Object.entries(market.outcomeByAssetId);
    if (outcomeEntries.length !== 2) {
      continue;
    }

    const eventTitle = market.eventTitle ?? market.question;
    const teams = parseMatchupTeams(eventTitle);
    if (!teams) {
      continue;
    }

    const firstOutcomeTeam = identifyMentionedTeam(outcomeEntries[0][1], teams);
    const secondOutcomeTeam = identifyMentionedTeam(outcomeEntries[1][1], teams);
    if (firstOutcomeTeam === null || secondOutcomeTeam === null || firstOutcomeTeam === secondOutcomeTeam) {
      continue;
    }

    const objective = deriveDirectMarketObjective(market, outcomeEntries.map((entry) => entry[1]));
    candidates.push({
      id: `${eventSlug}:direct:${market.slug}`,
      eventSlug,
      eventTitle,
      pairType: "direct_market_pair",
      pairLabel: `Direct market · ${formatGapObjectiveLabel(objective)}`,
      legs: [
        {
          marketSlug: market.slug,
          marketQuestion: `${market.question} — ${outcomeEntries[0][1]}`,
          marketUrl: `https://polymarket.com/event/${market.slug}`,
          noAssetId: outcomeEntries[0][0],
        },
        {
          marketSlug: market.slug,
          marketQuestion: `${market.question} — ${outcomeEntries[1][1]}`,
          marketUrl: `https://polymarket.com/event/${market.slug}`,
          noAssetId: outcomeEntries[1][0],
        },
      ],
    });
  }

  return candidates;
};

const parseMatchupTeams = (eventTitle: string): [string, string] | null => {
  const normalized = eventTitle.trim();
  const separators = [" vs. ", " vs ", " v. ", " v ", " @ ", " at "];
  for (const separator of separators) {
    const separatorIndex = normalized.toLowerCase().indexOf(separator.trim().toLowerCase());
    if (separatorIndex === -1) {
      continue;
    }

    const parts = normalized.split(new RegExp(separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    if (parts.length !== 2) {
      continue;
    }

    const left = sanitizeTeamName(parts[0]);
    const right = sanitizeTeamName(parts[1]);
    if (left && right) {
      return [left, right];
    }
  }

  return null;
};

const sanitizeTeamName = (value: string): string =>
  value
    .replace(/\([^)]*\)/g, "")
    .replace(/\bbo\d+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeTeamName = (value: string): string =>
  sanitizeTeamName(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildTeamAliases = (team: string): string[] => {
  const sanitized = sanitizeTeamName(team);
  const normalized = normalizeTeamName(sanitized);
  const words = normalized.split(" ").filter(Boolean);
  const aliases = new Set<string>();

  if (normalized) {
    aliases.add(normalized);
  }

  for (const word of words) {
    aliases.add(word);
  }

  const firstWord = words[0];
  if (firstWord && firstWord.length >= 3) {
    aliases.add(firstWord.slice(0, 3));
  }

  if (words.length >= 2) {
    aliases.add(words.map((word) => word[0]).join(""));
  }

  const clubSuffix = words[words.length - 1];
  if (firstWord && clubSuffix && ["fc", "cf", "sc", "ac"].includes(clubSuffix)) {
    aliases.add(`${firstWord[0]}${clubSuffix}`);
  }

  return Array.from(aliases).filter(Boolean);
};

const identifyMentionedTeam = (
  question: string,
  teams: [string, string],
): 0 | 1 | null => {
  const normalizedQuestion = normalizeTeamName(question);
  const matches = teams
    .map((team, index) => ({ index: index as 0 | 1, aliases: buildTeamAliases(team) }))
    .filter(({ aliases }) => aliases.some((alias) => alias && normalizedQuestion.includes(alias)));

  if (matches.length !== 1) {
    return null;
  }

  return matches[0].index;
};

const deriveGapObjective = (
  question: string,
  teams: [string, string],
): string | null => {
  const normalizedQuestion = normalizeTeamName(question);
  const strippedQuestion = teams.reduce(
    (current, team) => current.replaceAll(normalizeTeamName(team), " "),
    normalizedQuestion,
  );

  if (/\bwin\b|\bbeat\b/.test(strippedQuestion)) {
    return "win";
  }

  if (/\badvance\b|\bqualify\b|\breach\b/.test(strippedQuestion)) {
    return "advance";
  }

  return null;
};

const deriveDirectMarketObjective = (
  market: MarketRecord,
  outcomes: string[],
): string => {
  const normalizedQuestion = normalizeTeamName(market.question);
  const normalizedOutcomes = outcomes.map((outcome) => normalizeTeamName(outcome));

  if (normalizedOutcomes.some((outcome) => /(^| )[-+]\d+(\.\d+)?($| )/.test(outcome))) {
    return "spread";
  }

  if (/\bspread\b/.test(normalizedQuestion)) {
    return "spread";
  }

  return "win";
};

const formatGapObjectiveLabel = (objective: string): string => {
  if (objective === "win") {
    return "Win";
  }

  if (objective === "advance") {
    return "Advance";
  }

  if (objective === "spread") {
    return "Spread";
  }

  return objective;
};

const buildStrategyTrades = (position: StrategyPosition): StrategyTrade[] => {
  const trades: StrategyTrade[] = [];
  const initialShares = position.entryPrice > 0 ? position.entryNotionalUsd / position.entryPrice : 0;
  const halfShares = initialShares * 0.5;

  trades.push({
    id: `${position.id}:entry`,
    marketSlug: position.marketSlug,
    marketQuestion: position.marketQuestion,
    marketUrl: position.marketUrl,
    outcome: position.outcome,
    side: "BUY",
    reason: "Entry",
    timestamp: position.openedAt,
      price: position.entryPrice,
      shares: initialShares,
      usd: position.entryNotionalUsd,
      mode: "paper",
    });

  if (position.trim96Hit) {
    trades.push({
      id: `${position.id}:trim96`,
      marketSlug: position.marketSlug,
      marketQuestion: position.marketQuestion,
      marketUrl: position.marketUrl,
      outcome: position.outcome,
      side: "SELL",
      reason: "Trim 0.96",
      timestamp: position.updatedAt,
      price: 0.96,
      shares: halfShares,
      usd: halfShares * 0.96,
      mode: "paper",
    });
  }

  if (position.status === "closed") {
    trades.push({
      id: `${position.id}:final`,
      marketSlug: position.marketSlug,
      marketQuestion: position.marketQuestion,
      marketUrl: position.marketUrl,
      outcome: position.outcome,
      side: "SELL",
      reason: position.exitReason || "Final exit",
      timestamp: position.updatedAt,
      price: position.lastPrice,
      shares: initialShares * 0.5,
      usd: initialShares * 0.5 * position.lastPrice,
      mode: "paper",
    });
  }

  return trades;
};

const extractOrderId = (response: unknown): string | undefined => {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const candidate = (response as Record<string, unknown>).orderID
    ?? (response as Record<string, unknown>).orderId
    ?? (response as Record<string, unknown>).id;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
};

const extractOrderStatus = (response: unknown): string | undefined => {
  if (!response || typeof response !== "object") {
    return undefined;
  }

  const candidate = (response as Record<string, unknown>).status
    ?? (response as Record<string, unknown>).success;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate;
  }

  if (typeof candidate === "boolean") {
    return candidate ? "success" : "failed";
  }

  return undefined;
};
