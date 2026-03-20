import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";

const DATA_API_URL = "https://data-api.polymarket.com";

const parseArgs = (argv) => {
  const args = {
    username: "tuf",
    strategyKey: "edge_swing",
    closeStale: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--username" && argv[index + 1]) {
      args.username = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--strategy" && argv[index + 1]) {
      args.strategyKey = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--keep-stale-open") {
      args.closeStale = false;
      continue;
    }
  }

  return args;
};

const normalizeOutcomeName = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const getOutcomeWeightForMarket = (aggregate, outcome) => {
  const normalizedOutcome = normalizeOutcomeName(outcome);
  return (
    aggregate?.outcomeWeights?.find((entry) => normalizeOutcomeName(entry.outcome) === normalizedOutcome)?.weight ??
    0
  );
};

const getEdgePointsForOutcome = (aggregate, outcome) => {
  const normalizedOutcome = normalizeOutcomeName(outcome);
  const trackedWeight =
    aggregate?.outcomeWeights?.find((entry) => normalizeOutcomeName(entry.outcome) === normalizedOutcome)?.weight ?? 0;
  const opposingWeight = Math.max(
    0,
    ...(aggregate?.outcomeWeights ?? [])
      .filter((entry) => normalizeOutcomeName(entry.outcome) !== normalizedOutcome)
      .map((entry) => Number(entry.weight ?? 0)),
  );
  return trackedWeight - opposingWeight;
};

const toOpenPositionKey = (marketSlug, outcome) => `${marketSlug}:${outcome}`;

const parseNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const loadActiveWalletPositions = async (wallet) => {
  const url = new URL(`${DATA_API_URL}/positions`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("sizeThreshold", ".1");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Positions API returned ${response.status}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Positions API returned an unexpected payload");
  }

  return rows.filter((row) => {
    const size = parseNumber(row.size);
    const currentPrice = parseNumber(row.curPrice);
    const currentValue = parseNumber(row.currentValue);
    return size > 0 && !row.redeemable && (currentPrice > 0 || currentValue > 0);
  });
};

const main = async () => {
  const { username, strategyKey, closeStale } = parseArgs(process.argv.slice(2));
  if (!username.trim()) {
    throw new Error("Username is required");
  }
  if (strategyKey !== "edge_swing") {
    throw new Error(`Unsupported strategy "${strategyKey}" for this sync script`);
  }

  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
  const dbName = process.env.MONGO_DB_NAME || "polymarket_signals";
  const now = Date.now();

  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(dbName);
    const userSettingsCollection = db.collection("user_webhooks");
    const liveStrategyPositionsCollection = db.collection("live_strategy_positions");
    const marketAggregatesCollection = db.collection("market_aggregates");

    const settings = await userSettingsCollection.findOne({ username });
    const wallet = String(settings?.tradingWalletAddress || "").trim();
    if (!wallet) {
      throw new Error(`No tradingWalletAddress found for username "${username}"`);
    }

    const positions = await loadActiveWalletPositions(wallet);
    const aggregates = await marketAggregatesCollection
      .find(
        { marketSlug: { $in: positions.map((position) => String(position.slug || "").trim()).filter(Boolean) } },
        { projection: { _id: 0 } },
      )
      .toArray();
    const aggregateBySlug = new Map(
      aggregates.map((aggregate) => [String(aggregate.marketSlug || "").trim(), aggregate]),
    );

    const existingOpenPositions = await liveStrategyPositionsCollection
      .find(
        {
          username,
          strategyKey,
          status: "open",
        },
        { projection: { _id: 0 } },
      )
      .toArray();
    const existingByKey = new Map(
      existingOpenPositions.map((position) => [toOpenPositionKey(position.marketSlug, position.outcome), position]),
    );

    let inserted = 0;
    let updated = 0;
    let closed = 0;
    const activeKeys = new Set();

    for (const position of positions) {
      const marketSlug = String(position.slug || "").trim();
      const outcome = String(position.outcome || "").trim();
      const size = parseNumber(position.size);
      if (!marketSlug || !outcome || size <= 0) {
        continue;
      }

      const key = toOpenPositionKey(marketSlug, outcome);
      activeKeys.add(key);

      const existing = existingByKey.get(key);
      const aggregate = aggregateBySlug.get(marketSlug);
      const currentPrice = parseNumber(position.curPrice, parseNumber(position.avgPrice, 0));
      const entryPrice = parseNumber(position.avgPrice, currentPrice);
      const totalBought = parseNumber(position.totalBought, size);
      const soldPercent = totalBought > 0 ? Math.max(0, Math.min(100, (1 - size / totalBought) * 100)) : 0;
      const originalParticipants =
        aggregate?.outcomeParticipants
          ?.filter((participant) => normalizeOutcomeName(participant.outcome) === normalizeOutcomeName(outcome))
          .map((participant) => ({
            wallet: String(participant.wallet || ""),
            weight: parseNumber(participant.weight),
            tier: participant.tier || "none",
          })) ?? [];
      const originalSmartMoneyWeight =
        originalParticipants.reduce((sum, participant) => sum + parseNumber(participant.weight), 0) ||
        getOutcomeWeightForMarket(aggregate, outcome);

      const syncedPosition = {
        id: existing?.id || `${username}:${marketSlug}:${outcome}:${strategyKey}:live:${randomUUID()}`,
        strategyKey,
        username,
        marketSlug,
        marketQuestion: String(position.title || existing?.marketQuestion || marketSlug),
        marketUrl: `https://polymarket.com/event/${marketSlug}`,
        marketImage: String(position.icon || existing?.marketImage || ""),
        outcome,
        status: "open",
        openedAt: existing?.openedAt || now,
        updatedAt: now,
        entryPrice,
        lastPrice: currentPrice,
        entryNotionalUsd: parseNumber(position.initialValue, size * entryPrice),
        remainingShares: size,
        realizedUsd: parseNumber(position.realizedPnl, existing?.realizedUsd || 0),
        originalSmartMoneyWeight,
        remainingSmartMoneyWeight: getOutcomeWeightForMarket(aggregate, outcome) || originalSmartMoneyWeight,
        soldPercent,
        trim96Hit: Boolean(existing?.trim96Hit),
        setupQuality: parseNumber(existing?.setupQuality, 0),
        peakEdgePoints: Math.max(
          parseNumber(existing?.peakEdgePoints, Number.NEGATIVE_INFINITY),
          getEdgePointsForOutcome(aggregate, outcome),
        ),
        peakOutcomeWeight: Math.max(
          parseNumber(existing?.peakOutcomeWeight, Number.NEGATIVE_INFINITY),
          getOutcomeWeightForMarket(aggregate, outcome),
        ),
        originalParticipants,
      };

      if (!Number.isFinite(syncedPosition.peakEdgePoints)) {
        syncedPosition.peakEdgePoints = getEdgePointsForOutcome(aggregate, outcome);
      }
      if (!Number.isFinite(syncedPosition.peakOutcomeWeight)) {
        syncedPosition.peakOutcomeWeight = getOutcomeWeightForMarket(aggregate, outcome);
      }

      const result = await liveStrategyPositionsCollection.updateOne(
        { id: syncedPosition.id },
        { $set: syncedPosition },
        { upsert: true },
      );

      if (!existing && result.upsertedCount > 0) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    if (closeStale) {
      for (const position of existingOpenPositions) {
        const key = toOpenPositionKey(position.marketSlug, position.outcome);
        if (activeKeys.has(key)) {
          continue;
        }

        await liveStrategyPositionsCollection.updateOne(
          { id: position.id },
          {
            $set: {
              status: "closed",
              updatedAt: now,
              remainingShares: 0,
              soldPercent: 100,
              exitReason: "Wallet sync: not present in active positions",
            },
          },
        );
        closed += 1;
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          username,
          strategyKey,
          wallet,
          activePositionsFound: positions.length,
          inserted,
          updated,
          closed,
          closeStale,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
};

await main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
