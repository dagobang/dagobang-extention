import type { ReviewMetrics, TradeReview } from '@/types/review';

export const REVIEW_PEAK_ABOVE = 1_000_000;
export const REVIEW_PEAK_LOW = 300_000;
export const REVIEW_STAT_MIN_SAMPLE = 5;

export const NARRATIVES = ['animal', 'celebrity', 'ai', 'web2', 'kol', 'community', 'official'] as const;
export type ReviewNarrative = (typeof NARRATIVES)[number];

export const CATALYSTS = ['celebrity', 'web2_news', 'kol_flow', 'official', 'community', 'none'] as const;
export type ReviewCatalyst = (typeof CATALYSTS)[number];

export const CATALYST_RESULTS = ['ignited', 'missed', 'fizzled'] as const;
export type ReviewCatalystResult = (typeof CATALYST_RESULTS)[number];

export type ReviewCeiling = 'above_1m' | 'mid' | 'low';

const NARRATIVE_ZH: Record<ReviewNarrative, string> = {
  animal: '动物',
  celebrity: '名人',
  ai: 'AI',
  web2: 'Web2热点',
  kol: 'KOL',
  community: '社区梗',
  official: '官方',
};

const CATALYST_ZH: Record<ReviewCatalyst, string> = {
  celebrity: '等名人互动',
  web2_news: 'Web2新闻',
  kol_flow: 'KOL流量',
  official: '官方动作',
  community: '社区自己发酵',
  none: '没有明确热度',
};

const LEGACY_NARRATIVE: Record<string, ReviewNarrative> = {
  动物: 'animal',
  名人: 'celebrity',
  AI: 'ai',
  ai: 'ai',
  Web2: 'web2',
  web2: 'web2',
  'Web2热点': 'web2',
  KOL: 'kol',
  kol: 'kol',
  社区驱动: 'community',
  社区梗: 'community',
  社区: 'community',
  官方: 'official',
};

export function isNarrative(value: string): value is ReviewNarrative {
  return (NARRATIVES as readonly string[]).includes(value);
}

export function isCatalyst(value: string): value is ReviewCatalyst {
  return (CATALYSTS as readonly string[]).includes(value);
}

export function isCatalystResult(value: string): value is ReviewCatalystResult {
  return (CATALYST_RESULTS as readonly string[]).includes(value);
}

export function resolveReviewTag(raw: string, presets: readonly string[], labelOf: (value: string) => string): string {
  const text = String(raw || '').trim().slice(0, 32);
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const preset of presets) {
    if (preset.toLowerCase() === lower) return preset;
    if (labelOf(preset).trim().toLowerCase() === lower) return preset;
  }
  return text;
}

export function narrativeLabelOf(value: string): string {
  const text = reviewText(value);
  if (isNarrative(text)) return NARRATIVE_ZH[text];
  const legacy = LEGACY_NARRATIVE[text];
  return legacy ? NARRATIVE_ZH[legacy] : text;
}

const LEGACY_CATALYST: Record<string, ReviewCatalyst> = {
  等名人互动: 'celebrity',
  Web2新闻: 'web2_news',
  'Web2 新闻': 'web2_news',
  KOL流量: 'kol_flow',
  'KOL 流量': 'kol_flow',
  官方动作: 'official',
  社区自己发酵: 'community',
  没有明确热度: 'none',
};

export function catalystLabelOf(value: string): string {
  const text = reviewText(value);
  if (isCatalyst(text)) return CATALYST_ZH[text];
  const legacy = LEGACY_CATALYST[text];
  return legacy ? CATALYST_ZH[legacy] : text;
}

export function reviewChainLabel(chain: string): string {
  const value = String(chain || '').trim().toLowerCase();
  if (value === 'bsc' || value === 'bnb') return 'BSC';
  if (value === 'sol' || value === 'solana') return 'SOL';
  if (value === 'rh' || value === 'robinhood') return 'RH';
  return value ? value.toUpperCase() : '-';
}

export function positiveNum(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

export function capFromPrice(price: unknown, supply: unknown): number | null {
  const px = positiveNum(price);
  const total = positiveNum(supply);
  if (px == null || total == null) return null;
  return px * total;
}

export function reviewBuyCap(metrics?: ReviewMetrics | null): number | null {
  return capFromPrice(metrics?.avgBuyPrice, metrics?.totalSupply);
}

export function reviewSellCap(metrics?: ReviewMetrics | null): number | null {
  return capFromPrice(metrics?.avgSellPrice, metrics?.totalSupply);
}

export function reviewSpotCap(metrics?: ReviewMetrics | null): number | null {
  return positiveNum(metrics?.marketCap);
}

export function reviewPeakFloor(metrics?: ReviewMetrics | null): number | null {
  const values = [reviewSellCap(metrics), reviewSpotCap(metrics)].filter((n): n is number => n != null);
  if (!values.length) return null;
  return Math.max(...values);
}

export function reviewCeiling(peak: number | null | undefined): ReviewCeiling | null {
  if (peak == null || !Number.isFinite(peak) || peak <= 0) return null;
  if (peak >= REVIEW_PEAK_ABOVE) return 'above_1m';
  if (peak < REVIEW_PEAK_LOW) return 'low';
  return 'mid';
}

export function parseCapInput(raw: string): number | null {
  const text = String(raw || '').trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!text) return null;
  const matched = text.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!matched) return null;
  const num = Number(matched[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (matched[2] === 'k') return num * 1_000;
  if (matched[2] === 'm') return num * 1_000_000;
  return num;
}

export function formatCap(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '-';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

export function readReviewSample(input: {
  metrics?: Record<string, any> | null;
  narrativeTags?: string[] | null;
}) {
  const metrics = input.metrics || {};
  const rawNarrative = String(metrics.narrative || '').trim();
  const tagNarrative = (input.narrativeTags || []).map((tag) => String(tag || '').trim()).find(Boolean) || '';
  const narrative = resolveReviewTag(rawNarrative || tagNarrative, NARRATIVES, narrativeLabelOf);
  const rawCatalyst = String(metrics.catalyst || '').trim();
  const rawResult = String(metrics.catalystResult || '').trim();
  const peak = positiveNum(metrics.peakMarketCap);
  return {
    narrative,
    catalyst: resolveReviewTag(rawCatalyst, CATALYSTS, catalystLabelOf),
    catalystNote: typeof metrics.catalystNote === 'string' ? metrics.catalystNote : '',
    catalystResult: isCatalystResult(rawResult) ? rawResult : '',
    peakMarketCap: peak,
    notionPageId: typeof metrics.notionPageId === 'string' ? metrics.notionPageId : '',
    notionSyncedHash: typeof metrics.notionSyncedHash === 'string' ? metrics.notionSyncedHash : '',
  };
}

export function normalizeUnixSeconds(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

export function formatReviewTime(value: unknown): string {
  const sec = normalizeUnixSeconds(value);
  if (!sec) return '-';
  const date = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function reviewText(value: unknown): string {
  return String(value ?? '').trim();
}

export function isCompleteSample(review: Pick<TradeReview, 'narrative' | 'catalyst' | 'catalystResult' | 'peakMarketCap'>): boolean {
  return !!reviewText(review.narrative)
    && !!reviewText(review.catalyst)
    && isCatalystResult(reviewText(review.catalystResult))
    && review.peakMarketCap != null
    && Number(review.peakMarketCap) > 0;
}

export type CeilingGroup = {
  key: string;
  count: number;
  above: number;
  low: number;
  mid: number;
  medianPeak: number | null;
  aboveRate: number;
  lowRate: number;
  reliable: boolean;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function groupCeilingStats(items: Array<{ key: string; peak: number }>): CeilingGroup[] {
  const map = new Map<string, number[]>();
  for (const item of items) {
    if (!item.key || !Number.isFinite(item.peak) || item.peak <= 0) continue;
    const list = map.get(item.key) || [];
    list.push(item.peak);
    map.set(item.key, list);
  }
  const groups: CeilingGroup[] = [];
  for (const [key, peaks] of map) {
    const above = peaks.filter((peak) => peak >= REVIEW_PEAK_ABOVE).length;
    const low = peaks.filter((peak) => peak < REVIEW_PEAK_LOW).length;
    groups.push({
      key,
      count: peaks.length,
      above,
      low,
      mid: peaks.length - above - low,
      medianPeak: median(peaks),
      aboveRate: above / peaks.length,
      lowRate: low / peaks.length,
      reliable: peaks.length >= REVIEW_STAT_MIN_SAMPLE,
    });
  }
  groups.sort((a, b) => {
    if (a.reliable !== b.reliable) return a.reliable ? -1 : 1;
    if (b.aboveRate !== a.aboveRate) return b.aboveRate - a.aboveRate;
    return b.count - a.count;
  });
  return groups;
}
