import { createDecipheriv, createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import { Wallet } from "@ethersproject/wallet";
import {
  AssetType,
  ClobClient,
  OrderType,
  Side as ClobSide,
  SignatureType,
} from "@polymarket/clob-client";

const DATA_API_URL = "https://data-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const USDC_BASE_UNITS = 1_000_000;
const ALGORITHM = "aes-256-gcm";

const deriveKey = (secret) => createHash("sha256").update(secret).digest();

const decryptSecret = (payload, encryptionKey) => {
  const [ivPart, authTagPart, encryptedPart] = String(payload || "").split(".");
  if (!ivPart || !authTagPart || !encryptedPart) {
    throw new Error("Malformed encrypted secret payload");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
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

const parseArgs = (argv) => {
  const args = {
    username: "tuf",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--username" && argv[index + 1]) {
      args.username = String(argv[index + 1]);
      index += 1;
    }
  }

  return args;
};

const parseNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toKey = (marketSlug, outcome) => `${String(marketSlug || "").trim()}:${String(outcome || "").trim()}`;

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

const createLiveTradingClient = (settings, tradingEncryptionSecret) => {
  const privateKey = decryptSecret(settings.encryptedPrivateKey, tradingEncryptionSecret);
  const creds = {
    key: decryptSecret(settings.encryptedApiKey, tradingEncryptionSecret),
    secret: decryptSecret(settings.encryptedApiSecret, tradingEncryptionSecret),
    passphrase: decryptSecret(settings.encryptedApiPassphrase, tradingEncryptionSecret),
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

const ensureLiveAllowance = async (client, assetType, minimumAmount, tokenID) => {
  const response = await client.getBalanceAllowance(
    assetType === AssetType.CONDITIONAL ? { asset_type: assetType, token_id: tokenID } : { asset_type: assetType },
  );
  const allowance =
    assetType === AssetType.COLLATERAL
      ? Number(response.allowance ?? 0) / USDC_BASE_UNITS
      : Number(response.allowance ?? 0);

  if (allowance >= minimumAmount) {
    return;
  }

  await client.updateBalanceAllowance(
    assetType === AssetType.CONDITIONAL ? { asset_type: assetType, token_id: tokenID } : { asset_type: assetType },
  );
};

const getLiveOrderOptions = async (client, tokenID) => {
  const book = await client.getOrderBook(tokenID);
  return {
    tickSize: book.tick_size,
    negRisk: book.neg_risk,
  };
};

const closePosition = async (client, position) => {
  const tokenID = String(position.asset || "").trim();
  const marketSlug = String(position.slug || "").trim();
  const outcome = String(position.outcome || "").trim();
  const shares = parseNumber(position.size);

  if (!tokenID || !marketSlug || !outcome || shares <= 0) {
    throw new Error(`Invalid position payload for ${marketSlug || tokenID || "unknown market"}`);
  }

  const options = await getLiveOrderOptions(client, tokenID);
  await ensureLiveAllowance(client, AssetType.CONDITIONAL, shares, tokenID);

  const sellPrice = await client.calculateMarketPrice(tokenID, ClobSide.SELL, shares, OrderType.FOK);
  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    throw new Error(`No sell price available for ${marketSlug} ${outcome}`);
  }

  const response = await client.createAndPostMarketOrder(
    {
      tokenID,
      amount: shares,
      side: ClobSide.SELL,
    },
    options,
    OrderType.FOK,
  );

  return {
    marketSlug,
    outcome,
    shares,
    sellPrice,
    orderId:
      response?.orderID ??
      response?.orderId ??
      response?.id ??
      null,
    status:
      response?.status ??
      (typeof response?.success === "boolean" ? (response.success ? "success" : "failed") : null),
  };
};

const main = async () => {
  const { username } = parseArgs(process.argv.slice(2));
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
  const dbName = process.env.MONGO_DB_NAME || "polymarket_signals";
  const tradingEncryptionSecret =
    process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me";

  const client = new MongoClient(mongoUri);
  await client.connect();

  try {
    const db = client.db(dbName);
    const userSettingsCollection = db.collection("user_webhooks");
    const liveStrategyPositionsCollection = db.collection("live_strategy_positions");

    const settings = await userSettingsCollection.findOne({ username });
    if (!settings) {
      throw new Error(`No user settings found for "${username}"`);
    }

    const tradingWalletAddress = String(settings.tradingWalletAddress || "").trim();
    if (
      !tradingWalletAddress ||
      !settings.encryptedPrivateKey ||
      !settings.encryptedApiKey ||
      !settings.encryptedApiSecret ||
      !settings.encryptedApiPassphrase
    ) {
      throw new Error(`Missing live trading credentials for "${username}"`);
    }

    const trackedOpenPositions = await liveStrategyPositionsCollection
      .find(
        { username, status: "open" },
        { projection: { _id: 0, id: 1, marketSlug: 1, outcome: 1, strategyKey: 1, remainingShares: 1 } },
      )
      .toArray();
    const trackedKeys = new Set(
      trackedOpenPositions.map((position) => toKey(position.marketSlug, position.outcome)),
    );

    const walletPositions = await loadActiveWalletPositions(tradingWalletAddress);
    const walletKeys = new Set(walletPositions.map((position) => toKey(position.slug, position.outcome)));
    const untrackedPositions = walletPositions.filter(
      (position) => !trackedKeys.has(toKey(position.slug, position.outcome)),
    );
    const staleTrackedPositions = trackedOpenPositions.filter(
      (position) => !walletKeys.has(toKey(position.marketSlug, position.outcome)),
    );

    const tradingClient = createLiveTradingClient(settings, tradingEncryptionSecret);
    const closed = [];
    const failed = [];
    const staleDbClosed = [];

    for (const position of untrackedPositions) {
      try {
        const result = await closePosition(tradingClient, position);
        closed.push(result);
      } catch (error) {
        failed.push({
          marketSlug: String(position.slug || "").trim(),
          outcome: String(position.outcome || "").trim(),
          shares: parseNumber(position.size),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const closedAt = Date.now();
    for (const position of staleTrackedPositions) {
      await liveStrategyPositionsCollection.updateOne(
        { id: position.id },
        {
          $set: {
            status: "closed",
            updatedAt: closedAt,
            remainingShares: 0,
            soldPercent: 100,
            exitReason: "DB cleanup: position not present in wallet",
          },
        },
      );
      staleDbClosed.push({
        id: position.id,
        marketSlug: position.marketSlug,
        outcome: position.outcome,
        strategyKey: position.strategyKey ?? null,
      });
    }

    const summary = {
      ok: failed.length === 0,
      username,
      tradingWalletAddress,
      trackedOpenPositionCount: trackedOpenPositions.length,
      walletActivePositionCount: walletPositions.length,
      untrackedPositionCount: untrackedPositions.length,
      staleTrackedPositionCount: staleTrackedPositions.length,
      closedCount: closed.length,
      staleDbClosedCount: staleDbClosed.length,
      failedCount: failed.length,
      closed,
      staleDbClosed,
      failed,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (failed.length > 0) {
      process.exit(1);
    }
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
