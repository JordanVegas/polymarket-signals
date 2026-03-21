import type {
  MarketAggregate,
  MarketRecord,
  StrategyKey,
  TradeRecord,
  TraderSummary,
  WhaleSignal,
} from "./contracts.js";

export type EventEnvelope<TType extends string, TPayload> = {
  eventId: string;
  eventType: TType;
  schemaVersion: 1;
  occurredAt: number;
  producer: "market-intelligence" | "app-execution";
  payload: TPayload;
};

export type MarketCatalogSyncedEvent = EventEnvelope<
  "market.catalog.synced",
  {
    marketCount: number;
    assetCount: number;
    syncedAt: number;
  }
>;

export type MarketUpsertedEvent = EventEnvelope<
  "market.upserted",
  {
    market: MarketRecord;
  }
>;

export type MarketTradeObservedEvent = EventEnvelope<
  "market.trade.observed",
  {
    trade: TradeRecord;
  }
>;

export type TraderProfileUpdatedEvent = EventEnvelope<
  "trader.profile.updated",
  {
    trader: TraderSummary;
  }
>;

export type SignalDetectedEvent = EventEnvelope<
  "signal.detected",
  {
    signal: WhaleSignal;
    aggregate?: MarketAggregate;
  }
>;

export type StrategyReconcileRequestedEvent = EventEnvelope<
  "strategy.reconcile.requested",
  {
    username: string;
    marketSlug: string;
    strategyKey: StrategyKey;
    reason: "signal" | "position_sync" | "settings_update" | "startup";
  }
>;

export type LiveExecutionRequestedEvent = EventEnvelope<
  "execution.order.requested",
  {
    username: string;
    marketSlug: string;
    outcome: string;
    strategyKey: StrategyKey;
    side: "BUY" | "SELL";
    maxUsd: number;
    targetPrice?: number;
    reason: string;
  }
>;

export type AppEvent =
  | MarketCatalogSyncedEvent
  | MarketUpsertedEvent
  | MarketTradeObservedEvent
  | TraderProfileUpdatedEvent
  | SignalDetectedEvent
  | StrategyReconcileRequestedEvent
  | LiveExecutionRequestedEvent;
