import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const configFilePath = fileURLToPath(import.meta.url);
const configDir = path.dirname(configFilePath);
const resolveAppRootDir = (currentDir: string): string => {
  const candidates = [
    path.resolve(currentDir, "..", ".."),
    path.resolve(currentDir, "..", "..", ".."),
    path.resolve(currentDir, "..", "..", "..", ".."),
    path.resolve(currentDir, "..", "..", "..", "..", ".."),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return candidates[0];
};

const appRootDir = resolveAppRootDir(configDir);
const fileEnv: Record<string, string> = {};

const loadEnvFile = (filePath: string) => {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      fileEnv[key] = value;
      if (process.env[key] === undefined || !String(process.env[key]).trim()) {
        process.env[key] = value;
      }
    }
  }
};

loadEnvFile(path.resolve(appRootDir, ".env"));
loadEnvFile(path.resolve(appRootDir, ".env.market-intelligence"));
loadEnvFile(path.resolve(appRootDir, ".env.app-execution"));

const envValue = (key: string): string | undefined => {
  const fileValue = fileEnv[key];
  if (typeof fileValue === "string" && fileValue.trim()) {
    return fileValue;
  }
  const runtime = process.env[key];
  if (typeof runtime === "string" && runtime.trim()) {
    return runtime;
  }
  return undefined;
};

const defaultMongoUri = envValue("MONGO_URI") || "mongodb://127.0.0.1:27017";

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
  const inline = envValue("POLYMARKET_PROXY_URLS") || envValue("API_PROXY_URLS") || "";
  const filePath = envValue("POLYMARKET_PROXY_FILE") || envValue("API_PROXY_FILE") || "";

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

  const single = normalizeProxyUrl(envValue("POLYMARKET_PROXY_URL") || envValue("API_PROXY_URL") || "");
  if (single) {
    urls.add(single);
  }

  return Array.from(urls);
};

const proxyEnabled = parseBoolean(
  envValue("POLYMARKET_PROXY_ENABLED") ?? envValue("API_PROXY_ENABLED"),
  true,
);

export const config = {
  port: parseNumber(process.env.PORT || envValue("PORT"), 3001),
  marketIntelligencePort: parseNumber(
    process.env.MARKET_INTELLIGENCE_PORT || envValue("MARKET_INTELLIGENCE_PORT"),
    3002,
  ),
  mongoUri: defaultMongoUri,
  mongoDbName: envValue("MONGO_DB_NAME") || "polymarket_signals",
  mongoSignalsCollection: envValue("MONGO_SIGNALS_COLLECTION") || "signals",
  authMongoUri: envValue("AUTH_MONGO_URI") || withDatabaseName(defaultMongoUri, "authentication"),
  webSessionSecret: envValue("WEB_SESSION_SECRET") || "change-me",
  tradingEncryptionSecret:
    envValue("TRADING_ENCRYPTION_SECRET") || envValue("WEB_SESSION_SECRET") || "change-me",
  webSessionCookieName: envValue("WEB_SESSION_COOKIE_NAME") || "tuf_session",
  webCookieDomain: envValue("WEB_COOKIE_DOMAIN") || "",
  minSignalClusterUsd: parseNumber(envValue("MIN_SIGNAL_CLUSTER_USD"), 1_000),
  minWsTradeFetchUsd: parseNumber(envValue("MIN_WS_TRADE_FETCH_USD"), 10),
  tradeWindowMs: parseNumber(envValue("TRADE_WINDOW_MS"), 60_000),
  marketRefreshMs: parseNumber(envValue("MARKET_REFRESH_MS"), 10 * 60_000),
  tradePollMs: parseNumber(envValue("TRADE_POLL_MS"), 2_500),
  trackedTraderPollConcurrency: parseNumber(envValue("TRACKED_TRADER_POLL_CONCURRENCY"), 3),
  apiProxyUrls: proxyEnabled ? parseProxyUrls() : [],
  recentCatchupLookbackMinutes: parseNumber(envValue("RECENT_CATCHUP_LOOKBACK_MINUTES"), 30),
  recentCatchupMaxOffset: parseNumber(envValue("RECENT_CATCHUP_MAX_OFFSET"), 3_000),
  historicalFetchEnabled: parseBoolean(envValue("HISTORICAL_FETCH_ENABLED"), false),
  startupHistoricalBackfillEnabled: parseBoolean(
    envValue("STARTUP_HISTORICAL_BACKFILL_ENABLED"),
    false,
  ),
  marketHistoryCatchupEnabled: parseBoolean(
    envValue("MARKET_HISTORY_CATCHUP_ENABLED"),
    false,
  ),
  traderHistoryCatchupEnabled: parseBoolean(
    envValue("TRADER_HISTORY_CATCHUP_ENABLED"),
    false,
  ),
  historicalBackfillLimit: parseNumber(envValue("HISTORICAL_BACKFILL_LIMIT"), 2_000),
  historicalBackfillLookbackHours: parseNumber(
    envValue("HISTORICAL_BACKFILL_LOOKBACK_HOURS"),
    168,
  ),
  liveExecutionErrorLogPath:
    envValue("LIVE_EXECUTION_ERROR_LOG_PATH")
      ? path.resolve(appRootDir, envValue("LIVE_EXECUTION_ERROR_LOG_PATH") as string)
      : path.resolve(appRootDir, "logs", "live-execution-errors.log"),
  appExecutionActionLogPath:
    envValue("APP_EXECUTION_ACTION_LOG_PATH")
      ? path.resolve(appRootDir, envValue("APP_EXECUTION_ACTION_LOG_PATH") as string)
      : path.resolve(appRootDir, "logs", "app-execution-actions.log"),
};
