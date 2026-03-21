# Two-Service Split

This is the recommended first production split for this repository.

## Services

### `market-intelligence`

Owns public market intelligence only:

- Polymarket websocket ingestion
- Gamma market sync
- trade catch-up and historical backfill
- trader profiling
- signal clustering and signal creation
- market aggregates, best-trade projections, and gap projections

It should not:

- hold user trading credentials
- follow user wallets
- place orders
- send user webhooks
- host the UI

### `app-execution`

Owns user-specific behavior:

- HTTP API and UI hosting
- auth/session management
- user profile/settings
- watchlists and monitored wallet sync
- paper trading
- live trade decisions
- order placement and reconciliation

It consumes signals and market projections produced by `market-intelligence`.

## Current file ownership

Today almost everything is inside [`server/src/polymarket.ts`](/Users/Jordan/Documents/polymarket-signals/server/src/polymarket.ts). This is the recommended split by responsibility.

### Move to `market-intelligence`

- `start()` startup tasks related to market sync, websocket ingest, catch-up, backfill, aggregate refresh
- `syncMarkets()`
- websocket shard management and socket event handling
- `startTradePolling()`
- `catchUpRecentTrades()`
- `backfillHistoricalSignals()`
- `processHistoricalTrades()`
- trade ingestion and cluster accumulation
- `tryEmitSignal()` up to saving the signal and refreshing aggregate state
- trader summary fetching/classification
- `refreshMarketAggregates()`
- gap detection
- best-trade candidate tracking and resolution sync

### Move to `app-execution`

- `getUserProfile()`
- `updateUserProfile()`
- `watchMarket()`
- `unwatchMarket()`
- `getStrategyPositions()`
- `getLiveStrategyPositions()`
- `syncTrackedWalletWatches()`
- `syncTrackedWalletWatchesForUser()`
- `syncLiveWalletCoverage()`
- paper strategy reconcile flow
- live strategy reconcile flow
- live trading client creation and order placement
- Discord webhook delivery

### Keep in shared packages

- domain contracts in [`shared/contracts.ts`](/Users/Jordan/Documents/polymarket-signals/shared/contracts.ts)
- cross-service event contracts in [`shared/events.ts`](/Users/Jordan/Documents/polymarket-signals/shared/events.ts)
- storage helpers once they are split by ownership

## Handoff between services

Use the following handoff contract first:

- `market-intelligence` writes signals and projections to Mongo
- `app-execution` reads them from Mongo

That is the fastest migration because your app already uses Mongo for:

- signals
- market aggregates
- best trade candidates
- strategy positions
- tracked traders

The cleaner second step is to add event delivery with the contracts in [`shared/events.ts`](/Users/Jordan/Documents/polymarket-signals/shared/events.ts).

## Recommended runtime shape

### `market-intelligence` process

- no web login pages
- no user cookies
- no private keys
- exposes `/health`, `/api/health`, and `/api/snapshot` on its own port

Primary environment variables:

- `MARKET_INTELLIGENCE_PORT`
- `MONGO_URI`
- `MONGO_DB_NAME`
- `MIN_SIGNAL_CLUSTER_USD`
- `MIN_WS_TRADE_FETCH_USD`
- `TRADE_WINDOW_MS`
- `MARKET_REFRESH_MS`
- `TRADE_POLL_MS`
- `TRACKED_TRADER_POLL_CONCURRENCY`
- proxy and historical fetch settings

### `app-execution` process

- hosts the frontend and API
- owns auth and trading secrets
- polls or subscribes for new signals

Primary environment variables:

- `PORT`
- `AUTH_MONGO_URI`
- `WEB_SESSION_SECRET`
- `WEB_SESSION_COOKIE_NAME`
- `WEB_COOKIE_DOMAIN`
- `TRADING_ENCRYPTION_SECRET`
- `MONGO_URI`
- `MONGO_DB_NAME`

## Deployment model

Recommended first deployment:

1. run one `market-intelligence` instance
2. run one or more `app-execution` instances
3. point both at the same Mongo cluster

Reasoning:

- websocket ingest should be singleton or explicitly leader-elected
- app/API can scale horizontally more safely

## First extraction order

### Step 1

Create internal modules in the current server:

- `server/src/intelligence/`
- `server/src/execution/`
- `server/src/api/`

### Step 2

Move all signal creation side effects out of `tryEmitSignal()`.

Right now signal creation also triggers:

- paper strategy reconciles
- live strategy reconciles
- sell alerts
- trader history catch-up

That coupling is the main thing blocking the service split.

### Step 3

Introduce a `signal.detected` handoff.

At first this can be implemented by:

- saving the signal to Mongo
- having `app-execution` poll for new signals every few seconds

### Step 4

Once stable, replace polling with a queue or event bus.

## Concrete target repo layout

```text
apps/
  market-intelligence/
  app-execution/
packages/
  contracts/
  runtime/
  events/
```

You do not need to move files yet to benefit from this split. The important part is to stop adding new code directly to the monolith service without honoring these ownership lines.
