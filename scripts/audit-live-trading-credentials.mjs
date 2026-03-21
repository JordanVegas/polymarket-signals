import { MongoClient } from "mongodb";
import { decryptSecret } from "../dist/server/server/src/secrets.js";

const trim = (value) => (typeof value === "string" ? value.trim() : value);

const mongoUri = trim(process.env.MONGO_URI);
const dbName = trim(process.env.MONGO_DB_NAME) || "polymarket_signals";
const encryptionSecret =
  trim(process.env.TRADING_ENCRYPTION_SECRET) || trim(process.env.WEB_SESSION_SECRET) || "";
const shouldDisableBrokenUsers = process.argv.includes("--disable-live-flags");

if (!mongoUri) {
  throw new Error("MONGO_URI is required");
}

if (!encryptionSecret) {
  throw new Error("TRADING_ENCRYPTION_SECRET or WEB_SESSION_SECRET is required");
}

const client = new MongoClient(mongoUri);
await client.connect();

const collection = client.db(dbName).collection("user_webhooks");
const rows = await collection
  .find(
    {},
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
        updatedAt: 1,
      },
    },
  )
  .toArray();

const results = [];
for (const row of rows) {
  const encryptedFields = [
    ["encryptedPrivateKey", row.encryptedPrivateKey],
    ["encryptedApiKey", row.encryptedApiKey],
    ["encryptedApiSecret", row.encryptedApiSecret],
    ["encryptedApiPassphrase", row.encryptedApiPassphrase],
  ].filter(([, value]) => typeof value === "string" && value.trim());

  if (encryptedFields.length === 0) {
    continue;
  }

  const fieldResults = {};
  let ok = true;
  for (const [name, value] of encryptedFields) {
    try {
      const decrypted = decryptSecret(value, encryptionSecret);
      fieldResults[name] = { ok: true, length: decrypted.length };
    } catch (error) {
      ok = false;
      fieldResults[name] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  results.push({
    username: row.username,
    tradingWalletAddress: row.tradingWalletAddress ?? null,
    liveTradeEnabled: Boolean(row.liveTradeEnabled),
    edgeSwingLiveTradingEnabled: Boolean(row.edgeSwingLiveTradingEnabled),
    updatedAt: row.updatedAt ?? null,
    ok,
    fieldResults,
  });
}

const brokenUsers = results.filter((row) => !row.ok);

if (shouldDisableBrokenUsers && brokenUsers.length > 0) {
  for (const user of brokenUsers) {
    await collection.updateOne(
      { username: user.username },
      {
        $set: {
          liveTradeEnabled: false,
          edgeSwingLiveTradingEnabled: false,
        },
      },
    );
  }
}

console.log(
  JSON.stringify(
    {
      totalWithEncryptedCreds: results.length,
      okUsers: results.filter((row) => row.ok).map((row) => row.username),
      brokenUsers,
      disabledBrokenUsers: shouldDisableBrokenUsers ? brokenUsers.map((row) => row.username) : [],
    },
    null,
    2,
  ),
);

await client.close();
