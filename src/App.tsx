import { useEffect, useMemo, useState } from "react";

type TraderSummary = {
  wallet: string;
  displayName: string;
  profileImage?: string;
  openPnl: number;
  realizedPnl: number;
  totalValue: number;
  totalPnl: number;
  isVeryProfitable: boolean;
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
  label: "Profitable whale buy" | "Whale buy";
  labelTone: "green" | "blue";
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

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
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

    const loadSnapshot = async () => {
      const response = await fetch("/api/snapshot");
      const payload = (await response.json()) as Snapshot;
      if (!closed) {
        setSnapshot(payload);
      }
    };

    void loadSnapshot();
    refreshTimer = window.setInterval(() => {
      void loadSnapshot();
    }, 15_000);

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

    socket.addEventListener("open", () => {
      if (!closed) {
        setFeedConnected(true);
      }
    });

    socket.addEventListener("close", () => {
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

    return () => {
      closed = true;
      if (refreshTimer) {
        window.clearInterval(refreshTimer);
      }
      socket.close();
    };
  }, []);

  const headerSignal = snapshot.signals[0];
  const profitableCount = useMemo(
    () => snapshot.signals.filter((signal) => signal.labelTone === "green").length,
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
              value={snapshot.signals.length.toString()}
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
            <p className="feed-meta">Threshold: $200,000 per wallet-side cluster</p>
          </div>

          {snapshot.signals.length === 0 ? (
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
              {snapshot.signals.map((signal) => (
                <article className="signal-card" key={signal.id}>
                  <div className="signal-media">
                    {normalizeSecureUrl(signal.marketImage) ? (
                      <img src={normalizeSecureUrl(signal.marketImage)!} alt={signal.marketQuestion} />
                    ) : (
                      <div className="image-fallback">{signal.outcome[0]}</div>
                    )}
                    <div className={`pill pill-${signal.labelTone}`}>{signal.label}</div>
                  </div>

                  <div className="signal-body">
                    <div className="signal-topline">
                      <span>{timeFormatter.format(signal.timestamp)}</span>
                      <span>{signal.fillCount} fills</span>
                    </div>

                    <h3>{signal.marketQuestion}</h3>
                    <p className="signal-thesis">
                      <strong>{signal.displayName}</strong> {signal.side.toLowerCase()}{" "}
                      <span className="outcome-chip">{signal.outcome}</span>
                    </p>

                    <div className="metric-row">
                      <Metric label="Cluster size" value={currencyFormatter.format(signal.totalUsd)} />
                      <Metric label="Average price" value={signal.averagePrice.toFixed(3)} />
                      <Metric label="Shares" value={signal.totalShares.toLocaleString()} />
                    </div>

                    <div className="metric-row">
                      <Metric
                        label="Trader PnL"
                        value={compactCurrencyFormatter.format(signal.trader.totalPnl)}
                      />
                      <Metric
                        label="Portfolio value"
                        value={compactCurrencyFormatter.format(signal.trader.totalValue)}
                      />
                      <Metric
                        label="Wallet"
                        value={`${signal.wallet.slice(0, 6)}...${signal.wallet.slice(-4)}`}
                      />
                    </div>

                    <div className="signal-actions">
                      <a href={normalizeSecureUrl(signal.marketUrl) ?? signal.marketUrl} target="_blank" rel="noreferrer">
                        Open market
                      </a>
                      <a href={normalizeSecureUrl(signal.profileUrl) ?? signal.profileUrl} target="_blank" rel="noreferrer">
                        Open whale profile
                      </a>
                    </div>
                  </div>
                </article>
              ))}
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

function upsertSignal(signals: WhaleSignal[], nextSignal: WhaleSignal) {
  const remaining = signals.filter((signal) => signal.id !== nextSignal.id);
  return [nextSignal, ...remaining];
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
