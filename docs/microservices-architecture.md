# Microservices Migration Plan

## Why split this app

Right now [`PolymarketSignalService`](/Users/Jordan/Documents/polymarket-signals/server/src/polymarket.ts) is a single runtime that does all of this:

- market catalog sync from Gamma
- Polymarket websocket subscription and trade catch-up
- trade enrichment and trader profiling
- signal clustering and emission
- read model refresh for markets and gap opportunities
- portfolio watch syncing and alert fanout
- paper strategy management
- live trade execution
- HTTP and websocket delivery to the frontend

That works for speed, but it couples ingestion, strategy logic, and execution into one failure domain. A slow Polymarket API call, wallet sync, or live order retry can now interfere with everything else.

The better target is an event-driven set of services, with Mongo still allowed initially, but with clear ownership and asynchronous handoffs.

## Recommended service boundaries

### 1. `api-gateway`

Owns:

- auth/session handling
- frontend REST and websocket API
- profile mutations
- query aggregation for the UI

Does not own:

- Polymarket ingestion
- signal generation
- strategy execution

Notes:

- Keep this stateless.
- It should read projections built by downstream services instead of recomputing signals itself.

### 2. `market-catalog-service`

Owns:

- syncing active markets from Gamma
- keeping asset-to-market mappings current
- publishing market lifecycle events

Outputs:

- `market.catalog.synced`
- `market.upserted`
- `market.closed`

### 3. `trade-ingestor`

Owns:

- websocket subscriptions to Polymarket market feeds
- best bid/ask ingest
- catch-up polling for missed trades
- raw trade dedupe before publish

Outputs:

- `market.trade.observed`
- `market.quote.updated`

This service should be the only long-lived Polymarket websocket client.

### 4. `trader-profile-service`

Owns:

- fetching trader activity, open positions, value, and pnl
- tier classification (`whale` / `shark` / `pro`)
- tracked wallet refresh scheduling

Consumes:

- `market.trade.observed`

Outputs:

- `trader.profile.updated`
- `trader.promoted`

### 5. `signal-engine`

Owns:

- cluster windows by wallet, asset, side
- threshold checks
- signal creation
- signal persistence

Consumes:

- `market.trade.observed`
- `trader.profile.updated`
- market catalog cache

Outputs:

- `signal.detected`
- `signal.updated`

This is the heart of the app and should stay pure: no Discord delivery and no order placement here.

### 6. `market-projection-service`

Owns:

- market aggregates
- best-trade candidate projections
- gap opportunity projections
- read models for dashboard pages

Consumes:

- `signal.detected`
- `market.quote.updated`
- `market.upserted`
- resolution updates

Outputs:

- Mongo read models that the API gateway can serve directly

### 7. `watchlist-service`

Owns:

- user market watch state
- monitored wallet portfolio sync
- deciding which users should receive which sell alerts

Consumes:

- profile changes
- wallet/position snapshots
- `signal.detected`

Outputs:

- `alert.requested`

### 8. `notification-service`

Owns:

- Discord webhook delivery
- alert idempotency and retries

Consumes:

- `alert.requested`

Outputs:

- `alert.delivered`
- `alert.failed`

### 9. `strategy-engine`

Owns:

- best-trades paper strategy
- edge-swing paper strategy
- live-trading entry and exit decisions
- position lifecycle and risk rules

Consumes:

- `signal.detected`
- `market.quote.updated`
- user strategy settings

Outputs:

- `paper.position.opened`
- `paper.position.closed`
- `execution.order.requested`

Important:

- Separate strategy decisioning from actual order placement. This lets us test the strategy without touching live execution code.

### 10. `execution-service`

Owns:

- CLOB auth/session setup
- order placement, cancellation, retry, reconciliation
- live balance refresh
- exchange-facing error logging

Consumes:

- `execution.order.requested`

Outputs:

- `execution.order.accepted`
- `execution.order.failed`
- `execution.position.synced`

This service should be the only one that ever touches private keys or API secrets.

## Shared infrastructure

### Message bus

Use NATS JetStream first.

Why:

- simpler than Kafka for this scale
- durable streams and consumer groups
- easy local/dev ergonomics
- good fit for low-latency event fanout

If you want a gentler first step, use a Mongo outbox table plus polling workers, then swap to NATS once the boundaries are stable.

### Data storage

Short term:

- keep one Mongo cluster
- split ownership by collection/database, not necessarily by physical cluster

Long term:

- each service owns its writes
- API only reads projections or calls dedicated query services

### Secrets

- move trading credentials out of the general app process
- only `execution-service` should decrypt or use them
- if possible, store encrypted material in a dedicated secrets store instead of general app Mongo

## Recommended event contracts

Start with a small set:

- `market.trade.observed`
- `market.quote.updated`
- `trader.profile.updated`
- `signal.detected`
- `alert.requested`
- `execution.order.requested`
- `execution.order.accepted`
- `execution.order.failed`

All events should include:

- `eventId`
- `eventType`
- `occurredAt`
- `producer`
- `schemaVersion`
- payload

Make them append-only and idempotent. Consumers should be able to safely reprocess the same event.

## Incremental migration order

### Phase 1. Modular monolith

- extract shared contracts from app internals
- split `PolymarketSignalService` into modules inside the same repo:
  - ingestion
  - trader-profiling
  - signal-engine
  - projections
  - watchlists
  - strategy
  - execution

Goal:

- keep behavior the same
- remove direct cross-cutting calls where possible

### Phase 2. Externalize ingestion

- move websocket ingest and catch-up polling into `trade-ingestor`
- publish raw observed trades and quotes
- let the monolith consume those events instead of talking directly to the websocket

This is the safest first runtime split because ingestion already behaves like a background worker.

### Phase 3. Externalize signal generation

- move clustering and signal emission into `signal-engine`
- publish `signal.detected`
- keep API and projections separate

### Phase 4. Externalize strategy and notifications

- move Discord delivery to `notification-service`
- move paper/live strategy decisions to `strategy-engine`

### Phase 5. Externalize execution

- isolate live order placement into `execution-service`
- cut all secret usage out of the API process

## Practical repo shape

Suggested future layout:

```text
apps/
  api-gateway/
  trade-ingestor/
  trader-profile-service/
  signal-engine/
  market-projection-service/
  watchlist-service/
  notification-service/
  strategy-engine/
  execution-service/
packages/
  contracts/
  config/
  mongo/
  observability/
```

You do not need to create all of these on day one. Start with `api-gateway`, `trade-ingestor`, `signal-engine`, and `execution-service`.

## What should not be split yet

Avoid creating separate services for:

- auth alone
- gap detection alone
- each strategy alone

Those are modules, not services, until load or team boundaries justify the extra operational cost.

## Immediate next step for this codebase

The next safe refactor is:

1. extract the shared domain contracts
2. break [`PolymarketSignalService`](/Users/Jordan/Documents/polymarket-signals/server/src/polymarket.ts) into internal modules
3. introduce an event publisher interface inside the monolith
4. move websocket ingest into its own process first

That path preserves behavior while giving you a clean migration seam instead of a big-bang rewrite.
