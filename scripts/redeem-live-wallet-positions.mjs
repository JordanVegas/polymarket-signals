import { createDecipheriv, createHash } from "node:crypto";
import { MongoClient } from "mongodb";
import { Wallet } from "@ethersproject/wallet";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider } from "@ethersproject/providers";
import { getContractConfig } from "@polymarket/clob-client";

const DATA_API_URL = "https://data-api.polymarket.com";
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const ALGORITHM = "aes-256-gcm";
const POLYGON_CHAIN_ID = 137;
const DEFAULT_POLYGON_RPC_URL = "https://polygon-rpc.com";
const CONDITIONAL_TOKENS_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

const parseArgs = (argv) => {
  const args = {
    username: null,
    execute: false,
    minShares: 0.1,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--username" && argv[index + 1]) {
      args.username = String(argv[index + 1]).trim() || null;
      index += 1;
      continue;
    }

    if (current === "--execute") {
      args.execute = true;
      continue;
    }

    if (current === "--min-shares" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed >= 0) {
        args.minShares = parsed;
      }
      index += 1;
    }
  }

  return args;
};

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

const parseNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundNumber = (value, decimals = 4) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const fetchWalletPositions = async (wallet) => {
  const url = new URL(`${DATA_API_URL}/positions`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("sizeThreshold", "0");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Positions API returned ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Positions API returned an unexpected payload");
  }

  return payload;
};

const buildRedeemPlan = (positions, marketCatalogBySlug, minimumShares) => {
  const skipped = [];
  const groupsByConditionId = new Map();

  for (const position of positions) {
    const marketSlug = String(position.slug || "").trim();
    const outcome = String(position.outcome || "").trim();
    const assetId = String(position.asset || "").trim();
    const shares = parseNumber(position.size);

    if (shares < minimumShares) {
      skipped.push({
        marketSlug,
        outcome,
        assetId,
        shares: roundNumber(shares),
        reason: `shares below minimum threshold (${minimumShares})`,
      });
      continue;
    }

    const market = marketCatalogBySlug.get(marketSlug);
    if (!market) {
      skipped.push({
        marketSlug,
        outcome,
        assetId,
        shares: roundNumber(shares),
        reason: "market catalog entry missing",
      });
      continue;
    }

    const outcomeEntries = Object.entries(market.outcomeByAssetId ?? {});
    const outcomeIndex = outcomeEntries.findIndex(([candidateAssetId]) => String(candidateAssetId).trim() === assetId);
    if (outcomeIndex === -1) {
      skipped.push({
        marketSlug,
        outcome,
        assetId,
        shares: roundNumber(shares),
        conditionId: market.conditionId,
        reason: "asset id not present in market catalog",
      });
      continue;
    }

    if (outcomeIndex >= 31) {
      skipped.push({
        marketSlug,
        outcome,
        assetId,
        shares: roundNumber(shares),
        conditionId: market.conditionId,
        reason: "market has too many outcomes for numeric indexSet handling",
      });
      continue;
    }

    const indexSet = 2 ** outcomeIndex;
    const existingGroup = groupsByConditionId.get(market.conditionId) ?? {
      conditionId: market.conditionId,
      marketSlug,
      question: market.question,
      indexSets: new Set(),
      positions: [],
    };

    existingGroup.indexSets.add(indexSet);
    existingGroup.positions.push({
      marketSlug,
      outcome,
      assetId,
      shares: roundNumber(shares),
      indexSet,
    });
    groupsByConditionId.set(market.conditionId, existingGroup);
  }

  const groups = Array.from(groupsByConditionId.values()).map((group) => ({
    conditionId: group.conditionId,
    marketSlug: group.marketSlug,
    question: group.question,
    indexSets: Array.from(group.indexSets).sort((left, right) => left - right),
    positions: group.positions,
  }));

  return { groups, skipped };
};

const createWalletSigner = (settings, tradingEncryptionSecret, provider) => {
  const privateKey = decryptSecret(settings.encryptedPrivateKey, tradingEncryptionSecret);
  return new Wallet(privateKey, provider);
};

const main = async () => {
  const { username, execute, minShares } = parseArgs(process.argv);
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
  const dbName = process.env.MONGO_DB_NAME || "polymarket_signals";
  const tradingEncryptionSecret =
    process.env.TRADING_ENCRYPTION_SECRET || process.env.WEB_SESSION_SECRET || "change-me";
  const polygonRpcUrl = process.env.POLYGON_RPC_URL || process.env.RPC_URL || DEFAULT_POLYGON_RPC_URL;

  const mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();

  try {
    const db = mongoClient.db(dbName);
    const userSettingsCollection = db.collection("user_webhooks");
    const marketCatalogCollection = db.collection("market_catalog");

    const users = await userSettingsCollection.find(
      {
        tradingWalletAddress: { $exists: true, $ne: "" },
        encryptedPrivateKey: { $exists: true, $ne: "" },
        ...(username ? { username } : {}),
      },
      {
        projection: {
          _id: 0,
          username: 1,
          tradingWalletAddress: 1,
          tradingSignatureType: 1,
          encryptedPrivateKey: 1,
        },
      },
    ).toArray();

    const provider = execute ? new JsonRpcProvider(polygonRpcUrl, POLYGON_CHAIN_ID) : null;
    const contractConfig = getContractConfig(POLYGON_CHAIN_ID);
    const summaries = [];
    let hasFailures = false;

    for (const settings of users) {
      const normalizedUsername = String(settings.username || "").trim();
      const walletAddress = String(settings.tradingWalletAddress || "").trim();
      if (!normalizedUsername || !walletAddress) {
        continue;
      }

      const allPositions = await fetchWalletPositions(walletAddress);
      const redeemablePositions = allPositions.filter((position) => {
        const shares = parseNumber(position.size);
        return shares > 0 && position.redeemable === true;
      });

      const marketSlugs = Array.from(
        new Set(
          redeemablePositions
            .map((position) => String(position.slug || "").trim())
            .filter(Boolean),
        ),
      );
      const marketCatalogRows = marketSlugs.length > 0
        ? await marketCatalogCollection.find(
            { slug: { $in: marketSlugs } },
            { projection: { _id: 0, slug: 1, question: 1, conditionId: 1, outcomeByAssetId: 1 } },
          ).toArray()
        : [];
      const marketCatalogBySlug = new Map(
        marketCatalogRows.map((market) => [String(market.slug).trim(), market]),
      );

      const { groups, skipped } = buildRedeemPlan(redeemablePositions, marketCatalogBySlug, minShares);
      const summary = {
        ok: true,
        username: normalizedUsername,
        tradingWalletAddress: walletAddress,
        tradingSignatureType: settings.tradingSignatureType ?? "EOA",
        execute,
        redeemablePositionCount: redeemablePositions.length,
        redeemableGroupCount: groups.length,
        skippedCount: skipped.length,
        groups,
        skipped,
        executed: [],
        failures: [],
      };

      if (execute && groups.length > 0) {
        try {
          const signer = createWalletSigner(settings, tradingEncryptionSecret, provider);
          const signerAddress = await signer.getAddress();
          const normalizedSignerAddress = signerAddress.trim().toLowerCase();
          const normalizedWalletAddress = walletAddress.toLowerCase();

          if (
            String(settings.tradingSignatureType || "EOA") === "POLY_PROXY" &&
            normalizedSignerAddress !== normalizedWalletAddress
          ) {
            throw new Error(
              `Wallet uses POLY_PROXY and signer ${signerAddress} does not match trading wallet ${walletAddress}`,
            );
          }

          const contract = new Contract(
            contractConfig.conditionalTokens,
            CONDITIONAL_TOKENS_ABI,
            signer,
          );

          for (const group of groups) {
            try {
              const tx = await contract.redeemPositions(
                contractConfig.collateral,
                ZERO_BYTES32,
                group.conditionId,
                group.indexSets,
              );
              const receipt = await tx.wait(1);
              summary.executed.push({
                conditionId: group.conditionId,
                marketSlug: group.marketSlug,
                txHash: receipt.transactionHash,
                blockNumber: receipt.blockNumber,
                indexSets: group.indexSets,
              });
            } catch (error) {
              summary.ok = false;
              hasFailures = true;
              summary.failures.push({
                conditionId: group.conditionId,
                marketSlug: group.marketSlug,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          summary.ok = false;
          hasFailures = true;
          summary.failures.push({
            scope: "user",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      summaries.push(summary);
    }

    console.log(JSON.stringify({
      ok: !hasFailures,
      execute,
      usernameScope: username ?? "all_wallet_users",
      minShares,
      polygonRpcUrl,
      usersProcessed: summaries.length,
      summaries,
    }, null, 2));

    if (hasFailures) {
      process.exit(1);
    }
  } finally {
    await mongoClient.close();
  }
};

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
