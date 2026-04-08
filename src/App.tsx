import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import type {
  AppSnapshot,
  GapPageResponse,
  MarketAggregate,
  MarketPageResponse,
  MarketSortOption,
  StrategyDashboardResponse,
  TraderSummary,
  UserProfileResponse,
} from "../shared/contracts";

type Route = "/" | "/radar" | "/gaps" | "/playbooks" | "/workspace";
type ProfileState = "loading" | "authorized" | "unauthorized";
type Tone = "neutral" | "cyan" | "blue" | "green" | "yellow";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const routeLabels: Record<Route, string> = {
  "/": "Overview",
  "/radar": "Radar",
  "/gaps": "Gaps",
  "/playbooks": "Playbooks",
  "/workspace": "Workspace",
};

const routeAliases: Record<string, Route> = {
  "/": "/",
  "/radar": "/radar",
  "/gaps": "/gaps",
  "/gap-lab": "/gaps",
  "/playbooks": "/playbooks",
  "/workspace": "/workspace",
  "/profile": "/workspace",
  "/best-trades": "/radar",
  "/paper-auto-best-trades": "/playbooks",
  "/paper-auto-edge-swing": "/playbooks",
  "/live-auto-best-trades": "/workspace",
  "/live-auto-edge-swing": "/workspace",
};

function getRoute(pathname: string): Route {
  return routeAliases[pathname] ?? "/";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const error = new Error(`Request failed with ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return response.json() as Promise<T>;
}

function App() {
  const [route, setRoute] = useState<Route>(() => getRoute(window.location.pathname));
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [marketPage, setMarketPage] = useState<MarketPageResponse | null>(null);
  const [gapPage, setGapPage] = useState<GapPageResponse | null>(null);
  const [paperBest, setPaperBest] = useState<StrategyDashboardResponse | null>(null);
  const [paperEdge, setPaperEdge] = useState<StrategyDashboardResponse | null>(null);
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [profileState, setProfileState] = useState<ProfileState>("loading");
  const [sort, setSort] = useState<MarketSortOption>("weighted");
  const [view, setView] = useState<"best" | "monitor">("best");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [workspaceForm, setWorkspaceForm] = useState({ webhookUrl: "", monitoredWallet: "" });
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [watchBusy, setWatchBusy] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = () => setRoute(getRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadSnapshot = async () => {
      try {
        const next = await fetchJson<AppSnapshot>("/api/snapshot");
        if (!cancelled) {
          setSnapshot(next);
        }
      } catch {
        if (!cancelled) {
          setSnapshot(null);
        }
      }
    };

    void loadSnapshot();
    const timer = window.setInterval(() => void loadSnapshot(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({
      view,
      sort,
      search: deferredQuery,
      page: "1",
      pageSize: "36",
    });

    void fetchJson<MarketPageResponse>(`/api/markets?${params.toString()}`)
      .then((next) => {
        if (!cancelled) {
          setMarketPage(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMarketPage(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deferredQuery, sort, view]);

  useEffect(() => {
    void fetchJson<GapPageResponse>("/api/gaps?page=1&pageSize=20")
      .then(setGapPage)
      .catch(() => setGapPage(null));

    void fetchJson<UserProfileResponse>("/api/profile")
      .then((next) => {
        setProfile(next);
        setProfileState("authorized");
        setWorkspaceForm({
          webhookUrl: next.webhookUrl,
          monitoredWallet: next.monitoredWallet,
        });
      })
      .catch((error: Error & { status?: number }) => {
        if (error.status === 401) {
          setProfileState("unauthorized");
          return;
        }

        setProfileState("unauthorized");
      });
  }, []);

  useEffect(() => {
    if (profileState !== "authorized") {
      return;
    }

    void Promise.allSettled([
      fetchJson<StrategyDashboardResponse>("/api/strategy-positions?strategy=best_trades"),
      fetchJson<StrategyDashboardResponse>("/api/strategy-positions?strategy=edge_swing"),
    ]).then(([best, edge]) => {
      setPaperBest(best.status === "fulfilled" ? best.value : null);
      setPaperEdge(edge.status === "fulfilled" ? edge.value : null);
    });
  }, [profileState]);

  const navigate = (nextRoute: Route) => {
    startTransition(() => {
      window.history.pushState({}, "", nextRoute);
      setRoute(nextRoute);
    });
  };

  const markets = marketPage?.items ?? [];
  const topMarkets = markets.slice(0, 5);
  const topGaps = [...(gapPage?.items ?? [])]
    .sort((a, b) => (b.grossEdge ?? -1) - (a.grossEdge ?? -1))
    .slice(0, 6);
  const topTraders = useMemo(() => {
    const traderMap = new Map<string, TraderSummary>();
    for (const market of markets) {
      const trader = market.latestSignal.trader;
      const existing = traderMap.get(trader.wallet);
      if (!existing || trader.totalPnl > existing.totalPnl) {
        traderMap.set(trader.wallet, trader);
      }
    }

    return [...traderMap.values()].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 8);
  }, [markets]);

  const saveWorkspace = async () => {
    if (!profile) {
      return;
    }

    setWorkspaceMessage(null);
    setWorkspaceError(null);

    try {
      const response = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          webhookUrl: workspaceForm.webhookUrl,
          monitoredWallet: workspaceForm.monitoredWallet,
          paperTradingEnabled: false,
          liveTradingEnabled: false,
          startingBalanceUsd: profile.startingBalanceUsd,
          riskPercent: profile.riskPercent,
          edgeSwingPaperTradingEnabled: false,
          edgeSwingLiveTradingEnabled: false,
          edgeSwingStartingBalanceUsd: profile.edgeSwingStartingBalanceUsd,
          edgeSwingRiskPercent: profile.edgeSwingRiskPercent,
          tradingWalletAddress: "",
          tradingSignatureType: "EOA",
          privateKey: "",
          apiKey: "",
          apiSecret: "",
          apiPassphrase: "",
          clearTradingCredentials: false,
        }),
      });

      if (!response.ok) {
        throw new Error("Unable to save workspace");
      }

      const next = (await response.json()) as UserProfileResponse;
      setProfile(next);
      setWorkspaceMessage("Workspace saved.");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Unable to save workspace");
    }
  };

  const toggleWatch = async (market: MarketAggregate) => {
    if (profileState !== "authorized") {
      navigate("/workspace");
      return;
    }

    const key = `${market.marketSlug}:${market.latestSignal.outcome}`;
    setWatchBusy(key);

    try {
      if (market.isWatched) {
        await fetch(
          `/api/market-alerts/watch/${market.marketSlug}?outcome=${encodeURIComponent(market.latestSignal.outcome)}`,
          { method: "DELETE", credentials: "include" },
        );
      } else {
        await fetch("/api/market-alerts/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            marketSlug: market.marketSlug,
            outcome: market.latestSignal.outcome,
          }),
        });
      }

      setMarketPage((current) =>
        current
          ? {
              ...current,
              items: current.items.map((entry) =>
                entry.marketSlug === market.marketSlug ? { ...entry, isWatched: !entry.isWatched } : entry,
              ),
            }
          : current,
      );
    } finally {
      setWatchBusy(null);
    }
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className="page">
        <header className="topbar">
          <div>
            <p className="eyebrow">Polymarket Statistics Desk</p>
            <h1>Quiet board. Clear signals.</h1>
          </div>
          <nav className="nav">
            {(Object.keys(routeLabels) as Route[]).map((entry) => (
              <button
                key={entry}
                type="button"
                className={`nav-link ${route === entry ? "nav-link-active" : ""}`}
                onClick={() => navigate(entry)}
              >
                {routeLabels[entry]}
              </button>
            ))}
          </nav>
        </header>

        <section className="summary-grid">
          <MetricCard label="Tracked markets" value={String(snapshot?.status.marketCount ?? "—")} tone="blue" />
          <MetricCard
            label="WS coverage"
            value={
              snapshot
                ? `${snapshot.status.websocketAssetsSeenRecentlyCount}/${snapshot.status.websocketSubscribedAssetCount}`
                : "—"
            }
            tone="cyan"
          />
          <MetricCard label="Tracked traders" value={String(snapshot?.status.trackedTraderCount ?? "—")} tone="green" />
          <MetricCard label="Recent errors" value={String(snapshot?.status.recentErrorsLast10Minutes ?? "—")} tone="yellow" />
        </section>

        {route === "/" ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Overview</p>
                <h2>The app is now research-only.</h2>
              </div>
            </div>

            <div className="overview-grid">
              <div className="subpanel">
                <h3>Top conviction</h3>
                <div className="stack">
                  {topMarkets.length ? (
                    topMarkets.map((market) => (
                      <MarketRow key={market.marketSlug} market={market} watchBusy={watchBusy} onToggleWatch={toggleWatch} />
                    ))
                  ) : (
                    <div className="empty-state">
                      <p>No conviction signals yet.</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="subpanel">
                <h3>Top gaps</h3>
                <div className="stack">
                  {topGaps.length ? (
                    topGaps.map((gap) => (
                      <GapRow key={gap.id} gap={gap} />
                    ))
                  ) : (
                    <div className="empty-state">
                      <p>No active gap setups right now.</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="subpanel">
                <h3>Top traders</h3>
                <div className="stack">
                  {topTraders.length ? (
                    topTraders.map((trader, index) => (
                      <TraderRow key={trader.wallet} trader={trader} index={index} />
                    ))
                  ) : (
                    <div className="empty-state">
                      <p>No trader leaderboard data yet.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {route === "/radar" ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Radar</p>
                <h2>Simple market scan</h2>
              </div>
              <div className="controls">
                <div className="toggle">
                  <button type="button" className={view === "best" ? "toggle-active" : ""} onClick={() => setView("best")}>
                    Best
                  </button>
                  <button type="button" className={view === "monitor" ? "toggle-active" : ""} onClick={() => setView("monitor")}>
                    All
                  </button>
                </div>
                <input
                  className="search"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search markets or traders"
                />
                <select className="select" value={sort} onChange={(event) => setSort(event.target.value as MarketSortOption)}>
                  <option value="weighted">Weighted</option>
                  <option value="buyWeight">Outcome weight</option>
                  <option value="flow">Flow</option>
                  <option value="participants">Participants</option>
                  <option value="recent">Recent</option>
                </select>
              </div>
            </div>

            <div className="stack">
              {markets.map((market) => (
                <MarketRow key={market.marketSlug} market={market} watchBusy={watchBusy} onToggleWatch={toggleWatch} />
              ))}
            </div>
          </section>
        ) : null}

        {route === "/gaps" ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Gaps</p>
                <h2>Dislocations worth checking</h2>
              </div>
            </div>

            <div className="stack">
              {topGaps.map((gap) => (
                <GapRow key={gap.id} gap={gap} expanded />
              ))}
            </div>
          </section>
        ) : null}

        {route === "/playbooks" ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Playbooks</p>
                <h2>Historical paper strategy archives</h2>
              </div>
            </div>

            <div className="playbook-grid">
              <PlaybookCard title="Best trades archive" dashboard={paperBest} />
              <PlaybookCard title="Edge swing archive" dashboard={paperEdge} />
            </div>
          </section>
        ) : null}

        {route === "/workspace" ? (
          <section className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Workspace</p>
                <h2>Alerts and watchlist only</h2>
              </div>
            </div>

            {profileState === "unauthorized" ? (
              <div className="empty-state">
                <p>Sign in to save a webhook, a tracked wallet, and a watchlist.</p>
                <a className="button-link" href="/login">
                  Sign in
                </a>
              </div>
            ) : (
              <div className="workspace-grid">
                <div className="subpanel">
                  <label className="field">
                    <span>Discord webhook URL</span>
                    <input
                      className="search"
                      type="url"
                      value={workspaceForm.webhookUrl}
                      onChange={(event) =>
                        setWorkspaceForm((current) => ({ ...current, webhookUrl: event.target.value }))
                      }
                      placeholder="https://discord.com/api/webhooks/..."
                    />
                  </label>

                  <label className="field">
                    <span>Tracked wallet</span>
                    <input
                      className="search"
                      type="text"
                      value={workspaceForm.monitoredWallet}
                      onChange={(event) =>
                        setWorkspaceForm((current) => ({ ...current, monitoredWallet: event.target.value }))
                      }
                      placeholder="0x..."
                    />
                  </label>

                  {workspaceMessage ? <p className="success">{workspaceMessage}</p> : null}
                  {workspaceError ? <p className="error">{workspaceError}</p> : null}

                  <div className="workspace-actions">
                    <button type="button" className="button-link" onClick={() => void saveWorkspace()}>
                      Save
                    </button>
                    <a className="ghost-link" href="/logout">
                      Sign out
                    </a>
                  </div>
                </div>

                <div className="subpanel">
                  <h3>Watchlist</h3>
                  <div className="stack">
                    {profile?.watches?.length ? (
                      profile.watches.map((watch) => (
                        <article className="row" key={`${watch.marketSlug}:${watch.outcome}`}>
                          <div className="row-main">
                            <strong>{watch.marketQuestion}</strong>
                            <p>{watch.outcome}</p>
                          </div>
                          <a className="row-link" href={watch.marketUrl} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        </article>
                      ))
                    ) : (
                      <div className="empty-state">
                        <p>No watched markets yet.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: Tone;
}) {
  return (
    <article className={`metric-card metric-card-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function MarketRow({
  market,
  watchBusy,
  onToggleWatch,
}: {
  market: MarketAggregate;
  watchBusy: string | null;
  onToggleWatch: (market: MarketAggregate) => void;
}) {
  return (
    <article className="row row-market">
      <div className="row-main">
        <div className="row-titleline">
          <span className={`signal-pill signal-pill-${tierTone(market.latestSignal.trader.tier)}`}>
            {tierLabel(market.latestSignal.trader.tier)}
          </span>
          <span className={`signal-pill signal-pill-${market.isWatched ? "green" : "blue"}`}>
            {market.isWatched ? "Watching" : "Radar"}
          </span>
        </div>
        <strong>{market.marketQuestion}</strong>
        <p>
          {market.latestSignal.displayName} leaned {market.latestSignal.outcome} with{" "}
          {money.format(market.latestSignal.totalUsd)} in tracked flow.
        </p>
      </div>
      <div className="row-meta">
        <span>{market.participantCount} traders</span>
        <span>{market.latestSignal.averagePrice.toFixed(3)}</span>
        <span>{timeAgo(market.latestTimestamp)}</span>
      </div>
      <div className="row-actions">
        <a href={market.marketUrl} target="_blank" rel="noreferrer">
          Market
        </a>
        <button type="button" onClick={() => onToggleWatch(market)}>
          {watchBusy === `${market.marketSlug}:${market.latestSignal.outcome}`
            ? "Saving..."
            : market.isWatched
              ? "Watching"
              : "Watch"}
        </button>
      </div>
    </article>
  );
}

function GapRow({
  gap,
  expanded = false,
}: {
  gap: GapPageResponse["items"][number];
  expanded?: boolean;
}) {
  return (
    <article className="row row-gap">
      <div className="row-main">
        <div className="row-titleline">
          <span className="signal-pill signal-pill-yellow">{gap.pairLabel}</span>
          <span className={`signal-pill ${gap.grossEdge !== null && gap.grossEdge > 0 ? "signal-pill-green" : "signal-pill-neutral"}`}>
            {gap.grossEdge !== null ? `${(gap.grossEdge * 100).toFixed(2)}%` : "No edge"}
          </span>
        </div>
        <strong>{gap.eventTitle}</strong>
        <p>{gap.pairLabel}</p>
      </div>
      <div className="row-meta">
        <span>{gap.combinedNoAsk !== null ? gap.combinedNoAsk.toFixed(3) : "—"}</span>
        <span>{gap.grossEdge !== null ? `${(gap.grossEdge * 100).toFixed(2)}%` : "—"}</span>
        <span>{gap.executableStake !== null ? money.format(gap.executableStake) : "—"}</span>
      </div>
      {expanded ? (
        <div className="gap-links">
          {gap.legs.map((leg) => (
            <a key={`${gap.id}:${leg.marketSlug}`} href={leg.marketUrl} target="_blank" rel="noreferrer">
              {leg.marketQuestion}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function TraderRow({ trader, index }: { trader: TraderSummary; index: number }) {
  return (
    <article className="row">
      <div className="row-main">
        <div className="row-titleline">
          <span className={`signal-pill signal-pill-${tierTone(trader.tier)}`}>{tierLabel(trader.tier)}</span>
        </div>
        <strong>
          {String(index + 1).padStart(2, "0")} {trader.displayName}
        </strong>
        <p>{tierLabel(trader.tier)}</p>
      </div>
      <div className="row-meta">
        <span>{money.format(trader.totalPnl)}</span>
        <span>{trader.tradeCount} trades</span>
      </div>
    </article>
  );
}

function PlaybookCard({
  title,
  dashboard,
}: {
  title: string;
  dashboard: StrategyDashboardResponse | null;
}) {
  return (
    <article className="subpanel">
      <h3>{title}</h3>
      {dashboard ? (
        <div className="summary-grid summary-grid-compact">
          <MetricCard label="Open" value={String(dashboard.summary.openPositionCount)} tone="blue" />
          <MetricCard label="Closed" value={String(dashboard.summary.closedPositionCount)} tone="cyan" />
          <MetricCard label="Realized" value={money.format(dashboard.summary.realizedUsd)} tone="green" />
          <MetricCard label="Equity" value={money.format(dashboard.summary.totalEquityUsd)} tone="yellow" />
        </div>
      ) : (
        <div className="empty-state">
          <p>No archive data yet.</p>
        </div>
      )}
    </article>
  );
}

function tierLabel(tier: TraderSummary["tier"]) {
  if (tier === "whale") {
    return "Whale";
  }

  if (tier === "shark") {
    return "Shark";
  }

  if (tier === "pro") {
    return "Pro";
  }

  return "Large trader";
}

function tierTone(tier: TraderSummary["tier"]): Tone {
  if (tier === "whale") {
    return "cyan";
  }
  if (tier === "shark") {
    return "blue";
  }
  if (tier === "pro") {
    return "yellow";
  }
  return "neutral";
}

function timeAgo(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)}h`;
  }
  return `${Math.floor(minutes / 1440)}d`;
}

export default App;
