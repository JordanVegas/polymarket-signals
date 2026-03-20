import { MongoClient } from "mongodb";
import { createHash, createDecipheriv } from "node:crypto";
import { Wallet } from "@ethersproject/wallet";
import { AssetType, ClobClient, SignatureType } from "@polymarket/clob-client";

const CLOB_API_URL = "https://clob.polymarket.com";
const DATA_API_URL = "https://data-api.polymarket.com";
const USDC_BASE_UNITS = 1_000_000;

const parseArgs = (argv) => {
  const options = {
    username: "tuf",
    strategy: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--username") {
      options.username = String(argv[index + 1] ?? options.username).trim() || options.username;
      index += 1;
      continue;
    }

    if (token === "--strategy") {
      const value = String(argv[index + 1] ?? "").trim();
      options.strategy = value || null;
      index += 1;
    }
  }

  return options;
};

const deriveKey = (secret) => createHash("sha256").update(secret).digest();

const decryptSecret = (payload, encryptionKey) => {
  const [ivPart, authTagPart, encryptedPart] = String(payload ?? "").split(".");
  if (!ivPart || !authTagPart || !encryptedPart) {
    throw new Error("Malformed encrypted secret payload");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(encryptionKey),
    Buffer.from(ivPart, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagPart, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
};

const normalizeOutcome = (value) => String(value ?? "").trim().toLowerCase();
const positionKey = (marketSlug, outcome) => `${String(marketSlug ?? "").trim().toLowerCase()}::${normalizeOutcome(outcome)}`;
const roundUsd = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const summarizeRows = (rows, limit = 15) => rows.slice(0, limit);

const createLiveTradingClient = (settings) => {
  const privateKey = decryptSecret(settings.encryptedPrivateKey, process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me");
  const creds = {
    key: decryptSecret(settings.encryptedApiKey, process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me"),
    secret: decryptSecret(settings.encryptedApiSecret, process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me"),
    passphrase: decryptSecret(settings.encryptedApiPassphrase, process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me"),
  };
  const signer = new Wallet(privateKey);
  const signatureType =
    settings.tradingSignatureType === "POLY_PROXY" ? SignatureType.POLY_PROXY : SignatureType.EOA;

  return new ClobClient(
    CLOB_API_URL,
    137,
    signer,
    creds,
    signatureType,
    settings.tradingWalletAddress ?? undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
};

const fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}`);
  }

  return response.json();
};

const main = async () => {
  const { username, strategy } = parseArgs(process.argv);
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
  const dbName = process.env.MONGO_DB_NAME || "polymarket_signals";

  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(dbName);
    const settings = await db.collection("user_webhooks").findOne(
      { username },
      {
        projection: {
          _id: 0,
          username: 1,
          tradingWalletAddress: 1,
          tradingSignatureType: 1,
          encryptedPrivateKey: 1,
          encryptedApiKey: 1,
          encryptedApiSecret: 1,
          encryptedApiPassphrase: 1,
          liveTradeEnabled: 1,
          edgeSwingLiveTradingEnabled: 1,
        },
      },
    );

    if (!settings?.tradingWalletAddress) {
      throw new Error(`No trading wallet configured for ${username}`);
    }

    const livePositionFilter = {
      username,
      status: "open",
      ...(strategy ? { strategyKey: strategy } : {}),
    };
    const dbPositions = await db.collection("live_strategy_positions").find(
      livePositionFilter,
      {
        projection: {
          _id: 0,
          id: 1,
          strategyKey: 1,
          marketSlug: 1,
          outcome: 1,
          remainingShares: 1,
          lastPrice: 1,
          entryPrice: 1,
          entryNotionalUsd: 1,
          updatedAt: 1,
        },
      },
    ).toArray();

    const wallet = settings.tradingWalletAddress;
    const [publicPositions, publicValueRows] = await Promise.all([
      fetchJson(`${DATA_API_URL}/positions?user=${wallet}&sizeThreshold=.1`),
      fetchJson(`${DATA_API_URL}/value?user=${wallet}`),
    ]);

    const liveClient = createLiveTradingClient(settings);
    const collateralResponse = await liveClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const collateralUsd = Number(collateralResponse.balance ?? 0) / USDC_BASE_UNITS;

    const dbExposureUsd = dbPositions.reduce(
      (sum, position) => sum + Number(position.remainingShares ?? 0) * Number(position.lastPrice ?? 0),
      0,
    );
    const appEquityUsd = collateralUsd + dbExposureUsd;
    const publicValueUsd = Number(publicValueRows?.[0]?.value ?? 0);

    const dbPositionMap = new Map(
      dbPositions.map((position) => [positionKey(position.marketSlug, position.outcome), position]),
    );
    const publicPositionMap = new Map(
      publicPositions.map((position) => [positionKey(position.slug, position.outcome), position]),
    );

    const trackedButNotPublic = dbPositions
      .filter((position) => !publicPositionMap.has(positionKey(position.marketSlug, position.outcome)))
      .map((position) => ({
        strategyKey: position.strategyKey ?? "best_trades",
        marketSlug: position.marketSlug,
        outcome: position.outcome,
        remainingShares: Number(position.remainingShares ?? 0),
        lastPrice: Number(position.lastPrice ?? 0),
        appValueUsd: roundUsd(Number(position.remainingShares ?? 0) * Number(position.lastPrice ?? 0)),
      }));

    const publicButUntracked = publicPositions
      .filter((position) => !dbPositionMap.has(positionKey(position.slug, position.outcome)))
      .map((position) => ({
        marketSlug: position.slug,
        outcome: position.outcome,
        size: Number(position.size ?? 0),
        cashPnl: roundUsd(Number(position.cashPnl ?? 0)),
        realizedPnl: roundUsd(Number(position.realizedPnl ?? 0)),
        title: position.title ?? "",
      }));

    const matched = dbPositions.map((position) => {
      const walletPosition = publicPositionMap.get(positionKey(position.marketSlug, position.outcome));
      return {
        strategyKey: position.strategyKey ?? "best_trades",
        marketSlug: position.marketSlug,
        outcome: position.outcome,
        dbShares: roundUsd(Number(position.remainingShares ?? 0)),
        walletShares: roundUsd(Number(walletPosition?.size ?? 0)),
        shareDelta: roundUsd(Number(position.remainingShares ?? 0) - Number(walletPosition?.size ?? 0)),
        appLastPrice: roundUsd(Number(position.lastPrice ?? 0)),
        appValueUsd: roundUsd(Number(position.remainingShares ?? 0) * Number(position.lastPrice ?? 0)),
        walletCashPnl: roundUsd(Number(walletPosition?.cashPnl ?? 0)),
        walletRealizedPnl: roundUsd(Number(walletPosition?.realizedPnl ?? 0)),
      };
    }).sort((left, right) => Math.abs(right.shareDelta) - Math.abs(left.shareDelta));

    const summary = {
      username,
      wallet,
      strategy: strategy ?? "all",
      dbOpenPositionCount: dbPositions.length,
      dbExposureUsd: roundUsd(dbExposureUsd),
      appCollateralUsd: roundUsd(collateralUsd),
      appEquityUsd: roundUsd(appEquityUsd),
      publicPortfolioValueUsd: roundUsd(publicValueUsd),
      differenceUsd: roundUsd(publicValueUsd - appEquityUsd),
      trackedButNotPublicCount: trackedButNotPublic.length,
      publicButUntrackedCount: publicButUntracked.length,
    };

    console.log(JSON.stringify({
      summary,
      matchedPositions: summarizeRows(matched),
      trackedButNotPublic: summarizeRows(trackedButNotPublic),
      publicButUntracked: summarizeRows(publicButUntracked),
    }, null, 2));
  } finally {
    await client.close();
  }
};

await main();
