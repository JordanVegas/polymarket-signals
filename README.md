# Polymarket Whale Signals

Realtime Polymarket signal dashboard that:

- syncs active markets from the Gamma API
- listens to Polymarket's public market websocket
- clusters trades by wallet, side, and outcome
- classifies traders into whale, shark, and pro profile tiers
- streams signals into a live web UI with market and profile links

## Run locally

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:3001`

## Environment variables

```bash
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=polymarket_signals
MONGO_SIGNALS_COLLECTION=signals
PROFITABLE_WHALE_THRESHOLD_USD=50000
TRADE_WINDOW_MS=60000
MARKET_REFRESH_MS=600000
TRADE_POLL_MS=2500
MAX_SIGNALS=75
HISTORICAL_BACKFILL_LIMIT=50000
HISTORICAL_BACKFILL_LOOKBACK_HOURS=168
HISTORICAL_BACKFILL_TARGET_SIGNALS=25
```

## Notes

- Trade clusters are grouped per wallet, asset, and side inside a rolling time window.
- Profitability is estimated from Polymarket's public positions, closed positions, and value endpoints.
- `MONGO_URI` is required. Signal history, processed trade dedupe, and active whale clusters are stored in MongoDB.
- On startup, the app restores active clusters from MongoDB and also backfills recent trades for active markets so whale alerts can appear immediately.
- Signals now emit based on profile tier thresholds:
  - whale: `>= $100,000` profit and `>= 100` trades
  - shark: `>= $10,000` profit and `>= 50` trades
  - pro: `>= $2,000` profit and `>= 20` trades
