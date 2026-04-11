import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { MoneyRadarService } from "../money-radar.js";

const app = express();
const moneyRadar = new MoneyRadarService();
const authCookieName = config.webSessionCookieName;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolvePublicDir = (currentDir: string): string => {
  const candidates = [
    path.resolve(currentDir, "../../../public"),
    path.resolve(currentDir, "../../../../public"),
    path.resolve(currentDir, "../../../../../public"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return candidates[0];
};

const publicDir = resolvePublicDir(__dirname);
const resolveClientDistDir = (currentDir: string): string | null => {
  const candidates = [
    path.resolve(currentDir, "../../../dist/client"),
    path.resolve(currentDir, "../../../../dist/client"),
    path.resolve(currentDir, "../../../../../dist/client"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
};

const clientDistDir = resolveClientDistDir(__dirname);
const clientIndexFile = clientDistDir ? path.join(clientDistDir, "index.html") : null;

const serveStaticPage = (page: string) => (_request: express.Request, response: express.Response) => {
  response.sendFile(path.join(publicDir, page));
};
const serveClientApp = (_request: express.Request, response: express.Response) => {
  if (clientIndexFile) {
    response.sendFile(clientIndexFile);
    return;
  }

  response.sendFile(path.join(publicDir, "index.html"));
};

const resolveCookieDomain = (request: express.Request): string | undefined => {
  const host = String(request.headers.host ?? "").split(":")[0].toLowerCase();
  const configured = config.webCookieDomain.trim().replace(/^\./, "").toLowerCase();
  if (!configured || !host) {
    return undefined;
  }

  return host === configured || host.endsWith(`.${configured}`) ? config.webCookieDomain : undefined;
};

const setAuthCookie = (request: express.Request, response: express.Response, session: unknown) => {
  response.cookie(authCookieName, typeof session === "string" ? session : JSON.stringify(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    ...(resolveCookieDomain(request) ? { domain: resolveCookieDomain(request) } : {}),
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
};

const clearAuthCookie = (request: express.Request, response: express.Response) => {
  response.clearCookie(authCookieName, {
    sameSite: "lax",
    secure: false,
    path: "/",
    ...(resolveCookieDomain(request) ? { domain: resolveCookieDomain(request) } : {}),
  });
};

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "app-execution" });
});

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "app-execution" });
});

app.get("/api/batch-signals", async (request, response) => {
  response.json(
    await moneyRadar.getBatchSignals({
      category: typeof request.query.category === "string" ? request.query.category : undefined,
      israelFilter: String(request.query.israelFilter ?? "").toLowerCase() === "true",
      limit: Number(request.query.limit ?? 25),
      sortBy: typeof request.query.sortBy === "string" ? request.query.sortBy : undefined,
    }),
  );
});

app.get("/api/smart-traders", async (request, response) => {
  response.json(await moneyRadar.getSmartTraders(Math.max(1, Number(request.query.limit ?? 20))));
});

app.post("/api/analyze", async (request, response) => {
  response.json(
    await moneyRadar.analyzeMarket({
      url: String(request.body.url ?? ""),
      context: String(request.body.context ?? ""),
      selectedMarketSlug: String(request.body.selectedMarketSlug ?? ""),
    }),
  );
});

app.get("/api/signal-detail", async (request, response) => {
  response.json(await moneyRadar.getSignalDetail(String(request.query.slug ?? "")));
});

app.get("/api/history-prices", async (request, response) => {
  response.json(await moneyRadar.getHistoryPrices(String(request.query.slug ?? "")));
});

app.get("/api/markets", async (request, response) => {
  response.json(
    await moneyRadar.getMarkets({
      offset: Number(request.query.offset ?? 0),
      limit: Number(request.query.limit ?? 1000),
      category: typeof request.query.category === "string" ? request.query.category : undefined,
    }),
  );
});

app.post("/api/markets", async (request, response) => {
  const slug = String(request.body.slug ?? "");
  response.json(await moneyRadar.getMarketDetail(slug));
});

app.post("/api/markets/prices", async (request, response) => {
  const slugs = Array.isArray(request.body.slugs)
    ? request.body.slugs.map((entry: unknown) => String(entry ?? "")).filter(Boolean)
    : [];
  response.json(await moneyRadar.getMarketPrices(slugs));
});

app.post("/api/markets/refresh", async (_request, response) => {
  response.json(await moneyRadar.refreshMarkets());
});

app.get("/api/me", async (request, response) => {
  response.json(await moneyRadar.getSession(request.headers.cookie ?? ""));
});

app.post("/api/login", async (request, response) => {
  const result = await moneyRadar.login({
    email: String(request.body.email ?? ""),
    password: String(request.body.password ?? ""),
  });

  if (!result.success) {
    response.status(401).json(result);
    return;
  }

  if ("session" in result && result.session && typeof result.session === "object" && "id" in result.session) {
    setAuthCookie(request, response, String((result.session as { id: unknown }).id ?? ""));
  }

  response.json(result);
});

app.post("/api/logout", (request, response) => {
  clearAuthCookie(request, response);
  response.json({ success: true });
});

app.post("/api/check-subscription", async (request, response) => {
  response.json(await moneyRadar.checkSubscription(request.headers.cookie ?? ""));
});

app.post("/api/signup", async (request, response) => {
  const result = await moneyRadar.signup({
    email: String(request.body.email ?? ""),
    password: String(request.body.password ?? ""),
  });

  if (!result.success) {
    response.status(400).json(result);
    return;
  }

  if ("session" in result && result.session && typeof result.session === "object" && "id" in result.session) {
    setAuthCookie(request, response, String((result.session as { id: unknown }).id ?? ""));
  }

  response.json(result);
});

app.post("/api/request-password-reset", async (request, response) => {
  const result = await moneyRadar.requestPasswordReset({
    email: String(request.body.email ?? ""),
  });

  response.status(result.success ? 200 : 400).json(result);
});

app.get("/api/reset-password/validate", async (request, response) => {
  const result = await moneyRadar.validatePasswordResetToken(String(request.query.token ?? ""));
  response.status(result.success ? 200 : 400).json(result);
});

app.post("/api/reset-password", async (request, response) => {
  const result = await moneyRadar.resetPassword({
    token: String(request.body.token ?? ""),
    password: String(request.body.password ?? ""),
  });

  if (!result.success) {
    response.status(400).json(result);
    return;
  }

  if ("session" in result && result.session && typeof result.session === "object" && "id" in result.session) {
    setAuthCookie(request, response, String((result.session as { id: unknown }).id ?? ""));
  }

  response.json(result);
});

app.post("/api/credit-request", async (_request, response) => {
  response.json(await moneyRadar.requestCredits());
});

app.post("/api/accept-terms", async (request, response) => {
  const result = await moneyRadar.acceptTerms(request.headers.cookie ?? "");
  response.status(result.success ? 200 : 401).json(result);
});

app.get("/api/broadcast", async (_request, response) => {
  response.json(await moneyRadar.broadcast());
});

app.post("/api/broadcast", async (request, response) => {
  const result = await moneyRadar.postBroadcast(request.headers.cookie ?? "", {
    message: String(request.body.message ?? ""),
  });

  response.status(result.success ? 200 : 400).json(result);
});

app.get("/api/favorites/markets", async (request, response) => {
  response.json(await moneyRadar.getFavoriteMarkets(request.headers.cookie ?? ""));
});

app.post("/api/favorites/markets", async (request, response) => {
  const result = await moneyRadar.saveFavoriteMarket(request.headers.cookie ?? "", {
    market_id: String(request.body.market_id ?? ""),
    slug: String(request.body.slug ?? ""),
    question: String(request.body.question ?? ""),
    category: String(request.body.category ?? ""),
    url: String(request.body.url ?? ""),
    saved_price: Number(request.body.saved_price ?? Number.NaN),
  });

  if ("error" in result) {
    response.status(401).json(result);
    return;
  }

  response.json(result);
});

app.delete("/api/favorites/markets", async (request, response) => {
  response.json(
    await moneyRadar.deleteFavoriteMarket(request.headers.cookie ?? "", String(request.query.market_id ?? "")),
  );
});

app.get("/api/favorites/trades", async (request, response) => {
  response.json(await moneyRadar.getFavoriteTrades(request.headers.cookie ?? ""));
});

app.post("/api/favorites/trades", async (request, response) => {
  const result = await moneyRadar.saveFavoriteTrade(request.headers.cookie ?? "", {
    ...(request.body as Record<string, unknown>),
    trade_id: String(request.body.trade_id ?? ""),
  });

  if ("error" in result) {
    response.status(401).json(result);
    return;
  }

  response.json(result);
});

app.delete("/api/favorites/trades", async (request, response) => {
  response.json(
    await moneyRadar.deleteFavoriteTrade(request.headers.cookie ?? "", String(request.query.trade_id ?? "")),
  );
});

app.get("/legacy", serveStaticPage("index.html"));
app.get("/legacy/", serveStaticPage("index.html"));
app.get("/legacy/login", serveStaticPage("login.html"));
app.get("/legacy/about", serveStaticPage("about.html"));
app.get("/legacy/faq", serveStaticPage("faq.html"));
app.get("/legacy/privacy", serveStaticPage("privacy.html"));
app.get("/legacy/terms", serveStaticPage("terms.html"));
app.get("/legacy/signals", serveStaticPage("loginc1b0.html"));
app.get("/legacy/markets", serveStaticPage("logind029.html"));
app.get("/legacy/smart-traders", serveStaticPage("loginfb40.html"));
app.get("/legacy/chat", serveStaticPage("login8fb7.html"));
app.get("/legacy/history", serveStaticPage("login3a6b.html"));
app.get("/legacy/auth/callback", serveStaticPage("login.html"));
app.get("/legacy/auth/confirm", serveStaticPage("login.html"));
app.get("/legacy/reset-password", serveStaticPage("login.html"));

app.get("/", serveClientApp);
app.get("/login", serveClientApp);
app.get("/about", serveClientApp);
app.get("/faq", serveClientApp);
app.get("/privacy", serveClientApp);
app.get("/terms", serveClientApp);
app.get("/signals", serveClientApp);
app.get("/markets", serveClientApp);
app.get("/smart-traders", serveClientApp);
app.get("/chat", serveClientApp);
app.get("/history", serveClientApp);
app.get("/auth/callback", serveClientApp);
app.get("/auth/confirm", serveClientApp);
app.get("/reset-password", serveClientApp);

app.use("/static", express.static(path.join(publicDir, "static")));
app.use(express.static(publicDir, { extensions: ["html"] }));
if (clientDistDir) {
  app.use(express.static(clientDistDir));
}

app.get("*", (_request, response) => {
  if (clientIndexFile) {
    response.sendFile(clientIndexFile);
    return;
  }

  response.sendFile(path.join(publicDir, "index.html"));
});

const server = createServer(app);

void moneyRadar.start();

server.listen(config.port, () => {
  console.log(`Money Radar clone listening on http://localhost:${config.port}`);
});
