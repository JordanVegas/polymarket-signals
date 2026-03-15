# Polymarket Whale Signals

Realtime Polymarket signal dashboard that:

- syncs active markets from the Gamma API
- listens to Polymarket's public market websocket
- clusters large trades by wallet, side, and outcome
- labels very profitable traders separately from standard whale flow
- streams signals into a live web UI with market and profile links

## Run locally

```bash
npm install
npm run dev
```

Frontend: `http://localhost:5173`

Backend: `http://localhost:3001`

## Optional environment variables

```bash
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=polymarket_signals
MONGO_SIGNALS_COLLECTION=signals
WHALE_THRESHOLD_USD=200000
PROFITABLE_WHALE_THRESHOLD_USD=50000
TRADE_WINDOW_MS=60000
MARKET_REFRESH_MS=600000
TRADE_POLL_MS=2500
MAX_SIGNALS=75
```

## Notes

- Whale clusters are grouped per wallet, asset, and side inside a rolling time window.
- Profitability is estimated from Polymarket's public positions, closed positions, and value endpoints.
- The profitability threshold is configurable because "very profitable" is product-specific.
- If `MONGO_URI` is set, emitted whale signals are persisted and restored on startup.
