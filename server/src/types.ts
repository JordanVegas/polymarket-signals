export type MarketRecord = {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  image: string;
  endDate: string;
  liquidity: number;
  volume24hr: number;
  outcomeByAssetId: Record<string, string>;
};

export type TradeRecord = {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon?: string;
  outcome: string;
  pseudonym?: string;
  name?: string;
  profileImage?: string;
  transactionHash: string;
};

export type TraderSummary = {
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

export type WhaleSignal = {
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

export type AppSnapshot = {
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
    trackedTraderCount: number;
    trackedTraderPollInFlight: number;
    requestStats: {
      windowMinutes: number;
      endpoints: Array<{
        endpoint: string;
        total: number;
        success: number;
        failure: number;
        recent: number;
      }>;
    };
  };
};

export type MarketAggregate = {
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
  outcomeParticipants?: Array<{
    wallet: string;
    outcome: string;
    weight: number;
    tier: TraderSummary["tier"];
    totalUsd: number;
  }>;
  observedAvgEntry: number | null;
  participantCount: number;
  isWatched: boolean;
  latestSignal: WhaleSignal;
};

export type MarketSortOption = "recent" | "weighted" | "buyWeight" | "flow" | "participants";

export type MarketPageResponse = {
  items: MarketAggregate[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

export type WatchMarketResult = {
  isWatched: boolean;
  webhookConfigured: boolean;
};

export type UserProfileResponse = {
  username: string;
  webhookUrl: string;
  monitoredWallet: string;
  autoTradeEnabled: boolean;
  startingBalanceUsd: number;
  currentBalanceUsd: number;
  riskPercent: number;
  tradingWalletAddress: string;
  tradingSignatureType: "EOA" | "POLY_PROXY";
  hasTradingCredentials: boolean;
  watches: Array<{
    marketSlug: string;
    outcome: string;
    marketQuestion: string;
    marketUrl: string;
    source: "manual" | "portfolio_sync";
  }>;
};

export type StrategyPosition = {
  id: string;
  username: string;
  marketSlug: string;
  marketQuestion: string;
  marketUrl: string;
  marketImage: string;
  outcome: string;
  status: "open" | "closed";
  openedAt: number;
  updatedAt: number;
  entryPrice: number;
  lastPrice: number;
  entryNotionalUsd: number;
  remainingShares: number;
  realizedUsd: number;
  originalSmartMoneyWeight: number;
  remainingSmartMoneyWeight: number;
  soldPercent: number;
  trim90Hit: boolean;
  trim93Hit: boolean;
  setupQuality: number;
  exitReason?: string;
  originalParticipants: Array<{
    wallet: string;
    weight: number;
    tier: TraderSummary["tier"];
  }>;
};
