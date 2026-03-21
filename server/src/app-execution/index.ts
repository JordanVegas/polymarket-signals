import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { SharedAuthService } from "../auth.js";
import { config } from "../config.js";
import { AppExecutionService } from "./service.js";

const app = express();
const auth = new SharedAuthService();
app.use(cors());
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((_request, response, next) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; script-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; block-all-mixed-content",
  );
  next();
});
app.use(auth.createSessionMiddleware());
app.use(auth.attachSessionUser());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveClientDistDir(currentDir: string): string | null {
  const candidates = [
    path.resolve(currentDir, "../../../dist"),
    path.resolve(currentDir, "../../../../"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

const clientDistDir = resolveClientDistDir(__dirname);
const builtClientIndex = clientDistDir ? path.join(clientDistDir, "index.html") : null;
const hasBuiltClient = Boolean(clientDistDir && builtClientIndex);

const service = new AppExecutionService();

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "app-execution" });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "app-execution" });
});

app.get("/login", (request, response) => {
  auth.handleLoginPage(request, response);
});

app.post("/login", async (request, response) => {
  await auth.handleLogin(request, response);
});

app.get("/logout", (request, response) => {
  auth.handleLogout(request, response);
});

app.get("/api/snapshot", async (_request, response) => {
  response.json(await service.getSnapshot());
});

app.get("/api/profile", async (request, response) => {
  try {
    if (!request.sessionUser?.username) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    response.json(await service.getUserProfile(request.sessionUser.username));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to load profile",
    });
  }
});

app.put("/api/profile", async (request, response) => {
  try {
    if (!request.sessionUser?.username) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const webhookUrl = String(request.body.webhookUrl ?? "");
    const monitoredWallet = String(request.body.monitoredWallet ?? "");
    const paperTradingEnabled = Boolean(request.body.paperTradingEnabled);
    const liveTradingEnabled = Boolean(request.body.liveTradingEnabled);
    const startingBalanceUsd = Number(request.body.startingBalanceUsd ?? 1000);
    const riskPercent = Number(request.body.riskPercent ?? 5);
    const edgeSwingPaperTradingEnabled = Boolean(request.body.edgeSwingPaperTradingEnabled);
    const edgeSwingLiveTradingEnabled = Boolean(request.body.edgeSwingLiveTradingEnabled);
    const edgeSwingStartingBalanceUsd = Number(request.body.edgeSwingStartingBalanceUsd ?? 1000);
    const edgeSwingRiskPercent = Number(request.body.edgeSwingRiskPercent ?? 5);
    const tradingWalletAddress = String(request.body.tradingWalletAddress ?? "");
    const tradingSignatureType =
      String(request.body.tradingSignatureType ?? "EOA") === "POLY_PROXY" ? "POLY_PROXY" : "EOA";
    const privateKey = String(request.body.privateKey ?? "");
    const apiKey = String(request.body.apiKey ?? "");
    const apiSecret = String(request.body.apiSecret ?? "");
    const apiPassphrase = String(request.body.apiPassphrase ?? "");
    const clearTradingCredentials = Boolean(request.body.clearTradingCredentials);
    response.json(
      await service.updateUserProfile(request.sessionUser.username, {
        webhookUrl,
        monitoredWallet,
        paperTradingEnabled,
        liveTradingEnabled,
        startingBalanceUsd,
        riskPercent,
        edgeSwingPaperTradingEnabled,
        edgeSwingLiveTradingEnabled,
        edgeSwingStartingBalanceUsd,
        edgeSwingRiskPercent,
        tradingWalletAddress,
        tradingSignatureType,
        privateKey,
        apiKey,
        apiSecret,
        apiPassphrase,
        clearTradingCredentials,
      }),
    );
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to save profile",
    });
  }
});

app.get("/api/markets", async (request, response) => {
  const sortParam = String(request.query.sort ?? "recent");
  const sort = (
    ["recent", "weighted", "buyWeight", "flow", "participants"].includes(sortParam)
      ? sortParam
      : "recent"
  ) as "recent" | "weighted" | "buyWeight" | "flow" | "participants";
  const view = String(request.query.view ?? "monitor") === "best" ? "best" : "monitor";
  const search = String(request.query.search ?? "");
  const page = Number(request.query.page ?? 1);
  const pageSize = Number(request.query.pageSize ?? 24);
  response.json(await service.getMarketPage(sort, search, view, page, pageSize, request.sessionUser?.username));
});

app.get("/api/gaps", async (request, response) => {
  const page = Number(request.query.page ?? 1);
  const pageSize = Number(request.query.pageSize ?? 24);
  response.json(await service.getGapPage(page, pageSize));
});

app.get("/api/strategy-positions", async (request, response) => {
  if (!request.sessionUser?.username) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const strategyKey = String(request.query.strategy ?? "best_trades") === "edge_swing" ? "edge_swing" : "best_trades";
  response.json(await service.getStrategyPositions(request.sessionUser.username, strategyKey));
});

app.get("/api/live-strategy-positions", async (request, response) => {
  if (!request.sessionUser?.username) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const strategyKey = String(request.query.strategy ?? "best_trades") === "edge_swing" ? "edge_swing" : "best_trades";
  response.json(await service.getLiveStrategyPositions(request.sessionUser.username, strategyKey));
});

app.post("/api/market-alerts/watch", async (request, response) => {
  try {
    const marketSlug = String(request.body.marketSlug ?? "").trim();
    const outcome = String(request.body.outcome ?? "").trim();

    if (!request.sessionUser?.username) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!marketSlug || !outcome) {
      response.status(400).json({ error: "Market slug and outcome are required" });
      return;
    }

    response.json(await service.watchMarket(request.sessionUser.username, marketSlug, outcome));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update watch",
    });
  }
});

app.delete("/api/market-alerts/watch/:marketSlug", async (request, response) => {
  try {
    const marketSlug = String(request.params.marketSlug ?? "").trim();
    const outcome = String(request.query.outcome ?? "").trim();

    if (!request.sessionUser?.username) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (!marketSlug || !outcome) {
      response.status(400).json({ error: "Market slug and outcome are required" });
      return;
    }

    response.json(await service.unwatchMarket(request.sessionUser.username, marketSlug, outcome));
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update watch",
    });
  }
});

if (hasBuiltClient && clientDistDir && builtClientIndex) {
  app.use(express.static(clientDistDir));

  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api") || request.path === "/ws") {
      next();
      return;
    }

    response.sendFile(builtClientIndex);
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (socket) => {
  let unsubscribeSignal = () => {};

  void (async () => {
    socket.send(JSON.stringify({ type: "snapshot", payload: await service.getSnapshot() }));

    unsubscribeSignal = service.onSignal((signal) => {
      socket.send(JSON.stringify({ type: "signal", payload: signal }));
    });
  })();

  socket.on("close", () => {
    unsubscribeSignal();
  });
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  void (async () => {
    const sessionUser = await auth.getRequestUser(request);
    if (!sessionUser) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  })().catch(() => {
    socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    socket.destroy();
  });
});

void (async () => {
  await auth.connect();
  await service.start();
})();

server.listen(config.port, () => {
  console.log(`App execution listening on http://localhost:${config.port}`);
});
