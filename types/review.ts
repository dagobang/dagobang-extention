export type ReviewVisibility = 'private' | 'public';

export type ReviewMetrics = {
  balance?: string;
  usdValue?: string;
  accuAmount?: string;
  accuCost?: string;
  accuFee?: string;
  historyBoughtAmount?: string;
  historyBoughtCost?: string;
  historyBoughtFee?: string;
  historySoldAmount?: string;
  historySoldIncome?: string;
  historySoldFee?: string;
  historyTotalBuys?: number;
  historyTotalSells?: number;
  realizedProfit?: string;
  realizedProfitPnl?: string | null;
  unrealizedProfit?: string;
  unrealizedProfitPnl?: string | null;
  totalProfit?: string;
  totalProfitPnl?: string | null;
  holdStartAt?: number | null;
  holdEndAt?: number | null;
  lastActiveTimestamp?: number | null;
  tokenPrice?: string;
  liquidity?: string;
  avgBuyPrice?: string;
  avgSellPrice?: string;
  holdDurationSec?: number | null;
  likesCount?: number;
  favoritesCount?: number;
  commentsCount?: number;
  engagementScore?: number;
};

export type TradeReview = {
  id: string;
  walletAddress: string;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName?: string;
  launchpad?: string;
  visibility: ReviewVisibility;
  reviewTitle: string;
  tags: string[];
  narrativeTags: string[];
  mistakes: string[];
  emotionScore: number;
  executionScore: number;
  confidenceScore: number;
  buyLogic: string;
  sellLogic: string;
  summary: string;
  lessonLearned: string;
  nextAction: string;
  holdStartAt?: number | null;
  holdEndAt?: number | null;
  qualityScore?: number;
  engagementScore?: number;
  metrics: ReviewMetrics;
  createdAt: number;
  updatedAt: number;
};

export type TradeReviewUpsertInput = Omit<TradeReview, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

export type TradeReviewFilters = {
  walletAddress?: string;
  chain?: string;
  tokenAddress?: string;
  search?: string;
  limit?: number;
};
