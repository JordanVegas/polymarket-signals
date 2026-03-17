import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

type TraderSummary = {
  wallet: string;
  displayName: string;
  profileImage?: string;
  openPnl: number;
  realizedPnl: number;
  totalValue: number;
  totalPnl: number;
  tradeCount: number;
  tier: "whale" | "shark" | "pro" | "none";
  weight: number;
};

type WhaleSignal = {
  id: string;
  wallet: string;
  displayName: string;
  marketQuestion: string;
  marketSlug: string;
  marketUrl: string;
  marketImage: string;
  outcome: string;
  side: "BUY" | "SELL";
  label: string;
  labelTone: "cyan" | "blue" | "yellow" | "neutral";
  totalUsd: number;
  fillCount: number;
  totalShares: number;
  averagePrice: number;
  timestamp: number;
  profileUrl: string;
  profileImage?: string;
  trader: TraderSummary;
};

type Snapshot = {
  status: {
    marketCount: number;
    websocketConnected: boolean;
    websocketShardCount: number;
    websocketConnectedShardCount: number;
    lastMarketSyncAt: number | null;
    lastTradeAt: number | null;
    websocketSubscribedAssetCount: number;
    websocketAssetsSeenCount: number;
    websocketAssetsSeenRecentlyCount: number;
    lastWebsocketMessageAt: number | null;
  };
};

type MarketAggregate = {
  marketSlug: string;
  marketQuestion: string;
  marketUrl: string;
  marketImage: string;
  latestTimestamp: number;
  totalUsd: number;
  totalFillCount: number;
  whales: number;
  sharks: number;
  pros: number;
  weightedScore: number;
  outcomeWeights: Array<{ outcome: string; weight: number }>;
  observedAvgEntry: number | null;
  participantCount: number;
  isWatched: boolean;
  latestSignal: WhaleSignal;
};

type MarketSortOption = "recent" | "weighted" | "buyWeight" | "flow" | "participants";

type MarketPageResponse = {
  items: MarketAggregate[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

type UserProfileResponse = {
  username: string;
  webhookUrl: string;
  monitoredWallet: string;
  watches: Array<{
    marketSlug: string;
    outcome: string;
    marketQuestion: string;
    marketUrl: string;
    source: "manual" | "portfolio_sync";
  }>;
};

type Language = "en" | "he";
type PageRoute = "/" | "/best-trades" | "/profile";

const positiveOutcomeKeywords = ["yes", "up", "above", "over", "higher", "more", "long"];
const negativeOutcomeKeywords = ["no", "down", "below", "under", "lower", "less", "short"];
const outcomeOpposites: Record<string, string> = {
  yes: "No",
  no: "Yes",
  up: "Down",
  down: "Up",
  above: "Below",
  below: "Above",
  over: "Under",
  under: "Over",
  higher: "Lower",
  lower: "Higher",
  more: "Less",
  less: "More",
  long: "Short",
  short: "Long",
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const MARKET_PAGE_SIZE = 24;

function getPageRoute(pathname: string): PageRoute {
  if (pathname === "/profile" || pathname === "/best-trades") {
    return pathname;
  }

  return "/";
}

const copy = {
  en: {
    profile: "Profile",
    monitor: "Monitor",
    bestTrades: "Best trades",
    menu: "Menu",
    closeMenu: "Close menu",
    frontendStream: "Frontend stream",
    connected: "Connected",
    reconnecting: "Reconnecting",
    polymarketSocket: "Polymarket socket",
    syncing: "Syncing",
    shards: "shards",
    activeAssets: "Active assets",
    signalsSurfaced: "Signals surfaced",
    wsCoverage: "WS coverage",
    active: "active",
    lastMarketSync: "Last market sync",
    lastTradeSeen: "Last trade seen",
    pending: "Pending",
    settings: "Settings",
    backToMonitor: "Back to monitor",
    discordAlerts: "Discord alerts",
    profileTitle: "Profile",
    profileSuffix: "'s profile",
    profileBody:
      "Save your Discord webhook here once, then use Get sell alerts on any market card you want to track for exit signals.",
    discordWebhookUrl: "Discord webhook URL",
    monitoredWallet: "Tracked Polymarket wallet",
    saveWebhook: "Save webhook",
    saving: "Saving...",
    discordWebhookSaved: "Discord webhook saved",
    removing: "Removing...",
    activeWatches: "Active watches",
    noActiveWatches: "No sell-alert watches are active yet.",
    watchedOutcome: "Watched outcome",
    watchSourceManual: "Manual",
    watchSourcePortfolioSync: "Portfolio sync",
    openWatchedMarket: "Open watched market",
    removeWatch: "Remove watch",
    signalFeed: "Signal feed",
    vegasMonitor: "Vegas Monitor",
    bestTradesTitle: "Best trades",
    bestTradesSubtitle: "Highest-conviction markets surfaced by tracked smart money.",
    search: "Search",
    searchPlaceholder: "Markets, outcomes, traders",
    sort: "Sort",
    sortRecent: "Most recent",
    sortWeighted: "Highest weight",
    sortBuyWeight: "Top outcome weight",
    sortFlow: "Largest flow",
    sortParticipants: "Most traders",
    watchingTape: "Watching the tape",
    emptyState:
      "Once a wallet crosses the whale threshold, it will appear here with the market, chosen side, and trader profitability label.",
    traders: "traders",
    edge: "edge",
    marketFlow: "Market flow",
    lastPrice: "Last price",
    weighted: "Weighted",
    confidence: "Confidence",
    outcome1: "Outcome 1",
    outcome2: "Outcome 2",
    avgEntry: "Avg entry",
    whySignal: "Why",
    rationaleCluster: "cluster",
    tierWhale: "Whale",
    tierShark: "Shark",
    tierPro: "Pro",
    tierNone: "Large trader",
    openMarket: "Open market",
    openWhaleProfile: "Open whale profile",
    sellAlertsOn: "Sell alerts on",
    getSellAlerts: "Get sell alerts",
    loadingMarkets: "Loading markets...",
    scrollForMore: "Scroll for more",
    whaleBuy: "🐋 Whale buy",
    sharkBuy: "🦈 Shark buy",
    proBuy: "😎 Pro buy",
    whaleSell: "🐋 Whale sell",
    sharkSell: "🦈 Shark sell",
    proSell: "😎 Pro sell",
    now: "now",
    minutesAgo: "m ago",
    hoursAgo: "h ago",
    even: "Even",
    unableToLoadProfile: "Unable to load profile",
    unableToSaveProfile: "Unable to save profile",
    unableToUpdateSellAlerts: "Unable to update sell alerts",
  },
  he: {
    profile: "פרופיל",
    monitor: "מוניטור",
    bestTrades: "העסקאות הטובות ביותר",
    menu: "תפריט",
    closeMenu: "סגור תפריט",
    frontendStream: "חיבור לשרת",
    connected: "מחובר",
    reconnecting: "מתחבר מחדש",
    polymarketSocket: "סוקט פולימרקט",
    syncing: "מסנכרן",
    shards: "שארדים",
    activeAssets: "נכסים פעילים",
    signalsSurfaced: "סיגנלים מוצגים",
    wsCoverage: "כיסוי WS",
    active: "פעילים",
    lastMarketSync: "סנכרון שווקים אחרון",
    lastTradeSeen: "טרייד אחרון",
    pending: "ממתין",
    settings: "הגדרות",
    backToMonitor: "חזרה למוניטור",
    discordAlerts: "התראות דיסקורד",
    profileTitle: "פרופיל",
    profileSuffix: " של",
    profileBody:
      "שמור כאן פעם אחת את כתובת הוובהוק של דיסקורד, ואז השתמש ב-Get sell alerts על כל כרטיס שוק שתרצה לעקוב אחריו ליציאה.",
    discordWebhookUrl: "כתובת וובהוק של דיסקורד",
    monitoredWallet: "ארנק פולימרקט למעקב",
    saveWebhook: "שמור וובהוק",
    saving: "שומר...",
    discordWebhookSaved: "וובהוק דיסקורד נשמר",
    removing: "מסיר...",
    activeWatches: "מעקבים פעילים",
    noActiveWatches: "עדיין אין מעקבי התראות מכירה פעילים.",
    watchedOutcome: "תוצאה במעקב",
    watchSourceManual: "ידני",
    watchSourcePortfolioSync: "מסונכרן מהתיק",
    openWatchedMarket: "פתח שוק במעקב",
    removeWatch: "הסר מעקב",
    signalFeed: "פיד סיגנלים",
    vegasMonitor: "Vegas Monitor",
    bestTradesTitle: "העסקאות הטובות ביותר",
    bestTradesSubtitle: "השווקים עם הכי הרבה שכנוע מצד כסף חכם במעקב.",
    search: "חיפוש",
    searchPlaceholder: "שווקים, תוצאות, טריידרים",
    sort: "מיון",
    sortRecent: "הכי חדש",
    sortWeighted: "משקל גבוה",
    sortBuyWeight: "משקל צד מוביל",
    sortFlow: "זרימה גבוהה",
    sortParticipants: "הכי הרבה טריידרים",
    watchingTape: "עוקבים אחרי הזרם",
    emptyState:
      "ברגע שארנק עובר את סף הסיגנל, הוא יופיע כאן עם השוק, הצד שנבחר ותווית הרווחיות של הטריידר.",
    traders: "טריידרים",
    edge: "סיגנל",
    marketFlow: "נפח שוק",
    lastPrice: "מחיר אחרון",
    weighted: "משקל",
    confidence: "ביטחון",
    outcome1: "תוצאה 1",
    outcome2: "תוצאה 2",
    avgEntry: "ממוצע כניסה",
    whySignal: "למה",
    rationaleCluster: "אשכול",
    tierWhale: "לוויתן",
    tierShark: "כריש",
    tierPro: "מקצוען",
    tierNone: "טריידר גדול",
    openMarket: "פתח שוק",
    openWhaleProfile: "פתח פרופיל",
    sellAlertsOn: "התראות מכירה פועלות",
    getSellAlerts: "קבל התראות מכירה",
    loadingMarkets: "טוען שווקים...",
    scrollForMore: "גלול לעוד",
    whaleBuy: "🐋 עסקת לוויתן",
    sharkBuy: "🦈 עסקת כריש",
    proBuy: "😎 עסקת מקצוען",
    whaleSell: "🐋 מימוש לוויתן",
    sharkSell: "🦈 מימוש כריש",
    proSell: "😎 מימוש מקצוען",
    now: "עכשיו",
    minutesAgo: " דק׳",
    hoursAgo: " ש׳",
    even: "שוויון",
    unableToLoadProfile: "לא ניתן לטעון את הפרופיל",
    unableToSaveProfile: "לא ניתן לשמור את הפרופיל",
    unableToUpdateSellAlerts: "לא ניתן לעדכן התראות מכירה",
  },
} as const;

function App() {
  const [currentPath, setCurrentPath] = useState<PageRoute>(() => getPageRoute(window.location.pathname));
  const [language, setLanguage] = useState<Language>(() => {
    const saved = window.localStorage.getItem("language");
    return saved === "he" ? "he" : "en";
  });
  const [snapshot, setSnapshot] = useState<Snapshot>({
    status: {
      marketCount: 0,
      websocketConnected: false,
      websocketShardCount: 0,
      websocketConnectedShardCount: 0,
      lastMarketSyncAt: null,
      lastTradeAt: null,
      websocketSubscribedAssetCount: 0,
      websocketAssetsSeenCount: 0,
      websocketAssetsSeenRecentlyCount: 0,
      lastWebsocketMessageAt: null,
    },
  });
  const [feedConnected, setFeedConnected] = useState(false);
  const [marketSort, setMarketSort] = useState<MarketSortOption>("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [pageCount, setPageCount] = useState(1);
  const [marketPage, setMarketPage] = useState<MarketPageResponse>({
    items: [],
    total: 0,
    page: 1,
    pageSize: MARKET_PAGE_SIZE,
    hasMore: false,
  });
  const [isLoadingMarkets, setIsLoadingMarkets] = useState(false);
  const [alertActionMarketSlug, setAlertActionMarketSlug] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [profileFormWebhookUrl, setProfileFormWebhookUrl] = useState("");
  const [profileFormMonitoredWallet, setProfileFormMonitoredWallet] = useState("");
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [removingWatchKey, setRemovingWatchKey] = useState<string | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const deferredSearchQuery = useDeferredValue(debouncedSearchQuery);
  const deferredRefreshVersion = useDeferredValue(refreshVersion);
  const t = copy[language];

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "he" ? "rtl" : "ltr";
    window.localStorage.setItem("language", language);
  }, [language]);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(getPageRoute(window.location.pathname));
      setIsMenuOpen(false);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 1_500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | undefined;
    let socket: WebSocket | null = null;

    const loadSnapshot = async () => {
      const response = await fetch("/api/snapshot");
      const payload = (await response.json()) as Snapshot;
      if (!closed) {
        setSnapshot(payload);
      }
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) {
        return;
      }

      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connectSocket();
      }, 2_000);
    };

    const connectSocket = () => {
      if (closed) {
        return;
      }

      setFeedConnected(false);
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.addEventListener("open", () => {
        if (!closed) {
          setFeedConnected(true);
        }
      });

      socket.addEventListener("close", () => {
        if (!closed) {
          setFeedConnected(false);
          scheduleReconnect();
        }
      });

      socket.addEventListener("error", () => {
        if (!closed) {
          setFeedConnected(false);
        }
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as {
          type: "snapshot" | "signal";
          payload: Snapshot | WhaleSignal;
        };

        if (message.type === "snapshot") {
          setSnapshot(message.payload as Snapshot);
          return;
        }

        setRefreshVersion((current) => current + 1);
      });
    };

    void loadSnapshot();
    connectSocket();

    return () => {
      closed = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, []);

  useEffect(() => {
    setPageCount(1);
  }, [marketSort, deferredSearchQuery]);

  useEffect(() => {
    if (currentPath === "/best-trades" && marketSort === "recent") {
      setMarketSort("weighted");
    }
  }, [currentPath, marketSort]);

  useEffect(() => {
    if (currentPath === "/profile") {
      return;
    }

    let cancelled = false;

    const loadMarketPages = async () => {
      setIsLoadingMarkets(true);

      try {
        const responses = await Promise.all(
          Array.from({ length: pageCount }, async (_value, index) => {
            const page = index + 1;
            const url = new URL("/api/markets", window.location.origin);
            url.searchParams.set("sort", marketSort);
            url.searchParams.set("search", deferredSearchQuery);
            url.searchParams.set("page", String(page));
            url.searchParams.set("pageSize", String(MARKET_PAGE_SIZE));
            const response = await fetch(url);
            return (await response.json()) as MarketPageResponse;
          }),
        );

        if (cancelled) {
          return;
        }

        const lastResponse = responses[responses.length - 1] ?? {
          items: [],
          total: 0,
          page: 1,
          pageSize: MARKET_PAGE_SIZE,
          hasMore: false,
        };

        setMarketPage({
          items: responses.flatMap((response) => response.items),
          total: lastResponse.total,
          page: lastResponse.page,
          pageSize: lastResponse.pageSize,
          hasMore: lastResponse.hasMore,
        });
      } finally {
        if (!cancelled) {
          setIsLoadingMarkets(false);
        }
      }
    };

    void loadMarketPages();

    return () => {
      cancelled = true;
    };
  }, [currentPath, marketSort, deferredSearchQuery, pageCount, deferredRefreshVersion]);

  useEffect(() => {
    if (currentPath !== "/profile") {
      return;
    }

    let cancelled = false;

    const loadProfile = async () => {
      const response = await fetch("/api/profile");
      const payload = (await response.json()) as UserProfileResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || t.unableToLoadProfile);
      }

      if (!cancelled) {
        setProfile(payload);
        setProfileFormWebhookUrl(payload.webhookUrl);
        setProfileFormMonitoredWallet(payload.monitoredWallet);
      }
    };

    void loadProfile().catch((error) => {
      if (!cancelled) {
        setProfileMessage(error instanceof Error ? error.message : t.unableToLoadProfile);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [currentPath, t.unableToLoadProfile]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !marketPage.hasMore || isLoadingMarkets) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) {
          return;
        }

        setPageCount((current) => current + 1);
      },
      {
        rootMargin: "240px 0px",
      },
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [isLoadingMarkets, marketPage.hasMore]);

  const visibleMarkets = useMemo(() => marketPage.items, [marketPage.items]);

  const navigateTo = (path: PageRoute) => {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setCurrentPath(path);
    setIsMenuOpen(false);
    setProfileMessage(null);
  };

  const toggleSellAlerts = async (market: MarketAggregate) => {
    setAlertActionMarketSlug(market.marketSlug);
    const watchedOutcome = market.outcomeWeights[0]?.outcome ?? market.latestSignal.outcome;

    try {
      if (market.isWatched) {
        const url = new URL(`/api/market-alerts/watch/${encodeURIComponent(market.marketSlug)}`, window.location.origin);
        url.searchParams.set("outcome", watchedOutcome);
        const response = await fetch(url, {
          method: "DELETE",
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || t.unableToUpdateSellAlerts);
        }
      } else {
        const response = await fetch("/api/market-alerts/watch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            marketSlug: market.marketSlug,
            outcome: watchedOutcome,
          }),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || t.unableToUpdateSellAlerts);
        }
      }

      setRefreshVersion((current) => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.unableToUpdateSellAlerts;
      if (message.includes("Discord webhook URL")) {
        setProfileMessage(message);
        navigateTo("/profile");
      } else {
        window.alert(message);
      }
    } finally {
      setAlertActionMarketSlug(null);
    }
  };

  const saveProfile = async () => {
    setIsSavingProfile(true);
    setProfileMessage(null);

    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhookUrl: profileFormWebhookUrl,
          monitoredWallet: profileFormMonitoredWallet,
        }),
      });
      const payload = (await response.json()) as UserProfileResponse & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || t.unableToSaveProfile);
      }

      setProfile(payload);
      setProfileFormWebhookUrl(payload.webhookUrl);
      setProfileFormMonitoredWallet(payload.monitoredWallet);
      setProfileMessage(t.discordWebhookSaved);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : t.unableToSaveProfile);
    } finally {
      setIsSavingProfile(false);
    }
  };

  const removeWatch = async (marketSlug: string, outcome: string) => {
    const watchKey = `${marketSlug}:${outcome}`;
    setRemovingWatchKey(watchKey);
    setProfileMessage(null);

    try {
      const url = new URL(`/api/market-alerts/watch/${encodeURIComponent(marketSlug)}`, window.location.origin);
      url.searchParams.set("outcome", outcome);
      const response = await fetch(url, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || t.unableToUpdateSellAlerts);
      }

      setProfile((current) =>
        current
          ? {
              ...current,
              watches: current.watches.filter(
                (watch) => !(watch.marketSlug === marketSlug && watch.outcome === outcome),
              ),
            }
          : current,
      );
      setRefreshVersion((current) => current + 1);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : t.unableToUpdateSellAlerts);
    } finally {
      setRemovingWatchKey(null);
    }
  };

  const profileTitle = profile?.username
    ? language === "he"
      ? `${t.profileTitle} ${profile.username}`
      : `${profile.username}${t.profileSuffix}`
    : t.profileTitle;
  const isBestTradesPage = currentPath === "/best-trades";
  const feedTitle = isBestTradesPage ? t.bestTradesTitle : t.vegasMonitor;
  const feedKicker = isBestTradesPage ? t.bestTrades : t.signalFeed;
  const feedSubtitle = isBestTradesPage ? t.bestTradesSubtitle : null;

  return (
    <div className={`app-shell app-shell-${language}`}>
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <main className="page">
        <div className="page-topbar">
          <div className="page-topbar-left">
            <button
              type="button"
              className="menu-button"
              aria-label={t.menu}
              aria-expanded={isMenuOpen}
              onClick={() => setIsMenuOpen((current) => !current)}
            >
              <span />
              <span />
              <span />
            </button>
            <div className="page-brand" aria-label="Whale shark pro">
            🐋 &gt; 🦈 &gt; 😎
            </div>
          </div>
          <div className="page-topbar-actions">
            <button
              type="button"
              className="nav-button"
              onClick={() => setLanguage((current) => (current === "en" ? "he" : "en"))}
            >
              {language === "en" ? "עברית" : "English"}
            </button>
            <button type="button" className="nav-button" onClick={() => navigateTo("/profile")}>
              {t.profile}
            </button>
          </div>
        </div>

        <div
          className={`menu-backdrop ${isMenuOpen ? "menu-backdrop-open" : ""}`}
          onClick={() => setIsMenuOpen(false)}
        />
        <aside className={`side-menu ${isMenuOpen ? "side-menu-open" : ""}`} aria-hidden={!isMenuOpen}>
          <div className="side-menu-header">
            <div className="page-brand" aria-label="Whale shark pro">
              ðŸ‹ &gt; ðŸ¦ˆ &gt; ðŸ˜Ž
            </div>
            <button type="button" className="nav-button" onClick={() => setIsMenuOpen(false)}>
              {t.closeMenu}
            </button>
          </div>
          <nav className="side-menu-nav">
            <button
              type="button"
              className={`side-menu-link ${currentPath === "/" ? "side-menu-link-active" : ""}`}
              onClick={() => navigateTo("/")}
            >
              {t.monitor}
            </button>
            <button
              type="button"
              className={`side-menu-link ${currentPath === "/best-trades" ? "side-menu-link-active" : ""}`}
              onClick={() => navigateTo("/best-trades")}
            >
              {t.bestTrades}
            </button>
            <button
              type="button"
              className={`side-menu-link ${currentPath === "/profile" ? "side-menu-link-active" : ""}`}
              onClick={() => navigateTo("/profile")}
            >
              {t.profile}
            </button>
          </nav>
        </aside>

        <section className="hero">
          <div className="hero-panel">
            <StatusRow
              label={t.frontendStream}
              value={feedConnected ? t.connected : t.reconnecting}
              tone={feedConnected ? "green" : "blue"}
            />
            <StatusRow
              label={t.polymarketSocket}
              value={
                snapshot.status.websocketConnected
                  ? `${snapshot.status.websocketConnectedShardCount}/${snapshot.status.websocketShardCount} ${t.shards}`
                  : t.syncing
              }
              tone={snapshot.status.websocketConnected ? "green" : "blue"}
            />
            <StatusRow
              label={t.signalsSurfaced}
              value={marketPage.total.toString()}
              tone="neutral"
            />
            <StatusRow
              label={t.wsCoverage}
              value={`${snapshot.status.websocketAssetsSeenRecentlyCount}/${snapshot.status.websocketSubscribedAssetCount} ${t.active}`}
              tone="neutral"
            />
            <StatusRow
              label={t.lastMarketSync}
              value={formatTimestamp(snapshot.status.lastMarketSyncAt, t.pending)}
              tone="neutral"
            />
            <StatusRow
              label={t.lastTradeSeen}
              value={formatTimestamp(snapshot.status.lastTradeAt, t.pending)}
              tone="neutral"
            />
          </div>
        </section>

        {currentPath === "/profile" ? (
          <section className="profile-section">
            <div className="feed-header">
              <div>
                <p className="section-kicker">{t.settings}</p>
                <h2>{t.profile}</h2>
              </div>
              <div className="feed-controls">
                <button type="button" className="nav-button" onClick={() => navigateTo("/")}>
                  {t.backToMonitor}
                </button>
              </div>
            </div>

            <div className="profile-panel">
              <div className="profile-copy">
                <p className="section-kicker">{t.discordAlerts}</p>
                <h3>{profileTitle}</h3>
                <p>{t.profileBody}</p>
              </div>

              <label className="profile-field">
                <span>{t.discordWebhookUrl}</span>
                <input
                  type="url"
                  value={profileFormWebhookUrl}
                  onChange={(event) => setProfileFormWebhookUrl(event.target.value)}
                  placeholder="https://discord.com/api/webhooks/..."
                />
              </label>

              <label className="profile-field">
                <span>{t.monitoredWallet}</span>
                <input
                  type="text"
                  value={profileFormMonitoredWallet}
                  onChange={(event) => setProfileFormMonitoredWallet(event.target.value)}
                  placeholder="0x..."
                />
              </label>

              {profileMessage ? <p className="profile-message">{profileMessage}</p> : null}

              <div className="profile-actions">
                <button
                  type="button"
                  className="watch-button watch-button-active"
                  onClick={() => void saveProfile()}
                  disabled={isSavingProfile}
                >
                  {isSavingProfile ? t.saving : t.saveWebhook}
                </button>
              </div>

              <div className="profile-watches">
                <div className="profile-watches-header">
                  <p className="section-kicker">{t.activeWatches}</p>
                </div>
                {profile?.watches?.length ? (
                  <div className="profile-watch-list">
                    {profile.watches.map((watch) => (
                      <article className="profile-watch-item" key={`${watch.marketSlug}:${watch.outcome}`}>
                        <div className="profile-watch-copy">
                          <strong>{watch.marketQuestion}</strong>
                          <span>
                            {t.watchedOutcome}: {watch.outcome}
                          </span>
                          <span>
                            {watch.source === "portfolio_sync"
                              ? t.watchSourcePortfolioSync
                              : t.watchSourceManual}
                          </span>
                        </div>
                        <div className="profile-watch-actions">
                          <a href={normalizeSecureUrl(watch.marketUrl) ?? watch.marketUrl} target="_blank" rel="noreferrer">
                            {t.openWatchedMarket}
                          </a>
                          <button
                            type="button"
                            className="profile-watch-remove"
                            onClick={() => void removeWatch(watch.marketSlug, watch.outcome)}
                            disabled={removingWatchKey === `${watch.marketSlug}:${watch.outcome}`}
                          >
                            {removingWatchKey === `${watch.marketSlug}:${watch.outcome}`
                              ? t.removing
                              : t.removeWatch}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="profile-empty">{t.noActiveWatches}</p>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="feed-section">
            <div className="feed-header">
              <div>
                <p className="section-kicker">{feedKicker}</p>
                <h2>{feedTitle}</h2>
                {feedSubtitle ? <p className="feed-subtitle">{feedSubtitle}</p> : null}
              </div>
              <label className="search-control">
                <span>{t.search}</span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t.searchPlaceholder}
                />
              </label>
              <div className="feed-controls">
                <label className="sort-control">
                  <span>{t.sort}</span>
                  <select value={marketSort} onChange={(event) => setMarketSort(event.target.value as MarketSortOption)}>
                    <option value="recent">{t.sortRecent}</option>
                    <option value="weighted">{t.sortWeighted}</option>
                    <option value="buyWeight">{t.sortBuyWeight}</option>
                    <option value="flow">{t.sortFlow}</option>
                    <option value="participants">{t.sortParticipants}</option>
                  </select>
                </label>
              </div>
            </div>

            {visibleMarkets.length === 0 && !isLoadingMarkets ? (
              <div className="empty-state">
                <div className="empty-pulse" />
                <h3>{t.watchingTape}</h3>
                <p>{t.emptyState}</p>
              </div>
            ) : (
              <>
                <div className="signal-grid">
                  {visibleMarkets.map((market) => {
                    const signal = market.latestSignal;
                    const primaryOutcome = market.outcomeWeights[0];
                    const secondaryOutcome =
                      market.outcomeWeights[1] ??
                      inferMissingOutcome(primaryOutcome?.outcome, market.outcomeWeights);
                    const visibleOutcomeWeights = [primaryOutcome, secondaryOutcome].filter(Boolean) as Array<{
                      outcome: string;
                      weight: number;
                    }>;
                    const edgeLabel = formatOutcomeEdge(visibleOutcomeWeights, t.even);
                    const confidenceScore = getSignalConfidence(signal);
                    const signalRationale = getSignalRationale(signal, t);

                    return (
                      <article className="signal-card" key={market.marketSlug}>
                        <div className="signal-media">
                          {normalizeSecureUrl(market.marketImage) ? (
                            <img src={normalizeSecureUrl(market.marketImage)!} alt={market.marketQuestion} />
                          ) : (
                            <div className="image-fallback">{signal.outcome[0]}</div>
                          )}
                          <div className={`pill pill-${signal.labelTone}`}>{getSignalLabel(signal, t)}</div>
                        </div>

                        <div className="signal-body">
                          <div className="signal-topline">
                            <span>{formatRelativeTime(market.latestTimestamp, t)}</span>
                            <span>{market.participantCount} {t.traders}</span>
                          </div>

                          <h3>{market.marketQuestion}</h3>
                          <p className="signal-thesis">
                            <strong>{signal.displayName}</strong>
                            <span className="signal-thesis-trade">
                              <span>{t.edge}</span>
                              <span className={`outcome-chip outcome-chip-${getOutcomeTone(edgeLabel)}`}>
                                {edgeLabel}
                              </span>
                            </span>
                          </p>

                          <p className="signal-rationale">
                            <span>{t.whySignal}</span>
                            <strong>{signalRationale}</strong>
                          </p>

                          <div className="metric-row">
                            <Metric label={t.marketFlow} value={currencyFormatter.format(market.totalUsd)} />
                            <Metric label={t.lastPrice} value={signal.averagePrice.toFixed(3)} />
                            <Metric label={t.confidence} value={`${confidenceScore}/100`} />
                          </div>

                          <div className="metric-row">
                            <Metric
                              label={primaryOutcome?.outcome ?? t.outcome1}
                              value={(primaryOutcome?.weight ?? 0).toString()}
                            />
                            <Metric
                              label={secondaryOutcome?.outcome ?? t.outcome2}
                              value={(secondaryOutcome?.weight ?? 0).toString()}
                            />
                            <Metric
                              label={t.avgEntry}
                              value={market.observedAvgEntry !== null ? market.observedAvgEntry.toFixed(3) : "—"}
                            />
                          </div>

                          <div className="signal-actions">
                            <a href={normalizeSecureUrl(market.marketUrl) ?? market.marketUrl} target="_blank" rel="noreferrer">
                              {t.openMarket}
                            </a>
                            <a href={normalizeSecureUrl(signal.profileUrl) ?? signal.profileUrl} target="_blank" rel="noreferrer">
                              {t.openWhaleProfile}
                            </a>
                            <button
                              type="button"
                              className={`watch-button ${market.isWatched ? "watch-button-active" : ""}`}
                              onClick={() => void toggleSellAlerts(market)}
                              disabled={alertActionMarketSlug === market.marketSlug}
                            >
                              {alertActionMarketSlug === market.marketSlug
                                ? t.saving
                                : market.isWatched
                                  ? t.sellAlertsOn
                                  : t.getSellAlerts}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
                {marketPage.hasMore || isLoadingMarkets ? (
                  <div className="load-more-sentinel" ref={loadMoreRef}>
                    {isLoadingMarkets ? t.loadingMarkets : t.scrollForMore}
                  </div>
                ) : null}
              </>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function StatusRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "green" | "blue" | "neutral";
}) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <span className={`status-value status-${tone}`}>{value}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatTimestamp(value: number | null, pendingLabel: string) {
  if (!value) {
    return pendingLabel;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatRelativeTime(timestamp: number, t: (typeof copy)["en"]) {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) {
    return t.now;
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}${t.minutesAgo}`;
  }

  return `${Math.floor(diffMinutes / 60)}${t.hoursAgo}`;
}

function formatOutcomeEdge(outcomeWeights: Array<{ outcome: string; weight: number }>, evenLabel: string) {
  const first = outcomeWeights[0];
  const second = outcomeWeights[1];

  if (!first) {
    return evenLabel;
  }

  if (!second) {
    return `${first.outcome} +${first.weight}`;
  }

  if (first.weight === second.weight) {
    return evenLabel;
  }

  return `${first.outcome} +${first.weight - second.weight}`;
}

function normalizeSecureUrl(value?: string) {
  if (!value) {
    return undefined;
  }

  if (value.startsWith("http://")) {
    return `https://${value.slice("http://".length)}`;
  }

  return value;
}

function getOutcomeTone(outcome: string) {
  const normalized = outcome.trim().toLowerCase();

  if (positiveOutcomeKeywords.some((keyword) => normalized === keyword || normalized.includes(keyword))) {
    return "positive";
  }

  if (negativeOutcomeKeywords.some((keyword) => normalized === keyword || normalized.includes(keyword))) {
    return "negative";
  }

  return "neutral";
}

function getSignalConfidence(signal: WhaleSignal) {
  const tierBonus =
    signal.trader.tier === "whale"
      ? 28
      : signal.trader.tier === "shark"
        ? 18
        : signal.trader.tier === "pro"
          ? 10
          : 0;
  const pnlBonus = Math.min(18, Math.max(0, signal.trader.totalPnl / 10_000));
  const tradeCountBonus = Math.min(14, signal.trader.tradeCount / 12);
  const sizeBonus = Math.min(16, signal.totalUsd / 2_500);
  const fillBonus = Math.min(6, signal.fillCount);

  return Math.max(
    50,
    Math.min(99, Math.round(30 + tierBonus + pnlBonus + tradeCountBonus + sizeBonus + fillBonus)),
  );
}

function getTierLabel(tier: TraderSummary["tier"], t: (typeof copy)["en"]) {
  if (tier === "whale") {
    return t.tierWhale;
  }

  if (tier === "shark") {
    return t.tierShark;
  }

  if (tier === "pro") {
    return t.tierPro;
  }

  return t.tierNone;
}

function getSignalRationale(signal: WhaleSignal, t: (typeof copy)["en"]) {
  return [
    getTierLabel(signal.trader.tier, t),
    currencyFormatter.format(signal.trader.totalPnl),
    `${signal.trader.tradeCount} trades`,
    `${currencyFormatter.format(signal.totalUsd)} ${t.rationaleCluster}`,
  ].join(", ");
}

function getSignalLabel(signal: WhaleSignal, t: (typeof copy)["en"]) {
  if (signal.trader.tier === "whale") {
    return signal.side === "BUY" ? t.whaleBuy : t.whaleSell;
  }

  if (signal.trader.tier === "shark") {
    return signal.side === "BUY" ? t.sharkBuy : t.sharkSell;
  }

  if (signal.trader.tier === "pro") {
    return signal.side === "BUY" ? t.proBuy : t.proSell;
  }

  return signal.label;
}

function inferMissingOutcome(
  primaryOutcome: string | undefined,
  currentOutcomes: Array<{ outcome: string; weight: number }>,
) {
  if (!primaryOutcome) {
    return undefined;
  }

  const normalized = primaryOutcome.trim().toLowerCase();
  const opposite = outcomeOpposites[normalized];
  if (!opposite) {
    return undefined;
  }

  const alreadyExists = currentOutcomes.some((entry) => entry.outcome.trim().toLowerCase() === opposite.toLowerCase());
  if (alreadyExists) {
    return undefined;
  }

  return { outcome: opposite, weight: 0 };
}

export default App;
