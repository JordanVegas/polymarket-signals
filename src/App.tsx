import { useEffect, useMemo, useRef, useState } from "react";

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
  signals: WhaleSignal[];
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
  participantCount: number;
  latestSignal: WhaleSignal;
};

type MarketSortOption = "recent" | "weighted" | "buyWeight" | "flow" | "participants";

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

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
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
    signals: [],
  });
  const [feedConnected, setFeedConnected] = useState(false);
  const [marketSort, setMarketSort] = useState<MarketSortOption>("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleMarketCount, setVisibleMarketCount] = useState(MARKET_PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

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

        setSnapshot((current) => ({
          ...current,
          signals: upsertSignal(current.signals, message.payload as WhaleSignal),
        }));
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

  const visibleSignals = useMemo(
    () => snapshot.signals.filter((signal) => signal.side === "BUY"),
    [snapshot.signals],
  );
  const filteredMarketAggregates = useMemo(
    () => filterMarkets(sortMarkets(aggregateMarkets(visibleSignals), marketSort), searchQuery),
    [visibleSignals, marketSort, searchQuery],
  );
  const visibleMarkets = useMemo(
    () => filteredMarketAggregates.slice(0, visibleMarketCount),
    [filteredMarketAggregates, visibleMarketCount],
  );

  useEffect(() => {
    setVisibleMarketCount(MARKET_PAGE_SIZE);
  }, [marketSort, snapshot.signals, searchQuery]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || visibleMarketCount >= filteredMarketAggregates.length) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) {
          return;
        }

        setVisibleMarketCount((current) =>
          Math.min(current + MARKET_PAGE_SIZE, filteredMarketAggregates.length),
        );
      },
      {
        rootMargin: "240px 0px",
      },
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [filteredMarketAggregates.length, visibleMarketCount]);

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
              value={filteredMarketAggregates.length.toString()}
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
              <h2>Whale alerts</h2>
            </div>
            <div className="feed-controls">
              <label className="search-control">
                <span>Search</span>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Markets, outcomes, traders"
                />
              </label>
              <p className="feed-meta">Triggered by whale, shark, and pro tiers with a $1,000 minimum cluster</p>
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

          {filteredMarketAggregates.length === 0 ? (
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
                        <Metric
                          label="Last price"
                          value={signal.averagePrice.toFixed(3)}
                        />
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
                        <Metric label="W/S/P" value={`${market.whales}/${market.sharks}/${market.pros}`} />
                      </div>

                      <div className="signal-actions">
                        <a href={normalizeSecureUrl(market.marketUrl) ?? market.marketUrl} target="_blank" rel="noreferrer">
                          Open market
                        </a>
                        <a href={normalizeSecureUrl(signal.profileUrl) ?? signal.profileUrl} target="_blank" rel="noreferrer">
                          Open whale profile
                        </a>
                      </div>
                    </div>
                  </article>
                );
                })}
              </div>
              {visibleMarketCount < filteredMarketAggregates.length ? (
                <div className="load-more-sentinel" ref={loadMoreRef}>
                  Loading more markets...
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

function upsertSignal(signals: WhaleSignal[], nextSignal: WhaleSignal) {
  const remaining = signals.filter((signal) => signal.id !== nextSignal.id);
  return [nextSignal, ...remaining];
}

function aggregateMarkets(signals: WhaleSignal[]): MarketAggregate[] {
  const markets = new Map<string, MarketAggregate>();
  const traderSpendByMarket = new Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>();
  const traderOutcomeSpendByMarket = new Map<
    string,
    Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>
  >();

  for (const signal of signals) {
    const existing = markets.get(signal.marketSlug);
    if (!existing) {
      markets.set(signal.marketSlug, {
        marketSlug: signal.marketSlug,
        marketQuestion: signal.marketQuestion,
        marketUrl: signal.marketUrl,
        marketImage: signal.marketImage,
        latestTimestamp: signal.timestamp,
        totalUsd: signal.totalUsd,
        totalFillCount: signal.fillCount,
        whales: 0,
        sharks: 0,
        pros: 0,
        weightedScore: 0,
        outcomeWeights: [],
        participantCount: 0,
        latestSignal: signal,
      });
    } else {
      existing.totalUsd += signal.totalUsd;
      existing.totalFillCount += signal.fillCount;
      if (signal.timestamp > existing.latestTimestamp) {
        existing.latestTimestamp = signal.timestamp;
        existing.latestSignal = signal;
      }
    }

    const marketTraders =
      traderSpendByMarket.get(signal.marketSlug) ?? new Map<string, { totalUsd: number; trader: TraderSummary }>();
    const traderEntry = marketTraders.get(signal.wallet);
    if (traderEntry) {
      traderEntry.totalUsd += signal.totalUsd;
      if (signal.trader.weight > traderEntry.trader.weight) {
        traderEntry.trader = signal.trader;
      }
    } else {
      marketTraders.set(signal.wallet, { totalUsd: signal.totalUsd, trader: signal.trader });
    }
    traderSpendByMarket.set(signal.marketSlug, marketTraders);

    const marketOutcomeTraders =
      traderOutcomeSpendByMarket.get(signal.marketSlug) ??
      new Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>();
    const traderOutcomes =
      marketOutcomeTraders.get(signal.wallet) ??
      new Map<string, { totalUsd: number; trader: TraderSummary }>();
    const outcomeEntry = traderOutcomes.get(signal.outcome);
    if (outcomeEntry) {
      outcomeEntry.totalUsd += signal.totalUsd;
      if (signal.trader.weight > outcomeEntry.trader.weight) {
        outcomeEntry.trader = signal.trader;
      }
    } else {
      traderOutcomes.set(signal.outcome, { totalUsd: signal.totalUsd, trader: signal.trader });
    }
    marketOutcomeTraders.set(signal.wallet, traderOutcomes);
    traderOutcomeSpendByMarket.set(signal.marketSlug, marketOutcomeTraders);
  }

  for (const [marketSlug, aggregate] of markets) {
    const traders = traderSpendByMarket.get(marketSlug);
    const outcomeTraders = traderOutcomeSpendByMarket.get(marketSlug);
    if (!traders) {
      continue;
    }

    let whales = 0;
    let sharks = 0;
    let pros = 0;
    let weightedScore = 0;
    let participantCount = 0;
    const outcomeWeights = new Map<string, number>();

    for (const { totalUsd, trader } of traders.values()) {
      if (totalUsd < 1_000 || trader.tier === "none") {
        continue;
      }

      participantCount += 1;
      weightedScore += trader.weight;
      if (trader.tier === "whale") {
        whales += 1;
      } else if (trader.tier === "shark") {
        sharks += 1;
      } else if (trader.tier === "pro") {
        pros += 1;
      }
    }

    if (outcomeTraders) {
      for (const traderOutcomes of outcomeTraders.values()) {
        let leadingOutcome: string | null = null;
        let leadingUsd = 0;
        let leadingWeight = 0;

        for (const [outcome, { totalUsd, trader }] of traderOutcomes.entries()) {
          if (totalUsd < 1_000 || trader.tier === "none") {
            continue;
          }

          if (totalUsd > leadingUsd) {
            leadingOutcome = outcome;
            leadingUsd = totalUsd;
            leadingWeight = trader.weight;
          }
        }

        if (leadingOutcome) {
          outcomeWeights.set(leadingOutcome, (outcomeWeights.get(leadingOutcome) ?? 0) + leadingWeight);
        }
      }
    }

    aggregate.whales = whales;
    aggregate.sharks = sharks;
    aggregate.pros = pros;
    aggregate.weightedScore = weightedScore;
    aggregate.outcomeWeights = Array.from(outcomeWeights.entries())
      .map(([outcome, weight]) => ({ outcome, weight }))
      .sort((left, right) => right.weight - left.weight);
    aggregate.participantCount = participantCount;
  }

  return Array.from(markets.values()).sort((left, right) => right.latestTimestamp - left.latestTimestamp);
}

function sortMarkets(markets: MarketAggregate[], sort: MarketSortOption) {
  const sorted = [...markets];

  sorted.sort((left, right) => {
    if (sort === "weighted") {
      return (
        right.weightedScore - left.weightedScore ||
        (right.outcomeWeights[0]?.weight ?? 0) - (left.outcomeWeights[0]?.weight ?? 0) ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    if (sort === "buyWeight") {
      return (
        (right.outcomeWeights[0]?.weight ?? 0) - (left.outcomeWeights[0]?.weight ?? 0) ||
        right.weightedScore - left.weightedScore ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    if (sort === "flow") {
      return (
        right.totalUsd - left.totalUsd ||
        right.weightedScore - left.weightedScore ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    if (sort === "participants") {
      return (
        right.participantCount - left.participantCount ||
        right.weightedScore - left.weightedScore ||
        right.latestTimestamp - left.latestTimestamp
      );
    }

    return right.latestTimestamp - left.latestTimestamp;
  });

  return sorted;
}

function filterMarkets(markets: MarketAggregate[], query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return markets;
  }

  return markets.filter((market) => {
    const haystack = [
      market.marketQuestion,
      market.marketSlug,
      market.latestSignal.displayName,
      market.latestSignal.outcome,
      ...market.outcomeWeights.map((entry) => entry.outcome),
      ...market.outcomeStats.map((entry) => entry.outcome),
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
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

  const opposite = outcomeOpposites[primaryOutcome.trim().toLowerCase()];
  if (!opposite) {
    return undefined;
  }

  const existing = currentOutcomes.find(
    (entry) => entry.outcome.trim().toLowerCase() === opposite.toLowerCase(),
  );

  return existing ?? { outcome: opposite, weight: 0 };
}

export default App;
