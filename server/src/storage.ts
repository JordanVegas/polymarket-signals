import { MongoClient } from "mongodb";
import { config } from "./config.js";
import type { WhaleSignal } from "./types.js";

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

export type PersistedCluster = {
  clusterKey: string;
  wallet: string;
  assetId: string;
  side: "BUY" | "SELL";
  outcome: string;
  market: {
    id: string;
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
    await this.clusterCollection().createIndex({ clusterKey: 1 }, { unique: true });
    await this.clusterCollection().createIndex({ updatedAt: -1 });
    await this.clusterCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async loadRecentSignals(limit: number): Promise<WhaleSignal[]> {
    const rows = await this.collection()
      .find({}, { sort: { timestamp: -1 }, limit })
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
}
