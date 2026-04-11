export type AppRoute =
  | "/"
  | "/login"
  | "/about"
  | "/faq"
  | "/privacy"
  | "/terms"
  | "/signals"
  | "/markets"
  | "/smart-traders"
  | "/chat"
  | "/history"
  | "/auth/callback"
  | "/auth/confirm"
  | "/reset-password";

export type CategoryId = "israel" | "global" | "politics" | "crypto" | "sports" | "business" | "science";

export type SignalSummary = {
  id: string;
  market_id: string;
  slug: string;
  question: string;
  url?: string;
  image?: string;
  category?: string;
  end_date?: string;
  days_left?: number;
  last_price?: number;
  smart_money_side?: string;
  trader_category?: string;
  yes_smart_ratio?: number;
  no_smart_ratio?: number;
  wa_smart_yes?: number;
  wa_smart_no?: number;
  context_response?: string | null;
  estimable_method?: string;
  data_sources?: string[];
  description?: string;
  groupItemTitle?: string;
  active?: boolean;
  closed?: boolean;
  fair_value_calculation?: {
    reasoning?: string;
    data_points?: string[];
  };
};

export type SignalDetailResponse = {
  success: true;
  reasoning?: string;
  data_points?: string[];
};

export type HistoryPoint = {
  t: number;
  p: number;
};

export type MarketItem = {
  id: string;
  question: string;
  question_he?: string;
  slug: string;
  eventSlug?: string;
  url?: string;
  category?: string;
  category_he?: string;
  tags?: string[];
  yesPrice?: number;
  noPrice?: number;
  liquidity?: number;
  volume?: number;
  volume24h?: number;
  daysLeft?: number;
  endDate?: string;
  description?: string;
  priceChange1h?: number | null;
  priceChange24h?: number | null;
  priceChange1w?: number | null;
  priceChange1mo?: number | null;
  closed?: boolean;
  active?: boolean;
};

export type FavoriteMarket = {
  market_id: string;
  slug?: string;
  question?: string;
  category?: string;
  url?: string;
  saved_price?: number;
  saved_at: number;
};

export type FavoriteTrade = {
  trade_id: string;
  saved_at: number;
  market_name?: string;
  side?: string;
  outcome?: string;
  notional_usd?: number;
};

export type BroadcastMessage = {
  id?: string;
  created_at?: string;
  message?: string;
  username?: string;
  full_name?: string;
  body?: string;
};

export type ActivitySignal = {
  slug: string;
  question: string;
  image?: string;
  category?: string;
  url?: string;
  lastPrice?: number;
  smartSide?: string;
  timestamp: number;
  kind: "viewed" | "analysis";
};

export type AnalyzerSelection = {
  title: string;
  description?: string;
  slug?: string;
  subMarkets: Array<{
    id: string;
    slug: string;
    question: string;
    groupItemTitle?: string;
    outcomePrices?: string;
    active?: boolean;
    closed?: boolean;
  }>;
};
