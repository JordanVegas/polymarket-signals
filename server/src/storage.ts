import { MongoClient } from "mongodb";
import { config } from "./config.js";
import type {
  GapOpportunity,
  MarketAggregate,
  StrategyKey,
  StrategyPosition,
  StrategyTrade,
  TradeRecord,
  TraderSummary,
  WhaleSignal,
} from "./types.js";

type PersistedSignal = WhaleSignal & {
  updatedAt: Date;
};

export type PersistedTrade = {
  tradeId: string;
  proxyWallet: string;
  asset: string;
  side: "BUY" | "SELL";
  timestamp: number;
  totalUsd: number;
  createdAt: Date;
};

export type PersistedObservedTrade = TradeRecord & {
  tradeId: string;
  createdAt: Date;
};

export type PersistedMarketCatchup = {
  marketId: string;
  requestedAt: Date;
  completedAt?: Date;
};

export type PersistedTraderCatchup = {
  wallet: string;
  requestedAt: Date;
  completedAt?: Date;
};

export type PersistedCluster = {
  clusterKey: string;
  wallet: string;
  assetId: string;
  side: "BUY" | "SELL";
  outcome: string;
  market: {
    id: string;
    conditionId?: string;
    question: string;
    slug: string;
    image: string;
    endDate: string;
    liquidity: number;
    volume24hr: number;
    outcomeByAssetId: Record<string, string>;
  };
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
  expiresAt: Date;
};

export type PersistedUserWebhookSetting = {
  username: string;
  webhookUrl?: string;
  monitoredWallet?: string;
  autoTradeEnabled?: boolean;
  liveTradeEnabled?: boolean;
  startingBalanceUsd?: number;
  currentBalanceUsd?: number;
  riskPercent?: number;
  edgeSwingPaperTradingEnabled?: boolean;
  edgeSwingLiveTradingEnabled?: boolean;
  edgeSwingStartingBalanceUsd?: number;
  edgeSwingCurrentBalanceUsd?: number;
  edgeSwingRiskPercent?: number;
  tradingWalletAddress?: string;
  tradingSignatureType?: "EOA" | "POLY_PROXY";
  encryptedPrivateKey?: string;
  encryptedApiKey?: string;
  encryptedApiSecret?: string;
  encryptedApiPassphrase?: string;
  updatedAt: Date;
};

export type PersistedTraderSummary = TraderSummary & {
  updatedAt: Date;
};

export type PersistedTrackedTrader = TraderSummary & {
  lastSeenActivityTimestamp: number;
  lastPolledAt?: Date;
  updatedAt: Date;
};

export type PersistedMarketAggregate = MarketAggregate & {
  updatedAt: Date;
};

export type PersistedGapOpportunity = GapOpportunity & {
  updatedAtDate: Date;
};

export type PersistedBestTradeCandidate = {
  marketSlug: string;
  outcome: string;
  marketQuestion: string;
  marketUrl: string;
  marketImage: string;
  firstQualifiedAt: number;
  lastQualifiedAt: number;
  weightedScore: number;
  leadingOutcomeWeight: number;
  participantCount: number;
  observedAvgEntry: number | null;
  lastPrice: number;
  resolvedAt?: number;
  winningOutcome?: string;
  won?: boolean;
  updatedAt: Date;
};

export type PersistedMarketAlertWatch = {
  username: string;
  marketSlug: string;
  outcome: string;
  source: "manual" | "portfolio_sync";
  createdAt: Date;
  updatedAt: Date;
};

export type PersistedAlertDelivery = {
  username: string;
  marketSlug: string;
  outcome: string;
  signalId: string;
  sentAt: Date;
};

export type PersistedStrategyPosition = StrategyPosition & {
  updatedAtDate: Date;
};

export type PersistedLiveStrategyPosition = StrategyPosition & {
  updatedAtDate: Date;
};

export type PersistedLiveStrategyTrade = StrategyTrade & {
  username: string;
  updatedAtDate: Date;
};

const strategyKeyFilter = (strategyKey: StrategyKey) =>
  strategyKey === "best_trades" ? { $ne: "edge_swing" as StrategyKey } : strategyKey;

export class SignalStorage {
  private client: MongoClient | null = null;

  async connect(): Promise<void> {
    if (!config.mongoUri) {
      throw new Error("MONGO_URI is required for Polymarket Signals");
    }

    this.client = new MongoClient(config.mongoUri);
    await this.client.connect();
    await this.collection().createIndex({ id: 1 }, { unique: true });
    await this.collection().createIndex({ timestamp: -1 });
    await this.collection().createIndex({ marketSlug: 1, timestamp: -1 });
    await this.marketAggregateCollection().createIndex({ marketSlug: 1 }, { unique: true });
    await this.marketAggregateCollection().createIndex({ latestTimestamp: -1 });
    await this.marketAggregateCollection().createIndex({ weightedScore: -1, latestTimestamp: -1 });
    await this.marketAggregateCollection().createIndex({ participantCount: -1, latestTimestamp: -1 });
    await this.gapOpportunityCollection().createIndex({ id: 1 }, { unique: true });
    await this.gapOpportunityCollection().createIndex({ grossEdge: -1, updatedAt: -1 });
    await this.gapOpportunityCollection().createIndex({ combinedNoAsk: 1, updatedAt: -1 });
    await this.bestTradeCandidateCollection().createIndex({ marketSlug: 1, outcome: 1 }, { unique: true });
    await this.bestTradeCandidateCollection().createIndex({ resolvedAt: 1, updatedAt: -1 });
    await this.bestTradeCandidateCollection().createIndex({ won: 1, resolvedAt: -1 });
    await this.bestTradeCandidateCollection().createIndex({ lastQualifiedAt: -1 });
    await this.strategyPositionCollection().createIndex({ id: 1 }, { unique: true });
    await this.strategyPositionCollection().createIndex({ status: 1, updatedAt: -1 });
    await this.strategyPositionCollection().createIndex({ username: 1, status: 1, updatedAt: -1 });
    await this.strategyPositionCollection().createIndex({ username: 1, marketSlug: 1, outcome: 1, status: 1 });
    await this.liveStrategyPositionCollection().createIndex({ id: 1 }, { unique: true });
    await this.liveStrategyPositionCollection().createIndex({ status: 1, updatedAt: -1 });
    await this.liveStrategyPositionCollection().createIndex({ username: 1, status: 1, updatedAt: -1 });
    await this.liveStrategyPositionCollection().createIndex({ username: 1, marketSlug: 1, outcome: 1, status: 1 });
    await this.liveStrategyTradeCollection().createIndex({ id: 1 }, { unique: true });
    await this.liveStrategyTradeCollection().createIndex({ username: 1, timestamp: -1 });
    await this.tradeCollection().createIndex({ tradeId: 1 }, { unique: true });
    await this.tradeCollection().createIndex({ timestamp: -1 });
    await this.observedTradeCollection().createIndex({ tradeId: 1 }, { unique: true });
    await this.observedTradeCollection().createIndex({ timestamp: -1 });
    await this.marketCatchupCollection().createIndex({ marketId: 1 }, { unique: true });
    await this.traderCatchupCollection().createIndex({ wallet: 1 }, { unique: true });
    await this.clusterCollection().createIndex({ clusterKey: 1 }, { unique: true });
    await this.clusterCollection().createIndex({ updatedAt: -1 });
    await this.clusterCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.userWebhookCollection().createIndex({ username: 1 }, { unique: true });
    await this.userWebhookCollection().createIndex({ monitoredWallet: 1 });
    await this.traderSummaryCollection().createIndex({ wallet: 1 }, { unique: true });
    await this.traderSummaryCollection().createIndex({ updatedAt: -1 });
    await this.trackedTraderCollection().createIndex({ wallet: 1 }, { unique: true });
    await this.trackedTraderCollection().createIndex({ tier: 1, updatedAt: -1 });
    await this.trackedTraderCollection().createIndex({ lastPolledAt: 1, updatedAt: -1 });
    await this.dropLegacyMarketAlertIndexes();
    await this.marketAlertWatchCollection().createIndex(
      { username: 1, marketSlug: 1, outcome: 1, source: 1 },
      { unique: true },
    );
    await this.marketAlertWatchCollection().createIndex({ marketSlug: 1, outcome: 1, username: 1 });
    await this.marketAlertWatchCollection().createIndex({ username: 1, updatedAt: -1, createdAt: -1 });
    await this.alertDeliveryCollection().createIndex(
      { username: 1, marketSlug: 1, outcome: 1, signalId: 1 },
      { unique: true },
    );
  }

  async loadRecentSignals(limit: number): Promise<WhaleSignal[]> {
    const rows = await this.collection()
      .find({}, { sort: { timestamp: -1 }, limit })
      .toArray();

    return rows.map(({ _id: _ignored, updatedAt: _updatedAt, ...signal }) => signal);
  }

  async loadSignalsForMarketSlugs(marketSlugs: string[]): Promise<WhaleSignal[]> {
    if (marketSlugs.length === 0) {
      return [];
    }

    const rows = await this.collection()
      .find({ marketSlug: { $in: marketSlugs } }, { sort: { timestamp: -1 } })
      .toArray();

    return rows.map(({ _id: _ignored, updatedAt: _updatedAt, ...signal }) => signal);
  }

  async saveSignal(signal: WhaleSignal): Promise<void> {
    const payload: PersistedSignal = {
      ...signal,
      updatedAt: new Date(),
    };

    await this.collection().updateOne(
      { id: signal.id },
      { $set: payload },
      { upsert: true },
    );
  }

  async loadMarketAggregates(marketSlugs: string[]): Promise<MarketAggregate[]> {
    if (marketSlugs.length === 0) {
      return [];
    }

    const rows = await this.marketAggregateCollection()
      .find({ marketSlug: { $in: marketSlugs } })
      .toArray();

    return rows.map(({ _id: _ignored, updatedAt: _updatedAt, ...aggregate }) => aggregate);
  }

  async loadBestTradeMarketSlugs(limit = 500): Promise<string[]> {
    const rows = await this.marketAggregateCollection()
      .find({ isBestTrade: true }, { projection: { _id: 0, marketSlug: 1 }, sort: { latestTimestamp: -1 }, limit })
      .toArray();

    return rows.map((row) => row.marketSlug).filter((marketSlug): marketSlug is string => Boolean(marketSlug));
  }

  async saveMarketAggregate(aggregate: MarketAggregate): Promise<void> {
    const payload: PersistedMarketAggregate = {
      ...aggregate,
      updatedAt: new Date(),
    };

    await this.marketAggregateCollection().updateOne(
      { marketSlug: aggregate.marketSlug },
      { $set: payload },
      { upsert: true },
    );
  }

  async deleteMarketAggregate(marketSlug: string): Promise<void> {
    await this.marketAggregateCollection().deleteOne({ marketSlug });
  }

  async saveGapOpportunity(gap: GapOpportunity): Promise<void> {
    const payload: PersistedGapOpportunity = {
      ...gap,
      updatedAtDate: new Date(),
    };

    await this.gapOpportunityCollection().updateOne(
      { id: gap.id },
      { $set: payload },
      { upsert: true },
    );
  }

  async deleteGapOpportunity(id: string): Promise<void> {
    await this.gapOpportunityCollection().deleteOne({ id });
  }

  async pruneGapOpportunities(validIds: string[]): Promise<void> {
    if (validIds.length === 0) {
      await this.gapOpportunityCollection().deleteMany({});
      return;
    }

    await this.gapOpportunityCollection().deleteMany({
      id: { $nin: validIds },
    });
  }

  async loadGapOpportunities(page: number, pageSize: number): Promise<{
    items: GapOpportunity[];
    total: number;
  }> {
    const safePage = Math.max(1, page);
    const safePageSize = Math.max(1, Math.min(pageSize, 100));
    const [rows, total] = await Promise.all([
      this.gapOpportunityCollection()
        .find({ combinedNoAsk: { $lt: 1 } }, { sort: { grossEdge: -1, updatedAt: -1 } })
        .skip((safePage - 1) * safePageSize)
        .limit(safePageSize)
        .toArray(),
      this.gapOpportunityCollection().countDocuments({ combinedNoAsk: { $lt: 1 } }),
    ]);

    return {
      items: rows.map(({ _id: _ignored, updatedAtDate: _updatedAtDate, ...gap }) => gap),
      total,
    };
  }

  async upsertBestTradeCandidate(candidate: Omit<PersistedBestTradeCandidate, "updatedAt">): Promise<void> {
    await this.bestTradeCandidateCollection().updateOne(
      { marketSlug: candidate.marketSlug, outcome: candidate.outcome },
      {
        $set: {
          marketQuestion: candidate.marketQuestion,
          marketUrl: candidate.marketUrl,
          marketImage: candidate.marketImage,
          lastQualifiedAt: candidate.lastQualifiedAt,
          weightedScore: candidate.weightedScore,
          leadingOutcomeWeight: candidate.leadingOutcomeWeight,
          participantCount: candidate.participantCount,
          observedAvgEntry: candidate.observedAvgEntry,
          lastPrice: candidate.lastPrice,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          firstQualifiedAt: candidate.firstQualifiedAt,
        },
      },
      { upsert: true },
    );
  }

  async loadUnresolvedBestTradeCandidates(limit = 250): Promise<Array<Omit<PersistedBestTradeCandidate, "updatedAt">>> {
    const rows = await this.bestTradeCandidateCollection()
      .find({ resolvedAt: { $exists: false } }, { sort: { lastQualifiedAt: -1 }, limit })
      .toArray();

    return rows.map(({ _id: _ignored, updatedAt: _updatedAt, ...candidate }) => candidate);
  }

  async resolveBestTradeCandidate(
    marketSlug: string,
    outcome: string,
    resolution: { resolvedAt: number; winningOutcome: string; won: boolean },
  ): Promise<void> {
    await this.bestTradeCandidateCollection().updateOne(
      { marketSlug, outcome },
      {
        $set: {
          resolvedAt: resolution.resolvedAt,
          winningOutcome: resolution.winningOutcome,
          won: resolution.won,
          updatedAt: new Date(),
        },
      },
    );
  }

  async getBestTradeStats(): Promise<{
    trackedCount: number;
    resolvedCount: number;
    winCount: number;
    lossCount: number;
  }> {
    const [trackedCount, resolvedCount, winCount] = await Promise.all([
      this.bestTradeCandidateCollection().countDocuments({}),
      this.bestTradeCandidateCollection().countDocuments({ resolvedAt: { $exists: true } }),
      this.bestTradeCandidateCollection().countDocuments({ won: true }),
    ]);

    return {
      trackedCount,
      resolvedCount,
      winCount,
      lossCount: Math.max(0, resolvedCount - winCount),
    };
  }

  async loadStrategyPositions(
    username: string,
    strategyKey: StrategyKey = "best_trades",
    limit = 100,
  ): Promise<StrategyPosition[]> {
    const rows = await this.strategyPositionCollection()
      .find({ username, strategyKey: strategyKeyFilter(strategyKey) }, { sort: { updatedAt: -1 }, limit })
      .toArray();

    return rows.map(({ _id: _ignored, updatedAtDate: _updatedAtDate, ...position }) => ({
      ...position,
      strategyKey: position.strategyKey ?? "best_trades",
    }));
  }

  async loadOpenStrategyPosition(
    username: string,
    marketSlug: string,
    outcome: string,
    strategyKey: StrategyKey = "best_trades",
  ): Promise<StrategyPosition | null> {
    const row = await this.strategyPositionCollection().findOne({
      username,
      marketSlug,
      outcome,
      strategyKey: strategyKeyFilter(strategyKey),
      status: "open",
    });

    if (!row) {
      return null;
    }

    const { _id: _ignored, updatedAtDate: _updatedAtDate, ...position } = row;
    return { ...position, strategyKey: position.strategyKey ?? "best_trades" };
  }

  async loadOpenStrategyPositionForMarket(
    username: string,
    marketSlug: string,
    strategyKey: StrategyKey = "best_trades",
  ): Promise<StrategyPosition | null> {
    const row = await this.strategyPositionCollection().findOne({
      username,
      marketSlug,
      strategyKey: strategyKeyFilter(strategyKey),
      status: "open",
    });

    if (!row) {
      return null;
    }

    const { _id: _ignored, updatedAtDate: _updatedAtDate, ...position } = row;
    return { ...position, strategyKey: position.strategyKey ?? "best_trades" };
  }

  async saveStrategyPosition(position: StrategyPosition): Promise<void> {
    const payload: PersistedStrategyPosition = {
      ...position,
      strategyKey: position.strategyKey ?? "best_trades",
      updatedAtDate: new Date(),
    };

    await this.strategyPositionCollection().updateOne(
      { id: position.id },
      { $set: payload },
      { upsert: true },
    );
  }

  async loadLiveStrategyPositions(
    username: string,
    strategyKey: StrategyKey = "best_trades",
    limit = 100,
  ): Promise<StrategyPosition[]> {
    const rows = await this.liveStrategyPositionCollection()
      .find({ username, strategyKey: strategyKeyFilter(strategyKey) }, { sort: { updatedAt: -1 }, limit })
      .toArray();

    return rows.map(({ _id: _ignored, updatedAtDate: _updatedAtDate, ...position }) => ({
      ...position,
      strategyKey: position.strategyKey ?? "best_trades",
    }));
  }

  async loadOpenLiveStrategyPosition(
    username: string,
    marketSlug: string,
    outcome: string,
    strategyKey: StrategyKey = "best_trades",
  ): Promise<StrategyPosition | null> {
    const row = await this.liveStrategyPositionCollection().findOne({
      username,
      marketSlug,
      outcome,
      strategyKey: strategyKeyFilter(strategyKey),
      status: "open",
    });

    if (!row) {
      return null;
    }

    const { _id: _ignored, updatedAtDate: _updatedAtDate, ...position } = row;
    return { ...position, strategyKey: position.strategyKey ?? "best_trades" };
  }

  async loadOpenLiveStrategyPositionForMarket(
    username: string,
    marketSlug: string,
    strategyKey: StrategyKey = "best_trades",
  ): Promise<StrategyPosition | null> {
    const row = await this.liveStrategyPositionCollection().findOne({
      username,
      marketSlug,
      strategyKey: strategyKeyFilter(strategyKey),
      status: "open",
    });

    if (!row) {
      return null;
    }

    const { _id: _ignored, updatedAtDate: _updatedAtDate, ...position } = row;
    return { ...position, strategyKey: position.strategyKey ?? "best_trades" };
  }

  async saveLiveStrategyPosition(position: StrategyPosition): Promise<void> {
    const payload: PersistedLiveStrategyPosition = {
      ...position,
      strategyKey: position.strategyKey ?? "best_trades",
      updatedAtDate: new Date(),
    };

    await this.liveStrategyPositionCollection().updateOne(
      { id: position.id },
      { $set: payload },
      { upsert: true },
    );
  }

  async loadLiveStrategyTrades(
    username: string,
    strategyKey: StrategyKey = "best_trades",
    limit = 200,
  ): Promise<StrategyTrade[]> {
    const rows = await this.liveStrategyTradeCollection()
      .find({ username, strategyKey: strategyKeyFilter(strategyKey) }, { sort: { timestamp: -1 }, limit })
      .toArray();

    return rows.map(({ _id: _ignored, username: _username, updatedAtDate: _updatedAtDate, ...trade }) => ({
      ...trade,
      strategyKey: trade.strategyKey ?? "best_trades",
    }));
  }

  async saveLiveStrategyTrade(username: string, trade: StrategyTrade): Promise<void> {
    const payload: PersistedLiveStrategyTrade = {
      ...trade,
      strategyKey: trade.strategyKey ?? "best_trades",
      username,
      updatedAtDate: new Date(),
    };

    await this.liveStrategyTradeCollection().updateOne(
      { id: trade.id },
      { $set: payload },
      { upsert: true },
    );
  }

  async markTradeProcessed(trade: PersistedTrade): Promise<boolean> {
    const result = await this.tradeCollection().updateOne(
      { tradeId: trade.tradeId },
      { $setOnInsert: trade },
      { upsert: true },
    );

    return result.upsertedCount > 0;
  }

  async hasProcessedTrade(tradeId: string): Promise<boolean> {
    return (await this.tradeCollection().countDocuments({ tradeId }, { limit: 1 })) > 0;
  }

  async saveObservedTrade(trade: PersistedObservedTrade): Promise<boolean> {
    const result = await this.observedTradeCollection().updateOne(
      { tradeId: trade.tradeId },
      { $setOnInsert: trade },
      { upsert: true },
    );

    return result.upsertedCount > 0;
  }

  async loadObservedTradesSince(timestampSec: number, limit: number): Promise<TradeRecord[]> {
    const rows = await this.observedTradeCollection()
      .find({ timestamp: { $gte: timestampSec } }, { sort: { timestamp: 1 }, limit })
      .toArray();

    return rows.map(({ _id: _ignored, tradeId: _tradeId, createdAt: _createdAt, ...trade }) => trade);
  }

  async markMarketCatchupStarted(marketId: string): Promise<boolean> {
    const result = await this.marketCatchupCollection().updateOne(
      { marketId },
      {
        $setOnInsert: {
          marketId,
          requestedAt: new Date(),
        },
      },
      { upsert: true },
    );

    return result.upsertedCount > 0;
  }

  async markMarketCatchupCompleted(marketId: string): Promise<void> {
    await this.marketCatchupCollection().updateOne(
      { marketId },
      { $set: { completedAt: new Date() } },
      { upsert: true },
    );
  }

  async clearMarketCatchup(marketId: string): Promise<void> {
    await this.marketCatchupCollection().deleteOne({ marketId });
  }

  async markTraderCatchupStarted(wallet: string): Promise<boolean> {
    const result = await this.traderCatchupCollection().updateOne(
      { wallet },
      {
        $setOnInsert: {
          wallet,
          requestedAt: new Date(),
        },
      },
      { upsert: true },
    );

    return result.upsertedCount > 0;
  }

  async markTraderCatchupCompleted(wallet: string): Promise<void> {
    await this.traderCatchupCollection().updateOne(
      { wallet },
      { $set: { completedAt: new Date() } },
      { upsert: true },
    );
  }

  async clearTraderCatchup(wallet: string): Promise<void> {
    await this.traderCatchupCollection().deleteOne({ wallet });
  }

  async loadActiveClusters(cutoffMs: number): Promise<PersistedCluster[]> {
    return this.clusterCollection()
      .find({ updatedAt: { $gte: cutoffMs } })
      .toArray();
  }

  async saveCluster(cluster: PersistedCluster): Promise<void> {
    await this.clusterCollection().updateOne(
      { clusterKey: cluster.clusterKey },
      { $set: cluster },
      { upsert: true },
    );
  }

  async deleteCluster(clusterKey: string): Promise<void> {
    await this.clusterCollection().deleteOne({ clusterKey });
  }

  async updateUserSettings(
    username: string,
    updates: {
      webhookUrl?: string;
      monitoredWallet?: string;
      autoTradeEnabled?: boolean;
      liveTradeEnabled?: boolean;
      startingBalanceUsd?: number;
      currentBalanceUsd?: number;
      riskPercent?: number;
      edgeSwingPaperTradingEnabled?: boolean;
      edgeSwingLiveTradingEnabled?: boolean;
      edgeSwingStartingBalanceUsd?: number;
      edgeSwingCurrentBalanceUsd?: number;
      edgeSwingRiskPercent?: number;
      tradingWalletAddress?: string;
      tradingSignatureType?: "EOA" | "POLY_PROXY";
      encryptedPrivateKey?: string;
      encryptedApiKey?: string;
      encryptedApiSecret?: string;
      encryptedApiPassphrase?: string;
      clearTradingCredentials?: boolean;
    },
  ): Promise<void> {
    const { clearTradingCredentials, ...restUpdates } = updates;
    const unset: Record<string, "" | 1> = {};
    if (clearTradingCredentials) {
      unset.encryptedPrivateKey = "";
      unset.encryptedApiKey = "";
      unset.encryptedApiSecret = "";
      unset.encryptedApiPassphrase = "";
    }

    await this.userWebhookCollection().updateOne(
      { username },
      {
        $set: {
          username,
          ...restUpdates,
          updatedAt: new Date(),
        },
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      },
      { upsert: true },
    );
  }

  async getUserSettings(
    username: string,
  ): Promise<{
    webhookUrl: string | null;
    monitoredWallet: string | null;
    autoTradeEnabled: boolean;
    liveTradeEnabled: boolean;
    startingBalanceUsd: number | null;
    currentBalanceUsd: number | null;
    riskPercent: number | null;
    edgeSwingPaperTradingEnabled: boolean;
    edgeSwingLiveTradingEnabled: boolean;
    edgeSwingStartingBalanceUsd: number | null;
    edgeSwingCurrentBalanceUsd: number | null;
    edgeSwingRiskPercent: number | null;
    tradingWalletAddress: string | null;
    tradingSignatureType: "EOA" | "POLY_PROXY";
    encryptedPrivateKey: string | null;
    encryptedApiKey: string | null;
    encryptedApiSecret: string | null;
    encryptedApiPassphrase: string | null;
  }> {
    const row = await this.userWebhookCollection().findOne({ username });
    return {
      webhookUrl: row?.webhookUrl ?? null,
      monitoredWallet: row?.monitoredWallet ?? null,
      autoTradeEnabled: row?.autoTradeEnabled ?? false,
      liveTradeEnabled: row?.liveTradeEnabled ?? false,
      startingBalanceUsd: row?.startingBalanceUsd ?? null,
      currentBalanceUsd: row?.currentBalanceUsd ?? null,
      riskPercent: row?.riskPercent ?? null,
      edgeSwingPaperTradingEnabled: row?.edgeSwingPaperTradingEnabled ?? false,
      edgeSwingLiveTradingEnabled: row?.edgeSwingLiveTradingEnabled ?? false,
      edgeSwingStartingBalanceUsd: row?.edgeSwingStartingBalanceUsd ?? null,
      edgeSwingCurrentBalanceUsd: row?.edgeSwingCurrentBalanceUsd ?? null,
      edgeSwingRiskPercent: row?.edgeSwingRiskPercent ?? null,
      tradingWalletAddress: row?.tradingWalletAddress ?? null,
      tradingSignatureType: row?.tradingSignatureType ?? "EOA",
      encryptedPrivateKey: row?.encryptedPrivateKey ?? null,
      encryptedApiKey: row?.encryptedApiKey ?? null,
      encryptedApiSecret: row?.encryptedApiSecret ?? null,
      encryptedApiPassphrase: row?.encryptedApiPassphrase ?? null,
    };
  }

  async loadTraderSummary(wallet: string): Promise<{ summary: TraderSummary; updatedAt: number } | null> {
    const row = await this.traderSummaryCollection().findOne({ wallet });
    if (!row) {
      return null;
    }

    const { _id: _ignored, updatedAt, ...summary } = row;
    return {
      summary,
      updatedAt: updatedAt.getTime(),
    };
  }

  async saveTraderSummary(summary: TraderSummary): Promise<void> {
    const payload: PersistedTraderSummary = {
      ...summary,
      updatedAt: new Date(),
    };

    await this.traderSummaryCollection().updateOne(
      { wallet: summary.wallet },
      { $set: payload },
      { upsert: true },
    );
  }

  async upsertTrackedTrader(summary: TraderSummary): Promise<void> {
    await this.trackedTraderCollection().updateOne(
      { wallet: summary.wallet },
      {
        $set: {
          ...summary,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          lastSeenActivityTimestamp: 0,
        },
      },
      { upsert: true },
    );
  }

  async loadTrackedTraders(limit: number): Promise<PersistedTrackedTrader[]> {
    return this.trackedTraderCollection()
      .find(
        { tier: { $in: ["whale", "shark", "pro"] } },
        { sort: { lastPolledAt: 1, updatedAt: -1 }, limit },
      )
      .toArray();
  }

  async countTrackedTraders(): Promise<number> {
    return this.trackedTraderCollection().countDocuments({
      tier: { $in: ["whale", "shark", "pro"] },
    });
  }

  async updateTrackedTraderPollState(wallet: string, lastSeenActivityTimestamp: number): Promise<void> {
    await this.trackedTraderCollection().updateOne(
      { wallet },
      {
        $set: {
          lastSeenActivityTimestamp,
          lastPolledAt: new Date(),
        },
      },
    );
  }

  async watchMarket(username: string, marketSlug: string, outcome: string): Promise<void> {
    await this.marketAlertWatchCollection().updateOne(
      { username, marketSlug, outcome, source: "manual" },
      {
        $set: {
          username,
          marketSlug,
          outcome,
          source: "manual",
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async unwatchMarket(username: string, marketSlug: string, outcome: string): Promise<void> {
    await this.marketAlertWatchCollection().deleteMany({ username, marketSlug, outcome });
  }

  async loadWatchedOutcomesByMarket(username: string): Promise<Map<string, Set<string>>> {
    const rows = await this.marketAlertWatchCollection()
      .find({ username }, { projection: { marketSlug: 1, outcome: 1 } })
      .toArray();

    const watchedOutcomesByMarket = new Map<string, Set<string>>();
    for (const row of rows) {
      const current = watchedOutcomesByMarket.get(row.marketSlug) ?? new Set<string>();
      current.add(row.outcome);
      watchedOutcomesByMarket.set(row.marketSlug, current);
    }

    return watchedOutcomesByMarket;
  }

  async loadWatchedMarkets(
    username: string,
  ): Promise<Array<{ marketSlug: string; outcome: string; source: "manual" | "portfolio_sync"; createdAt?: Date; updatedAt?: Date }>> {
    const rows = await this.marketAlertWatchCollection()
      .find({ username }, { projection: { _id: 0, marketSlug: 1, outcome: 1, source: 1, createdAt: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return rows.map((row) => ({
      marketSlug: row.marketSlug,
      outcome: row.outcome,
      source: row.source ?? "manual",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async syncPortfolioWatches(
    username: string,
    watches: Array<{ marketSlug: string; outcome: string }>,
  ): Promise<void> {
    const normalizedKeys = new Set(
      watches.map((watch) => `${watch.marketSlug}:${watch.outcome}`),
    );

    if (watches.length > 0) {
      const bulk = watches.map((watch) => ({
        updateOne: {
          filter: {
            username,
            marketSlug: watch.marketSlug,
            outcome: watch.outcome,
            source: "portfolio_sync" as const,
          },
          update: {
            $set: {
              username,
              marketSlug: watch.marketSlug,
              outcome: watch.outcome,
              source: "portfolio_sync" as const,
              updatedAt: new Date(),
            },
            $setOnInsert: {
              createdAt: new Date(),
            },
          },
          upsert: true,
        },
      }));
      await this.marketAlertWatchCollection().bulkWrite(bulk, { ordered: false });
    }

    const existingAutoWatches = await this.marketAlertWatchCollection()
      .find(
        { username, source: "portfolio_sync" },
        { projection: { marketSlug: 1, outcome: 1 } },
      )
      .toArray();

    const staleIds = existingAutoWatches
      .filter((watch) => !normalizedKeys.has(`${watch.marketSlug}:${watch.outcome}`))
      .map((watch) => watch._id);

    if (staleIds.length > 0) {
      await this.marketAlertWatchCollection().deleteMany({ _id: { $in: staleIds } });
    }
  }

  async loadUsersWithMonitoredWallets(): Promise<Array<{ username: string; monitoredWallet: string }>> {
    const rows = await this.userWebhookCollection()
      .find(
        { monitoredWallet: { $exists: true, $ne: "" } },
        { projection: { _id: 0, username: 1, monitoredWallet: 1 } },
      )
      .toArray();

    return rows
      .map((row) => ({
        username: row.username,
        monitoredWallet: row.monitoredWallet ?? "",
      }))
      .filter((row) => Boolean(row.username && row.monitoredWallet));
  }

  async loadAutoTradeUsers(strategyKey: StrategyKey = "best_trades"): Promise<Array<{ username: string }>> {
    const enabledField =
      strategyKey === "edge_swing" ? "edgeSwingPaperTradingEnabled" : "autoTradeEnabled";
    const rows = await this.userWebhookCollection()
      .find(
        { [enabledField]: true },
        { projection: { _id: 0, username: 1 } },
      )
      .toArray();

    return rows
      .map((row) => ({
        username: row.username,
      }))
      .filter((row) => Boolean(row.username));
  }

  async loadLiveTradeUsers(strategyKey: StrategyKey = "best_trades"): Promise<Array<{ username: string }>> {
    const enabledField =
      strategyKey === "edge_swing" ? "edgeSwingLiveTradingEnabled" : "liveTradeEnabled";
    const rows = await this.userWebhookCollection()
      .find(
        {
          [enabledField]: true,
          tradingWalletAddress: { $exists: true, $ne: "" },
          encryptedPrivateKey: { $exists: true, $ne: "" },
          encryptedApiKey: { $exists: true, $ne: "" },
          encryptedApiSecret: { $exists: true, $ne: "" },
          encryptedApiPassphrase: { $exists: true, $ne: "" },
        },
        { projection: { _id: 0, username: 1 } },
      )
      .toArray();

    return rows
      .map((row) => ({
        username: row.username,
      }))
      .filter((row) => Boolean(row.username));
  }

  async loadWatchersForMarket(
    marketSlug: string,
    outcome: string,
  ): Promise<Array<{ username: string; webhookUrl: string }>> {
    const rows = await this.marketAlertWatchCollection()
      .aggregate<{
        username: string;
        webhookUrl: string;
      }>([
        { $match: { marketSlug, outcome } },
        {
          $lookup: {
            from: "user_webhooks",
            localField: "username",
            foreignField: "username",
            as: "webhook",
          },
        },
        { $unwind: "$webhook" },
        {
          $project: {
            _id: 0,
            username: 1,
            webhookUrl: "$webhook.webhookUrl",
          },
        },
      ])
      .toArray();

    return rows.filter((row) => Boolean(row.webhookUrl));
  }

  async markAlertDelivered(
    username: string,
    marketSlug: string,
    outcome: string,
    signalId: string,
  ): Promise<boolean> {
    const result = await this.alertDeliveryCollection().updateOne(
      { username, marketSlug, outcome, signalId },
      {
        $setOnInsert: {
          username,
          marketSlug,
          outcome,
          signalId,
          sentAt: new Date(),
        },
      },
      { upsert: true },
    );

    return result.upsertedCount > 0;
  }

  private collection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedSignal>(config.mongoSignalsCollection);
  }

  private tradeCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedTrade>("processed_trades");
  }

  private strategyPositionCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedStrategyPosition>("strategy_positions");
  }

  private liveStrategyPositionCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedLiveStrategyPosition>("live_strategy_positions");
  }

  private liveStrategyTradeCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedLiveStrategyTrade>("live_strategy_trades");
  }

  private marketAggregateCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedMarketAggregate>("market_aggregates");
  }

  private gapOpportunityCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedGapOpportunity>("market_gaps");
  }

  private bestTradeCandidateCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedBestTradeCandidate>("best_trade_candidates");
  }

  private clusterCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedCluster>("active_clusters");
  }

  private observedTradeCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedObservedTrade>("observed_trades");
  }

  private marketCatchupCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedMarketCatchup>("market_catchups");
  }

  private traderCatchupCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedTraderCatchup>("trader_catchups");
  }

  private userWebhookCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedUserWebhookSetting>("user_webhooks");
  }

  private marketAlertWatchCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedMarketAlertWatch>("market_alert_watches");
  }

  private async dropLegacyMarketAlertIndexes(): Promise<void> {
    const collection = this.marketAlertWatchCollection();
    const indexes = await collection.indexes();
    const legacyNames = new Set([
      "username_1_marketSlug_1",
      "username_1_marketSlug_1_outcome_1",
    ]);

    for (const index of indexes) {
      if (index.name && legacyNames.has(index.name)) {
        await collection.dropIndex(index.name).catch(() => undefined);
      }
    }
  }

  private traderSummaryCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedTraderSummary>("trader_summaries");
  }

  private trackedTraderCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedTrackedTrader>("tracked_traders");
  }

  private alertDeliveryCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedAlertDelivery>("alert_deliveries");
  }
}
