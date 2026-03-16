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

function App() {
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
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const deferredSearchQuery = useDeferredValue(debouncedSearchQuery);
  const deferredRefreshVersion = useDeferredValue(refreshVersion);

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
  }, [marketSort, deferredSearchQuery, pageCount, deferredRefreshVersion]);

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

  const toggleSellAlerts = async (market: MarketAggregate) => {
    setAlertActionMarketSlug(market.marketSlug);

    try {
      if (market.isWatched) {
        const response = await fetch(`/api/market-alerts/watch/${encodeURIComponent(market.marketSlug)}`, {
          method: "DELETE",
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Unable to disable sell alerts");
        }
      } else {
        const webhookUrl = window.prompt(
          "Enter your Discord webhook URL for sell alerts. If you've already saved one, you can leave this blank.",
          "",
        );

        if (webhookUrl === null) {
          return;
        }

        const response = await fetch("/api/market-alerts/watch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            marketSlug: market.marketSlug,
            webhookUrl: webhookUrl.trim() || undefined,
          }),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "Unable to enable sell alerts");
        }
      }

      setRefreshVersion((current) => current + 1);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unable to update sell alerts");
    } finally {
      setAlertActionMarketSlug(null);
    }
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <main className="page">
        <section className="hero">
          <div className="hero-panel">
            <StatusRow
              label="Frontend stream"
              value={feedConnected ? "Connected" : "Reconnecting"}
              tone={feedConnected ? "green" : "blue"}
            />
            <StatusRow
              label="Polymarket socket"
              value={
                snapshot.status.websocketConnected
                  ? `${snapshot.status.websocketConnectedShardCount}/${snapshot.status.websocketShardCount} shards`
                  : "Syncing"
              }
              tone={snapshot.status.websocketConnected ? "green" : "blue"}
            />
            <StatusRow
              label="Active assets"
              value={snapshot.status.marketCount.toLocaleString()}
              tone="neutral"
            />
            <StatusRow
              label="Signals surfaced"
              value={marketPage.total.toString()}
              tone="neutral"
            />
            <StatusRow
              label="WS coverage"
              value={`${snapshot.status.websocketAssetsSeenRecentlyCount}/${snapshot.status.websocketSubscribedAssetCount} active`}
              tone="neutral"
            />
            <StatusRow
              label="Last market sync"
              value={formatTimestamp(snapshot.status.lastMarketSyncAt)}
              tone="neutral"
            />
            <StatusRow
              label="Last trade seen"
              value={formatTimestamp(snapshot.status.lastTradeAt)}
              tone="neutral"
            />
          </div>
        </section>

        <section className="feed-section">
          <div className="feed-header">
            <div>
              <p className="section-kicker">Signal feed</p>
              <h2>Vegas Monitor</h2>
            </div>
            <label className="search-control">
              <span>Search</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Markets, outcomes, traders"
              />
            </label>
            <div className="feed-controls">
              <label className="sort-control">
                <span>Sort</span>
                <select value={marketSort} onChange={(event) => setMarketSort(event.target.value as MarketSortOption)}>
                  <option value="recent">Most recent</option>
                  <option value="weighted">Highest weight</option>
                  <option value="buyWeight">Top outcome weight</option>
                  <option value="flow">Largest flow</option>
                  <option value="participants">Most traders</option>
                </select>
              </label>
            </div>
          </div>

          {visibleMarkets.length === 0 && !isLoadingMarkets ? (
            <div className="empty-state">
              <div className="empty-pulse" />
              <h3>Watching the tape</h3>
              <p>
                Once a wallet crosses the whale threshold, it will appear here with the market,
                chosen side, and trader profitability label.
              </p>
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
                  const edgeLabel = formatOutcomeEdge(visibleOutcomeWeights);

                  return (
                    <article className="signal-card" key={market.marketSlug}>
                      <div className="signal-media">
                        {normalizeSecureUrl(market.marketImage) ? (
                          <img src={normalizeSecureUrl(market.marketImage)!} alt={market.marketQuestion} />
                        ) : (
                          <div className="image-fallback">{signal.outcome[0]}</div>
                        )}
                        <div className={`pill pill-${signal.labelTone}`}>{signal.label}</div>
                      </div>

                      <div className="signal-body">
                        <div className="signal-topline">
                          <span>{formatRelativeTime(market.latestTimestamp)}</span>
                          <span>{market.participantCount} traders</span>
                        </div>

                        <h3>{market.marketQuestion}</h3>
                        <p className="signal-thesis">
                          <strong>{signal.displayName}</strong>
                          <span className="signal-thesis-trade">
                            <span>edge</span>
                            <span className={`outcome-chip outcome-chip-${getOutcomeTone(edgeLabel)}`}>
                              {edgeLabel}
                            </span>
                          </span>
                        </p>

                        <div className="metric-row">
                          <Metric label="Market flow" value={currencyFormatter.format(market.totalUsd)} />
                          <Metric label="Last price" value={signal.averagePrice.toFixed(3)} />
                          <Metric label="Weighted" value={market.weightedScore.toString()} />
                        </div>

                        <div className="metric-row">
                          <Metric
                            label={primaryOutcome?.outcome ?? "Outcome 1"}
                            value={(primaryOutcome?.weight ?? 0).toString()}
                          />
                          <Metric
                            label={secondaryOutcome?.outcome ?? "Outcome 2"}
                            value={(secondaryOutcome?.weight ?? 0).toString()}
                          />
                          <Metric
                            label="Avg entry"
                            value={market.observedAvgEntry !== null ? market.observedAvgEntry.toFixed(3) : "—"}
                          />
                        </div>

                        <div className="signal-actions">
                          <a href={normalizeSecureUrl(market.marketUrl) ?? market.marketUrl} target="_blank" rel="noreferrer">
                            Open market
                          </a>
                          <a href={normalizeSecureUrl(signal.profileUrl) ?? signal.profileUrl} target="_blank" rel="noreferrer">
                            Open whale profile
                          </a>
                          <button
                            type="button"
                            className={`watch-button ${market.isWatched ? "watch-button-active" : ""}`}
                            onClick={() => void toggleSellAlerts(market)}
                            disabled={alertActionMarketSlug === market.marketSlug}
                          >
                            {alertActionMarketSlug === market.marketSlug
                              ? "Saving..."
                              : market.isWatched
                                ? "Sell alerts on"
                                : "Get sell alerts"}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              {marketPage.hasMore || isLoadingMarkets ? (
                <div className="load-more-sentinel" ref={loadMoreRef}>
                  {isLoadingMarkets ? "Loading markets..." : "Scroll for more"}
                </div>
              ) : null}
            </>
          )}
        </section>
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

function formatTimestamp(value: number | null) {
  if (!value) {
    return "Pending";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatRelativeTime(timestamp: number) {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) {
    return "now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  return `${Math.floor(diffMinutes / 60)}h ago`;
}

function formatOutcomeEdge(outcomeWeights: Array<{ outcome: string; weight: number }>) {
  const first = outcomeWeights[0];
  const second = outcomeWeights[1];

  if (!first) {
    return "Even";
  }

  if (!second) {
    return `${first.outcome} +${first.weight}`;
  }

  if (first.weight === second.weight) {
    return "Even";
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
