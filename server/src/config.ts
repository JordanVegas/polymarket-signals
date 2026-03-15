const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parseNumber(process.env.PORT, 3001),
  mongoUri: process.env.MONGO_URI || "",
  mongoDbName: process.env.MONGO_DB_NAME || "polymarket_signals",
  mongoSignalsCollection: process.env.MONGO_SIGNALS_COLLECTION || "signals",
  whaleThresholdUsd: parseNumber(process.env.WHALE_THRESHOLD_USD, 200_000),
  profitableWhaleThresholdUsd: parseNumber(
    process.env.PROFITABLE_WHALE_THRESHOLD_USD,
    50_000,
  ),
  tradeWindowMs: parseNumber(process.env.TRADE_WINDOW_MS, 60_000),
  maxSignals: parseNumber(process.env.MAX_SIGNALS, 75),
  marketRefreshMs: parseNumber(process.env.MARKET_REFRESH_MS, 10 * 60_000),
  tradePollMs: parseNumber(process.env.TRADE_POLL_MS, 2_500),
};
