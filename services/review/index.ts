import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { TradeReview, TradeReviewFilters, TradeReviewUpsertInput } from '@/types/review';

const TABLE_NAME = 'trade_reviews';
const CACHE_KEY = 'dagobang_trade_reviews_cache_v1';

type TradeReviewRow = {
  id: string;
  wallet_address: string;
  chain: string;
  token_address: string;
  token_symbol: string;
  token_name?: string | null;
  launchpad?: string | null;
  visibility: 'private' | 'public';
  review_title: string;
  tags: string[];
  narrative_tags?: string[] | null;
  mistakes: string[];
  buy_logic?: string | null;
  sell_logic?: string | null;
  emotion_score: number;
  execution_score: number;
  confidence_score: number;
  quality_score?: number | null;
  likes_count?: number | null;
  favorites_count?: number | null;
  comments_count?: number | null;
  engagement_score?: number | null;
  plan_take_profit: string;
  plan_stop_loss: string;
  summary: string;
  lesson_learned: string;
  next_action: string;
  hold_start_at?: number | null;
  hold_end_at?: number | null;
  metrics: Record<string, any>;
  created_at: string;
  updated_at: string;
};

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeCount(value: any) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function calcEngagementScore(likes: number, favorites: number, comments: number) {
  const raw = likes * 1 + favorites * 2 + comments * 3;
  return clampScore(raw);
}

function calcQualityScore(input: {
  reviewTitle?: string;
  narrativeTags?: string[];
  buyLogic?: string;
  sellLogic?: string;
  summary?: string;
  lessonLearned?: string;
  nextAction?: string;
  mistakes?: string[];
  metrics?: Record<string, any>;
}) {
  let score = 0;
  if ((input.reviewTitle || '').trim().length >= 6) score += 10;
  const narrativeCount = (input.narrativeTags || []).filter(Boolean).length;
  score += Math.min(15, narrativeCount * 5);
  if ((input.buyLogic || '').trim().length >= 12) score += 20;
  if ((input.sellLogic || '').trim().length >= 12) score += 20;
  if ((input.summary || '').trim().length >= 20) score += 12;
  if ((input.lessonLearned || '').trim().length >= 12) score += 8;
  if ((input.nextAction || '').trim().length >= 8) score += 5;
  if ((input.mistakes || []).length > 0) score += 5;
  const m = input.metrics || {};
  const engagementScore = Number(m.engagementScore || 0);
  const metricsChecks = [
    Number.isFinite(Number(m.totalProfitPnl)),
    Number.isFinite(Number(m.avgBuyPrice)),
    Number.isFinite(Number(m.avgSellPrice)),
    Number.isFinite(Number(m.historyTotalBuys)),
    Number.isFinite(Number(m.historyTotalSells)),
    Number.isFinite(Number(m.holdDurationSec)) && Number(m.holdDurationSec) > 0,
  ];
  score += metricsChecks.filter(Boolean).length * 2.5;
  if (engagementScore > 0) {
    score += Math.min(10, engagementScore * 0.1);
  }
  return clampScore(score);
}

function toReview(row: TradeReviewRow): TradeReview {
  const metrics = row.metrics || {};
  const narrativeTags = Array.isArray(row.narrative_tags) ? row.narrative_tags : (Array.isArray(metrics.narrativeTags) ? metrics.narrativeTags : []);
  const buyLogic = typeof row.buy_logic === 'string'
    ? row.buy_logic
    : (typeof metrics.buyLogic === 'string' ? metrics.buyLogic : '');
  const sellLogic = typeof row.sell_logic === 'string'
    ? row.sell_logic
    : (typeof metrics.sellLogic === 'string' ? metrics.sellLogic : '');
  const likesCount = Number.isFinite(Number(row.likes_count)) ? normalizeCount(row.likes_count) : normalizeCount(metrics.likesCount);
  const favoritesCount = Number.isFinite(Number(row.favorites_count)) ? normalizeCount(row.favorites_count) : normalizeCount(metrics.favoritesCount);
  const commentsCount = Number.isFinite(Number(row.comments_count)) ? normalizeCount(row.comments_count) : normalizeCount(metrics.commentsCount);
  const engagementScore = Number.isFinite(Number(row.engagement_score))
    ? clampScore(Number(row.engagement_score))
    : calcEngagementScore(likesCount, favoritesCount, commentsCount);
  metrics.likesCount = likesCount;
  metrics.favoritesCount = favoritesCount;
  metrics.commentsCount = commentsCount;
  metrics.engagementScore = engagementScore;
  const qualityScore = Number.isFinite(Number(row.quality_score))
    ? clampScore(Number(row.quality_score))
    : calcQualityScore({
      reviewTitle: row.review_title,
      narrativeTags,
      buyLogic,
      sellLogic,
      summary: row.summary,
      lessonLearned: row.lesson_learned,
      nextAction: row.next_action,
      mistakes: Array.isArray(row.mistakes) ? row.mistakes : [],
      metrics,
    });
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    chain: row.chain,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenName: row.token_name || '',
    launchpad: row.launchpad || '',
    visibility: row.visibility,
    reviewTitle: row.review_title,
    tags: Array.isArray(row.tags) ? row.tags : [],
    narrativeTags,
    mistakes: Array.isArray(row.mistakes) ? row.mistakes : [],
    emotionScore: Number(row.emotion_score || 0),
    executionScore: Number(row.execution_score || 0),
    confidenceScore: Number(row.confidence_score || 0),
    buyLogic,
    sellLogic,
    summary: row.summary || '',
    lessonLearned: row.lesson_learned || '',
    nextAction: row.next_action || '',
    holdStartAt: row.hold_start_at ?? null,
    holdEndAt: row.hold_end_at ?? null,
    qualityScore,
    engagementScore,
    metrics,
    createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
    updatedAt: Math.floor(new Date(row.updated_at).getTime() / 1000),
  };
}

function toRow(input: TradeReviewUpsertInput): Omit<TradeReviewRow, 'created_at' | 'updated_at'> {
  const narrativeTags = input.narrativeTags || [];
  const buyLogic = input.buyLogic || '';
  const sellLogic = input.sellLogic || '';
  const likesCount = normalizeCount(input.metrics?.likesCount);
  const favoritesCount = normalizeCount(input.metrics?.favoritesCount);
  const commentsCount = normalizeCount(input.metrics?.commentsCount);
  const engagementScore = calcEngagementScore(likesCount, favoritesCount, commentsCount);
  const mergedMetrics = {
    ...(input.metrics || {}),
    narrativeTags,
    buyLogic,
    sellLogic,
    likesCount,
    favoritesCount,
    commentsCount,
    engagementScore,
  };
  const qualityScore = calcQualityScore({
    reviewTitle: input.reviewTitle,
    narrativeTags,
    buyLogic,
    sellLogic,
    summary: input.summary,
    lessonLearned: input.lessonLearned,
    nextAction: input.nextAction,
    mistakes: input.mistakes,
    metrics: mergedMetrics,
  });
  return {
    id: input.id ?? crypto.randomUUID(),
    wallet_address: input.walletAddress,
    chain: input.chain,
    token_address: input.tokenAddress.toLowerCase(),
    token_symbol: input.tokenSymbol,
    token_name: input.tokenName || '',
    launchpad: input.launchpad || '',
    visibility: input.visibility,
    review_title: input.reviewTitle,
    tags: input.tags || [],
    narrative_tags: narrativeTags,
    mistakes: input.mistakes || [],
    buy_logic: buyLogic,
    sell_logic: sellLogic,
    emotion_score: input.emotionScore,
    execution_score: input.executionScore,
    confidence_score: input.confidenceScore,
    quality_score: qualityScore,
    likes_count: likesCount,
    favorites_count: favoritesCount,
    comments_count: commentsCount,
    engagement_score: engagementScore,
    plan_take_profit: '',
    plan_stop_loss: '',
    summary: input.summary,
    lesson_learned: input.lessonLearned,
    next_action: input.nextAction,
    hold_start_at: input.holdStartAt ?? null,
    hold_end_at: input.holdEndAt ?? null,
    metrics: mergedMetrics,
  };
}

function getSupabaseConfig() {
  const envUrl = (import.meta as any).env?.WXT_PUBLIC_SUPABASE_URL || '';
  const envAnon = (import.meta as any).env?.WXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const localUrl = window.localStorage.getItem('dagobang_supabase_url') || '';
  const localAnon = window.localStorage.getItem('dagobang_supabase_anon_key') || '';
  const url = String(localUrl || envUrl || '').trim();
  const anonKey = String(localAnon || envAnon || '').trim();
  return { url, anonKey };
}

function getCache(): TradeReview[] {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TradeReview[];
  } catch {
    return [];
  }
}

function setCache(items: TradeReview[]) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(items));
  } catch {
  }
}

function filterReviews(items: TradeReview[], filters: TradeReviewFilters = {}) {
  const search = (filters.search || '').trim().toLowerCase();
  const tokenAddress = (filters.tokenAddress || '').trim().toLowerCase();
  let result = items.filter((item) => {
    if (filters.walletAddress && item.walletAddress.toLowerCase() !== filters.walletAddress.toLowerCase()) return false;
    if (filters.chain && item.chain !== filters.chain) return false;
    if (tokenAddress && item.tokenAddress.toLowerCase() !== tokenAddress) return false;
    if (!search) return true;
    const combined = [
      item.tokenAddress,
      item.tokenSymbol,
      item.tokenName || '',
      item.reviewTitle,
      item.summary,
      item.buyLogic,
      item.sellLogic,
      item.lessonLearned,
      item.nextAction,
      item.tags.join(' '),
      item.narrativeTags.join(' '),
      item.mistakes.join(' ')
    ].join(' ').toLowerCase();
    return combined.includes(search);
  });
  result = result.sort((a, b) => b.updatedAt - a.updatedAt);
  if (filters.limit && filters.limit > 0) {
    return result.slice(0, filters.limit);
  }
  return result;
}

export class ReviewService {
  private static client: SupabaseClient | null = null;
  private static configKey = '';

  private static getClient() {
    const cfg = getSupabaseConfig();
    const key = `${cfg.url}|${cfg.anonKey}`;
    if (!cfg.url || !cfg.anonKey) return null;
    if (!this.client || this.configKey !== key) {
      this.client = createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { 'x-client-info': 'dagobang-review/1.0.0' } },
      });
      this.configKey = key;
    }
    return this.client;
  }

  static async list(filters: TradeReviewFilters = {}): Promise<{ items: TradeReview[]; source: 'cloud' | 'local' }> {
    const client = this.getClient();
    if (!client) {
      return { items: filterReviews(getCache(), filters), source: 'local' };
    }
    try {
      let query = client
        .from(TABLE_NAME)
        .select('*')
        .order('updated_at', { ascending: false });
      if (filters.walletAddress) {
        query = query.eq('wallet_address', filters.walletAddress.toLowerCase());
      }
      if (filters.chain) {
        query = query.eq('chain', filters.chain);
      }
      if (filters.tokenAddress) {
        query = query.eq('token_address', filters.tokenAddress.toLowerCase());
      }
      if (filters.limit && filters.limit > 0) {
        query = query.limit(filters.limit);
      }
      const { data, error } = await query;
      if (error) throw error;
      const items = Array.isArray(data) ? (data as TradeReviewRow[]).map(toReview) : [];
      const filtered = filterReviews(items, { ...filters, tokenAddress: undefined, walletAddress: undefined, chain: undefined, limit: undefined });
      setCache(items);
      return { items: filtered, source: 'cloud' };
    } catch {
      return { items: filterReviews(getCache(), filters), source: 'local' };
    }
  }

  static async upsert(input: TradeReviewUpsertInput): Promise<{ item: TradeReview; source: 'cloud' | 'local' }> {
    const row = toRow(input);
    const client = this.getClient();
    if (!client) {
      const cache = getCache();
      const idx = cache.findIndex((it) => it.id === row.id);
      const next: TradeReview = {
        ...toReview({
          ...row,
          created_at: new Date((idx >= 0 ? cache[idx].createdAt : nowUnix()) * 1000).toISOString(),
          updated_at: new Date(nowUnix() * 1000).toISOString(),
        }),
      };
      if (idx >= 0) cache[idx] = next;
      else cache.unshift(next);
      setCache(cache);
      return { item: next, source: 'local' };
    }
    const payload = { ...row };
    let { data, error } = await client
      .from(TABLE_NAME)
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single();
    if (error && /column .* does not exist/i.test(String(error.message || ''))) {
      const legacyPayload: Record<string, any> = { ...payload };
      delete legacyPayload.narrative_tags;
      delete legacyPayload.buy_logic;
      delete legacyPayload.sell_logic;
      delete legacyPayload.quality_score;
      delete legacyPayload.likes_count;
      delete legacyPayload.favorites_count;
      delete legacyPayload.comments_count;
      delete legacyPayload.engagement_score;
      const retried = await client
        .from(TABLE_NAME)
        .upsert(legacyPayload, { onConflict: 'id' })
        .select('*')
        .single();
      data = retried.data;
      error = retried.error;
    }
    if (error || !data) {
      const cache = getCache();
      const fallback: TradeReview = {
        ...toReview({
          ...row,
          created_at: new Date(nowUnix() * 1000).toISOString(),
          updated_at: new Date(nowUnix() * 1000).toISOString(),
        }),
      };
      const idx = cache.findIndex((it) => it.id === fallback.id);
      if (idx >= 0) cache[idx] = fallback;
      else cache.unshift(fallback);
      setCache(cache);
      return { item: fallback, source: 'local' };
    }
    const item = toReview(data as TradeReviewRow);
    const cache = getCache();
    const idx = cache.findIndex((it) => it.id === item.id);
    if (idx >= 0) cache[idx] = item;
    else cache.unshift(item);
    setCache(cache);
    return { item, source: 'cloud' };
  }

  static async remove(id: string): Promise<{ ok: true; source: 'cloud' | 'local' }> {
    const client = this.getClient();
    if (!client) {
      setCache(getCache().filter((it) => it.id !== id));
      return { ok: true, source: 'local' };
    }
    try {
      const { error } = await client.from(TABLE_NAME).delete().eq('id', id);
      if (error) throw error;
      setCache(getCache().filter((it) => it.id !== id));
      return { ok: true, source: 'cloud' };
    } catch {
      setCache(getCache().filter((it) => it.id !== id));
      return { ok: true, source: 'local' };
    }
  }
}
