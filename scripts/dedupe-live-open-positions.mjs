import fs from "node:fs";
import process from "node:process";
import { MongoClient } from "mongodb";

const parseEnvFile = (path) => {
  const raw = fs.readFileSync(path, "utf8").replace(/\r/g, "");
  const env = {};
  for (const line of raw.split("\n")) {
    if (!line || /^\s*#/.test(line) || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return env;
};

const envPath = process.argv[2] || ".env.app-execution";
const env = {
  ...process.env,
  ...parseEnvFile(envPath),
};

if (!env.MONGO_URI || !env.MONGO_DB_NAME) {
  throw new Error("MONGO_URI and MONGO_DB_NAME are required");
}

const scorePosition = (position) =>
  (Number(position.updatedAt ?? 0) * 10)
  + (position.pendingCloseOrderId ? 1 : 0);

const pickWinner = (positions) =>
  [...positions].sort((left, right) => scorePosition(right) - scorePosition(left))[0];

const mergeIntoWinner = (winner, duplicates) => {
  const merged = { ...winner };
  for (const duplicate of duplicates) {
    merged.openedAt = Math.min(Number(merged.openedAt ?? 0), Number(duplicate.openedAt ?? merged.openedAt ?? 0));
    merged.updatedAt = Math.max(Number(merged.updatedAt ?? 0), Number(duplicate.updatedAt ?? 0));
    merged.realizedUsd = Math.max(Number(merged.realizedUsd ?? 0), Number(duplicate.realizedUsd ?? 0));
    merged.trim96Hit = Boolean(merged.trim96Hit || duplicate.trim96Hit);
    merged.peakEdgePoints = Math.max(
      Number(merged.peakEdgePoints ?? 0),
      Number(duplicate.peakEdgePoints ?? 0),
    ) || undefined;
    merged.peakOutcomeWeight = Math.max(
      Number(merged.peakOutcomeWeight ?? 0),
      Number(duplicate.peakOutcomeWeight ?? 0),
    ) || undefined;
    if (!merged.pendingCloseOrderId && duplicate.pendingCloseOrderId) {
      merged.pendingCloseOrderId = duplicate.pendingCloseOrderId;
      merged.pendingClosePrice = duplicate.pendingClosePrice;
      merged.pendingCloseReason = duplicate.pendingCloseReason;
      merged.pendingClosePlacedAt = duplicate.pendingClosePlacedAt;
      merged.pendingCloseStatus = duplicate.pendingCloseStatus;
    }
  }
  return merged;
};

const client = new MongoClient(env.MONGO_URI, {
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
});

await client.connect();

try {
  const db = client.db(env.MONGO_DB_NAME);
  const collection = db.collection("live_strategy_positions");

  const groups = await collection.aggregate([
    { $match: { status: "open" } },
    {
      $group: {
        _id: {
          username: "$username",
          strategyKey: "$strategyKey",
          marketSlug: "$marketSlug",
          outcome: "$outcome",
        },
        ids: { $push: "$id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  const summary = {
    duplicateGroups: groups.length,
    deletedDocuments: 0,
    updatedDocuments: 0,
    groups: [],
  };

  for (const group of groups) {
    const positions = await collection.find({
      id: { $in: group.ids },
    }).toArray();

    if (positions.length < 2) {
      continue;
    }

    const winner = pickWinner(positions);
    const losers = positions.filter((position) => position.id !== winner.id);
    const merged = mergeIntoWinner(winner, losers);

    await collection.updateOne(
      { id: winner.id },
      {
        $set: {
          ...merged,
          updatedAtDate: new Date(),
        },
      },
    );
    summary.updatedDocuments += 1;

    if (losers.length > 0) {
      const deleteResult = await collection.deleteMany({
        id: { $in: losers.map((position) => position.id) },
      });
      summary.deletedDocuments += deleteResult.deletedCount;
    }

    summary.groups.push({
      key: group._id,
      keptId: winner.id,
      removedIds: losers.map((position) => position.id),
    });
  }

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
}
