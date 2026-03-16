import { MongoClient } from "mongodb";
import { config } from "./config.js";
import type { TradeRecord, WhaleSignal } from "./types.js";

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
  webhookUrl: string;
  updatedAt: Date;
};

export type PersistedMarketAlertWatch = {
  username: string;
  marketSlug: string;
  outcome: string;
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
    await this.marketAlertWatchCollection().createIndex(
      { username: 1, marketSlug: 1, outcome: 1 },
      { unique: true },
    );
    await this.marketAlertWatchCollection().createIndex({ marketSlug: 1, outcome: 1, username: 1 });
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

  async upsertUserWebhook(username: string, webhookUrl: string): Promise<void> {
    await this.userWebhookCollection().updateOne(
      { username },
      {
        $set: {
          username,
          webhookUrl,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async getUserWebhook(username: string): Promise<string | null> {
    const row = await this.userWebhookCollection().findOne({ username });
    return row?.webhookUrl ?? null;
  }

  async watchMarket(username: string, marketSlug: string, outcome: string): Promise<void> {
    await this.marketAlertWatchCollection().updateOne(
      { username, marketSlug, outcome },
      {
        $set: {
          username,
          marketSlug,
          outcome,
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
    await this.marketAlertWatchCollection().deleteOne({ username, marketSlug, outcome });
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
  ): Promise<Array<{ marketSlug: string; outcome: string; createdAt?: Date; updatedAt?: Date }>> {
    const rows = await this.marketAlertWatchCollection()
      .find({ username }, { projection: { _id: 0, marketSlug: 1, outcome: 1, createdAt: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1, createdAt: -1 })
      .toArray();

    return rows.map((row) => ({
      marketSlug: row.marketSlug,
      outcome: row.outcome,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
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

  private alertDeliveryCollection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedAlertDelivery>("alert_deliveries");
  }
}
