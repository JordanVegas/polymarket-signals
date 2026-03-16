const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

const withDatabaseName = (mongoUri: string, databaseName: string): string => {
  try {
    const nextUri = new URL(mongoUri);
    nextUri.pathname = `/${databaseName}`;
    return nextUri.toString();
  } catch {
    return mongoUri;
  }
};

const defaultMongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";

export const config = {
  port: parseNumber(process.env.PORT, 3001),
  mongoUri: defaultMongoUri,
  mongoDbName: process.env.MONGO_DB_NAME || "polymarket_signals",
  mongoSignalsCollection: process.env.MONGO_SIGNALS_COLLECTION || "signals",
  authMongoUri: process.env.AUTH_MONGO_URI || withDatabaseName(defaultMongoUri, "authentication"),
  webSessionSecret: process.env.WEB_SESSION_SECRET || "change-me",
  webSessionCookieName: process.env.WEB_SESSION_COOKIE_NAME || "tuf_session",
  webCookieDomain: process.env.WEB_COOKIE_DOMAIN || "",
  minSignalClusterUsd: parseNumber(process.env.MIN_SIGNAL_CLUSTER_USD, 1_000),
  whaleThresholdUsd: parseNumber(process.env.WHALE_THRESHOLD_USD, 200_000),
  profitableWhaleThresholdUsd: parseNumber(
    process.env.PROFITABLE_WHALE_THRESHOLD_USD,
    50_000,
  ),
  tradeWindowMs: parseNumber(process.env.TRADE_WINDOW_MS, 60_000),
  maxSignals: parseNumber(process.env.MAX_SIGNALS, 75),
  marketRefreshMs: parseNumber(process.env.MARKET_REFRESH_MS, 10 * 60_000),
  tradePollMs: parseNumber(process.env.TRADE_POLL_MS, 2_500),
  historicalFetchEnabled: parseBoolean(process.env.HISTORICAL_FETCH_ENABLED, false),
  historicalBackfillLimit: parseNumber(process.env.HISTORICAL_BACKFILL_LIMIT, 2_000),
  historicalBackfillLookbackHours: parseNumber(
    process.env.HISTORICAL_BACKFILL_LOOKBACK_HOURS,
    168,
  ),
};
