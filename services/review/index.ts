import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { browser } from 'wxt/browser';
import type { TradeReview, TradeReviewFilters, TradeReviewUpsertInput } from '@/types/review';
import { isSolanaAddress, normalizeAddress, normalizeAddressKey } from '@/services/xSniper/engine/metrics';
import { normalizeUnixSeconds, readReviewSample } from '@/services/review/sample';

const TABLE_NAME = 'trade_reviews';
const CACHE_KEY = 'dagobang_trade_reviews_cache_v1';
const SUPABASE_STORAGE_KEY = 'dagobang_supabase_config_v1';
const TAG_STORAGE_KEY = 'dagobang_review_tags_v1';

export type ReviewTagCatalog = {
  narratives: string[];
  catalysts: string[];
  results: string[];
};
const SUPABASE_URL_KEY = 'dagobang_supabase_url';
const SUPABASE_ANON_KEY = 'dagobang_supabase_anon_key';

type SupabaseConfig = { url: string; anonKey: string };

let storedConfig: SupabaseConfig | null = null;
let configHydrated = false;
let hydratePromise: Promise<SupabaseConfig> | null = null;

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
  const sample = readReviewSample({ metrics, narrativeTags });
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
    narrative: sample.narrative,
    catalyst: sample.catalyst,
    catalystNote: sample.catalystNote,
    catalystResult: sample.catalystResult,
    peakMarketCap: sample.peakMarketCap,
    notionPageId: sample.notionPageId,
    notionSyncedHash: sample.notionSyncedHash,
    mistakes: Array.isArray(row.mistakes) ? row.mistakes : [],
    emotionScore: Number(row.emotion_score || 0),
    executionScore: Number(row.execution_score || 0),
    confidenceScore: Number(row.confidence_score || 0),
    buyLogic,
    sellLogic,
    summary: row.summary || '',
    lessonLearned: row.lesson_learned || '',
    nextAction: row.next_action || '',
    holdStartAt: normalizeUnixSeconds(row.hold_start_at ?? metrics.holdStartAt),
    holdEndAt: normalizeUnixSeconds(row.hold_end_at ?? metrics.holdEndAt),
    qualityScore,
    engagementScore,
    metrics,
    createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
    updatedAt: Math.floor(new Date(row.updated_at).getTime() / 1000),
  };
}

function toRow(input: TradeReviewUpsertInput): Omit<TradeReviewRow, 'created_at' | 'updated_at'> {
  const narrative = String(input.narrative || '').trim();
  const narrativeTags = narrative ? [narrative] : (input.narrativeTags || []);
  const buyLogic = input.buyLogic || '';
  const sellLogic = input.sellLogic || '';
  const likesCount = normalizeCount(input.metrics?.likesCount);
  const favoritesCount = normalizeCount(input.metrics?.favoritesCount);
  const commentsCount = normalizeCount(input.metrics?.commentsCount);
  const engagementScore = calcEngagementScore(likesCount, favoritesCount, commentsCount);
  const peak = Number(input.peakMarketCap);
  const holdStartAt = normalizeUnixSeconds(input.holdStartAt ?? input.metrics?.holdStartAt);
  const holdEndAt = normalizeUnixSeconds(input.holdEndAt ?? input.metrics?.holdEndAt);
  const mergedMetrics = {
    ...(input.metrics || {}),
    narrativeTags,
    narrative,
    catalyst: String(input.catalyst || '').trim(),
    catalystNote: String(input.catalystNote || '').trim(),
    catalystResult: String(input.catalystResult || '').trim(),
    peakMarketCap: Number.isFinite(peak) && peak > 0 ? peak : null,
    notionPageId: String(input.notionPageId || '').trim(),
    notionSyncedHash: String(input.notionSyncedHash || '').trim(),
    holdStartAt,
    holdEndAt,
    holdDurationSec: holdStartAt && holdEndAt ? Math.max(0, holdEndAt - holdStartAt) : (input.metrics?.holdDurationSec ?? null),
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
    wallet_address: normalizeAddress(input.walletAddress) ?? input.walletAddress,
    chain: input.chain,
    token_address: normalizeAddress(input.tokenAddress) ?? input.tokenAddress,
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
    hold_start_at: holdStartAt,
    hold_end_at: holdEndAt,
    metrics: mergedMetrics,
  };
}

function readPageConfig(): SupabaseConfig {
  try {
    return {
      url: String(window.localStorage.getItem(SUPABASE_URL_KEY) || '').trim(),
      anonKey: String(window.localStorage.getItem(SUPABASE_ANON_KEY) || '').trim(),
    };
  } catch {
    return { url: '', anonKey: '' };
  }
}

function writePageConfig(config: SupabaseConfig) {
  try {
    if (config.url) window.localStorage.setItem(SUPABASE_URL_KEY, config.url);
    else window.localStorage.removeItem(SUPABASE_URL_KEY);
    if (config.anonKey) window.localStorage.setItem(SUPABASE_ANON_KEY, config.anonKey);
    else window.localStorage.removeItem(SUPABASE_ANON_KEY);
  } catch {
  }
}

function readEnvConfig(): SupabaseConfig {
  return {
    url: String((import.meta as any).env?.WXT_PUBLIC_SUPABASE_URL || '').trim(),
    anonKey: String((import.meta as any).env?.WXT_PUBLIC_SUPABASE_ANON_KEY || '').trim(),
  };
}

function getSupabaseConfig(): SupabaseConfig {
  const page = readPageConfig();
  const env = readEnvConfig();
  const stored = configHydrated ? storedConfig : null;
  return {
    url: String(stored?.url || page.url || env.url || '').trim(),
    anonKey: String(stored?.anonKey || page.anonKey || env.anonKey || '').trim(),
  };
}

export async function loadReviewSupabaseConfig(): Promise<SupabaseConfig> {
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        const res = await browser.storage.local.get(SUPABASE_STORAGE_KEY);
        const raw = res?.[SUPABASE_STORAGE_KEY] as Partial<SupabaseConfig> | undefined;
        if (!configHydrated) {
          storedConfig = {
            url: String(raw?.url || '').trim(),
            anonKey: String(raw?.anonKey || '').trim(),
          };
          configHydrated = true;
          ReviewService.resetClient();
        }
      } catch {
        if (!configHydrated) {
          storedConfig = { url: '', anonKey: '' };
          configHydrated = true;
        }
      }
      return getSupabaseConfig();
    })();
  }
  return hydratePromise;
}

export async function saveReviewSupabaseConfig(url: string, anonKey: string): Promise<SupabaseConfig> {
  const next = { url: String(url || '').trim(), anonKey: String(anonKey || '').trim() };
  storedConfig = next;
  configHydrated = true;
  hydratePromise = Promise.resolve(getSupabaseConfig());
  writePageConfig(next);
  ReviewService.resetClient();
  try {
    await browser.storage.local.set({ [SUPABASE_STORAGE_KEY]: next });
  } catch {
  }
  return getSupabaseConfig();
}

function uniqueTags(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || '').trim().slice(0, 32);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, 80);
}

export function mergeReviewTagCatalog(...parts: Array<Partial<ReviewTagCatalog> | null | undefined>): ReviewTagCatalog {
  return {
    narratives: uniqueTags(parts.flatMap((part) => part?.narratives || [])),
    catalysts: uniqueTags(parts.flatMap((part) => part?.catalysts || [])),
    results: uniqueTags(parts.flatMap((part) => part?.results || [])),
  };
}

async function readStoredTagCatalog(): Promise<ReviewTagCatalog> {
  try {
    const res = await browser.storage.local.get(TAG_STORAGE_KEY);
    const raw = res?.[TAG_STORAGE_KEY] as Partial<ReviewTagCatalog> | undefined;
    return mergeReviewTagCatalog(raw);
  } catch {
    return { narratives: [], catalysts: [], results: [] };
  }
}

export async function loadReviewTagCatalog(): Promise<ReviewTagCatalog> {
  const [stored, remote] = await Promise.all([
    readStoredTagCatalog(),
    ReviewService.listTagCatalog(),
  ]);
  return mergeReviewTagCatalog(stored, remote);
}

export async function rememberReviewTags(partial: Partial<ReviewTagCatalog>): Promise<ReviewTagCatalog> {
  const stored = await readStoredTagCatalog();
  const next = mergeReviewTagCatalog(stored, partial);
  try {
    await browser.storage.local.set({ [TAG_STORAGE_KEY]: next });
  } catch {
  }
  return next;
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

function sameStoredAddress(stored: string, query: string): boolean {
  const left = normalizeAddressKey(stored);
  const right = normalizeAddressKey(query);
  if (!left || !right) return false;
  if (left === right) return true;
  return isSolanaAddress(left) && isSolanaAddress(right) && left.toLowerCase() === right.toLowerCase();
}

function filterReviews(items: TradeReview[], filters: TradeReviewFilters = {}) {
  const search = (filters.search || '').trim().toLowerCase();
  const tokenAddress = String(filters.tokenAddress || '').trim();
  const walletAddress = String(filters.walletAddress || '').trim();
  let result = items.filter((item) => {
    if (walletAddress && !sameStoredAddress(item.walletAddress, walletAddress)) return false;
    if (filters.chain && item.chain !== filters.chain) return false;
    if (tokenAddress && !sameStoredAddress(item.tokenAddress, tokenAddress)) return false;
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
      item.tags?.join?.(' ') || '',
      item.narrativeTags?.join?.(' ') || '',
      item.narrative,
      item.catalyst,
      item.catalystNote,
      item.catalystResult,
      item.mistakes?.join?.(' ') || ''
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

  private static localPush: Promise<void> | null = null;

  static resetClient() {
    this.client = null;
    this.configKey = '';
    this.localPush = null;
  }

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

  private static async pushLocalOnlyReviews(client: SupabaseClient): Promise<void> {
    if (!this.localPush) {
      this.localPush = (async () => {
        const localItems = getCache().filter((item) => item?.id);
        if (!localItems.length) return;
        const { data, error } = await client.from(TABLE_NAME).select('id');
        if (error) return;
        const remoteIds = new Set((Array.isArray(data) ? data : []).map((row) => String((row as { id?: string }).id || '')));
        for (const item of localItems) {
          if (remoteIds.has(item.id)) continue;
          const saved = await this.upsert(item);
          if (saved.source === 'cloud') remoteIds.add(saved.item.id);
        }
      })().finally(() => {
        this.localPush = null;
      });
    }
    await this.localPush;
  }

  static async listTagCatalog(): Promise<ReviewTagCatalog> {
    await loadReviewSupabaseConfig();
    const narratives: string[] = [];
    const catalysts: string[] = [];
    const results: string[] = [];
    const push = (item: { narrative?: string; catalyst?: string; catalystResult?: string }) => {
      narratives.push(String(item.narrative || ''));
      catalysts.push(String(item.catalyst || ''));
      results.push(String(item.catalystResult || ''));
    };
    for (const item of getCache()) push(item);
    const client = this.getClient();
    if (client) {
      try {
        const { data, error } = await client
          .from(TABLE_NAME)
          .select('narrative_tags, metrics')
          .limit(1000);
        if (!error && Array.isArray(data)) {
          for (const row of data) {
            push(readReviewSample({
              metrics: (row as { metrics?: Record<string, any> }).metrics,
              narrativeTags: (row as { narrative_tags?: string[] | null }).narrative_tags,
            }));
          }
        }
      } catch {
      }
    }
    return mergeReviewTagCatalog({ narratives, catalysts, results });
  }

  static async list(filters: TradeReviewFilters = {}): Promise<{ items: TradeReview[]; source: 'cloud' | 'local' }> {
    await loadReviewSupabaseConfig();
    const client = this.getClient();
    if (!client) {
      return { items: filterReviews(getCache(), filters), source: 'local' };
    }
    try {
      const localBefore = getCache();
      await this.pushLocalOnlyReviews(client);
      let query = client
        .from(TABLE_NAME)
        .select('*')
        .order('updated_at', { ascending: false });
      if (filters.walletAddress) {
        const wallet = normalizeAddress(filters.walletAddress) ?? filters.walletAddress;
        query = isSolanaAddress(wallet) ? query.ilike('wallet_address', wallet) : query.eq('wallet_address', wallet);
      }
      if (filters.chain) {
        query = query.eq('chain', filters.chain);
      }
      if (filters.tokenAddress) {
        const token = normalizeAddress(filters.tokenAddress) ?? filters.tokenAddress;
        query = isSolanaAddress(token) ? query.ilike('token_address', token) : query.eq('token_address', token);
      }
      if (filters.limit && filters.limit > 0) {
        query = query.limit(filters.limit);
      }
      const { data, error } = await query;
      if (error) throw error;
      const items = Array.isArray(data) ? (data as TradeReviewRow[]).map(toReview) : [];
      const merged = new Map<string, TradeReview>();
      for (const item of localBefore) {
        if (item?.id) merged.set(item.id, item);
      }
      for (const item of getCache()) {
        if (item?.id) merged.set(item.id, item);
      }
      for (const item of items) merged.set(item.id, item);
      const nextCache = Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      setCache(nextCache);
      return { items: filterReviews(nextCache, filters), source: 'cloud' };
    } catch {
      return { items: filterReviews(getCache(), filters), source: 'local' };
    }
  }

  static async upsert(input: TradeReviewUpsertInput): Promise<{ item: TradeReview; source: 'cloud' | 'local' }> {
    await loadReviewSupabaseConfig();
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
    await loadReviewSupabaseConfig();
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
