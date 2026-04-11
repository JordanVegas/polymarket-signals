import type { ActivitySignal, AppRoute, CategoryId, SignalSummary } from "./types";

export const nativeRoutes = new Set<AppRoute>([
  "/",
  "/login",
  "/about",
  "/faq",
  "/privacy",
  "/terms",
  "/signals",
  "/markets",
  "/smart-traders",
  "/chat",
  "/history",
  "/auth/callback",
  "/auth/confirm",
  "/reset-password",
]);

export const legacyRouteMap: Record<Exclude<AppRoute, "/" | "/signals" | "/markets" | "/smart-traders" | "/chat" | "/history">, string> =
  {
    "/login": "/legacy/login",
    "/about": "/legacy/about",
    "/faq": "/legacy/faq",
    "/privacy": "/legacy/privacy",
    "/terms": "/legacy/terms",
    "/auth/callback": "/legacy/auth/callback",
    "/auth/confirm": "/legacy/auth/confirm",
    "/reset-password": "/legacy/reset-password",
  };

export const pageTitles: Record<AppRoute, string> = {
  "/": "רדאר הכסף | דף הבית",
  "/signals": "רדאר הכסף | סורק השוק",
  "/markets": "רדאר הכסף | כל האירועים",
  "/smart-traders": "רדאר הכסף | רדאר הכרישים",
  "/chat": "רדאר הכסף | צ'אט הקהילה",
  "/history": "רדאר הכסף | הפעילות שלי",
  "/login": "רדאר הכסף | התחברות",
  "/about": "רדאר הכסף | אודות",
  "/faq": "רדאר הכסף | שאלות",
  "/privacy": "רדאר הכסף | פרטיות",
  "/terms": "רדאר הכסף | תנאים",
  "/auth/callback": "רדאר הכסף | Auth",
  "/auth/confirm": "רדאר הכסף | Confirm",
  "/reset-password": "רדאר הכסף | Reset",
};

export const categoryTabs: Array<{
  id: CategoryId;
  emoji: string;
  label: string;
  description: string;
  query: string;
}> = [
  { id: "israel", emoji: "🇮🇱", label: "ישראל", description: "שווקים עם הקשר ישראלי ואזורי.", query: "/api/batch-signals?israelFilter=true&limit=24" },
  { id: "global", emoji: "🌍", label: "טרנדים", description: "שווקים חמים לפי נפח ותנופה.", query: "/api/batch-signals?sortBy=volume24h&limit=24" },
  { id: "politics", emoji: "🗳️", label: "פוליטיקה", description: "בחירות, ממשלות ורגולציה.", query: "/api/batch-signals?category=Politics&limit=24" },
  { id: "crypto", emoji: "₿", label: "קריפטו", description: "ביטקוין, את'ריום וסנטימנט.", query: "/api/batch-signals?category=Crypto&limit=24" },
  { id: "sports", emoji: "⚽", label: "ספורט", description: "משחקים, ליגות ואירועי ספורט.", query: "/api/batch-signals?category=Sports&limit=24" },
  { id: "business", emoji: "💼", label: "עסקים", description: "חברות, מאקרו וריביות.", query: "/api/batch-signals?category=Business&limit=24" },
  { id: "science", emoji: "🔬", label: "מדע", description: "חדשנות, AI וחלל.", query: "/api/batch-signals?category=Science&limit=24" },
];

const localActivityKey = "money-radar-local-activity";
export const favoritesEventName = "money-radar-favorites";

export function normalizeRoute(pathname: string): AppRoute {
  if (
    pathname === "/"
    || pathname === "/login"
    || pathname === "/about"
    || pathname === "/faq"
    || pathname === "/privacy"
    || pathname === "/terms"
    || pathname === "/signals"
    || pathname === "/markets"
    || pathname === "/smart-traders"
    || pathname === "/chat"
    || pathname === "/history"
    || pathname === "/auth/callback"
    || pathname === "/auth/confirm"
    || pathname === "/reset-password"
  ) {
    return pathname;
  }

  return "/";
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "הבקשה נכשלה");
  }

  return payload as T;
}

export function formatPrice(value?: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }
  return `${Math.round(value * 100)}¢`;
}

export function formatPercent(value?: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }
  return `${Math.round(value)}%`;
}

export function formatCompactNumber(value?: number | null) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }
  return new Intl.NumberFormat("he-IL", { notation: "compact", maximumFractionDigits: value >= 1000 ? 1 : 0 }).format(value);
}

export function formatRelativeDays(days?: number) {
  if (typeof days !== "number" || Number.isNaN(days)) {
    return "ללא תאריך";
  }
  if (days < 1) {
    return "נסגר תוך פחות מיום";
  }
  return `${Math.round(days)} ימים לסיום`;
}

export function formatDate(value?: string) {
  if (!value) {
    return "תאריך לא זמין";
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return "תאריך לא זמין";
  }
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium" }).format(parsed);
}

export function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

export function getSignalConviction(signal: SignalSummary) {
  const yes = signal.wa_smart_yes ?? signal.yes_smart_ratio ?? ((signal.last_price ?? 0.5) * 100);
  const no = signal.wa_smart_no ?? signal.no_smart_ratio ?? (100 - yes);
  return { yes, no };
}

export function readLocalActivity(): ActivitySignal[] {
  try {
    const raw = window.localStorage.getItem(localActivityKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ActivitySignal[]) : [];
  } catch {
    return [];
  }
}

export function recordLocalSignal(signal: SignalSummary, kind: ActivitySignal["kind"]) {
  const entry: ActivitySignal = {
    slug: signal.slug,
    question: signal.question,
    image: signal.image,
    category: signal.category,
    url: signal.url,
    lastPrice: signal.last_price,
    smartSide: signal.smart_money_side,
    timestamp: Date.now(),
    kind,
  };

  const existing = readLocalActivity().filter((item) => !(item.slug === entry.slug && item.kind === entry.kind));
  window.localStorage.setItem(localActivityKey, JSON.stringify([entry, ...existing].slice(0, 40)));
  window.dispatchEvent(new Event("money-radar-activity"));
}

export function emitFavoritesUpdated() {
  window.dispatchEvent(new Event(favoritesEventName));
}

export function parseOutcomePrice(raw?: string) {
  if (!raw) {
    return 0;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === "number") {
      return parsed[0];
    }
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return Number(parsed[0]) || 0;
    }
  } catch {
    return 0;
  }
  return 0;
}
