import { MongoClient } from "mongodb";
import { config } from "./config.js";
import type { WhaleSignal } from "./types.js";

type PersistedSignal = WhaleSignal & {
  updatedAt: Date;
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

  private collection() {
    if (!this.client) {
      throw new Error("Mongo client not connected");
    }

    return this.client
      .db(config.mongoDbName)
      .collection<PersistedSignal>(config.mongoSignalsCollection);
  }
}
