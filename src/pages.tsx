import { useDeferredValue, useEffect, useState } from "react";
import { AnalyzerPanel, PageIntro, SignalCard, SkeletonGrid, SkeletonTable, icons, interceptInternalNavigation } from "./components";
import type { AppRoute, BroadcastMessage, FavoriteMarket, FavoriteTrade, MarketItem, SignalSummary } from "./types";
import {
  categoryTabs,
  emitFavoritesUpdated,
  fetchJson,
  favoritesEventName,
  formatCompactNumber,
  formatDate,
  formatPrice,
  formatRelativeDays,
  formatTimestamp,
  readLocalActivity,
} from "./utils";

const faqItems = [
  {
    question: "האם זה עכשיו React אמיתי או רק עטיפה?",
    answer:
      "מסכי הליבה וכל מסכי המעטפת שנמצאים בניווט הראשי נבנים עכשיו בתוך הלקוח המקומי של React ומדברים ישירות עם השרת המקומי.",
  },
  {
    question: "מאיפה הנתונים מגיעים?",
    answer:
      "היישום מושך נתונים מ-Polymarket דרך שכבת התאמה בשרת, ומשתמש גם ברפרנסים שמצאת כדי לשמור על מבנה תגובות שתואם לאתר המקורי.",
  },
  {
    question: "האם צריך עדיין את תיקיית המראה הישנה?",
    answer:
      "לא עבור הניווט הראשי. המסכים שבנינו כאן כבר לא תלויים ב-iframe או בטעינת HTML משוכפל כדי לפעול.",
  },
  {
    question: "מה עדיין לא מושלם?",
    answer:
      "זרימות auth וקהילה עדיין משתמשות ב-backend תאימות ולא במערכת משתמשים מלאה זהה למקור, ולכן יש עוד מקום להעמקה בשלב הבא.",
  },
];

const termsSections = [
  "המערכת מיועדת למחקר, לימוד והבנת שווקי חיזוי בלבד.",
  "שום מידע בדשבורד, בצ'אט או בניתוחי AI אינו מהווה ייעוץ השקעות.",
  "המשתמש אחראי באופן בלעדי לכל החלטה פיננסית או מסחרית.",
  "פלטפורמות צד שלישי כמו Polymarket פועלות לפי הכללים והתשתיות שלהן, ולא לפי האתר הזה.",
  "מותר להשתמש במידע לצורכי מחקר פנימי בלבד, ולא להפצה מסחרית של תוכן המערכת ללא אישור.",
];

function useSignalsFeed(query: string) {
  const [signals, setSignals] = useState<SignalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const payload = await fetchJson<{ success: true; signals: SignalSummary[] }>(query);
        if (!cancelled) {
          setSignals(payload.signals ?? []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setSignals([]);
          setError(loadError instanceof Error ? loadError.message : "טעינת הסיגנלים נכשלה");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [query]);

  return { signals, loading, error };
}

function useSession() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    profile: Record<string, unknown> | null;
  }>({
    authenticated: false,
    profile: null,
  });

  const refresh = async () => {
    const payload = await fetchJson<{
      success: true;
      authenticated: boolean;
      profile: Record<string, unknown> | null;
    }>("/api/me").catch(() => ({
      success: true,
      authenticated: false,
      profile: null,
    }));

    setSession({
      authenticated: payload.authenticated,
      profile: payload.profile,
    });
  };

  useEffect(() => {
    void refresh();
  }, []);

  return { ...session, refresh };
}

function useFavoriteMarkets() {
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = async () => {
    const payload = await fetchJson<{ markets: FavoriteMarket[] }>("/api/favorites/markets").catch(() => ({ markets: [] }));
    setFavoriteIds(new Set((payload.markets ?? []).map((market) => market.market_id)));
  };

  useEffect(() => {
    void load();
    const onFavoritesChanged = () => {
      void load();
    };

    window.addEventListener(favoritesEventName, onFavoritesChanged);
    return () => window.removeEventListener(favoritesEventName, onFavoritesChanged);
  }, []);

  const toggleFavorite = async (market: {
    market_id: string;
    slug?: string;
    question?: string;
    category?: string;
    url?: string;
    saved_price?: number | null;
  }) => {
    const marketId = market.market_id;
    setBusyIds((current) => new Set(current).add(marketId));

    try {
      if (favoriteIds.has(marketId)) {
        await fetchJson(`/api/favorites/markets?market_id=${encodeURIComponent(marketId)}`, {
          method: "DELETE",
        });
      } else {
        await fetchJson("/api/favorites/markets", {
          method: "POST",
          body: JSON.stringify({
            market_id: market.market_id,
            slug: market.slug ?? "",
            question: market.question ?? "",
            category: market.category ?? "",
            url: market.url ?? "",
            saved_price: market.saved_price ?? null,
          }),
        });
      }

      emitFavoritesUpdated();
      await load();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(marketId);
        return next;
      });
    }
  };

  return { favoriteIds, busyIds, toggleFavorite };
}

function useFavoriteTrades() {
  const [favoriteTradeIds, setFavoriteTradeIds] = useState<Set<string>>(new Set());
  const [busyTradeIds, setBusyTradeIds] = useState<Set<string>>(new Set());

  const load = async () => {
    const payload = await fetchJson<{ trades: FavoriteTrade[] }>("/api/favorites/trades").catch(() => ({ trades: [] }));
    setFavoriteTradeIds(new Set((payload.trades ?? []).map((trade) => trade.trade_id)));
  };

  useEffect(() => {
    void load();
    const onFavoritesChanged = () => {
      void load();
    };

    window.addEventListener(favoritesEventName, onFavoritesChanged);
    return () => window.removeEventListener(favoritesEventName, onFavoritesChanged);
  }, []);

  const toggleTrade = async (trade: FavoriteTrade) => {
    const tradeId = trade.trade_id;
    setBusyTradeIds((current) => new Set(current).add(tradeId));

    try {
      if (favoriteTradeIds.has(tradeId)) {
        await fetchJson(`/api/favorites/trades?trade_id=${encodeURIComponent(tradeId)}`, {
          method: "DELETE",
        });
      } else {
        await fetchJson("/api/favorites/trades", {
          method: "POST",
          body: JSON.stringify(trade),
        });
      }

      emitFavoritesUpdated();
      await load();
    } finally {
      setBusyTradeIds((current) => {
        const next = new Set(current);
        next.delete(tradeId);
        return next;
      });
    }
  };

  return { favoriteTradeIds, busyTradeIds, toggleTrade };
}

export function HomePage({
  onOpenSignal,
  onTrackAnalysis,
  navigate,
}: {
  onOpenSignal: (signal: SignalSummary) => void;
  onTrackAnalysis: (signal: SignalSummary) => void;
  navigate: (route: AppRoute) => void;
}) {
  const [activeCategory, setActiveCategory] = useState(categoryTabs[0].id);
  const activeTab = categoryTabs.find((tab) => tab.id === activeCategory) ?? categoryTabs[0];
  const { signals, loading, error } = useSignalsFeed(activeTab.query);
  const { favoriteIds, busyIds, toggleFavorite } = useFavoriteMarkets();
  const featuredSignals = signals.slice(0, 6);
  const avgPrice = signals.length ? signals.reduce((sum, signal) => sum + (signal.last_price ?? 0), 0) / signals.length : 0;

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Money Radar</span>
          <h1>
            רדאר שוק React-native
            <br />
            על גבי נתונים חיים.
          </h1>
          <p>
            דשבורד הליבה, סורק השוק, שוקים, כרישים, צ'אט והיסטוריה פועלים עכשיו כ-React אמיתי
            מול השרת המקומי וה-fetches שתיעדת.
          </p>
          <div className="hero-actions">
            <a href="/signals" onClick={(event) => interceptInternalNavigation(event, "/signals", navigate)} className="primary-button">
              פתח את סורק השוק
            </a>
            <a href="/markets" onClick={(event) => interceptInternalNavigation(event, "/markets", navigate)} className="ghost-button">
              עבור לכל האירועים
            </a>
          </div>
        </div>
        <div className="hero-grid">
          <article className="hero-stat">
            <span>פיד פעיל</span>
            <strong>{signals.length}</strong>
            <small>שווקים בקטגוריה הנוכחית</small>
          </article>
          <article className="hero-stat">
            <span>מחיר אמצע</span>
            <strong>{formatPrice(avgPrice)}</strong>
            <small>ממוצע בפיד הבית</small>
          </article>
          <article className="hero-stat">
            <span>פוקוס</span>
            <strong>{activeTab.label}</strong>
            <small>{activeTab.description}</small>
          </article>
        </div>
      </section>

      <section className="tab-strip">
        {categoryTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab-chip ${tab.id === activeCategory ? "tab-chip-active" : ""}`}
            onClick={() => setActiveCategory(tab.id)}
          >
            <span>{tab.emoji}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </section>

      <AnalyzerPanel onOpenSignal={onOpenSignal} onTrackAnalysis={onTrackAnalysis} />

      <section className="content-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Live Radar</span>
            <h2>הסיגנלים החזקים עכשיו</h2>
          </div>
          <p>{activeTab.description}</p>
        </div>
        {loading ? (
          <SkeletonGrid />
        ) : error ? (
          <div className="empty-card">{error}</div>
        ) : (
          <div className="card-grid">
            {featuredSignals.map((signal) => (
              <SignalCard
                key={signal.slug}
                signal={signal}
                onOpen={onOpenSignal}
                favorite={{
                  active: favoriteIds.has(signal.market_id),
                  busy: busyIds.has(signal.market_id),
                  onToggle: () =>
                    void toggleFavorite({
                      market_id: signal.market_id,
                      slug: signal.slug,
                      question: signal.question,
                      category: signal.category,
                      url: signal.url,
                      saved_price: signal.last_price,
                    }),
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function SignalsPage({ onOpenSignal }: { onOpenSignal: (signal: SignalSummary) => void }) {
  const [activeCategory, setActiveCategory] = useState(categoryTabs[1].id);
  const [search, setSearch] = useState("");
  const activeTab = categoryTabs.find((tab) => tab.id === activeCategory) ?? categoryTabs[0];
  const { signals, loading, error } = useSignalsFeed(activeTab.query);
  const { favoriteIds, busyIds, toggleFavorite } = useFavoriteMarkets();
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const filteredSignals = signals.filter((signal) => {
    if (!deferredSearch) {
      return true;
    }
    const haystack = `${signal.question} ${signal.category ?? ""} ${signal.description ?? ""}`.toLowerCase();
    return haystack.includes(deferredSearch);
  });

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Signal Scanner"
        title="סורק השוק"
        description="תצוגת React מלאה עם פילטרים, חיפוש, פירוט היסטורי ופתיחה ישירה לכל חוזה."
      />

      <section className="toolbar-card">
        <div className="tab-strip tab-strip-tight">
          {categoryTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`tab-chip ${tab.id === activeCategory ? "tab-chip-active" : ""}`}
              onClick={() => setActiveCategory(tab.id)}
            >
              <span>{tab.emoji}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <label className="search-box">
          <span>חיפוש חופשי</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="חפש שוק, קטגוריה או נושא..." />
        </label>
      </section>

      {loading ? (
        <SkeletonGrid />
      ) : error ? (
        <div className="empty-card">{error}</div>
      ) : filteredSignals.length ? (
        <div className="card-grid">
          {filteredSignals.map((signal) => (
            <SignalCard
              key={signal.slug}
              signal={signal}
              onOpen={onOpenSignal}
              favorite={{
                active: favoriteIds.has(signal.market_id),
                busy: busyIds.has(signal.market_id),
                onToggle: () =>
                  void toggleFavorite({
                    market_id: signal.market_id,
                    slug: signal.slug,
                    question: signal.question,
                    category: signal.category,
                    url: signal.url,
                    saved_price: signal.last_price,
                  }),
              }}
            />
          ))}
        </div>
      ) : (
        <div className="empty-card">לא נמצאו תוצאות עבור החיפוש הנוכחי.</div>
      )}
    </div>
  );
}

export function MarketsPage({ onOpenSignal }: { onOpenSignal: (signal: SignalSummary) => void }) {
  const [markets, setMarkets] = useState<MarketItem[]>([]);
  const [fallbackSignals, setFallbackSignals] = useState<SignalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { favoriteIds, busyIds, toggleFavorite } = useFavoriteMarkets();

  const load = async () => {
    setLoading(true);
    setError(null);

    try {
      const payload = await fetchJson<{ success: true; markets: MarketItem[] }>("/api/markets?offset=0&limit=120");
      const nextMarkets = payload.markets ?? [];
      setMarkets(nextMarkets);

      if (!nextMarkets.length) {
        const signalPayload = await fetchJson<{ success: true; signals: SignalSummary[] }>("/api/batch-signals?sortBy=volume24h&limit=18");
        setFallbackSignals(signalPayload.signals ?? []);
      } else {
        setFallbackSignals([]);
      }
    } catch (loadError) {
      setMarkets([]);
      setFallbackSignals([]);
      setError(loadError instanceof Error ? loadError.message : "טעינת האירועים נכשלה");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const totalLiquidity = markets.reduce((sum, market) => sum + (market.liquidity ?? 0), 0);

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Market Board"
        title="כל האירועים"
        description="המסך מיושר לשדות האמיתיים של API השווקים: question, tags, daysLeft, volume24h, yes/no price ועוד."
        actions={
          <button type="button" className="ghost-button" onClick={() => void load()}>
            <span className="button-icon">{icons.refresh}</span>
            רענן נתונים
          </button>
        }
      />

      <section className="stats-row">
        <article className="stat-card">
          <span>אירועים בקטלוג</span>
          <strong>{markets.length}</strong>
          <small>טעינה חיה מ-`/api/markets`</small>
        </article>
        <article className="stat-card">
          <span>נזילות כוללת</span>
          <strong>${formatCompactNumber(totalLiquidity)}</strong>
          <small>על בסיס הדגימה שנטענה</small>
        </article>
        <article className="stat-card">
          <span>מצב לוח</span>
          <strong>{markets.length ? "Live catalog" : "Signal fallback"}</strong>
          <small>Fallback נשמר למסכים ריקים</small>
        </article>
      </section>

      {loading ? (
        <SkeletonTable />
      ) : error ? (
        <div className="empty-card">{error}</div>
      ) : markets.length ? (
        <section className="market-table">
          {markets.map((market) => (
            <article key={market.id} className="market-row">
              <div className="market-main">
                <div className="image-fallback market-avatar">{market.category?.slice(0, 2) ?? "MR"}</div>
                <div>
                  <strong>{market.question_he ?? market.question}</strong>
                  <small>
                    {(market.category_he ?? market.category ?? "כללי")}
                    {" · "}
                    {formatDate(market.endDate)}
                    {" · "}
                    {market.daysLeft ?? "?"} ימים
                  </small>
                </div>
              </div>
              <div className="market-metrics">
                <button
                  type="button"
                  className="ghost-button market-action"
                  onClick={() =>
                    void toggleFavorite({
                      market_id: market.id,
                      slug: market.slug,
                      question: market.question_he ?? market.question,
                      category: market.category_he ?? market.category,
                      url: market.url,
                      saved_price: market.yesPrice,
                    })
                  }
                  disabled={busyIds.has(market.id)}
                >
                  <span className="button-icon">{icons.star}</span>
                  {favoriteIds.has(market.id) ? "Saved" : busyIds.has(market.id) ? "Saving..." : "Save"}
                </button>
                <span>כן {formatPrice(market.yesPrice)}</span>
                <span>לא {formatPrice(market.noPrice)}</span>
                <span>24ש ${formatCompactNumber(market.volume24h)}</span>
                <span>נזילות ${formatCompactNumber(market.liquidity)}</span>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <div className="card-grid">
          {fallbackSignals.map((signal) => (
            <SignalCard
              key={signal.slug}
              signal={signal}
              onOpen={onOpenSignal}
              favorite={{
                active: favoriteIds.has(signal.market_id),
                busy: busyIds.has(signal.market_id),
                onToggle: () =>
                  void toggleFavorite({
                    market_id: signal.market_id,
                    slug: signal.slug,
                    question: signal.question,
                    category: signal.category,
                    url: signal.url,
                    saved_price: signal.last_price,
                  }),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SmartTradersPage({ onOpenSignal }: { onOpenSignal: (signal: SignalSummary) => void }) {
  const [signals, setSignals] = useState<Array<SignalSummary & FavoriteTrade>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const { favoriteTradeIds, busyTradeIds, toggleTrade } = useFavoriteTrades();

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const payload = await fetchJson<{ success: true; signals: Array<Record<string, unknown>> }>("/api/smart-traders?limit=18");
        const liveSignals = payload.signals ?? [];

        if (liveSignals.length) {
          const adapted = liveSignals.map((item, index) => ({
            id: String(item.id ?? index),
            market_id: String(item.market_id ?? item.trade_id ?? item.id ?? index),
            slug: String(item.market_slug ?? item.market_id ?? `smart-${index}`),
            question: String(item.market_name ?? item.question ?? "Whale activity"),
            category: "Whales",
            smart_money_side: String(item.side ?? item.outcome ?? "Flow"),
            last_price: 0.5,
            trade_id: String(item.id ?? item.trade_id ?? `trade-${index}`),
            market_name: String(item.market_name ?? item.question ?? "Whale activity"),
            side: String(item.side ?? ""),
            outcome: String(item.outcome ?? ""),
            notional_usd: Number(item.notional_usd ?? 0),
            saved_at: Date.now(),
            context_response: `${item.whale_group ?? item.trader_category ?? "Smart flow"} · ${item.side ?? ""} ${item.outcome ?? ""}`.trim(),
          })) as Array<SignalSummary & FavoriteTrade>;

          if (!cancelled) {
            setSignals(adapted);
            setFallback(false);
          }
          return;
        }

        const fallbackPayload = await fetchJson<{ success: true; signals: SignalSummary[] }>("/api/batch-signals?sortBy=volume24h&limit=12");
        if (!cancelled) {
          setSignals(fallbackPayload.signals ?? []);
          setFallback(true);
        }
      } catch (loadError) {
        if (!cancelled) {
          setSignals([]);
          setError(loadError instanceof Error ? loadError.message : "טעינת כרישים נכשלה");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const onFavoritesChanged = () => {
      void load();
    };
    window.addEventListener(favoritesEventName, onFavoritesChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(favoritesEventName, onFavoritesChanged);
    };
  }, []);

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Whale Radar"
        title="רדאר הכרישים"
        description="אם פיד הכרישים החי ריק, המסך ממשיך לפעול עם קריאת כסף חכם שנגזרת מסיגנלי השוק החיים."
      />

      {fallback ? <div className="notice-banner">פיד הכרישים שקט כרגע, לכן מוצגת קריאת כסף חכם מהסיגנלים החיים.</div> : null}

      {loading ? (
        <SkeletonGrid />
      ) : error ? (
        <div className="empty-card">{error}</div>
      ) : (
        <div className="card-grid">
          {signals.map((signal) => (
            <article key={`${signal.slug}-${signal.id}`} className="detail-panel trader-card">
              <div className="panel-head">
                <div>
                  <h3>{signal.market_name ?? signal.question}</h3>
                  <span>{signal.context_response ?? signal.smart_money_side ?? "Flow"}</span>
                </div>
                <span>{signal.outcome ?? signal.smart_money_side ?? "Trade"}</span>
              </div>
              <div className="metric-pills">
                <span>{signal.side ?? "flow"}</span>
                <span>${formatCompactNumber(signal.notional_usd ?? 0)}</span>
                <span>{signal.category ?? "Whales"}</span>
              </div>
              <p className="detail-copy">{signal.question}</p>
              <div className="button-row">
                <button type="button" className="ghost-button" onClick={() => onOpenSignal(signal)}>
                  Open detail
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    void toggleTrade({
                      trade_id: signal.trade_id,
                      market_name: signal.market_name ?? signal.question,
                      side: signal.side,
                      outcome: signal.outcome,
                      notional_usd: signal.notional_usd,
                      saved_at: signal.saved_at,
                    })
                  }
                  disabled={busyTradeIds.has(signal.trade_id)}
                >
                  <span className="button-icon">{icons.star}</span>
                  {favoriteTradeIds.has(signal.trade_id) ? "Saved trade" : busyTradeIds.has(signal.trade_id) ? "Saving..." : "Save trade"}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChatPage() {
  const [messages, setMessages] = useState<BroadcastMessage[]>([]);
  const [fallbackSignals, setFallbackSignals] = useState<SignalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const { authenticated, profile, refresh } = useSession();

  const load = async () => {
    setLoading(true);
    setError(null);

    try {
      const payload = await fetchJson<{ success: true; messages: BroadcastMessage[] }>("/api/broadcast");
      setMessages(payload.messages ?? []);

      if (!payload.messages?.length) {
        const signalPayload = await fetchJson<{ success: true; signals: SignalSummary[] }>("/api/batch-signals?sortBy=volume24h&limit=6");
        setFallbackSignals(signalPayload.signals ?? []);
      } else {
        setFallbackSignals([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "טעינת הצ'אט נכשלה");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const guardedLoad = async () => {
      if (cancelled) {
        return;
      }
      await load();
    };

    void guardedLoad();
    const interval = window.setInterval(guardedLoad, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const submitMessage = async () => {
    setPosting(true);
    setError(null);
    try {
      await fetchJson("/api/broadcast", {
        method: "POST",
        body: JSON.stringify({ message: draft }),
      });
      setDraft("");
      await Promise.all([load(), refresh()]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "שליחת ההודעה נכשלה");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Community Feed"
        title="צ'אט הקהילה"
        description="ערוץ React מול `/api/broadcast`, עם fallback ברור כשהפיד המקורי ריק."
      />

      <section className="chat-shell">
        <article className="chat-panel">
          <div className="panel-head">
            <h3>פיד שידורים</h3>
            <span>{messages.length ? `${messages.length} הודעות` : "שקט כרגע"}</span>
          </div>
          {loading ? (
            <div className="loading-copy">טוען פיד קהילה...</div>
          ) : error ? (
            <div className="empty-card">{error}</div>
          ) : messages.length ? (
            <div className="chat-list">
              {messages.map((message, index) => (
                <article key={message.id ?? index} className="chat-message">
                  <strong>{message.full_name ?? message.username ?? "Money Radar"}</strong>
                  <p>{message.body ?? message.message ?? ""}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="chat-list">
              {fallbackSignals.map((signal) => (
                <article key={signal.slug} className="chat-message system-message">
                  <strong>System pulse</strong>
                  <p>
                    {signal.question}
                    <br />
                    {signal.smart_money_side ?? "Signal"} · מחיר {formatPrice(signal.last_price)} · {formatRelativeDays(signal.days_left)}
                  </p>
                </article>
              ))}
            </div>
          )}
        </article>

        <article className="chat-panel">
          <div className="panel-head">
            <h3>כללי מרחב</h3>
            <span>{authenticated ? "מחובר" : "אורח"}</span>
          </div>
          <ul className="detail-list">
            <li>המסך React-native ומחובר ל-API המקומי שכבר קיים.</li>
            <li>כשהפיד החי שקט, הוא לא נשבר אלא מציג system pulses רלוונטיים.</li>
            <li>אפשר עכשיו לשמור הודעות בצד השרת המקומי דרך Mongo.</li>
          </ul>
          <label className="search-box">
            <span>הודעה חדשה</span>
            <textarea
              rows={5}
              placeholder="שתף תובנה, טרייד מעניין או קריאת שוק..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="button" className="primary-button" disabled={posting || !draft.trim()} onClick={() => void submitMessage()}>
              {posting ? "שולח..." : "שלח הודעה"}
            </button>
          </div>
          <p className="auth-inline-note">
            הכותב יוצג כ-
            {" "}
            {String((profile?.full_name as string) || (profile?.email as string)?.split("@")[0] || "Guest Analyst")}
            .
          </p>
        </article>
      </section>
    </div>
  );
}

export function HistoryPage({ onOpenSignal }: { onOpenSignal: (signal: SignalSummary) => void }) {
  const [favoriteMarkets, setFavoriteMarkets] = useState<FavoriteMarket[]>([]);
  const [favoriteTrades, setFavoriteTrades] = useState<FavoriteTrade[]>([]);
  const [recent, setRecent] = useState(() => readLocalActivity());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const sync = () => setRecent(readLocalActivity());
    window.addEventListener("money-radar-activity", sync);
    return () => window.removeEventListener("money-radar-activity", sync);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);

      const [marketsPayload, tradesPayload] = await Promise.all([
        fetchJson<{ markets: FavoriteMarket[] }>("/api/favorites/markets").catch(() => ({ markets: [] })),
        fetchJson<{ trades: FavoriteTrade[] }>("/api/favorites/trades").catch(() => ({ trades: [] })),
      ]);

      if (!cancelled) {
        setFavoriteMarkets(marketsPayload.markets ?? []);
        setFavoriteTrades(tradesPayload.trades ?? []);
        setLoading(false);
      }
    };

    void load();
    const onFavoritesChanged = () => {
      void load();
    };
    window.addEventListener(favoritesEventName, onFavoritesChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(favoritesEventName, onFavoritesChanged);
    };
  }, []);

  const recentViews = recent.filter((entry) => entry.kind === "viewed").slice(0, 8);
  const analyses = recent.filter((entry) => entry.kind === "analysis").slice(0, 8);

  const removeFavoriteMarket = async (marketId: string) => {
    await fetchJson(`/api/favorites/markets?market_id=${encodeURIComponent(marketId)}`, {
      method: "DELETE",
    }).catch(() => ({ success: false }));
    emitFavoritesUpdated();
  };

  const removeFavoriteTrade = async (tradeId: string) => {
    await fetchJson(`/api/favorites/trades?trade_id=${encodeURIComponent(tradeId)}`, {
      method: "DELETE",
    }).catch(() => ({ success: false }));
    emitFavoritesUpdated();
  };

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="History"
        title="הפעילות שלי"
        description="שילוב של מועדפים מהשרת המקומי יחד עם היסטוריית עיון וניתוחים מהדפדפן."
      />

      {loading ? <div className="loading-copy">טוען היסטוריה...</div> : null}

      <section className="history-grid">
        <article className="detail-panel">
          <div className="panel-head">
            <h3>צפיות אחרונות</h3>
            <span>{recentViews.length}</span>
          </div>
          {recentViews.length ? (
            <div className="history-list">
              {recentViews.map((entry) => (
                <button
                  key={`${entry.slug}-${entry.timestamp}`}
                  type="button"
                  className="history-item"
                  onClick={() =>
                    onOpenSignal({
                      id: entry.slug,
                      market_id: entry.slug,
                      slug: entry.slug,
                      question: entry.question,
                      image: entry.image,
                      category: entry.category,
                      url: entry.url,
                      last_price: entry.lastPrice,
                      smart_money_side: entry.smartSide,
                    })
                  }
                >
                  <strong>{entry.question}</strong>
                  <small>{formatTimestamp(entry.timestamp)}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-card">עדיין לא פתחת סיגנלים במסך React החדש.</div>
          )}
        </article>

        <article className="detail-panel">
          <div className="panel-head">
            <h3>ניתוחים אחרונים</h3>
            <span>{analyses.length}</span>
          </div>
          {analyses.length ? (
            <div className="history-list">
              {analyses.map((entry) => (
                <button
                  key={`${entry.slug}-${entry.timestamp}`}
                  type="button"
                  className="history-item"
                  onClick={() =>
                    onOpenSignal({
                      id: entry.slug,
                      market_id: entry.slug,
                      slug: entry.slug,
                      question: entry.question,
                      image: entry.image,
                      category: entry.category,
                      url: entry.url,
                      last_price: entry.lastPrice,
                      smart_money_side: entry.smartSide,
                    })
                  }
                >
                  <strong>{entry.question}</strong>
                  <small>{formatTimestamp(entry.timestamp)}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-card">אין עדיין ניתוחים מקומיים שמורים.</div>
          )}
        </article>
      </section>

      <section className="history-grid">
        <article className="detail-panel">
          <div className="panel-head">
            <h3>מועדפי שווקים</h3>
            <span>{favoriteMarkets.length}</span>
          </div>
          {favoriteMarkets.length ? (
            <div className="history-list">
              {favoriteMarkets.map((market) => (
                <article key={`${market.market_id}-${market.saved_at}`} className="history-item history-item-static">
                  <div className="history-copy">
                    <strong>{market.question ?? market.slug ?? market.market_id}</strong>
                    <small>{formatTimestamp(market.saved_at)}</small>
                  </div>
                  <button type="button" className="ghost-button history-action" onClick={() => void removeFavoriteMarket(market.market_id)}>
                    Remove
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-card">אין מועדפים שמורים מהשרת עבור הסשן הנוכחי.</div>
          )}
        </article>

        <article className="detail-panel">
          <div className="panel-head">
            <h3>מועדפי טריידים</h3>
            <span>{favoriteTrades.length}</span>
          </div>
          {favoriteTrades.length ? (
            <div className="history-list">
              {favoriteTrades.map((trade) => (
                <article key={`${trade.trade_id}-${trade.saved_at}`} className="history-item history-item-static">
                  <div className="history-copy">
                    <strong>{trade.market_name ?? trade.trade_id}</strong>
                  </div>
                  <button type="button" className="ghost-button history-action" onClick={() => void removeFavoriteTrade(trade.trade_id)}>
                    Remove
                  </button>
                  <small>{trade.side ?? "Trade"} · {trade.outcome ?? ""}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-card">אין טריידים שמורים כרגע.</div>
          )}
        </article>
      </section>
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="About"
        title="אודות רדאר הכסף"
        description="גרסת React מקומית של המוצר, שנבנתה מחדש מעל שרת תאימות שמתחבר ל-Polymarket ולשאר המקורות שהאתר המקורי הסתמך עליהם."
      />
      <section className="content-prose">
        <article className="detail-panel prose-card">
          <h2>מה נבנה כאן</h2>
          <p>
            המטרה של הפרויקט הזה היא לקחת את חוויית Money Radar ולהפוך אותה לאפליקציה עצמאית שפועלת מתוך
            הקוד שלך, בלי תלות בתיקיית mirror לצורך הניווט הראשי.
          </p>
          <p>
            המסכים המרכזיים, הסיגנלים, שוקי האירועים, פיד הכרישים, הצ&apos;אט וההיסטוריה פועלים כעת
            כרכיבי React אמיתיים עם קריאות API מקומיות.
          </p>
        </article>
        <article className="detail-panel prose-card">
          <h2>מה משרת הנתונים עושה</h2>
          <p>
            שרת האפליקציה המקומי מתווך בין הלקוח לבין Polymarket, שומר על פורמט תגובות דומה למוצר המקורי,
            ומספק fallback חכם כשנתוני קטלוג פנימיים אינם זמינים.
          </p>
          <ul className="detail-list">
            <li>סיגנלים חיים מגיעים מ-`/api/batch-signals`.</li>
            <li>לוח האירועים מיושר לשדות של `markets` ו-`markets/prices`.</li>
            <li>ניתוחי AI ושכבת ההיסטוריה עובדים מול השרת המקומי.</li>
          </ul>
        </article>
      </section>
    </div>
  );
}

export function FaqPage() {
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="FAQ"
        title="שאלות נפוצות"
        description="ריכוז קצר של השאלות החשובות על הגרסה המקומית ועל מצב השכפול."
      />
      <section className="faq-list">
        {faqItems.map((item) => (
          <article key={item.question} className="detail-panel faq-card">
            <h3>{item.question}</h3>
            <p>{item.answer}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Privacy"
        title="מדיניות פרטיות"
        description="המסך הזה הוא גרסה מקומית ברורה למסמך הפרטיות, בלי תלות בעמוד המשוחזר."
      />
      <section className="content-prose">
        <article className="detail-panel prose-card">
          <h2>מה נאסף</h2>
          <p>
            הגרסה המקומית שומרת רק מידע תפעולי שנדרש להפעלת החוויה, כמו היסטוריית עיון מקומית בדפדפן ומועדפים
            אם קיימת שכבת משתמש פעילה בשרת.
          </p>
          <p>
            מידע שמגיע מצדדים שלישיים, כמו Polymarket, אינו נשמר מעבר למה שנדרש לתצוגה, ניתוח ו-caching
            תפעולי.
          </p>
        </article>
        <article className="detail-panel prose-card">
          <h2>אחסון מקומי</h2>
          <ul className="detail-list">
            <li>היסטוריית צפייה וניתוח נשמרת ב-`localStorage` לצורך חוויית המשתמש.</li>
            <li>מועדפים ונתוני auth תלויים בעוגיות ובשכבת backend אם היא קיימת.</li>
            <li>אין כאן analytics צד שלישי שנוספו כחלק מהשכתוב הזה.</li>
          </ul>
        </article>
      </section>
    </div>
  );
}

export function TermsPage() {
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Terms"
        title="תנאי שימוש"
        description="גרסה מקומית תמציתית של כללי השימוש, בהשראת מבנה המוצר המקורי."
      />
      <section className="content-prose">
        <article className="detail-panel prose-card">
          <h2>עקרונות שימוש</h2>
          <ul className="detail-list">
            {termsSections.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
        <article className="detail-panel prose-card">
          <h2>הבהרה חשובה</h2>
          <p>
            כל התכנים, הסיגנלים והניתוחים נועדו למחקר ולמידה בלבד. לפני כל פעולה בעולם האמיתי יש לבדוק עצמאית
            את כללי החוזה, נזילות, סיכונים והשלכות משפטיות.
          </p>
        </article>
      </section>
    </div>
  );
}

export function LoginPage({ navigate }: { navigate: (route: AppRoute) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { authenticated, profile, refresh } = useSession();

  const login = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setResetLink(null);

    try {
      const payload = await fetchJson<Record<string, unknown>>("/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setStatus(typeof payload.success === "boolean" ? "התחברת בהצלחה למערכת המקומית." : "החיבור הושלם.");
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "התחברות נכשלה");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setResetLink(null);

    try {
      const payload = await fetchJson<Record<string, unknown>>("/api/signup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });

      setStatus(
        typeof payload.message === "string"
          ? payload.message
          : "בקשת ההרשמה נשלחה דרך שכבת התאימות. אפשר להמשיך לבדוק את האפליקציה המקומית.",
      );
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "ההרשמה נכשלה");
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    setResetLink(null);

    try {
      const payload = await fetchJson<{ success: true; message?: string; resetUrl?: string }>("/api/request-password-reset", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setStatus(payload.message ?? "Recovery link created.");
      setResetLink(payload.resetUrl ?? null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Password reset request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Access"
        title="כניסה והרשמה"
        description="מסך React מקומי לזרימות גישה בסיסיות. הוא מחובר ל-endpoints שכבר קיימים בשרת במקום לטעון את עמוד ההתחברות הישן."
      />
      <section className="auth-layout">
        <article className="detail-panel auth-card">
          <h2>פתח גישה</h2>
          {authenticated ? (
            <div className="notice-banner">
              מחובר כעת כ-
              {" "}
              {String((profile?.full_name as string) || (profile?.email as string) || "משתמש")}
              .
            </div>
          ) : null}
          <label className="search-box">
            <span>אימייל</span>
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" />
          </label>
          <label className="search-box">
            <span>סיסמה</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" />
          </label>
          {status ? <div className="notice-banner">{status}</div> : null}
          {resetLink ? (
            <div className="notice-banner">
              <a href={resetLink}>Open password reset</a>
            </div>
          ) : null}
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="button-row">
            <button type="button" className="primary-button" onClick={() => void login()} disabled={busy || !email || !password}>
              {busy ? "שולח..." : "התחבר"}
            </button>
            <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy || !email || !password}>
              {busy ? "שולח..." : "צור חשבון"}
            </button>
            <button type="button" className="ghost-button" onClick={() => navigate("/")}>
              חזור לדשבורד
            </button>
            <button type="button" className="ghost-button" onClick={() => void requestReset()} disabled={busy || !email}>
              {busy ? "×©×•×œ×—..." : "×§×‘×œ ×§×™×©×•×¨ ××™×¤×•×¡"}
            </button>
            {authenticated ? (
              <button
                type="button"
                className="ghost-button"
                onClick={async () => {
                  await fetchJson("/api/logout", { method: "POST" }).catch(() => ({}));
                  await refresh();
                  setStatus("החיבור נותק.");
                }}
              >
                התנתק
              </button>
            ) : null}
          </div>
        </article>
        <article className="detail-panel auth-card">
          <h2>מה חשוב לדעת</h2>
          <ul className="detail-list">
            <li>המסך הזה מחליף את עמוד ה-login הישן בניווט React מקומי.</li>
            <li>שכבת auth מלאה עדיין תלויה בהרחבת backend מעבר ל-signup compatibility.</li>
            <li>לבדיקות UI ופונקציונליות של שאר האפליקציה אין יותר צורך בעמוד mirror ישן.</li>
          </ul>
          <div className="button-row">
            <a href="/terms" onClick={(event) => interceptInternalNavigation(event, "/terms", navigate)} className="ghost-button">
              קרא תנאים
            </a>
            <a href="/privacy" onClick={(event) => interceptInternalNavigation(event, "/privacy", navigate)} className="ghost-button">
              קרא פרטיות
            </a>
          </div>
        </article>
      </section>
    </div>
  );
}

export function AuthStatusPage({
  mode,
  navigate,
}: {
  mode: "callback" | "confirm";
  navigate: (route: AppRoute) => void;
}) {
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token =
    searchParams.get("token")
    ?? hashParams.get("token")
    ?? searchParams.get("access_token")
    ?? hashParams.get("access_token")
    ?? "";
  const nextPath = searchParams.get("next") ?? hashParams.get("next");
  const type = searchParams.get("type") ?? hashParams.get("type");
  const callbackError =
    searchParams.get("error_description")
    ?? hashParams.get("error_description")
    ?? searchParams.get("error")
    ?? hashParams.get("error");
  const hasSessionHint = Boolean(token || searchParams.get("access_token") || hashParams.get("access_token"));
  const title = mode === "callback" ? "אימות חשבון" : "אישור גישה";
  const description =
    mode === "callback"
      ? "זהו מסך React מקומי ל-auth callback. הוא שומר על ניווט עקבי גם בלי עמוד ה-legacy."
      : "זהו מסך React מקומי ל-auth confirm. אפשר להחזיר מכאן את המשתמש ישירות למסכים הפעילים.";

  return (
    <div className="page-stack">
      <PageIntro eyebrow="Auth" title={title} description={description} />
      <section className="auth-layout auth-layout-single">
        <article className="detail-panel auth-card">
          <h2>הסטטוס טופל מקומית</h2>
          <p>
            אם נחבר בהמשך auth מלא ל-Supabase או למערכת משתמשים אחרת, זה יהיה המסך שיציג סטטוס אמת, שגיאות,
            והמשך אוטומטי לאפליקציה.
          </p>
          {callbackError ? <div className="error-banner">{callbackError}</div> : null}
          {type === "recovery" && token ? (
            <div className="notice-banner">
              Recovery token detected.
              {" "}
              <a href={`/reset-password?token=${encodeURIComponent(token)}`}>Continue to password reset</a>
            </div>
          ) : null}
          {hasSessionHint && !callbackError && mode === "callback" ? (
            <div className="notice-banner">Authentication details were received. Redirecting into the app.</div>
          ) : null}
          {nextPath ? <div className="notice-banner">Next destination: {nextPath}</div> : null}
          <div className="button-row">
            <button type="button" className="primary-button" onClick={() => navigate("/")}>
              חזור לדשבורד
            </button>
            <button type="button" className="ghost-button" onClick={() => navigate("/login")}>
              עבור להתחברות
            </button>
          </div>
        </article>
      </section>
    </div>
  );
}

export function ResetPasswordPage({ navigate }: { navigate: (route: AppRoute) => void }) {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenState, setTokenState] = useState<{ checked: boolean; valid: boolean; email?: string }>({
    checked: false,
    valid: false,
  });

  useEffect(() => {
    let cancelled = false;

    const validate = async () => {
      if (!token) {
        setTokenState({ checked: true, valid: false });
        return;
      }

      try {
        const payload = await fetchJson<{ success: true; valid: true; email?: string }>(
          `/api/reset-password/validate?token=${encodeURIComponent(token)}`,
        );
        if (!cancelled) {
          setTokenState({ checked: true, valid: true, email: payload.email });
        }
      } catch {
        if (!cancelled) {
          setTokenState({ checked: true, valid: false });
        }
      }
    };

    void validate();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submitReset = async () => {
    setBusy(true);
    setStatus(null);
    setError(null);

    try {
      const payload = await fetchJson<{ success: true; message?: string }>("/api/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setStatus(payload.message ?? "Password updated.");
      window.setTimeout(() => navigate("/"), 800);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Password reset failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Reset"
        title="איפוס סיסמה"
        description="מסך React מקומי שמחליף את עמוד האיפוס המשוחזר ומשאיר את הניווט אחיד בתוך האפליקציה."
      />
      <section className="auth-layout auth-layout-single">
        <article className="detail-panel auth-card">
          <h2>הכן את הזרימה להמשך</h2>
          {!tokenState.checked ? <div className="loading-copy">Checking reset link...</div> : null}
          {tokenState.checked && !tokenState.valid ? <div className="error-banner">Reset link is missing or expired.</div> : null}
          {tokenState.valid && tokenState.email ? <div className="notice-banner">Resetting password for {tokenState.email}</div> : null}
          <label className="search-box">
            <span>סיסמה חדשה</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" />
          </label>
          <label className="search-box">
            <span>אימות סיסמה</span>
            <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="••••••••" />
          </label>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              disabled={!tokenState.valid || busy || !password || password !== confirm}
              onClick={() => void submitReset()}
            >
              עדכן סיסמה
            </button>
            <button type="button" className="ghost-button" onClick={() => navigate("/login")}>
              חזור להתחברות
            </button>
          </div>
          {status ? <div className="notice-banner">{status}</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
        </article>
      </section>
    </div>
  );
}
