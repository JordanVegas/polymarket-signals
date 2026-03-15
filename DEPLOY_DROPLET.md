# Polysignals Deploy To TUF Droplet

- App path: `/opt/polymarket-signals`
- App port: `3002`
- Public URL: `https://polysignals.tuf.to`
- Process manager: systemd
- Reverse proxy: nginx on the shared TUF droplet

## App env

Create `/opt/polymarket-signals/.env`:

```env
NODE_ENV=production
PORT=3002
MONGO_URI=mongodb://127.0.0.1:27017
MONGO_DB_NAME=polymarket_signals
MONGO_SIGNALS_COLLECTION=signals
WHALE_THRESHOLD_USD=200000
PROFITABLE_WHALE_THRESHOLD_USD=50000
TRADE_WINDOW_MS=60000
MARKET_REFRESH_MS=600000
TRADE_POLL_MS=2500
MAX_SIGNALS=75
HISTORICAL_BACKFILL_LIMIT=50000
HISTORICAL_BACKFILL_LOOKBACK_HOURS=168
HISTORICAL_BACKFILL_TARGET_SIGNALS=25
```

`MONGO_URI` is required because the app stores signal history, processed trades, and active aggregation windows in MongoDB.

## Update flow

```bash
cd /opt/polymarket-signals
git pull
npm ci
npm run build
sudo systemctl restart polysignals
```

## GitHub auto deploy

This repo can auto-deploy on every push to `main` using
[`.github/workflows/deploy-droplet.yml`](C:/Users/Jordan/Documents/polymarket-signals/.github/workflows/deploy-droplet.yml).

Set these GitHub Actions secrets:

- `DROPLET_HOST=129.212.171.226`
- `DROPLET_USER=root`
- `DROPLET_PORT=22`
- `DROPLET_SSH_KEY`
- `DROPLET_SSH_PASSPHRASE` if your key uses one
- `DROPLET_APP_DIR=/opt/polymarket-signals`
