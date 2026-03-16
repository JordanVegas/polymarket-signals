import { useEffect, useMemo, useState } from "react";

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
  labelTone: "green" | "blue" | "neutral";
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
    lastMarketSyncAt: number | null;
    lastTradeAt: number | null;
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
  buyWeight: number;
  sellWeight: number;
  participantCount: number;
  latestSignal: WhaleSignal;
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

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    status: {
      marketCount: 0,
      websocketConnected: false,
      lastMarketSyncAt: null,
      lastTradeAt: null,
    },
    signals: [],
  });
  const [feedConnected, setFeedConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    let refreshTimer: number | undefined;
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
          signals: upsertSignal(current.signals, message.payload as WhaleSignal).slice(0, 75),
        }));
      });
    };

    void loadSnapshot();
    refreshTimer = window.setInterval(() => {
      void loadSnapshot();
    }, 15_000);
    connectSocket();

    return () => {
      closed = true;
      if (refreshTimer) {
        window.clearInterval(refreshTimer);
      }
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, []);

  const headerSignal = snapshot.signals[0];
  const marketAggregates = useMemo(() => aggregateMarkets(snapshot.signals), [snapshot.signals]);
  const profitableCount = useMemo(
    () => snapshot.signals.filter((signal) => signal.trader.tier === "whale").length,
    [snapshot.signals],
  );

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <main className="page">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Realtime whale flow on Polymarket</p>
            <h1>Track oversized conviction trades the moment they hit.</h1>
            <p className="hero-text">
              Live active-market monitoring, trade clustering by wallet, and fast whale labeling
              powered by Polymarket websockets plus the public HTTP APIs.
            </p>
            <div className="hero-links">
              <a className="hero-link hero-link-primary" href="https://tuf.to" target="_blank" rel="noreferrer">
                Open TUF homepage
              </a>
            </div>
          </div>

          <div className="hero-panel">
            <StatusRow
              label="Frontend stream"
              value={feedConnected ? "Connected" : "Reconnecting"}
              tone={feedConnected ? "green" : "blue"}
            />
            <StatusRow
              label="Polymarket socket"
              value={snapshot.status.websocketConnected ? "Connected" : "Syncing"}
              tone={snapshot.status.websocketConnected ? "green" : "blue"}
            />
            <StatusRow
              label="Active assets"
              value={snapshot.status.marketCount.toLocaleString()}
              tone="neutral"
            />
            <StatusRow
              label="Signals surfaced"
              value={marketAggregates.length.toString()}
              tone="neutral"
            />
            <StatusRow
              label="Profitable whales"
              value={profitableCount.toString()}
              tone="green"
            />
          </div>
        </section>

        <section className="summary-strip">
          <SummaryCard
            className="summary-card-featured"
            label="Most recent alert"
            value={headerSignal ? headerSignal.displayName : "Waiting for whale flow"}
            detail={
              headerSignal
                ? `${headerSignal.outcome} ${headerSignal.side.toLowerCase()} in ${headerSignal.marketQuestion}`
                : "The feed will populate as large clustered trades appear."
            }
          />
          <SummaryCard
            label="Last market sync"
            value={formatTimestamp(snapshot.status.lastMarketSyncAt)}
            detail="Active markets are refreshed continuously so new listings join the stream."
          />
          <SummaryCard
            label="Last trade seen"
            value={formatTimestamp(snapshot.status.lastTradeAt)}
            detail="Signals are grouped by wallet, market outcome, and side within a rolling window."
          />
        </section>

        <section className="feed-section">
          <div className="feed-header">
            <div>
              <p className="section-kicker">Signal feed</p>
              <h2>Whale alerts</h2>
            </div>
            <p className="feed-meta">Triggered by whale, shark, and pro tiers with a $1,000 minimum cluster</p>
          </div>

          {marketAggregates.length === 0 ? (
            <div className="empty-state">
              <div className="empty-pulse" />
              <h3>Watching the tape</h3>
              <p>
                Once a wallet crosses the whale threshold, it will appear here with the market,
                chosen side, and trader profitability label.
              </p>
            </div>
          ) : (
            <div className="signal-grid">
              {marketAggregates.map((market) => {
                const signal = market.latestSignal;
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
                        <strong>{signal.displayName}</strong> last {signal.side.toLowerCase()}{" "}
                        <span className="outcome-chip">{signal.outcome}</span>
                      </p>

                      <div className="metric-row">
                        <Metric label="Market flow" value={currencyFormatter.format(market.totalUsd)} />
                        <Metric label="Signals" value={market.totalFillCount.toString()} />
                        <Metric label="Last price" value={signal.averagePrice.toFixed(3)} />
                      </div>

                      <div className="metric-row metric-row-tier-counts">
                        <Metric label="Whales" value={market.whales.toString()} />
                        <Metric label="Sharks" value={market.sharks.toString()} />
                        <Metric label="Pros" value={market.pros.toString()} />
                      </div>

                      <div className="metric-row">
                        <Metric label="Buy weight" value={market.buyWeight.toString()} />
                        <Metric label="Sell weight" value={market.sellWeight.toString()} />
                        <Metric label="Edge" value={formatWeightEdge(market.buyWeight, market.sellWeight)} />
                      </div>

                      <div className="metric-row">
                        <Metric label="Weighted" value={market.weightedScore.toString()} />
                        <Metric label="Last trader" value={signal.displayName} />
                        <Metric label="Last tier" value={`${signal.trader.tier.toUpperCase()} x${signal.trader.weight}`} />
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

function SummaryCard({
  className,
  label,
  value,
  detail,
}: {
  className?: string;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className={`summary-card ${className ?? ""}`.trim()}>
      <p>{label}</p>
      <h3>{value}</h3>
      <span>{detail}</span>
    </article>
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

function formatWeightEdge(buyWeight: number, sellWeight: number) {
  if (buyWeight === sellWeight) {
    return "Even";
  }

  if (buyWeight > sellWeight) {
    return `Buy +${buyWeight - sellWeight}`;
  }

  return `Sell +${sellWeight - buyWeight}`;
}

function upsertSignal(signals: WhaleSignal[], nextSignal: WhaleSignal) {
  const remaining = signals.filter((signal) => signal.id !== nextSignal.id);
  return [nextSignal, ...remaining];
}

function aggregateMarkets(signals: WhaleSignal[]): MarketAggregate[] {
  const markets = new Map<string, MarketAggregate>();
  const traderSpendByMarket = new Map<string, Map<string, { totalUsd: number; trader: TraderSummary }>>();
  const traderSideSpendByMarket = new Map<
    string,
    Map<string, { buyUsd: number; sellUsd: number; trader: TraderSummary }>
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
        buyWeight: 0,
        sellWeight: 0,
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

    const marketSideTraders =
      traderSideSpendByMarket.get(signal.marketSlug) ??
      new Map<string, { buyUsd: number; sellUsd: number; trader: TraderSummary }>();
    const sideTraderEntry = marketSideTraders.get(signal.wallet);
    if (sideTraderEntry) {
      if (signal.side === "BUY") {
        sideTraderEntry.buyUsd += signal.totalUsd;
      } else {
        sideTraderEntry.sellUsd += signal.totalUsd;
      }

      if (signal.trader.weight > sideTraderEntry.trader.weight) {
        sideTraderEntry.trader = signal.trader;
      }
    } else {
      marketSideTraders.set(signal.wallet, {
        buyUsd: signal.side === "BUY" ? signal.totalUsd : 0,
        sellUsd: signal.side === "SELL" ? signal.totalUsd : 0,
        trader: signal.trader,
      });
    }
    traderSideSpendByMarket.set(signal.marketSlug, marketSideTraders);
  }

  for (const [marketSlug, aggregate] of markets) {
    const traders = traderSpendByMarket.get(marketSlug);
    const sideTraders = traderSideSpendByMarket.get(marketSlug);
    if (!traders) {
      continue;
    }

    let whales = 0;
    let sharks = 0;
    let pros = 0;
    let weightedScore = 0;
    let buyWeight = 0;
    let sellWeight = 0;
    let participantCount = 0;

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

    if (sideTraders) {
      for (const { buyUsd, sellUsd, trader } of sideTraders.values()) {
        if (buyUsd + sellUsd < 1_000 || trader.tier === "none") {
          continue;
        }

        if (buyUsd > sellUsd) {
          buyWeight += trader.weight;
        } else if (sellUsd > buyUsd) {
          sellWeight += trader.weight;
        }
      }
    }

    aggregate.whales = whales;
    aggregate.sharks = sharks;
    aggregate.pros = pros;
    aggregate.weightedScore = weightedScore;
    aggregate.buyWeight = buyWeight;
    aggregate.sellWeight = sellWeight;
    aggregate.participantCount = participantCount;
  }

  return Array.from(markets.values()).sort((left, right) => right.latestTimestamp - left.latestTimestamp);
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

export default App;
