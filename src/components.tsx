import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import type {
  AnalyzerSelection,
  AppRoute,
  HistoryPoint,
  SignalDetailResponse,
  SignalSummary,
} from "./types";
import {
  emitFavoritesUpdated,
  fetchJson,
  favoritesEventName,
  formatDate,
  formatPercent,
  formatPrice,
  formatRelativeDays,
  getSignalConviction,
  legacyRouteMap,
  parseOutcomePrice,
} from "./utils";

export const icons = {
  home: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10.8V20h14v-9.2" />
      <path d="M10 20v-5h4v5" />
    </svg>
  ),
  signals: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  ),
  markets: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2.7 8.1-8.1 2.7 2.7-8.1 8.1-2.7Z" />
    </svg>
  ),
  traders: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="10" cy="7" r="4" />
      <path d="M21 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.8 8.8 0 0 1-3.4-.68L3 21l1.68-5.59A8.5 8.5 0 1 1 21 11.5Z" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  ),
  external: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 5h5v5" />
      <path d="M10 14 19 5" />
      <path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
  spark: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 0 1-15.5 6.4" />
      <path d="M3 12A9 9 0 0 1 18.5 5.6" />
      <path d="M3 4v5h5" />
      <path d="M21 20v-5h-5" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.2 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z" />
    </svg>
  ),
};

const analysisSteps = [
  "מאמת כתובת שוק",
  "מושך נתוני מחירים ונזילות",
  "מאתר את חוזה היעד",
  "מריץ קריאת מצב עם AI",
  "מרכיב מסקנות להחלטה מהירה",
];

export function interceptInternalNavigation(event: MouseEvent<HTMLAnchorElement>, href: AppRoute, navigate: (route: AppRoute) => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return;
  }

  event.preventDefault();
  navigate(href);
}

export function Sidebar({
  route,
  mobileOpen,
  onClose,
  onOpen,
  onNavigate,
}: {
  route: AppRoute;
  mobileOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  onNavigate: (route: AppRoute) => void;
}) {
  const navItems: Array<{ route: AppRoute; label: string; icon: ReactNode }> = [
    { route: "/", label: "דף הבית", icon: icons.home },
    { route: "/signals", label: "סורק השוק", icon: icons.signals },
    { route: "/markets", label: "כל האירועים", icon: icons.markets },
    { route: "/smart-traders", label: "רדאר הכרישים", icon: icons.traders },
    { route: "/chat", label: "צ'אט הקהילה", icon: icons.chat },
    { route: "/history", label: "הפעילות שלי", icon: icons.history },
  ];

  return (
    <>
      <button type="button" className="mobile-toggle" onClick={mobileOpen ? onClose : onOpen} aria-label="פתח תפריט">
        ☰
      </button>
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <a
            href="/"
            onClick={(event) => {
              interceptInternalNavigation(event, "/", onNavigate);
              onClose();
            }}
          >
            <img src="/logo.png" alt="Money Radar" />
          </a>
          <div>
            <strong>רדאר הכסף</strong>
            <small>React-native clone</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <a
              key={item.route}
              href={item.route}
              className={`sidebar-link ${route === item.route ? "sidebar-link-active" : ""}`}
              onClick={(event) => {
                interceptInternalNavigation(event, item.route, onNavigate);
                onClose();
              }}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span>{item.label}</span>
            </a>
          ))}
        </nav>

        <div className="sidebar-footer">
          <a href="/privacy" onClick={(event) => interceptInternalNavigation(event, "/privacy", onNavigate)}>פרטיות</a>
          <a href="/terms" onClick={(event) => interceptInternalNavigation(event, "/terms", onNavigate)}>תנאים</a>
          <a href="/faq" onClick={(event) => interceptInternalNavigation(event, "/faq", onNavigate)}>שאלות</a>
        </div>
      </aside>
    </>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section className="page-intro">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </section>
  );
}

export function SignalCard({
  signal,
  onOpen,
  compact = true,
  favorite,
}: {
  signal: SignalSummary;
  onOpen: (signal: SignalSummary) => void;
  compact?: boolean;
  favorite?: {
    active: boolean;
    busy?: boolean;
    onToggle: () => void;
  };
}) {
  const conviction = getSignalConviction(signal);
  const spread = Math.abs(conviction.yes - conviction.no);

  return (
    <article className={`signal-card ${compact ? "" : "signal-card-featured"}`}>
      <div className="signal-image">
        {signal.image ? <img src={signal.image} alt={signal.question} loading="lazy" /> : <div className="image-fallback">MR</div>}
        <div className="signal-overlay">
          <span>{signal.category ?? "General"}</span>
          <span>{formatRelativeDays(signal.days_left)}</span>
        </div>
      </div>
      <div className="signal-body">
        <div className="signal-topline">
          <span className="signal-badge">{signal.smart_money_side ?? "Signal"}</span>
          <span className="signal-price">{formatPrice(signal.last_price)}</span>
        </div>
        <h3>{signal.question}</h3>
        <p>{signal.context_response ?? signal.description?.slice(0, 140) ?? "קריאת מצב חיה מהשוק."}</p>
        <div className="signal-meter">
          <div className="signal-meter-fill" style={{ width: `${Math.max(12, conviction.yes)}%` }} />
        </div>
        <div className="signal-split">
          <span>כן {formatPercent(conviction.yes)}</span>
          <span>פער {formatPercent(spread)}</span>
          <span>לא {formatPercent(conviction.no)}</span>
        </div>
        <div className="card-actions">
          <button type="button" className="ghost-button" onClick={() => onOpen(signal)}>
            פתח פירוט
          </button>
          {favorite ? (
            <button type="button" className="ghost-button" onClick={favorite.onToggle} disabled={favorite.busy}>
              <span className="button-icon">{icons.star}</span>
              {favorite.active ? "Saved" : favorite.busy ? "Saving..." : "Save"}
            </button>
          ) : null}
          {signal.url ? (
            <a className="link-button" href={signal.url} target="_blank" rel="noreferrer">
              <span className="button-icon">{icons.external}</span>
              Polymarket
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function AnalyzerPanel({
  onOpenSignal,
  onTrackAnalysis,
}: {
  onOpenSignal: (signal: SignalSummary) => void;
  onTrackAnalysis: (signal: SignalSummary) => void;
}) {
  const [url, setUrl] = useState("");
  const [context, setContext] = useState("");
  const [selection, setSelection] = useState<AnalyzerSelection | null>(null);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [loadingStep, setLoadingStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signal, setSignal] = useState<SignalSummary | null>(null);

  useEffect(() => {
    if (loadingStep === null) {
      return;
    }

    const interval = window.setInterval(() => {
      setLoadingStep((current) => {
        if (current === null) {
          return current;
        }
        return Math.min(current + 1, analysisSteps.length - 1);
      });
    }, 2200);

    return () => window.clearInterval(interval);
  }, [loadingStep]);

  const runAnalysis = async (event: FormEvent, explicitSlug?: string) => {
    event.preventDefault();
    setError(null);
    setSignal(null);
    setSelection(null);
    setLoadingStep(0);

    try {
      const payload = await fetchJson<
        | { success: true; type: "single"; signal: SignalSummary }
        | { success: true; type: "multi"; event: { title: string; description?: string; slug?: string }; subMarkets: AnalyzerSelection["subMarkets"] }
      >("/api/analyze", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          context: context.trim() || undefined,
          selectedMarketSlug: explicitSlug,
        }),
      });

      if (payload.type === "multi") {
        setSelection({
          title: payload.event.title,
          description: payload.event.description,
          slug: payload.event.slug,
          subMarkets: payload.subMarkets,
        });
        setSelectedSlug("");
        return;
      }

      setSignal(payload.signal);
      onTrackAnalysis(payload.signal);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : "הניתוח נכשל");
    } finally {
      setLoadingStep(null);
    }
  };

  return (
    <section className="hero-card analyzer-card">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AI Analysis</span>
          <h2>נתח שוק ישירות מ-Polymarket</h2>
        </div>
        <p>אותו flow שהאתר המקורי הפעיל, רק עכשיו כמסך React מקומי בלי embed.</p>
      </div>

      {!selection && !signal && loadingStep === null ? (
        <form className="analyzer-form" onSubmit={(event) => void runAnalysis(event)}>
          <div className="form-grid">
            <label>
              <span>כתובת שוק</span>
              <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://polymarket.com/event/..." />
            </label>
            <label>
              <span>הקשר נוסף</span>
              <textarea
                rows={3}
                value={context}
                onChange={(event) => setContext(event.target.value)}
                placeholder="מאקרו, סנטימנט, קטליזטורים, סיכונים..."
              />
            </label>
          </div>
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="button-row">
            <button type="submit" className="primary-button">
              <span className="button-icon">{icons.spark}</span>
              קבל ניתוח
            </button>
          </div>
        </form>
      ) : null}

      {loadingStep !== null ? (
        <div className="analysis-loading">
          <div className="spinner" />
          <div>
            <h3>המנוע עובד על זה</h3>
            <p>הבקשה עוברת דרך השרת המקומי והמקורות החיים שזיהינו.</p>
          </div>
          <ul className="detail-list">
            {analysisSteps.map((step, index) => (
              <li key={step} className={index <= loadingStep ? "is-active" : ""}>
                {step}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {selection ? (
        <div className="multi-select-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Event Split</span>
              <h3>{selection.title}</h3>
            </div>
            <p>{selection.description ?? "בחר את תת-השוק המדויק לניתוח."}</p>
          </div>
          <div className="selection-list">
            {selection.subMarkets
              .filter((item) => item.active !== false && item.closed !== true)
              .map((item) => (
                <button
                  key={item.slug}
                  type="button"
                  className={`selection-item ${selectedSlug === item.slug ? "selection-item-active" : ""}`}
                  onClick={() => setSelectedSlug(item.slug)}
                >
                  <div>
                    <strong>{item.groupItemTitle ?? item.question}</strong>
                    <small>{item.question}</small>
                  </div>
                  <span>{formatPrice(parseOutcomePrice(item.outcomePrices))}</span>
                </button>
              ))}
          </div>
          <div className="button-row">
            <button type="button" className="ghost-button" onClick={() => setSelection(null)}>
              חזור
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!selectedSlug}
              onClick={(event) => void runAnalysis(event as unknown as FormEvent, selectedSlug)}
            >
              נתח את הבחירה
            </button>
          </div>
        </div>
      ) : null}

      {signal ? (
        <div className="analysis-result">
          <SignalCard signal={signal} onOpen={onOpenSignal} compact={false} />
          <div className="button-row">
            <button type="button" className="primary-button" onClick={() => onOpenSignal(signal)}>
              פתח ניתוח מלא
            </button>
            <button type="button" className="ghost-button" onClick={() => setSignal(null)}>
              נתח שוק נוסף
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SignalDetailModal({
  signal,
  onClose,
  onTrackAnalysis,
}: {
  signal: SignalSummary;
  onClose: () => void;
  onTrackAnalysis: (signal: SignalSummary) => void;
}) {
  const [detail, setDetail] = useState<SignalDetailResponse | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [favoriteActive, setFavoriteActive] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const [detailPayload, historyPayload] = await Promise.all([
          fetchJson<SignalDetailResponse>(`/api/signal-detail?slug=${encodeURIComponent(signal.slug)}`),
          fetchJson<{ success: true; history: HistoryPoint[] }>(`/api/history-prices?slug=${encodeURIComponent(signal.slug)}`),
        ]);

        if (!cancelled) {
          setDetail(detailPayload);
          setHistory(historyPayload.history ?? []);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "הטעינה נכשלה");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [signal.slug]);

  useEffect(() => {
    let cancelled = false;

    const loadFavoriteState = async () => {
      try {
        const payload = await fetchJson<{ markets: Array<{ market_id: string }> }>("/api/favorites/markets");
        if (!cancelled) {
          setFavoriteActive((payload.markets ?? []).some((market) => market.market_id === signal.market_id));
        }
      } catch {
        if (!cancelled) {
          setFavoriteActive(false);
        }
      }
    };

    void loadFavoriteState();
    const onFavoritesChanged = () => {
      void loadFavoriteState();
    };

    window.addEventListener(favoritesEventName, onFavoritesChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(favoritesEventName, onFavoritesChanged);
    };
  }, [signal.market_id]);

  const conviction = getSignalConviction(signal);

  const toggleFavorite = async () => {
    setFavoriteBusy(true);
    setFavoriteError(null);

    try {
      if (favoriteActive) {
        await fetchJson(`/api/favorites/markets?market_id=${encodeURIComponent(signal.market_id)}`, {
          method: "DELETE",
        });
        setFavoriteActive(false);
      } else {
        await fetchJson("/api/favorites/markets", {
          method: "POST",
          body: JSON.stringify({
            market_id: signal.market_id,
            slug: signal.slug,
            question: signal.question,
            category: signal.category ?? "",
            url: signal.url ?? "",
            saved_price: signal.last_price ?? null,
          }),
        });
        setFavoriteActive(true);
      }

      emitFavoritesUpdated();
    } catch (toggleError) {
      setFavoriteError(toggleError instanceof Error ? toggleError.message : "Unable to update favorite.");
    } finally {
      setFavoriteBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">Signal Drilldown</span>
            <h3>{signal.question}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="סגור">
            {icons.close}
          </button>
        </div>

        <div className="modal-grid">
          <div className="modal-hero">
            {signal.image ? <img src={signal.image} alt={signal.question} /> : <div className="image-fallback">MR</div>}
            <div className="metric-pills">
              <span>{signal.category ?? "כללי"}</span>
              <span>{formatPrice(signal.last_price)}</span>
              <span>{signal.smart_money_side ?? "Signal"}</span>
            </div>
          </div>

          <div className="modal-stack">
            <div className="stat-row">
              <article className="stat-card">
                <span>הטיית כסף חכם</span>
                <strong>{signal.smart_money_side ?? "N/A"}</strong>
                <small>כן {formatPercent(conviction.yes)} / לא {formatPercent(conviction.no)}</small>
              </article>
              <article className="stat-card">
                <span>דדליין</span>
                <strong>{formatRelativeDays(signal.days_left)}</strong>
                <small>{formatDate(signal.end_date)}</small>
              </article>
            </div>

            <article className="detail-panel">
              <div className="panel-head">
                <h4>תנועת מחיר</h4>
                <span>{history.length} נקודות</span>
              </div>
              {loading ? <div className="loading-line" /> : <Sparkline points={history} />}
            </article>

            <article className="detail-panel">
              <div className="panel-head">
                <h4>פירוק AI</h4>
                <span>{signal.estimable_method ?? "market_price"}</span>
              </div>
              {error ? (
                <div className="empty-card">{error}</div>
              ) : (
                <>
                  <p className="detail-copy">{detail?.reasoning ?? signal.context_response ?? "אין ניתוח זמין כרגע."}</p>
                  <ul className="detail-list">
                    {(detail?.data_points ?? signal.fair_value_calculation?.data_points ?? []).map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </>
              )}
            </article>

            <article className="detail-panel">
              <div className="panel-head">
                <h4>כללי הכרעה</h4>
                <span>מקורות: {(signal.data_sources ?? []).join(" · ") || "Polymarket"}</span>
              </div>
              <p className="detail-copy">{signal.description ?? "אין תיאור זמין לחוזה זה."}</p>
            </article>

            {favoriteError ? <div className="error-banner">{favoriteError}</div> : null}

            <div className="modal-actions">
              {signal.url ? (
                <a className="ghost-button" href={signal.url} target="_blank" rel="noreferrer">
                  <span className="button-icon">{icons.external}</span>
                  פתח ב-Polymarket
                </a>
              ) : null}
              <button type="button" className="ghost-button" onClick={() => void toggleFavorite()} disabled={favoriteBusy}>
                <span className="button-icon">{icons.star}</span>
                {favoriteActive ? "Remove saved market" : favoriteBusy ? "Saving..." : "Save market"}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  onTrackAnalysis(signal);
                  onClose();
                }}
              >
                <span className="button-icon">{icons.spark}</span>
                שמור כניתוח מקומי
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sparkline({ points }: { points: HistoryPoint[] }) {
  if (!points.length) {
    return <div className="empty-card">עדיין אין היסטוריית מחיר להצגה.</div>;
  }

  const width = 560;
  const height = 180;
  const padding = 16;
  const prices = points.map((point) => point.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 0.01;
  const path = points
    .map((point, index) => {
      const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point.p - min) / range) * (height - padding * 2);
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");
  const last = points[points.length - 1];

  return (
    <div className="sparkline-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" role="img" aria-label="תנועת מחיר">
        <defs>
          <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(55, 208, 255, 0.38)" />
            <stop offset="100%" stopColor="rgba(55, 208, 255, 0)" />
          </linearGradient>
        </defs>
        <path d={`M ${padding} ${height - padding} ${path.slice(1)} L ${width - padding} ${height - padding} Z`} fill="url(#spark-fill)" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="sparkline-caption">
        <span>מחיר אחרון</span>
        <strong>{formatPrice(last?.p)}</strong>
      </div>
    </div>
  );
}

export function SkeletonGrid() {
  return (
    <div className="card-grid">
      {Array.from({ length: 6 }).map((_, index) => (
        <article key={index} className="signal-card skeleton-card">
          <div className="signal-image skeleton-block" />
          <div className="signal-body">
            <div className="skeleton-line short" />
            <div className="skeleton-line" />
            <div className="skeleton-line" />
            <div className="skeleton-line medium" />
          </div>
        </article>
      ))}
    </div>
  );
}

export function SkeletonTable() {
  return (
    <section className="market-table">
      {Array.from({ length: 6 }).map((_, index) => (
        <article key={index} className="market-row">
          <div className="market-main">
            <div className="skeleton-avatar" />
            <div className="skeleton-stack">
              <div className="skeleton-line medium" />
              <div className="skeleton-line short" />
            </div>
          </div>
          <div className="market-metrics">
            <div className="skeleton-chip" />
            <div className="skeleton-chip" />
            <div className="skeleton-chip" />
          </div>
        </article>
      ))}
    </section>
  );
}

export function LegacyBridge({
  route,
  navigate,
}: {
  route: Exclude<AppRoute, "/" | "/signals" | "/markets" | "/smart-traders" | "/chat" | "/history">;
  navigate: (route: AppRoute) => void;
}) {
  const src = legacyRouteMap[route];

  return (
    <section className="legacy-bridge">
      <div className="detail-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Legacy Page</span>
            <h2>עמוד זה עדיין משתמש במראה המשוחזר</h2>
          </div>
          <p>מסכי הליבה כבר נבנו מחדש ב-React. העמוד הזה נשאר זמין כדי לא לשבור את הניווט ההיקפי.</p>
        </div>
        <div className="bridge-actions">
          <a className="primary-button" href={src}>
            פתח את הגרסה המקומית
          </a>
          <a href="/" onClick={(event) => interceptInternalNavigation(event, "/", navigate)} className="ghost-button">
            חזור לדשבורד
          </a>
        </div>
        <iframe title={route} src={src} className="bridge-frame" />
      </div>
    </section>
  );
}
