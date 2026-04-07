import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import type {
  AppSnapshot,
  GapPageResponse,
  LiveStrategyDashboardResponse,
  MarketAggregate,
  MarketPageResponse,
  MarketSortOption,
  StrategyDashboardResponse,
  StrategyTrade,
  TraderSummary,
  UserProfileResponse,
} from "../shared/contracts";

type Route = "/" | "/radar" | "/whales" | "/gap-lab" | "/playbooks" | "/workspace";
type ProfileState = "loading" | "authorized" | "unauthorized";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const moneyPrecise = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

const routeMap: Record<string, Route> = {
  "/": "/",
  "/radar": "/radar",
  "/whales": "/whales",
  "/gap-lab": "/gap-lab",
  "/playbooks": "/playbooks",
  "/workspace": "/workspace",
  "/best-trades": "/radar",
  "/gaps": "/gap-lab",
  "/profile": "/workspace",
  "/paper-auto-best-trades": "/playbooks",
  "/live-auto-best-trades": "/playbooks",
  "/paper-auto-edge-swing": "/playbooks",
  "/live-auto-edge-swing": "/playbooks",
};

const getRoute = (pathname: string): Route => routeMap[pathname] ?? "/";

const fetchJson = async <T,>(url: string) => {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const error = new Error(`Request failed with ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return response.json() as Promise<T>;
};

function App() {
  const [route, setRoute] = useState<Route>(() => getRoute(window.location.pathname));
  const [menuOpen, setMenuOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [markets, setMarkets] = useState<MarketPageResponse | null>(null);
  const [bestMarkets, setBestMarkets] = useState<MarketPageResponse | null>(null);
  const [gaps, setGaps] = useState<GapPageResponse | null>(null);
  const [profileState, setProfileState] = useState<ProfileState>("loading");
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [paperBest, setPaperBest] = useState<StrategyDashboardResponse | null>(null);
  const [paperEdge, setPaperEdge] = useState<StrategyDashboardResponse | null>(null);
  const [liveBest, setLiveBest] = useState<LiveStrategyDashboardResponse | null>(null);
  const [liveEdge, setLiveEdge] = useState<LiveStrategyDashboardResponse | null>(null);
  const [marketView, setMarketView] = useState<"best" | "monitor">("best");
  const [sort, setSort] = useState<MarketSortOption>("weighted");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [workspaceForm, setWorkspaceForm] = useState({ webhookUrl: "", monitoredWallet: "" });
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [watchBusy, setWatchBusy] = useState<string | null>(null);

  useEffect(() => {
    const onPop = () => setRoute(getRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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
    const timer = window.setInterval(() => void loadSnapshot(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ view: marketView, sort, search: deferredQuery, page: "1", pageSize: "36" });
    void fetchJson<MarketPageResponse>(`/api/markets?${params.toString()}`)
      .then((next) => !cancelled && setMarkets(next))
      .catch(() => !cancelled && setMarkets(null));
    return () => {
      cancelled = true;
    };
  }, [deferredQuery, marketView, sort]);

  useEffect(() => {
    void fetchJson<MarketPageResponse>("/api/markets?view=best&sort=weighted&page=1&pageSize=6")
      .then(setBestMarkets)
      .catch(() => setBestMarkets(null));
    void fetchJson<GapPageResponse>("/api/gaps?page=1&pageSize=12")
      .then(setGaps)
      .catch(() => setGaps(null));
    void fetchJson<UserProfileResponse>("/api/profile")
      .then((next) => {
        setProfileState("authorized");
        setProfile(next);
        setWorkspaceForm({ webhookUrl: next.webhookUrl, monitoredWallet: next.monitoredWallet });
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
      fetchJson<LiveStrategyDashboardResponse>("/api/live-strategy-positions?strategy=best_trades"),
      fetchJson<LiveStrategyDashboardResponse>("/api/live-strategy-positions?strategy=edge_swing"),
    ]).then(([a, b, c, d]) => {
      setPaperBest(a.status === "fulfilled" ? a.value : null);
      setPaperEdge(b.status === "fulfilled" ? b.value : null);
      setLiveBest(c.status === "fulfilled" ? c.value : null);
      setLiveEdge(d.status === "fulfilled" ? d.value : null);
    });
  }, [profileState]);

  const navigate = (next: Route) => {
    startTransition(() => {
      window.history.pushState({}, "", next);
      setRoute(next);
      setMenuOpen(false);
    });
  };

  const featured = bestMarkets?.items ?? [];
  const board = markets?.items ?? [];
  const gapBoard = [...(gaps?.items ?? [])].sort((a, b) => (b.grossEdge ?? -1) - (a.grossEdge ?? -1));
  const whaleBoard = useMemo(() => {
    const seen = new Map<string, TraderSummary>();
    for (const market of board) {
      const trader = market.latestSignal.trader;
      const current = seen.get(trader.wallet);
      if (!current || trader.totalPnl > current.totalPnl) {
        seen.set(trader.wallet, trader);
      }
    }
    return [...seen.values()].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 10);
  }, [board]);
  const journal = useMemo(
    () =>
      [
        ...wrapTrades("Best trades archive", paperBest?.trades),
        ...wrapTrades("Edge swing archive", paperEdge?.trades),
        ...wrapTrades("Best trades execution", liveBest?.trades),
        ...wrapTrades("Edge swing execution", liveEdge?.trades),
      ]
        .sort((a, b) => b.trade.timestamp - a.trade.timestamp)
        .slice(0, 12),
    [liveBest?.trades, liveEdge?.trades, paperBest?.trades, paperEdge?.trades],
  );

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
          paperTradingEnabled: profile.paperTradingEnabled,
          liveTradingEnabled: profile.liveTradingEnabled,
          startingBalanceUsd: profile.startingBalanceUsd,
          riskPercent: profile.riskPercent,
          edgeSwingPaperTradingEnabled: profile.edgeSwingPaperTradingEnabled,
          edgeSwingLiveTradingEnabled: profile.edgeSwingLiveTradingEnabled,
          edgeSwingStartingBalanceUsd: profile.edgeSwingStartingBalanceUsd,
          edgeSwingRiskPercent: profile.edgeSwingRiskPercent,
          tradingWalletAddress: profile.tradingWalletAddress,
          tradingSignatureType: profile.tradingSignatureType,
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
        await fetch(`/api/market-alerts/watch/${market.marketSlug}?outcome=${encodeURIComponent(market.latestSignal.outcome)}`, { method: "DELETE", credentials: "include" });
      } else {
        await fetch("/api/market-alerts/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ marketSlug: market.marketSlug, outcome: market.latestSignal.outcome }),
        });
      }

      const patch = (page: MarketPageResponse | null) =>
        page
          ? {
              ...page,
              items: page.items.map((entry) =>
                entry.marketSlug === market.marketSlug ? { ...entry, isWatched: !entry.isWatched } : entry,
              ),
            }
          : page;
      setMarkets((current) => patch(current));
      setBestMarkets((current) => patch(current));
    } finally {
      setWatchBusy(null);
    }
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <div className={`menu-backdrop ${menuOpen ? "menu-backdrop-open" : ""}`} onClick={() => setMenuOpen(false)} />
      <aside className={`side-menu ${menuOpen ? "side-menu-open" : ""}`}>
        <p className="side-kicker">Polymarket consultant</p>
        {(["/", "/radar", "/whales", "/gap-lab", "/playbooks", "/workspace"] as Route[]).map((entry) => (
          <button key={entry} type="button" className={`side-menu-link ${route === entry ? "side-menu-link-active" : ""}`} onClick={() => navigate(entry)}>
            {routeLabel(entry)}
          </button>
        ))}
      </aside>
      <main className="page">
        <header className="masthead">
          <div className="masthead-bar">
            <button className="menu-button" type="button" onClick={() => setMenuOpen(true)}><span /><span /><span /></button>
            <div className="brand-block">
              <span className="brand-pill">VEGAS MONITOR</span>
              <div>
                <h1>Trader Desk</h1>
                <p>Statistics first. Consultant second. Auto-trading left in the background.</p>
              </div>
            </div>
            <button type="button" className="route-button" onClick={() => navigate("/workspace")}>{profileState === "authorized" ? "Workspace" : "Sign in"}</button>
          </div>
          <div className="ticker-grid">
            <Stat label="Markets" value={String(snapshot?.status.marketCount ?? "—")} note="Tracked research universe" />
            <Stat label="Coverage" value={snapshot ? `${snapshot.status.websocketAssetsSeenRecentlyCount}/${snapshot.status.websocketSubscribedAssetCount}` : "—"} note="Recently seen assets" />
            <Stat label="Errors" value={String(snapshot?.status.recentErrorsLast10Minutes ?? "—")} note="Last 10 minutes" />
            <Stat label="Traders" value={String(snapshot?.status.trackedTraderCount ?? "—")} note="Tracked wallets" />
          </div>
        </header>
        {route === "/" ? (
          <>
            <section className="hero-grid">
              <article className="hero-card hero-card-primary">
                <p className="eyebrow">Desk summary</p>
                <h2>Make decisions like a Polymarket consultant.</h2>
                <p className="lead-copy">
                  The product now centers on board reading, whale behavior, pricing dislocations, and statistical playbooks instead of order execution.
                </p>
                <div className="hero-metrics">
                  <Stat label="Best-trade win rate" value={bestMarkets?.bestTradeStats?.winRate !== null && bestMarkets?.bestTradeStats?.winRate !== undefined ? `${(bestMarkets.bestTradeStats.winRate * 100).toFixed(1)}%` : "Pending"} note="Resolved consultant calls" />
                  <Stat label="Resolved calls" value={String(bestMarkets?.bestTradeStats?.resolvedCount ?? "—")} note="Historical record" />
                  <Stat label="Signal tape" value={String(board.slice(0, 8).length)} note="Fresh clustered moves" />
                  <Stat label="Gap setups" value={String(gapBoard.slice(0, 4).length)} note="Manual arb candidates" />
                </div>
                <div className="hero-actions">
                  <button type="button" className="primary-button" onClick={() => navigate("/radar")}>Open radar</button>
                  <button type="button" className="secondary-button" onClick={() => navigate("/whales")}>Read smart money</button>
                </div>
              </article>
              <article className="hero-card hero-card-feature">
                <p className="eyebrow">Lead setup</p>
                {featured[0] ? (
                  <>
                    <h3>{featured[0].marketQuestion}</h3>
                    <p className="feature-copy">
                      {featured[0].latestSignal.displayName} is leaning <strong>{featured[0].latestSignal.outcome}</strong> with {money.format(featured[0].totalUsd)} in tracked flow.
                    </p>
                    <div className="bar-list">
                      {featured[0].outcomeWeights.slice(0, 3).map((outcome) => (
                        <Bar key={`${featured[0].marketSlug}:${outcome.outcome}`} outcome={outcome.outcome} value={outcome.weight} />
                      ))}
                    </div>
                  </>
                ) : (
                  <Empty title="Loading lead setup" body="Waiting for the first conviction snapshot." />
                )}
              </article>
            </section>

            <section className="section-shell">
              <SectionHeader kicker="Conviction board" title="Setups worth attention now" description="The strongest clustered markets based on weight, breadth, and price context." action="Full radar" onAction={() => navigate("/radar")} />
              <div className="compact-grid">
                {featured.slice(0, 4).map((market) => (
                  <CompactCard key={market.marketSlug} market={market} watchBusy={watchBusy} onToggleWatch={toggleWatch} />
                ))}
              </div>
            </section>

            <section className="split-grid">
              <div className="section-shell">
                <SectionHeader kicker="Smart money tape" title="Who moved most recently" description="A running tape of the latest clustered decisions from tracked traders." />
                <div className="list-stack">
                  {board.slice(0, 8).map((market) => (
                    <article className="list-card" key={`tape:${market.marketSlug}`}>
                      <div>
                        <strong>{market.latestSignal.displayName}</strong>
                        <p>{market.marketQuestion}</p>
                      </div>
                      <div className="list-meta">
                        <span>{market.latestSignal.outcome}</span>
                        <span>{money.format(market.latestSignal.totalUsd)}</span>
                        <span>{timeAgo(market.latestTimestamp)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
              <div className="section-shell">
                <SectionHeader kicker="Gap lab" title="Dislocations and pairings" description="No/no and paired-market inefficiencies that deserve manual review." action="Open gap lab" onAction={() => navigate("/gap-lab")} />
                <div className="list-stack">
                  {gapBoard.slice(0, 4).map((gap) => (
                    <GapCard key={gap.id} gap={gap} />
                  ))}
                </div>
              </div>
            </section>
          </>
        ) : null}

        {route === "/radar" ? (
          <section className="section-shell">
            <SectionHeader kicker="Market radar" title="Research the board like a desk" description="Search, sort, and compare where tracked money is concentrating right now." />
            <div className="control-row">
              <div className="segment">
                <button type="button" className={marketView === "best" ? "segment-active" : ""} onClick={() => setMarketView("best")}>Highest conviction</button>
                <button type="button" className={marketView === "monitor" ? "segment-active" : ""} onClick={() => setMarketView("monitor")}>Full monitor</button>
              </div>
              <label className="field">
                <span>Search</span>
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Markets, outcomes, traders" />
              </label>
              <label className="field field-small">
                <span>Sort</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as MarketSortOption)}>
                  <option value="weighted">Weighted score</option>
                  <option value="buyWeight">Outcome weight</option>
                  <option value="flow">Largest flow</option>
                  <option value="participants">Participants</option>
                  <option value="recent">Recent</option>
                </select>
              </label>
            </div>
            <div className="radar-grid">
              {board.map((market) => (
                <MarketCard key={market.marketSlug} market={market} watchBusy={watchBusy} onToggleWatch={toggleWatch} />
              ))}
            </div>
          </section>
        ) : null}

        {route === "/whales" ? (
          <section className="split-grid">
            <div className="section-shell">
              <SectionHeader kicker="Smart money" title="Whale leaderboard" description="A quick ranking of the most profitable tracked traders currently influencing the board." />
              <div className="list-stack">
                {whaleBoard.map((trader, index) => (
                  <article className="leader-card" key={`${trader.wallet}:${index}`}>
                    <span className="leader-rank">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{trader.displayName}</strong>
                      <p>{tierLabel(trader.tier)} tier</p>
                    </div>
                    <div className="leader-metrics">
                      <span>{money.format(trader.totalPnl)}</span>
                      <span>{trader.tradeCount} trades</span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
            <div className="section-shell">
              <SectionHeader kicker="Flow" title="Recent clustered signals" description="Read the markets where concentrated traders just left a visible footprint." />
              <div className="list-stack">
                {board.slice(0, 10).map((market) => (
                  <article className="flow-card" key={`flow:${market.marketSlug}`}>
                    <span className="eyebrow">{timeAgo(market.latestTimestamp)}</span>
                    <h3>{market.marketQuestion}</h3>
                    <p>{market.latestSignal.displayName} leaned {market.latestSignal.outcome} at {market.latestSignal.averagePrice.toFixed(3)} with {money.format(market.latestSignal.totalUsd)} in tracked volume.</p>
                    <div className="bar-list">
                      {market.outcomeWeights.slice(0, 2).map((outcome) => (
                        <Bar key={`${market.marketSlug}:${outcome.outcome}`} outcome={outcome.outcome} value={outcome.weight} />
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {route === "/gap-lab" ? (
          <section className="section-shell">
            <SectionHeader kicker="Gap lab" title="Manual arb and dislocation board" description="This is where paired pricing gaps live so traders can inspect them with discretion." />
            <div className="list-stack">
              {gapBoard.map((gap) => (
                <GapCard key={gap.id} gap={gap} expanded />
              ))}
            </div>
          </section>
        ) : null}

        {route === "/playbooks" ? (
          <section className="section-shell">
            <SectionHeader kicker="Playbooks" title="Historical signal archives" description="The old automation surfaces are now framed as study material and execution review." />
            {profileState !== "authorized" ? (
              <Empty title="Sign in to unlock archives" body="Research playbooks use your saved strategy history and execution records." action="Open workspace" onAction={() => navigate("/workspace")} />
            ) : (
              <>
                <div className="compact-grid">
                  <ResearchCard title="Best trades archive" body="Paper record for the highest-conviction ideas." dashboard={paperBest} />
                  <ResearchCard title="Edge swing archive" body="Paper record for broad edge-capture setups." dashboard={paperEdge} />
                  <ResearchCard title="Best trades execution" body="Execution history for the live best-trades stream." dashboard={liveBest} />
                  <ResearchCard title="Edge swing execution" body="Execution history for the live edge-swing stream." dashboard={liveEdge} />
                </div>
                <div className="section-shell nested-shell">
                  <SectionHeader kicker="Journal" title="Cross-playbook activity" description="A single place to read what the systems did, without turning the app into a trading cockpit." />
                  <div className="list-stack">
                    {journal.map((entry) => (
                      <article className="list-card" key={`${entry.label}:${entry.trade.id}`}>
                        <div>
                          <strong>{entry.trade.marketQuestion}</strong>
                          <p>{entry.label}</p>
                        </div>
                        <div className="list-meta">
                          <span>{entry.trade.side}</span>
                          <span>{entry.trade.reason}</span>
                          <span>{moneyPrecise.format(entry.trade.usd)} @ {entry.trade.price.toFixed(3)}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </>
            )}
          </section>
        ) : null}

        {route === "/workspace" ? (
          <section className="split-grid">
            <div className="section-shell">
              <SectionHeader kicker="Workspace" title="Alerts and personal context" description="Keep this area focused on alerts, tracked wallets, and your private research context." />
              {profileState === "unauthorized" ? (
                <Empty title="Sign in for a workspace" body="Store a webhook, save a tracked wallet, and keep a personal watchlist." action="Go to sign in" onAction={() => { window.location.href = "/login"; }} />
              ) : (
                <div className="workspace-panel">
                  <label className="field">
                    <span>Discord webhook URL</span>
                    <input type="url" value={workspaceForm.webhookUrl} onChange={(event) => setWorkspaceForm((current) => ({ ...current, webhookUrl: event.target.value }))} placeholder="https://discord.com/api/webhooks/..." />
                  </label>
                  <label className="field">
                    <span>Tracked Polymarket wallet</span>
                    <input type="text" value={workspaceForm.monitoredWallet} onChange={(event) => setWorkspaceForm((current) => ({ ...current, monitoredWallet: event.target.value }))} placeholder="0x..." />
                  </label>
                  {workspaceMessage ? <p className="flash-success">{workspaceMessage}</p> : null}
                  {workspaceError ? <p className="flash-error">{workspaceError}</p> : null}
                  <div className="hero-actions">
                    <button type="button" className="primary-button" onClick={() => void saveWorkspace()}>Save workspace</button>
                    {profileState === "authorized" ? <a className="secondary-button link-button" href="/logout">Sign out</a> : null}
                  </div>
                </div>
              )}
            </div>
            <div className="section-shell">
              <SectionHeader kicker="Watchlist" title="Watched markets" description="Use the radar screen to add markets you want notifications for." />
              <div className="list-stack">
                {profile?.watches?.length ? profile.watches.map((watch) => (
                  <article className="list-card" key={`${watch.marketSlug}:${watch.outcome}`}>
                    <div>
                      <strong>{watch.marketQuestion}</strong>
                      <p>{watch.outcome}</p>
                    </div>
                    <div className="list-meta">
                      <span>{watch.source}</span>
                      <a href={watch.marketUrl} target="_blank" rel="noreferrer">Open market</a>
                    </div>
                  </article>
                )) : <Empty title="No watched markets yet" body="Add any market from the radar to build your alert book." />}
              </div>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><p>{note}</p></article>;
}

function SectionHeader({ kicker, title, description, action, onAction }: { kicker: string; title: string; description: string; action?: string; onAction?: () => void }) {
  return (
    <div className="section-header">
      <div>
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action && onAction ? <button type="button" className="secondary-button" onClick={onAction}>{action}</button> : null}
    </div>
  );
}

function CompactCard({ market, watchBusy, onToggleWatch }: { market: MarketAggregate; watchBusy: string | null; onToggleWatch: (market: MarketAggregate) => void }) {
  return (
    <article className="compact-card">
      <div className="card-top"><span>{timeAgo(market.latestTimestamp)}</span><span>{money.format(market.totalUsd)}</span></div>
      <h3>{market.marketQuestion}</h3>
      <div className="bar-list">{market.outcomeWeights.slice(0, 3).map((entry) => <Bar key={`${market.marketSlug}:${entry.outcome}`} outcome={entry.outcome} value={entry.weight} />)}</div>
      <div className="card-actions">
        <span>{market.participantCount} participants</span>
        <button type="button" className={`watch-button ${market.isWatched ? "watch-button-active" : ""}`} onClick={() => onToggleWatch(market)}>
          {watchBusy === `${market.marketSlug}:${market.latestSignal.outcome}` ? "Saving..." : market.isWatched ? "Watching" : "Watch"}
        </button>
      </div>
    </article>
  );
}

function MarketCard({ market, watchBusy, onToggleWatch }: { market: MarketAggregate; watchBusy: string | null; onToggleWatch: (market: MarketAggregate) => void }) {
  return (
    <article className="market-card">
      <div className="card-top"><span>{timeAgo(market.latestTimestamp)}</span><span>{market.participantCount} wallets</span></div>
      <h3>{market.marketQuestion}</h3>
      <p>{market.latestSignal.displayName} leaned <strong>{market.latestSignal.outcome}</strong> with {money.format(market.latestSignal.totalUsd)} in tracked volume.</p>
      <div className="metric-grid">
        <Metric label="Quality" value={`${quality(market)}/100`} />
        <Metric label="Flow" value={money.format(market.totalUsd)} />
        <Metric label="Avg entry" value={market.observedAvgEntry ? market.observedAvgEntry.toFixed(3) : "—"} />
        <Metric label="Last" value={market.latestSignal.averagePrice.toFixed(3)} />
      </div>
      <div className="bar-list">{market.outcomeWeights.slice(0, 4).map((entry) => <Bar key={`${market.marketSlug}:${entry.outcome}`} outcome={entry.outcome} value={entry.weight} />)}</div>
      <div className="card-actions">
        <a href={market.marketUrl} target="_blank" rel="noreferrer">Open market</a>
        <a href={market.latestSignal.profileUrl} target="_blank" rel="noreferrer">Whale profile</a>
        <button type="button" className={`watch-button ${market.isWatched ? "watch-button-active" : ""}`} onClick={() => onToggleWatch(market)}>
          {watchBusy === `${market.marketSlug}:${market.latestSignal.outcome}` ? "Saving..." : market.isWatched ? "Watching" : "Watch"}
        </button>
      </div>
    </article>
  );
}

function GapCard({ gap, expanded = false }: { gap: GapPageResponse["items"][number]; expanded?: boolean }) {
  return (
    <article className={`gap-card ${expanded ? "gap-card-expanded" : ""}`}>
      <div className="card-top"><span>{gap.pairLabel}</span><span>{timeAgo(gap.updatedAt)}</span></div>
      <h3>{gap.eventTitle}</h3>
      <div className="metric-grid">
        <Metric label="Combined ask" value={gap.combinedNoAsk !== null ? gap.combinedNoAsk.toFixed(3) : "—"} />
        <Metric label="Gross edge" value={gap.grossEdge !== null ? `${(gap.grossEdge * 100).toFixed(2)}%` : "—"} />
        <Metric label="Executable" value={gap.executableStake !== null ? money.format(gap.executableStake) : "—"} />
      </div>
      <div className="gap-legs">
        {gap.legs.map((leg) => <a key={`${gap.id}:${leg.marketSlug}`} className="gap-leg" href={leg.marketUrl} target="_blank" rel="noreferrer"><strong>{leg.marketQuestion}</strong><span>No ask {leg.noAsk !== null ? leg.noAsk.toFixed(3) : "—"}</span></a>)}
      </div>
    </article>
  );
}

function ResearchCard({ title, body, dashboard }: { title: string; body: string; dashboard: StrategyDashboardResponse | LiveStrategyDashboardResponse | null }) {
  return (
    <article className="compact-card">
      <p className="eyebrow">{title}</p>
      <h3>{body}</h3>
      {dashboard ? (
        <div className="metric-grid">
          <Metric label="Open" value={String(dashboard.summary.openPositionCount)} />
          <Metric label="Closed" value={String(dashboard.summary.closedPositionCount)} />
          <Metric label="Realized" value={money.format(dashboard.summary.realizedUsd)} />
          <Metric label="Equity" value={money.format(dashboard.summary.totalEquityUsd)} />
        </div>
      ) : (
        <p>No archive data yet.</p>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

function Bar({ outcome, value }: { outcome: string; value: number }) {
  return (
    <div className="bar-row">
      <div className="bar-copy"><span>{outcome}</span><strong>{value}</strong></div>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.max(6, Math.min(100, value))}%` }} /></div>
    </div>
  );
}

function Empty({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty-card">
      <div className="empty-orbit" />
      <h3>{title}</h3>
      <p>{body}</p>
      {action && onAction ? <button type="button" className="secondary-button" onClick={onAction}>{action}</button> : null}
    </div>
  );
}

function wrapTrades(label: string, trades?: StrategyTrade[]) {
  return (trades ?? []).map((trade) => ({ label, trade }));
}

function routeLabel(route: Route) {
  if (route === "/") return "Overview";
  if (route === "/radar") return "Market radar";
  if (route === "/whales") return "Smart money";
  if (route === "/gap-lab") return "Gap lab";
  if (route === "/playbooks") return "Playbooks";
  return "Workspace";
}

function quality(market: MarketAggregate) {
  const lead = market.outcomeWeights[0]?.weight ?? 0;
  const freshnessPenalty = Math.min(35, (Date.now() - market.latestTimestamp) / 600000);
  const priceContext = market.observedAvgEntry ? Math.max(0, 15 - Math.abs(market.latestSignal.averagePrice - market.observedAvgEntry) * 100) : 7;
  return Math.max(1, Math.min(99, Math.round(market.weightedScore * 0.45 + lead * 0.3 + market.participantCount * 2 + priceContext - freshnessPenalty)));
}

function tierLabel(tier: TraderSummary["tier"]) {
  if (tier === "whale") return "Whale";
  if (tier === "shark") return "Shark";
  if (tier === "pro") return "Pro";
  return "Large trader";
}

function timeAgo(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export default App;
