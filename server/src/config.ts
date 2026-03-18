import fs from "node:fs";

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

const normalizeProxyUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^(https?|socks5?):\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
};

const parseProxyUrls = (): string[] => {
  const inline = process.env.POLYMARKET_PROXY_URLS || process.env.API_PROXY_URLS || "";
  const filePath = process.env.POLYMARKET_PROXY_FILE || process.env.API_PROXY_FILE || "";

  const urls = new Set<string>();

  for (const entry of inline.split(/[\r\n,;]+/)) {
    const normalized = normalizeProxyUrl(entry);
    if (normalized) {
      urls.add(normalized);
    }
  }

  if (filePath.trim() && fs.existsSync(filePath.trim())) {
    const fileContents = fs.readFileSync(filePath.trim(), "utf8");
    for (const entry of fileContents.split(/[\r\n]+/)) {
      const normalized = normalizeProxyUrl(entry);
      if (normalized) {
        urls.add(normalized);
      }
    }
  }

  const single = normalizeProxyUrl(process.env.POLYMARKET_PROXY_URL || process.env.API_PROXY_URL || "");
  if (single) {
    urls.add(single);
  }

  return Array.from(urls);
};

export const config = {
  port: parseNumber(process.env.PORT, 3001),
  mongoUri: defaultMongoUri,
  mongoDbName: process.env.MONGO_DB_NAME || "polymarket_signals",
  mongoSignalsCollection: process.env.MONGO_SIGNALS_COLLECTION || "signals",
  authMongoUri: process.env.AUTH_MONGO_URI || withDatabaseName(defaultMongoUri, "authentication"),
  webSessionSecret: process.env.WEB_SESSION_SECRET || "change-me",
  tradingEncryptionSecret:
    process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me",
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
  trackedTraderPollConcurrency: parseNumber(process.env.TRACKED_TRADER_POLL_CONCURRENCY, 3),
  apiProxyUrls: parseProxyUrls(),
  recentCatchupLookbackMinutes: parseNumber(process.env.RECENT_CATCHUP_LOOKBACK_MINUTES, 30),
  recentCatchupMaxOffset: parseNumber(process.env.RECENT_CATCHUP_MAX_OFFSET, 3_000),
  historicalFetchEnabled: parseBoolean(process.env.HISTORICAL_FETCH_ENABLED, false),
  startupHistoricalBackfillEnabled: parseBoolean(
    process.env.STARTUP_HISTORICAL_BACKFILL_ENABLED,
    false,
  ),
  marketHistoryCatchupEnabled: parseBoolean(
    process.env.MARKET_HISTORY_CATCHUP_ENABLED,
    false,
  ),
  traderHistoryCatchupEnabled: parseBoolean(
    process.env.TRADER_HISTORY_CATCHUP_ENABLED,
    false,
  ),
  historicalBackfillLimit: parseNumber(process.env.HISTORICAL_BACKFILL_LIMIT, 2_000),
  historicalBackfillLookbackHours: parseNumber(
    process.env.HISTORICAL_BACKFILL_LOOKBACK_HOURS,
    168,
  ),
};
