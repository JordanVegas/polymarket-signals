# Polymarket Whale Signals

Realtime Polymarket signal dashboard that:

- syncs active markets from the Gamma API
- listens to Polymarket's public market websocket
- clusters trades by wallet, side, and outcome
- classifies traders into whale, shark, and pro profile tiers
- streams signals into a live web UI with market and profile links

Microservices migration notes live in [docs/microservices-architecture.md](/Users/Jordan/Documents/polymarket-signals/docs/microservices-architecture.md).
The recommended first split for this repo is documented in [docs/two-service-split.md](/Users/Jordan/Documents/polymarket-signals/docs/two-service-split.md).

## Run locally

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

App execution: `http://localhost:3001`

Market intelligence: `http://localhost:3002`

## Environment variables

```bash
PORT=3001
MARKET_INTELLIGENCE_PORT=3002
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=polymarket_signals
MONGO_SIGNALS_COLLECTION=signals
AUTH_MONGO_URI=mongodb://127.0.0.1:27017/authentication
WEB_SESSION_SECRET=change-me
WEB_SESSION_COOKIE_NAME=tuf_session
WEB_COOKIE_DOMAIN=
MIN_SIGNAL_CLUSTER_USD=1000
MIN_WS_TRADE_FETCH_USD=10
TRADE_WINDOW_MS=60000
MARKET_REFRESH_MS=600000
TRADE_POLL_MS=2500
TRACKED_TRADER_POLL_CONCURRENCY=3
API_PROXY_ENABLED=true
API_PROXY_URL=
API_PROXY_URLS=
API_PROXY_FILE=
RECENT_CATCHUP_LOOKBACK_MINUTES=30
RECENT_CATCHUP_MAX_OFFSET=3000
TRADING_ENCRYPTION_SECRET=
APP_EXECUTION_ACTION_LOG_PATH=logs/app-execution-actions.log
HISTORICAL_FETCH_ENABLED=false
STARTUP_HISTORICAL_BACKFILL_ENABLED=false
MARKET_HISTORY_CATCHUP_ENABLED=false
TRADER_HISTORY_CATCHUP_ENABLED=false
HISTORICAL_BACKFILL_LIMIT=50000
HISTORICAL_BACKFILL_LOOKBACK_HOURS=168
```

Set `API_PROXY_ENABLED=false` to force direct connections even if `API_PROXY_URL`, `API_PROXY_URLS`, or `API_PROXY_FILE` are configured.
Set `MIN_WS_TRADE_FETCH_USD=10` to ignore tiny websocket trades when deciding whether to fetch recent market trades.
Set `APP_EXECUTION_ACTION_LOG_PATH` to control where detailed app-execution JSONL action logs are written.

## Split services

The repo now has two server entrypoints:

- `server/src/market-intelligence/index.ts`
- `server/src/app-execution/index.ts`

Service-specific wrappers live in:

- `server/src/market-intelligence/service.ts`
- `server/src/app-execution/service.ts`

Useful commands:

- `npm run dev` runs both services plus the client
- `npm run start:market-intelligence` runs only the market intelligence service
- `npm run start:app-execution` runs only the UI and execution service

The old combined server entrypoint has been removed.

Deploy env files:

- `deploy/droplet/market-intelligence.service` loads `.env.market-intelligence`
- `deploy/droplet/app-execution.service` loads `.env.app-execution`

## Notes

- Trade clusters are grouped per wallet, asset, and side inside a rolling time window.
- Profitability is estimated from Polymarket's public positions, closed positions, and value endpoints.
- `MONGO_URI` is required. Signal history, processed trade dedupe, and active whale clusters are stored in MongoDB.
- On startup, the app restores active clusters from MongoDB and also backfills recent trades for active markets so whale alerts can appear immediately.
- Signals now emit based on profile tier thresholds:
  - whale: `>= $100,000` profit and `>= 100` trades
  - shark: `>= $10,000` profit and `>= 50` trades
  - pro: `>= $2,000` profit and `>= 20` trades
- Signals also require at least `$1,000` of clustered flow.
