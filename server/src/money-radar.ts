import { ClobClient } from "@polymarket/clob-client";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { SignalStorage } from "./storage.js";
import type { MarketAggregate, MarketRecord } from "./types.js";

const SUPABASE_URL = "https://hmazuplprcfzxuuifysj.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhtYXp1cGxwcmNmenh1dWlmeXNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1MDQ4MTgsImV4cCI6MjA4NDA4MDgxOH0.bJtR9qTCnBwnqspUcpZDkYh3xhvTCDlh4MYifma2-Yw";
const SUPABASE_COOKIE_NAME = "sb-hmazuplprcfzxuuifysj-auth-token";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;
const ISRAEL_KEYWORDS = [
  "israel",
  "gaza",
  "hamas",
  "idf",
  "netanyahu",
  "jerusalem",
  "tel aviv",
  "hezbollah",
  "iran",
];

type RawGammaMarket = {
  id: string;
  slug: string;
  question: string;
  description?: string;
  endDate?: string;
  image?: string;
  icon?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  liquidityNum?: number | string;
  volume24hr?: number | string;
  oneDayPriceChange?: number | string;
  oneWeekPriceChange?: number | string;
  clobTokenIds?: string;
  outcomes?: string;
  outcomePrices?: string;
  groupItemTitle?: string;
  events?: Array<{
    slug?: string;
    title?: string;
  }>;
};

type FavoriteMarket = {
  user_id: string;
  market_id: string;
  slug?: string;
  question?: string;
  category?: string;
  url?: string;
  saved_price?: number;
  saved_at: number;
};

type FavoriteTrade = {
  user_id: string;
  trade_id: string;
  saved_at: number;
  [key: string]: unknown;
};

type BroadcastMessage = {
  id: string;
  user_id: string | null;
  username: string;
  full_name?: string | null;
  body: string;
  created_at: string;
};

type AuthUser = {
  id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  password_salt: string;
  full_name: string | null;
  subscription_tier: string;
  pro_expires_at: string | null;
  terms_accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

type AuthSession = {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
};

type AuthToken = {
  id: string;
  user_id: string;
  type: "password_reset";
  token: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

type SessionPayload = {
  id: string;
  user_id: string;
  expires_at: string;
  user: {
    id: string;
    email: string;
  };
};

type MoneyRadarSignal = Record<string, unknown>;

const toNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseJsonArray = <T,>(value: string | undefined, fallback: T[]): T[] => {
  if (!value) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
};

const parseCookies = (cookieHeader = ""): Record<string, string> => {
  const cookies: Record<string, string> = {};
  for (const chunk of cookieHeader.split(";")) {
    const [key, ...rest] = chunk.trim().split("=");
    if (!key) {
      continue;
    }
    cookies[key] = decodeURIComponent(rest.join("="));
  }
  return cookies;
};

const decodeJwtPayload = (token: string): Record<string, unknown> | null => {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const extractSupabaseUserId = (cookieHeader = ""): string | null => {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[SUPABASE_COOKIE_NAME];
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      const payload = decodeJwtPayload(parsed[0]);
      return typeof payload?.sub === "string" ? payload.sub : null;
    }

    if (parsed && typeof parsed === "object") {
      const accessToken = (parsed as { access_token?: unknown }).access_token;
      if (typeof accessToken === "string") {
        const payload = decodeJwtPayload(accessToken);
        return typeof payload?.sub === "string" ? payload.sub : null;
      }
    }
  } catch {
    return null;
  }

  return null;
};

const extractSupabaseAccessToken = (cookieHeader = ""): string | null => {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[SUPABASE_COOKIE_NAME];
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return parsed[0];
    }

    if (parsed && typeof parsed === "object") {
      const accessToken = (parsed as { access_token?: unknown }).access_token;
      return typeof accessToken === "string" ? accessToken : null;
    }
  } catch {
    return null;
  }

  return null;
};

const hashPassword = (password: string, salt: string): string =>
  scryptSync(password, salt, 64).toString("hex");

const verifyPassword = (password: string, salt: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const resolveAuthDbName = (): string => {
  try {
    const url = new URL(config.authMongoUri);
    return url.pathname.replace(/^\//, "") || "authentication";
  } catch {
    return "authentication";
  }
};

const extractWebSessionId = (cookieHeader = ""): string | null => {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[config.webSessionCookieName];
  return raw ? raw.trim() : null;
};

const normalizeOutcomeName = (value: string): string => value.trim().toLowerCase();

const inferCategory = (text: string): string => {
  const normalized = text.toLowerCase();
  if (normalized.includes("bitcoin") || normalized.includes("ethereum") || normalized.includes("crypto")) {
    return "Crypto";
  }
  if (normalized.includes("president") || normalized.includes("election") || normalized.includes("senate")) {
    return "Politics";
  }
  if (normalized.includes("game") || normalized.includes("match") || normalized.includes(" vs ")) {
    return "Sports";
  }
  if (normalized.includes("science") || normalized.includes("nasa")) {
    return "Science";
  }
  if (normalized.includes("stock") || normalized.includes("fed") || normalized.includes("company")) {
    return "Business";
  }
  return "News";
};

const computeDaysLeft = (endDate?: string): number => {
  if (!endDate) {
    return 0;
  }

  const end = Date.parse(endDate);
  if (!Number.isFinite(end)) {
    return 0;
  }

  return Math.max(0, (end - Date.now()) / 86_400_000);
};

const isIsraelRelated = (market: Pick<RawGammaMarket, "question" | "description" | "events">): boolean => {
  const searchable = [
    market.question,
    market.description ?? "",
    ...(market.events ?? []).flatMap((entry) => [entry.slug ?? "", entry.title ?? ""]),
  ]
    .join(" ")
    .toLowerCase();
  return ISRAEL_KEYWORDS.some((keyword) => searchable.includes(keyword));
};

export class MoneyRadarService {
  private readonly storage = new SignalStorage();
  private readonly mongoClient = new MongoClient(config.mongoUri);
  private readonly authMongoClient = new MongoClient(config.authMongoUri);
  private readonly clobClient = new ClobClient(CLOB_API_URL, POLYGON_CHAIN_ID);
  private readonly memoryBroadcastMessages: BroadcastMessage[] = [];
  private readonly authDbName = resolveAuthDbName();
  private storageReady = false;
  private mongoReady = false;
  private authReady = false;

  async start(): Promise<void> {
    await Promise.allSettled([
      (async () => {
        await this.storage.connect();
        this.storageReady = true;
      })(),
      (async () => {
        await this.mongoClient.connect();
        this.mongoReady = true;
        await Promise.all([
          this.favoriteMarketsCollection().createIndex({ user_id: 1, market_id: 1 }, { unique: true }),
          this.favoriteTradesCollection().createIndex({ user_id: 1, trade_id: 1 }, { unique: true }),
          this.broadcastCollection().createIndex({ created_at: -1 }),
        ]);
      })(),
      (async () => {
        await this.authMongoClient.connect();
        this.authReady = true;
        await Promise.all([
          this.usersCollection().createIndex({ email_normalized: 1 }, { unique: true }),
          this.sessionsCollection().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
          this.sessionsCollection().createIndex({ user_id: 1 }),
          this.authTokensCollection().createIndex({ token: 1 }, { unique: true }),
          this.authTokensCollection().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
          this.authTokensCollection().createIndex({ user_id: 1, type: 1 }),
        ]);
      })(),
    ]);
  }

  async getBatchSignals(params: {
    category?: string;
    israelFilter?: boolean;
    limit?: number;
    sortBy?: string;
  }): Promise<{ success: true; signals: MoneyRadarSignal[] }> {
    const limit = Math.max(1, Math.min(params.limit ?? 25, 50));
    const [aggregates, catalog] = this.storageReady
      ? await Promise.all([
          this.storage.loadAllMarketAggregates(1_500),
          this.storage.loadMarketCatalog(),
        ])
      : [[], [] as MarketRecord[]];

    if (aggregates.length === 0) {
      const fallback = await this.fetchLiveGammaMarkets({
        limit,
        category: params.category,
        israelFilter: params.israelFilter,
      });
      return { success: true, signals: fallback.map((market) => this.buildFallbackSignalFromGamma(market)) };
    }

    const catalogBySlug = new Map(catalog.map((entry) => [entry.slug, entry] as const));
    let filtered = aggregates.filter((aggregate) => {
      const market = catalogBySlug.get(aggregate.marketSlug);
      if (params.category && (market?.category ?? inferCategory(aggregate.marketQuestion)) !== params.category) {
        return false;
      }

      if (
        params.israelFilter &&
        !isIsraelRelated({
          question: aggregate.marketQuestion,
          description: "",
          events:
            market?.eventSlug || market?.eventTitle
              ? [{ slug: market?.eventSlug, title: market?.eventTitle }]
              : [],
        })
      ) {
        return false;
      }

      return true;
    });

    if (params.sortBy === "volume24h") {
      filtered = filtered.sort((left, right) => {
        const leftVolume = toNumber(catalogBySlug.get(left.marketSlug)?.volume24hr, left.totalUsd);
        const rightVolume = toNumber(catalogBySlug.get(right.marketSlug)?.volume24hr, right.totalUsd);
        return rightVolume - leftVolume;
      });
    } else {
      filtered = filtered.sort(
        (left, right) => right.weightedScore - left.weightedScore || right.latestTimestamp - left.latestTimestamp,
      );
    }

    return {
      success: true,
      signals: filtered
        .slice(0, limit)
        .map((aggregate) =>
          this.buildMirrorSignalFromAggregate(aggregate, catalogBySlug.get(aggregate.marketSlug)),
        ),
    };
  }

  async getSmartTraders(limit: number): Promise<{ success: true; signals: Array<Record<string, unknown>> }> {
    if (!this.storageReady) {
      return { success: true, signals: [] };
    }

    const recentSignals = await this.storage.loadRecentSignals(Math.max(limit * 3, 30));
    return {
      success: true,
      signals: recentSignals.slice(0, limit).map((signal) => ({
        id: signal.id,
        whale_group:
          signal.trader.tier === "whale"
            ? "Winning Whale"
            : signal.trader.tier === "shark"
              ? "Market Mover Whale"
              : signal.trader.tier === "pro"
                ? "New Whale"
                : undefined,
        trader_category: signal.trader.tier,
        side: signal.side,
        notional_usd: signal.totalUsd,
        outcome: signal.outcome,
        market_name: signal.marketQuestion,
      })),
    };
  }

  async getMarkets(params: {
    offset: number;
    limit: number;
    category?: string;
  }): Promise<Record<string, unknown>> {
    const [catalog, aggregates] = this.storageReady
      ? await Promise.all([
          this.storage.loadMarketCatalog(),
          this.storage.loadAllMarketAggregates(2_000),
        ])
      : [[], [] as MarketAggregate[]];
    const aggregateBySlug = new Map(aggregates.map((entry) => [entry.marketSlug, entry] as const));

    let markets = catalog;
    if (params.category) {
      markets = markets.filter((entry) => entry.category === params.category);
    }

    const offset = Math.max(0, params.offset);
    const limit = Math.max(1, Math.min(params.limit, 1000));

    if (markets.length === 0) {
      const liveMarkets = await this.fetchLiveGammaMarketPage({
        offset,
        limit,
        category: params.category,
      });

      return {
        success: true,
        markets: liveMarkets
          .map((market) => this.mapRawMarketToCatalogMarket(market))
          .map((market) => this.buildMarketListItem(market)),
        totalMarkets: offset + liveMarkets.length,
        hasMore: liveMarkets.length === limit,
        lastUpdated: new Date().toISOString(),
      };
    }

    markets = markets.sort((left, right) => toNumber(right.volume24hr, 0) - toNumber(left.volume24hr, 0));

    return {
      success: true,
      markets: markets
        .slice(offset, offset + limit)
        .map((market) => this.buildMarketListItem(market, aggregateBySlug.get(market.slug))),
      totalMarkets: markets.length,
      hasMore: offset + limit < markets.length,
      lastUpdated: Date.now(),
    };
  }

  async refreshMarkets(): Promise<Record<string, unknown>> {
    const liveMarkets = await this.fetchLiveGammaMarkets({ limit: 250 });
    return {
      success: true,
      stats: {
        binaryMarkets: liveMarkets.length,
      },
    };
  }

  async analyzeMarket(input: {
    url: string;
    context?: string;
    selectedMarketSlug?: string;
  }): Promise<Record<string, unknown>> {
    const parsedUrl = new URL(input.url);
    const slug = input.selectedMarketSlug || parsedUrl.pathname.split("/").filter(Boolean).pop();
    if (!slug) {
      return { success: false, error: "Could not determine market slug from URL." };
    }

    const directMarket = await this.fetchGammaMarketBySlug(slug).catch(() => null);
    const eventMarkets = directMarket ? [directMarket] : await this.fetchGammaMarketsByEventSlug(slug).catch(() => []);

    if (!directMarket && eventMarkets.length === 0) {
      return { success: false, error: "No Polymarket market was found for that URL." };
    }

    if (!input.selectedMarketSlug && eventMarkets.length > 1) {
      const event = await this.fetchGammaEventBySlug(slug).catch(() => null);
      return {
        success: true,
        type: "multi",
        event: {
          title: event?.title ?? eventMarkets[0]?.events?.[0]?.title ?? slug,
          description: event?.description ?? "",
          slug,
        },
        subMarkets: eventMarkets.map((market) => ({
          id: market.id,
          slug: market.slug,
          question: market.question,
          groupItemTitle: market.groupItemTitle ?? market.question,
          outcomePrices: market.outcomePrices,
          active: market.active ?? true,
          closed: market.closed ?? false,
        })),
      };
    }

    const chosen = input.selectedMarketSlug
      ? await this.fetchGammaMarketBySlug(input.selectedMarketSlug)
      : directMarket ?? eventMarkets[0];
    const detail = await this.buildSignalDetail(chosen.slug, input.context);

    return {
      success: true,
      type: "single",
      signal: detail.signal,
      usageCount: 0,
      totalCredits: 10,
    };
  }

  async getSignalDetail(
    slug: string,
    context?: string,
  ): Promise<{ success: true; reasoning: string; data_points: string[] }> {
    const detail = await this.buildSignalDetail(slug, context);
    return {
      success: true,
      reasoning: detail.reasoning,
      data_points: detail.dataPoints,
    };
  }

  async getHistoryPrices(slug: string): Promise<{ success: true; history: Array<{ t: number; p: number }> }> {
    const market = await this.fetchGammaMarketBySlug(slug);
    const tokenIds = parseJsonArray<string>(market.clobTokenIds, []);
    const outcomes = parseJsonArray<string>(market.outcomes, []);
    const yesTokenId = tokenIds.find((_tokenId, index) => normalizeOutcomeName(outcomes[index] ?? "") === "yes");
    const tokenId = yesTokenId ?? tokenIds[0];

    if (!tokenId) {
      return { success: true, history: [] };
    }

    const response = (await this.clobClient.getPricesHistory({
      market: tokenId,
      interval: "1d",
      fidelity: 60,
    } as never)) as { history?: Array<{ t: number; p: number }> };

    return {
      success: true,
      history: Array.isArray(response?.history) ? response.history : [],
    };
  }

  async getMarketDetail(slug: string): Promise<Record<string, unknown>> {
    const market = await this.fetchGammaMarketBySlug(slug);
    const prices = this.extractBinaryPrices(market);

    return {
      success: true,
      data: {
        bestBid: prices.yesPrice,
        bestAsk: prices.noPrice,
        yesPrice: prices.yesPrice,
        noPrice: prices.noPrice,
        oiYes: null,
        oiNo: null,
        volume24h: toNumber(market.volume24hr, 0),
        priceChange1h: null,
        priceChange24h: toNumber(market.oneDayPriceChange, 0),
        priceChange1w: toNumber(market.oneWeekPriceChange, 0),
        priceChange1mo: null,
      },
    };
  }

  async getMarketPrices(slugs: string[]): Promise<Record<string, unknown>> {
    const prices = Object.fromEntries(
      await Promise.all(
        slugs.map(async (slug) => {
          const market = await this.fetchGammaMarketBySlug(slug).catch(() => null);
          return [slug, market ? this.extractBinaryPrices(market) : { yesPrice: null, noPrice: null }];
        }),
      ),
    );

    return { success: true, prices };
  }

  async requestCredits(): Promise<Record<string, unknown>> {
    return { success: true };
  }

  async getSession(cookieHeader = ""): Promise<Record<string, unknown>> {
    const auth = await this.getAuthenticatedUser(cookieHeader);
    if (!auth) {
      return { success: true, authenticated: false, session: null, profile: null };
    }

    return {
      success: true,
      authenticated: true,
      session: auth.session,
      profile: this.toProfile(auth.user),
    };
  }

  async login(body: { email: string; password: string }): Promise<Record<string, unknown>> {
    if (!this.authAvailable()) {
      return { success: false, error: "Auth storage unavailable." };
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");
    if (!email || !password) {
      return { success: false, error: "Email and password are required." };
    }

    const user = await this.usersCollection().findOne({ email_normalized: email });
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      return { success: false, error: "Invalid email or password." };
    }

    const session = await this.createSession(user);

    return {
      success: true,
      session,
      profile: this.toProfile(user),
    };
  }

  async checkSubscription(cookieHeader = ""): Promise<Record<string, unknown>> {
    const auth = await this.getAuthenticatedUser(cookieHeader);
    if (!auth) {
      return {
        success: true,
        isAuthenticated: false,
        subscription: "free",
      };
    }

    return {
      success: true,
      isAuthenticated: true,
      subscription: auth.user.subscription_tier ?? "free",
      profile: this.toProfile(auth.user),
    };
  }

  async broadcast(): Promise<Record<string, unknown>> {
    if (!this.mongoReady) {
      return { success: true, messages: this.memoryBroadcastMessages.slice(-50) };
    }

    const messages = await this.broadcastCollection()
      .find({}, { projection: { _id: 0 } })
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    return { success: true, messages: messages.reverse() };
  }

  async postBroadcast(cookieHeader: string, body: { message?: string }): Promise<Record<string, unknown>> {
    if (!this.mongoReady) {
      const guestMessage = this.buildBroadcastMessage(cookieHeader, String(body.message ?? "").trim(), null);
      if (!guestMessage) {
        return { success: false, error: "Message is required." };
      }

      this.memoryBroadcastMessages.push(guestMessage);
      if (this.memoryBroadcastMessages.length > 100) {
        this.memoryBroadcastMessages.splice(0, this.memoryBroadcastMessages.length - 100);
      }

      return { success: true, message: guestMessage };
    }

    const trimmed = String(body.message ?? "").trim();
    const auth = await this.getAuthenticatedUser(cookieHeader);
    const profile = auth ? this.toProfile(auth.user) : null;
    const message = this.buildBroadcastMessage(cookieHeader, trimmed, profile);
    if (!message) {
      return { success: false, error: "Message is required." };
    }

    await this.broadcastCollection().insertOne(message);

    return { success: true, message };
  }

  async acceptTerms(cookieHeader: string): Promise<Record<string, unknown>> {
    const auth = await this.getAuthenticatedUser(cookieHeader);
    if (!auth || !this.authAvailable()) {
      return { success: false, error: "Unauthorized" };
    }

    const timestamp = new Date().toISOString();
    await this.usersCollection().updateOne(
      { id: auth.user.id },
      {
        $set: {
        terms_accepted_at: timestamp,
        updated_at: timestamp,
        },
      },
    );

    return { success: true, termsAcceptedAt: timestamp };
  }

  async signup(body: { email: string; password: string }): Promise<Record<string, unknown>> {
    if (!this.authAvailable()) {
      return { success: false, error: "Auth storage unavailable." };
    }

    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");
    if (!email || !password) {
      return { success: false, error: "Email and password are required." };
    }

    const existing = await this.usersCollection().findOne({ email_normalized: email });
    if (existing) {
      return { success: false, error: "Email already registered." };
    }

    const now = new Date().toISOString();
    const salt = randomUUID();
    const user: AuthUser = {
      id: randomUUID(),
      email,
      email_normalized: email,
      password_hash: hashPassword(password, salt),
      password_salt: salt,
      full_name: email.split("@")[0] || null,
      subscription_tier: "free",
      pro_expires_at: null,
      terms_accepted_at: null,
      created_at: now,
      updated_at: now,
    };

    await this.usersCollection().insertOne(user);
    const session = await this.createSession(user);

    return {
      success: true,
      requiresConfirmation: false,
      session,
      profile: this.toProfile(user),
      message: "החשבון נוצר והחיבור הופעל.",
    };
  }

  async requestPasswordReset(body: { email: string }): Promise<Record<string, unknown>> {
    if (!this.authAvailable()) {
      return { success: false, error: "Auth storage unavailable." };
    }

    const email = normalizeEmail(body.email);
    if (!email) {
      return { success: false, error: "Email is required." };
    }

    const user = await this.usersCollection().findOne({ email_normalized: email });
    if (!user) {
      return {
        success: true,
        message: "If the account exists, a recovery link is ready.",
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 30).toISOString();
    const token = randomBytes(24).toString("hex");

    await this.authTokensCollection().deleteMany({ user_id: user.id, type: "password_reset" });
    await this.authTokensCollection().insertOne({
      id: randomUUID(),
      user_id: user.id,
      type: "password_reset",
      token,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      used_at: null,
    });

    return {
      success: true,
      message: "Password reset link created.",
      resetUrl: `/reset-password?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  async validatePasswordResetToken(token: string): Promise<Record<string, unknown>> {
    const authToken = await this.getValidAuthToken(token, "password_reset");
    if (!authToken) {
      return { success: false, valid: false, error: "Reset link is invalid or expired." };
    }

    return {
      success: true,
      valid: true,
      email: authToken.user.email,
      expiresAt: authToken.token.expires_at,
    };
  }

  async resetPassword(body: { token: string; password: string }): Promise<Record<string, unknown>> {
    if (!this.authAvailable()) {
      return { success: false, error: "Auth storage unavailable." };
    }

    const password = String(body.password ?? "");
    if (password.length < 8) {
      return { success: false, error: "Password must be at least 8 characters." };
    }

    const authToken = await this.getValidAuthToken(body.token, "password_reset");
    if (!authToken) {
      return { success: false, error: "Reset link is invalid or expired." };
    }

    const now = new Date().toISOString();
    const salt = randomUUID();
    await this.usersCollection().updateOne(
      { id: authToken.user.id },
      {
        $set: {
          password_hash: hashPassword(password, salt),
          password_salt: salt,
          updated_at: now,
        },
      },
    );
    await this.authTokensCollection().updateOne({ id: authToken.token.id }, { $set: { used_at: now } });
    await this.sessionsCollection().deleteMany({ user_id: authToken.user.id });

    const refreshedUser = await this.usersCollection().findOne({ id: authToken.user.id });
    if (!refreshedUser) {
      return { success: false, error: "Account unavailable after reset." };
    }

    const session = await this.createSession(refreshedUser);
    return {
      success: true,
      message: "Password updated successfully.",
      session,
      profile: this.toProfile(refreshedUser),
    };
  }

  async getFavoriteMarkets(cookieHeader = ""): Promise<{ markets: FavoriteMarket[] }> {
    if (!this.mongoReady) {
      return { markets: [] };
    }

    const userId = await this.getAuthenticatedUserId(cookieHeader);
    if (!userId) {
      return { markets: [] };
    }

    const rows = await this.favoriteMarketsCollection()
      .find({ user_id: userId }, { projection: { _id: 0 } })
      .sort({ saved_at: -1 })
      .toArray();

    return { markets: rows as FavoriteMarket[] };
  }

  async saveFavoriteMarket(
    cookieHeader: string,
    market: Omit<FavoriteMarket, "user_id" | "saved_at">,
  ): Promise<Record<string, unknown>> {
    if (!this.mongoReady) {
      return { error: "Favorites storage unavailable" };
    }

    const userId = await this.getAuthenticatedUserId(cookieHeader);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    const payload: FavoriteMarket = {
      user_id: userId,
      saved_at: Date.now(),
      ...market,
    };

    await this.favoriteMarketsCollection().updateOne(
      { user_id: userId, market_id: payload.market_id },
      { $set: payload },
      { upsert: true },
    );

    return { market: payload };
  }

  async deleteFavoriteMarket(cookieHeader: string, marketId: string): Promise<{ success: boolean }> {
    if (!this.mongoReady) {
      return { success: false };
    }

    const userId = await this.getAuthenticatedUserId(cookieHeader);
    if (!userId) {
      return { success: false };
    }

    await this.favoriteMarketsCollection().deleteOne({ user_id: userId, market_id: marketId });
    return { success: true };
  }

  async getFavoriteTrades(cookieHeader = ""): Promise<{ trades: FavoriteTrade[] }> {
    if (!this.mongoReady) {
      return { trades: [] };
    }

    const userId = await this.getAuthenticatedUserId(cookieHeader);
    if (!userId) {
      return { trades: [] };
    }

    const rows = await this.favoriteTradesCollection()
      .find({ user_id: userId }, { projection: { _id: 0 } })
      .sort({ saved_at: -1 })
      .toArray();

    return { trades: rows as FavoriteTrade[] };
  }

  async saveFavoriteTrade(
    cookieHeader: string,
    trade: Omit<FavoriteTrade, "user_id" | "saved_at">,
  ): Promise<Record<string, unknown>> {
    if (!this.mongoReady) {
      return { error: "Favorites storage unavailable" };
    }

    const userId = await this.getAuthenticatedUserId(cookieHeader);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    const payload: FavoriteTrade = {
      user_id: userId,
      trade_id: String(trade.trade_id ?? ""),
      saved_at: Date.now(),
      ...trade,
    };

    await this.favoriteTradesCollection().updateOne(
      { user_id: userId, trade_id: payload.trade_id },
      { $set: payload },
      { upsert: true },
    );

    return { trade: payload };
  }

  async deleteFavoriteTrade(cookieHeader: string, tradeId: string): Promise<{ success: boolean }> {
    if (!this.mongoReady) {
      return { success: false };
    }

    const userId = await this.getAuthenticatedUserId(cookieHeader);
    if (!userId) {
      return { success: false };
    }

    await this.favoriteTradesCollection().deleteOne({ user_id: userId, trade_id: tradeId });
    return { success: true };
  }

  private async buildSignalDetail(slug: string, context?: string): Promise<{
    signal: MoneyRadarSignal;
    reasoning: string;
    dataPoints: string[];
  }> {
    const [market, aggregates, historyResponse] = await Promise.all([
      this.fetchGammaMarketBySlug(slug),
      this.storageReady ? this.storage.loadAllMarketAggregates(1_500) : Promise.resolve([] as MarketAggregate[]),
      this.getHistoryPrices(slug).catch(() => ({ success: true, history: [] as Array<{ t: number; p: number }> })),
    ]);
    const aggregate = aggregates.find((entry) => entry.marketSlug === slug);
    const prices = this.extractBinaryPrices(market);
    const currentPercent = `${Math.round(((prices.yesPrice ?? 0.5) as number) * 100)}¢`;
    const historySummary = this.summarizePriceMove(historyResponse.history);
    const dataPoints = [
      `מחיר כן נוכחי: ${currentPercent}`,
      `נזילות מוצהרת: $${Math.round(toNumber(market.liquidityNum, 0)).toLocaleString()}`,
      `נפח 24 שעות: $${Math.round(toNumber(market.volume24hr, 0)).toLocaleString()}`,
      historySummary,
    ];

    if (context?.trim()) {
      dataPoints.push(`הקשר נוסף מהמשתמש: ${context.trim()}`);
    }

    const reasoning = [
      market.question,
      "",
      "הערכת הבסיס נשענת על מחיר השוק, נזילות, נפח מסחר ומגמת המחיר האחרונה.",
      historySummary,
      context?.trim() ? `הבאתי בחשבון גם את ההקשר שסיפקת: ${context.trim()}` : "",
      "זו קריאת מצב מהירה של השוק, לא ייעוץ פיננסי.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      signal: aggregate
        ? this.buildMirrorSignalFromAggregate(aggregate, this.mapRawMarketToCatalogMarket(market), {
            reasoning,
            dataPoints,
            description: market.description,
          })
        : this.buildFallbackSignalFromGamma(market, {
            reasoning,
            dataPoints,
            description: market.description,
          }),
      reasoning,
      dataPoints,
    };
  }

  private summarizePriceMove(history: Array<{ t: number; p: number }>): string {
    if (history.length < 2) {
      return "אין מספיק היסטוריית מחירים כדי לזהות מגמה ברורה.";
    }

    const delta = history[history.length - 1].p - history[0].p;
    if (Math.abs(delta) < 0.02) {
      return "המחיר היה יציב יחסית בתקופה האחרונה.";
    }

    return delta > 0
      ? `המחיר עלה בכ-${Math.round(delta * 100)} נקודות במהלך חלון המדידה.`
      : `המחיר ירד בכ-${Math.round(Math.abs(delta) * 100)} נקודות במהלך חלון המדידה.`;
  }

  private determineSignalSide(
    aggregate: MarketAggregate,
    market?: MarketRecord,
  ): { smartSide: "YES" | "NO"; trackedOutcome: string; trackedPrice: number } {
    const sortedWeights = [...aggregate.outcomeWeights].sort((left, right) => right.weight - left.weight);
    const trackedOutcome = sortedWeights[0]?.outcome ?? aggregate.latestSignal.outcome;
    const trackedOutcomeNormalized = normalizeOutcomeName(trackedOutcome);
    const outcomePrices =
      market?.outcomePriceByAssetId
        ? Object.entries(market.outcomeByAssetId).map(([assetId, outcome]) => ({
            outcome,
            price: toNumber(market.outcomePriceByAssetId?.[assetId], Number.NaN),
          }))
        : aggregate.outcomeLatestPrices?.map((entry) => ({ outcome: entry.outcome, price: entry.price })) ?? [];

    const trackedPrice =
      outcomePrices.find((entry) => normalizeOutcomeName(entry.outcome) === trackedOutcomeNormalized)?.price
        ?? aggregate.observedAvgEntry
        ?? aggregate.latestSignal.averagePrice;

    if (trackedOutcomeNormalized === "yes") {
      return { smartSide: "YES", trackedOutcome, trackedPrice };
    }
    if (trackedOutcomeNormalized === "no") {
      return { smartSide: "NO", trackedOutcome, trackedPrice };
    }

    return {
      smartSide: trackedPrice >= 0.5 ? "YES" : "NO",
      trackedOutcome,
      trackedPrice,
    };
  }

  private buildMirrorSignalFromAggregate(
    aggregate: MarketAggregate,
    market?: MarketRecord,
    detail?: {
      reasoning?: string;
      dataPoints?: string[];
      description?: string;
    },
  ): MoneyRadarSignal {
    const { smartSide, trackedOutcome, trackedPrice } = this.determineSignalSide(aggregate, market);
    const totalWeight = aggregate.outcomeWeights.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0) || 1;
    const binaryYesWeight = aggregate.outcomeWeights
      .filter((entry) => normalizeOutcomeName(entry.outcome) === "yes")
      .reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
    const binaryNoWeight = aggregate.outcomeWeights
      .filter((entry) => normalizeOutcomeName(entry.outcome) === "no")
      .reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
    const leadRatio = Math.round((Math.max(...aggregate.outcomeWeights.map((entry) => entry.weight), 0) / totalWeight) * 100);
    const yesSmartRatio =
      binaryYesWeight > 0 || binaryNoWeight > 0
        ? Math.round((binaryYesWeight / Math.max(1, binaryYesWeight + binaryNoWeight)) * 100)
        : leadRatio;
    const noSmartRatio =
      binaryYesWeight > 0 || binaryNoWeight > 0 ? 100 - yesSmartRatio : Math.max(0, 100 - leadRatio);

    return {
      id: aggregate.latestSignal.id,
      market_id: aggregate.marketSlug,
      slug: aggregate.marketSlug,
      question: aggregate.marketQuestion,
      url: aggregate.marketUrl,
      image: aggregate.marketImage,
      category: market?.category ?? inferCategory(aggregate.marketQuestion),
      end_date: aggregate.marketEndDate,
      days_left: computeDaysLeft(aggregate.marketEndDate),
      last_price: Math.min(0.99, Math.max(0.01, trackedPrice)),
      smart_money_side: smartSide,
      trader_category: aggregate.latestSignal.trader.tier,
      yes_smart_ratio: yesSmartRatio,
      no_smart_ratio: noSmartRatio,
      wa_smart_yes: yesSmartRatio,
      wa_smart_no: noSmartRatio,
      context_response: detail?.reasoning ?? null,
      estimable_method: "market_structure",
      fair_value_calculation: detail
        ? {
            reasoning: detail.reasoning ?? "",
            data_points: detail.dataPoints ?? [],
          }
        : undefined,
      data_sources: ["Polymarket Gamma", "Polymarket CLOB", "Local signal archive"],
      description: detail?.description,
      groupItemTitle: trackedOutcome,
      active: true,
      closed: false,
    };
  }

  private extractBinaryPrices(market: RawGammaMarket): { yesPrice: number | null; noPrice: number | null } {
    const outcomes = parseJsonArray<string>(market.outcomes, []);
    const prices = parseJsonArray<string | number>(market.outcomePrices, []);
    const pairs = outcomes.map((outcome, index) => ({ outcome, price: toNumber(prices[index], Number.NaN) }));
    const yesPrice = pairs.find((entry) => normalizeOutcomeName(entry.outcome) === "yes")?.price ?? pairs[0]?.price;
    if (!Number.isFinite(yesPrice)) {
      return { yesPrice: null, noPrice: null };
    }

    const noExplicit = pairs.find((entry) => normalizeOutcomeName(entry.outcome) === "no")?.price;
    return {
      yesPrice,
      noPrice: Number.isFinite(noExplicit ?? Number.NaN) ? (noExplicit ?? null) : 1 - yesPrice,
    };
  }

  private buildFallbackSignalFromGamma(
    market: RawGammaMarket,
    detail?: {
      reasoning?: string;
      dataPoints?: string[];
      description?: string;
    },
  ): MoneyRadarSignal {
    const prices = this.extractBinaryPrices(market);
    const trackedPrice = prices.yesPrice ?? 0.5;
    const smartSide = trackedPrice >= 0.5 ? "YES" : "NO";

    return {
      id: market.id,
      market_id: market.slug,
      slug: market.slug,
      question: market.question,
      url: `https://polymarket.com/event/${market.slug}`,
      image: market.image ?? market.icon,
      category: market.category ?? inferCategory(market.question),
      end_date: market.endDate,
      days_left: computeDaysLeft(market.endDate),
      last_price: smartSide === "YES" ? trackedPrice : prices.noPrice ?? 1 - trackedPrice,
      smart_money_side: smartSide,
      trader_category: "none",
      yes_smart_ratio: Math.round(trackedPrice * 100),
      no_smart_ratio: Math.round((1 - trackedPrice) * 100),
      wa_smart_yes: Math.round(trackedPrice * 100),
      wa_smart_no: Math.round((1 - trackedPrice) * 100),
      context_response: detail?.reasoning ?? null,
      estimable_method: "market_price",
      fair_value_calculation: detail
        ? {
            reasoning: detail.reasoning ?? "",
            data_points: detail.dataPoints ?? [],
          }
        : undefined,
      data_sources: ["Polymarket Gamma", "Polymarket CLOB"],
      description: detail?.description ?? market.description,
      groupItemTitle: market.groupItemTitle ?? (smartSide === "YES" ? "Yes" : "No"),
      active: market.active ?? true,
      closed: market.closed ?? false,
    };
  }

  private buildMarketListItem(market: MarketRecord, aggregate?: MarketAggregate): Record<string, unknown> {
    const outcomeEntries = Object.entries(market.outcomeByAssetId);
    const prices = outcomeEntries.map(([assetId, outcome]) => ({
      outcome,
      price: toNumber(market.outcomePriceByAssetId?.[assetId], Number.NaN),
    }));
    const yesPrice = prices.find((entry) => normalizeOutcomeName(entry.outcome) === "yes")?.price ?? prices[0]?.price;
    const noPrice =
      prices.find((entry) => normalizeOutcomeName(entry.outcome) === "no")?.price
      ?? (Number.isFinite(yesPrice ?? Number.NaN) ? 1 - (yesPrice ?? 0.5) : null);

    return {
      id: market.id,
      conditionId: market.conditionId,
      slug: market.slug,
      question: market.question,
      question_he: market.question,
      eventSlug: market.eventSlug,
      url: `https://polymarket.com/event/${market.eventSlug ?? market.slug}`,
      description: "",
      image: market.image,
      category: market.category,
      category_he: market.category,
      tags: market.category ? [market.category] : [],
      active: true,
      closed: false,
      endDate: market.endDate,
      daysLeft: Math.round(computeDaysLeft(market.endDate)),
      liquidity: market.liquidity,
      volume: market.volume24hr,
      volume24h: market.volume24hr,
      yesPrice,
      noPrice,
      priceChange1h: null,
      priceChange24h: null,
      priceChange1w: null,
      priceChange1mo: null,
      outcomePrices: JSON.stringify(prices.map((entry) => entry.price)),
      outcomes: JSON.stringify(outcomeEntries.map((entry) => entry[1])),
      topOutcome: aggregate?.outcomeWeights[0]?.outcome ?? null,
      weightedScore: aggregate?.weightedScore ?? 0,
      participants: aggregate?.participantCount ?? 0,
    };
  }

  private mapRawMarketToCatalogMarket(market: RawGammaMarket): MarketRecord {
    const outcomes = parseJsonArray<string>(market.outcomes, []);
    const tokenIds = parseJsonArray<string>(market.clobTokenIds, []);
    const prices = parseJsonArray<string | number>(market.outcomePrices, []);

    return {
      id: market.id,
      conditionId: market.id,
      slug: market.slug,
      question: market.question,
      image: market.image ?? market.icon ?? "",
      endDate: market.endDate ?? new Date().toISOString(),
      liquidity: toNumber(market.liquidityNum, 0),
      volume24hr: toNumber(market.volume24hr, 0),
      category: market.category,
      eventSlug: market.events?.[0]?.slug,
      eventTitle: market.events?.[0]?.title,
      outcomeByAssetId: Object.fromEntries(
        tokenIds.map((tokenId, index) => [tokenId, outcomes[index] ?? `Outcome ${index + 1}`]),
      ),
      outcomePriceByAssetId: Object.fromEntries(
        tokenIds.map((tokenId, index) => [tokenId, toNumber(prices[index], Number.NaN)]),
      ),
    };
  }

  private async fetchLiveGammaMarkets(params: {
    limit: number;
    category?: string;
    israelFilter?: boolean;
  }): Promise<RawGammaMarket[]> {
    const url = new URL(`${GAMMA_API_URL}/markets`);
    url.searchParams.set("limit", String(Math.max(1, Math.min(params.limit, 250))));
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    if (params.category) {
      url.searchParams.set("category", params.category);
    }

    const response = await fetch(url);
    const markets = (await response.json()) as RawGammaMarket[];
    return markets.filter((entry) => !params.israelFilter || isIsraelRelated(entry));
  }

  private async fetchLiveGammaMarketPage(params: {
    offset: number;
    limit: number;
    category?: string;
  }): Promise<RawGammaMarket[]> {
    const url = new URL(`${GAMMA_API_URL}/markets`);
    url.searchParams.set("limit", String(Math.max(1, Math.min(params.limit, 1000))));
    url.searchParams.set("offset", String(Math.max(0, params.offset)));
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    if (params.category) {
      url.searchParams.set("category", params.category);
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gamma markets page lookup failed with status ${response.status}`);
    }

    return (await response.json()) as RawGammaMarket[];
  }

  private async fetchGammaMarketBySlug(slug: string): Promise<RawGammaMarket> {
    const response = await fetch(`${GAMMA_API_URL}/markets/slug/${encodeURIComponent(slug)}`);
    if (!response.ok) {
      throw new Error(`Gamma market lookup failed for ${slug}`);
    }
    return (await response.json()) as RawGammaMarket;
  }

  private async fetchGammaMarketsByEventSlug(eventSlug: string): Promise<RawGammaMarket[]> {
    const url = new URL(`${GAMMA_API_URL}/markets`);
    url.searchParams.set("eventSlug", eventSlug);
    url.searchParams.set("limit", "50");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gamma event market lookup failed for ${eventSlug}`);
    }
    return (await response.json()) as RawGammaMarket[];
  }

  private async fetchGammaEventBySlug(slug: string): Promise<{ title?: string; description?: string }> {
    const response = await fetch(`${GAMMA_API_URL}/events/slug/${encodeURIComponent(slug)}`);
    if (!response.ok) {
      throw new Error(`Gamma event lookup failed for ${slug}`);
    }
    return (await response.json()) as { title?: string; description?: string };
  }

  private async getAuthenticatedUser(cookieHeader = ""): Promise<{ user: AuthUser; session: SessionPayload } | null> {
    if (!this.authAvailable()) {
      return null;
    }

    const sessionId = extractWebSessionId(cookieHeader);
    if (!sessionId) {
      return null;
    }

    const session = await this.sessionsCollection().findOne({ id: sessionId });
    if (!session) {
      return null;
    }

    if (Date.parse(session.expires_at) <= Date.now()) {
      await this.sessionsCollection().deleteOne({ id: session.id });
      return null;
    }

    const user = await this.usersCollection().findOne({ id: session.user_id });
    if (!user) {
      return null;
    }

    return {
      user,
      session: {
        id: session.id,
        user_id: user.id,
        expires_at: session.expires_at,
        user: {
          id: user.id,
          email: user.email,
        },
      },
    };
  }

  private async getAuthenticatedUserId(cookieHeader = ""): Promise<string | null> {
    const auth = await this.getAuthenticatedUser(cookieHeader);
    return auth?.user.id ?? null;
  }

  private async createSession(user: AuthUser): Promise<SessionPayload> {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    const session: AuthSession = {
      id: randomUUID(),
      user_id: user.id,
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
    };

    await this.sessionsCollection().insertOne(session);

    return {
      id: session.id,
      user_id: user.id,
      expires_at: expiresAt,
      user: {
        id: user.id,
        email: user.email,
      },
    };
  }

  private async getValidAuthToken(
    token: string,
    type: AuthToken["type"],
  ): Promise<{ token: AuthToken; user: AuthUser } | null> {
    if (!this.authAvailable()) {
      return null;
    }

    const normalized = String(token ?? "").trim();
    if (!normalized) {
      return null;
    }

    const authToken = await this.authTokensCollection().findOne({ token: normalized, type, used_at: null });
    if (!authToken) {
      return null;
    }

    if (Date.parse(authToken.expires_at) <= Date.now()) {
      await this.authTokensCollection().deleteOne({ id: authToken.id });
      return null;
    }

    const user = await this.usersCollection().findOne({ id: authToken.user_id });
    if (!user) {
      return null;
    }

    return { token: authToken, user };
  }

  private toProfile(user: AuthUser): Record<string, unknown> {
    return {
      id: user.id,
      email: user.email,
      full_name: user.full_name,
      subscription_tier: user.subscription_tier,
      pro_expires_at: user.pro_expires_at,
      terms_accepted_at: user.terms_accepted_at,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  private buildBroadcastMessage(
    cookieHeader: string,
    rawMessage: string,
    profile: Record<string, unknown> | null,
  ): BroadcastMessage | null {
    const trimmed = rawMessage.trim();
    if (!trimmed) {
      return null;
    }

    const sanitized = trimmed.replace(/\s+/g, " ").slice(0, 600);
    const sessionId = extractWebSessionId(cookieHeader);
    const profileName = typeof profile?.full_name === "string" ? profile.full_name : null;
    const profileEmail = typeof profile?.email === "string" ? profile.email : null;
    const username =
      profileName
      || profileEmail?.split("@")[0]
      || (typeof profile?.email === "string" ? profile.email.split("@")[0] : null)
      || "Guest Analyst";

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      user_id: sessionId,
      username,
      full_name: profileName,
      body: sanitized,
      created_at: new Date().toISOString(),
    };
  }

  private authAvailable(): boolean {
    return this.authReady || this.mongoReady;
  }

  private authDb() {
    if (this.authReady) {
      return this.authMongoClient.db();
    }

    return this.mongoClient.db(this.authDbName);
  }

  private usersCollection() {
    return this.authDb().collection<AuthUser>("money_radar_users");
  }

  private sessionsCollection() {
    return this.authDb().collection<AuthSession>("money_radar_sessions");
  }

  private authTokensCollection() {
    return this.authDb().collection<AuthToken>("money_radar_auth_tokens");
  }

  private favoriteMarketsCollection() {
    return this.mongoClient.db(config.mongoDbName).collection<FavoriteMarket>("money_radar_favorite_markets");
  }

  private favoriteTradesCollection() {
    return this.mongoClient.db(config.mongoDbName).collection<FavoriteTrade>("money_radar_favorite_trades");
  }

  private broadcastCollection() {
    return this.mongoClient.db(config.mongoDbName).collection<BroadcastMessage>("money_radar_broadcast_messages");
  }
}
