import crypto from "node:crypto";
import { MongoClient } from "mongodb";

const parseArgs = (argv) => {
  const args = {
    username: "",
    password: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--username" && argv[index + 1]) {
      args.username = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--password" && argv[index + 1]) {
      args.password = String(argv[index + 1]);
      index += 1;
    }
  }

  return args;
};

const derivePasswordHash = (password, salt) =>
  crypto.scryptSync(String(password), String(salt), 64).toString("hex");

const main = async () => {
  const { username, password } = parseArgs(process.argv.slice(2));
  if (!username.trim() || !password) {
    throw new Error("Both --username and --password are required");
  }

  const authMongoUri = process.env.AUTH_MONGO_URI || "mongodb://127.0.0.1:27017/authentication";
  const client = new MongoClient(authMongoUri);
  await client.connect();

  try {
    const collection = client.db().collection("webusers");
    const existing = await collection.findOne({ username });

    if (existing) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            username,
            created: false,
            reason: "already_exists",
            allowedApps: existing.allowedApps ?? [],
          },
          null,
          2,
        ),
      );
      return;
    }

    const passwordSalt = crypto.randomBytes(16).toString("hex");
    const passwordHash = derivePasswordHash(password, passwordSalt);
    await collection.insertOne({
      username,
      passwordSalt,
      passwordHash,
      allowedApps: ["polysignals"],
    });

    const created = await collection.findOne(
      { username },
      { projection: { _id: 0, username: 1, allowedApps: 1 } },
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          username,
          created: true,
          user: created,
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
