import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { X, RefreshCw, Save, Trash2, Search, Cloud, HardDrive, Sparkles } from 'lucide-react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import type { Settings } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import GmgnAPI from '@/hooks/GmgnAPI';
import type { ReviewMetrics, TradeReview, TradeReviewUpsertInput } from '@/types/review';
import { ReviewService } from '@/services/review';

type ReviewPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  address: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
};

type DraftState = {
  id?: string;
  reviewTitle: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  launchpad: string;
  visibility: 'private' | 'public';
  tagsText: string;
  narrativeTagsText: string;
  mistakesText: string;
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
  metrics: ReviewMetrics;
};

const COLORS = ['#10b981', '#f59e0b', '#f43f5e', '#60a5fa', '#a78bfa', '#22d3ee', '#f97316'];

function parseListInput(input: string) {
  return input
    .split(/[,\n，]/g)
    .map((i) => i.trim())
    .filter(Boolean);
}

function toDraft(initial?: Partial<DraftState>): DraftState {
  return {
    id: initial?.id,
    reviewTitle: initial?.reviewTitle || '',
    tokenAddress: initial?.tokenAddress || '',
    tokenSymbol: initial?.tokenSymbol || '',
    tokenName: initial?.tokenName || '',
    launchpad: initial?.launchpad || '',
    visibility: initial?.visibility || 'private',
    tagsText: initial?.tagsText || '',
    narrativeTagsText: initial?.narrativeTagsText || '',
    mistakesText: initial?.mistakesText || '',
    emotionScore: initial?.emotionScore ?? 50,
    executionScore: initial?.executionScore ?? 50,
    confidenceScore: initial?.confidenceScore ?? 50,
    buyLogic: initial?.buyLogic || '',
    sellLogic: initial?.sellLogic || '',
    summary: initial?.summary || '',
    lessonLearned: initial?.lessonLearned || '',
    nextAction: initial?.nextAction || '',
    holdStartAt: initial?.holdStartAt ?? null,
    holdEndAt: initial?.holdEndAt ?? null,
    metrics: initial?.metrics || {},
  };
}

function toDraftFromReview(item: TradeReview): DraftState {
  return toDraft({
    id: item.id,
    reviewTitle: item.reviewTitle,
    tokenAddress: item.tokenAddress,
    tokenSymbol: item.tokenSymbol,
    tokenName: item.tokenName || '',
    launchpad: item.launchpad || '',
    visibility: item.visibility,
    tagsText: item.tags.join(', '),
    narrativeTagsText: item.narrativeTags.join(', '),
    mistakesText: item.mistakes.join(', '),
    emotionScore: item.emotionScore,
    executionScore: item.executionScore,
    confidenceScore: item.confidenceScore,
    buyLogic: item.buyLogic,
    sellLogic: item.sellLogic,
    summary: item.summary,
    lessonLearned: item.lessonLearned,
    nextAction: item.nextAction,
    holdStartAt: item.holdStartAt ?? null,
    holdEndAt: item.holdEndAt ?? null,
    metrics: item.metrics || {},
  });
}

function clampPanelPos(pos: { x: number; y: number }) {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, pos.x), Math.max(0, width - 860));
  const clampedY = Math.min(Math.max(0, pos.y), Math.max(0, height - 120));
  return { x: clampedX, y: clampedY };
}

export function ReviewPanel({
  visible,
  onVisibleChange,
  settings,
  address,
  tokenAddress,
  tokenSymbol,
}: ReviewPanelProps) {
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const dateLocale = locale === 'zh_CN' ? 'zh-CN' : locale === 'zh_TW' ? 'zh-TW' : 'en-US';
  const [isMaximized, setIsMaximized] = useState(false);
  const [search, setSearch] = useState('');
  const [reviews, setReviews] = useState<TradeReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dataSource, setDataSource] = useState<'cloud' | 'local'>('local');
  const [viewMode, setViewMode] = useState<'input' | 'analysis'>('input');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState>(() => toDraft({
    tokenAddress: tokenAddress || '',
    tokenSymbol: tokenSymbol || '',
  }));
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    return { x: Math.max(0, (width - 860) / 2), y: 90 };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_review_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      setPos(clampPanelPos(parsed));
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      setPos(clampPanelPos({
        x: dragging.current.baseX + dx,
        y: dragging.current.baseY + dy,
      }));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        window.localStorage.setItem('dagobang_review_panel_pos', JSON.stringify(posRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const fetchReviews = async () => {
    if (!address) return;
    setLoading(true);
    try {
      const chain = (await GmgnAPI.getChain()) || 'bsc';
      const res = await ReviewService.list({
        walletAddress: address,
        chain,
        search,
      });
      setReviews(res.items);
      setDataSource(res.source);
      if (!activeId && res.items.length > 0) {
        setActiveId(res.items[0].id);
        setDraft(toDraftFromReview(res.items[0]));
      }
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const applyHoldingDetail = async (targetTokenAddress: string, silent: boolean) => {
    if (!address || !targetTokenAddress) return;
    try {
      const chain = (await GmgnAPI.getChain()) || 'bsc';
      const detail = await GmgnAPI.getTokenHoldingDetail(chain, address, targetTokenAddress);
      if (!detail) {
        if (!silent) toast.error(tt('contentUi.review.toast.holdingNotFound'));
        return;
      }
      const boughtAmount = Number(detail.history_bought_amount || 0);
      const soldAmount = Number(detail.history_sold_amount || 0);
      const boughtCost = Number(detail.history_bought_cost || 0);
      const soldIncome = Number(detail.history_sold_income || 0);
      const avgBuyPrice = boughtAmount > 0 ? boughtCost / boughtAmount : 0;
      const avgSellPrice = soldAmount > 0 ? soldIncome / soldAmount : 0;
      const holdDurationSec = (detail.end_holding_at && detail.start_holding_at)
        ? Math.max(0, detail.end_holding_at - detail.start_holding_at)
        : null;
      setDraft((prev) => ({
        ...prev,
        tokenSymbol: prev.tokenSymbol || detail.token?.symbol || '',
        tokenName: prev.tokenName || detail.token?.name || '',
        launchpad: prev.launchpad || detail.token?.launchpad || detail.token?.launchpad_platform || '',
        holdStartAt: detail.start_holding_at ?? null,
        holdEndAt: detail.end_holding_at ?? null,
        metrics: {
          ...(prev.metrics || {}),
          balance: detail.balance,
          usdValue: detail.usd_value,
          accuAmount: detail.accu_amount,
          accuCost: detail.accu_cost,
          accuFee: detail.accu_fee,
          historyBoughtAmount: detail.history_bought_amount,
          historyBoughtCost: detail.history_bought_cost,
          historyBoughtFee: detail.history_bought_fee,
          historySoldAmount: detail.history_sold_amount,
          historySoldIncome: detail.history_sold_income,
          historySoldFee: detail.history_sold_fee,
          historyTotalBuys: detail.history_total_buys,
          historyTotalSells: detail.history_total_sells,
          realizedProfit: detail.realized_profit,
          realizedProfitPnl: detail.realized_profit_pnl,
          unrealizedProfit: detail.unrealized_profit,
          unrealizedProfitPnl: detail.unrealized_profit_pnl,
          totalProfit: detail.total_profit,
          totalProfitPnl: detail.total_profit_pnl,
          holdStartAt: detail.start_holding_at,
          holdEndAt: detail.end_holding_at,
          lastActiveTimestamp: detail.last_active_timestamp,
          tokenPrice: detail.token?.price || '',
          liquidity: detail.token?.liquidity || '',
          avgBuyPrice: avgBuyPrice > 0 ? String(avgBuyPrice) : '0',
          avgSellPrice: avgSellPrice > 0 ? String(avgSellPrice) : '0',
          holdDurationSec,
        },
      }));
      if (!silent) toast.success(tt('contentUi.review.toast.autofillSuccess'));
    } catch (err: any) {
      if (!silent) toast.error(err?.message || tt('contentUi.review.toast.autofillFailed'));
    }
  };

  const resolveTokenReview = async () => {
    if (!visible || !address) return;
    const currentToken = (tokenAddress || '').trim().toLowerCase();
    if (!currentToken) {
      await fetchReviews();
      return;
    }
    setLoading(true);
    try {
      const chain = (await GmgnAPI.getChain()) || 'bsc';
      const exact = await ReviewService.list({
        walletAddress: address,
        chain,
        tokenAddress: currentToken,
        limit: 1,
      });
      setDataSource(exact.source);
      if (exact.items.length > 0) {
        setActiveId(exact.items[0].id);
        setDraft(toDraftFromReview(exact.items[0]));
      } else {
        setActiveId(null);
        setDraft(toDraft({
          tokenAddress: currentToken,
          tokenSymbol: tokenSymbol || '',
          reviewTitle: `${tokenSymbol || currentToken.slice(0, 6)} ${tt('contentUi.review.form.defaultTitleSuffix')}`,
        }));
        await applyHoldingDetail(currentToken, true);
      }
      const full = await ReviewService.list({
        walletAddress: address,
        chain,
        search,
      });
      setReviews(full.items);
      setDataSource(full.source);
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!visible || !address) return;
    void resolveTokenReview();
  }, [visible, address, tokenAddress]);

  useEffect(() => {
    if (!visible || !address) return;
    const timer = window.setTimeout(() => {
      void fetchReviews();
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  const chartMistakes = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of reviews) {
      for (const m of item.mistakes) {
        const key = m.trim();
        if (!key) continue;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [reviews]);

  const chartExecution = useMemo(() => {
    return reviews
      .slice(0, 12)
      .map((r) => ({
        name: r.tokenSymbol || r.tokenAddress.slice(0, 6),
        execution: r.executionScore,
        emotion: r.emotionScore,
        confidence: r.confidenceScore,
      }))
      .reverse();
  }, [reviews]);

  const summary = useMemo(() => {
    const total = reviews.length;
    const avgExecution = total ? Math.round(reviews.reduce((acc, cur) => acc + cur.executionScore, 0) / total) : 0;
    const avgEmotion = total ? Math.round(reviews.reduce((acc, cur) => acc + cur.emotionScore, 0) / total) : 0;
    const avgQuality = total ? Math.round(reviews.reduce((acc, cur) => acc + Number(cur.qualityScore || 0), 0) / total) : 0;
    const avgEngagement = total ? Math.round(reviews.reduce((acc, cur) => acc + Number(cur.engagementScore || 0), 0) / total) : 0;
    const pnlList = reviews.map((r) => Number(r.metrics?.totalProfitPnl || 0)).filter((n) => Number.isFinite(n));
    const avgPnl = pnlList.length ? pnlList.reduce((a, b) => a + b, 0) / pnlList.length : 0;
    return { total, avgExecution, avgEmotion, avgPnl, avgQuality, avgEngagement };
  }, [reviews]);

  const tagSuggestions = useMemo(() => {
    const collect = (pick: (r: TradeReview) => string[]) => {
      const map = new Map<string, number>();
      for (const item of reviews) {
        for (const raw of pick(item)) {
          const v = String(raw || '').trim();
          if (!v) continue;
          map.set(v, (map.get(v) || 0) + 1);
        }
      }
      return Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([v]) => v)
        .slice(0, 12);
    };
    return {
      tags: collect((r) => r.tags || []),
      narrative: collect((r) => r.narrativeTags || []),
      mistakes: collect((r) => r.mistakes || []),
    };
  }, [reviews]);

  const handleSave = async () => {
    if (!address) {
      toast.error(tt('contentUi.review.toast.walletRequired'));
      return;
    }
    const tokenAddr = draft.tokenAddress.trim();
    if (!tokenAddr) {
      toast.error(tt('contentUi.review.toast.tokenRequired'));
      return;
    }
    setSaving(true);
    try {
      const chain = (await GmgnAPI.getChain()) || 'bsc';
      const payload: TradeReviewUpsertInput = {
        id: draft.id,
        walletAddress: address.toLowerCase(),
        chain,
        tokenAddress: tokenAddr,
        tokenSymbol: draft.tokenSymbol.trim() || 'UNKNOWN',
        tokenName: draft.tokenName.trim(),
        launchpad: draft.launchpad.trim(),
        visibility: draft.visibility,
        reviewTitle: draft.reviewTitle.trim() || `${draft.tokenSymbol || tokenAddr.slice(0, 6)} ${tt('contentUi.review.form.defaultTitleSuffix')}`,
        tags: parseListInput(draft.tagsText),
        narrativeTags: parseListInput(draft.narrativeTagsText),
        mistakes: parseListInput(draft.mistakesText),
        emotionScore: Math.min(100, Math.max(0, Math.round(draft.emotionScore))),
        executionScore: Math.min(100, Math.max(0, Math.round(draft.executionScore))),
        confidenceScore: Math.min(100, Math.max(0, Math.round(draft.confidenceScore))),
        buyLogic: draft.buyLogic.trim(),
        sellLogic: draft.sellLogic.trim(),
        summary: draft.summary.trim(),
        lessonLearned: draft.lessonLearned.trim(),
        nextAction: draft.nextAction.trim(),
        holdStartAt: draft.holdStartAt ?? null,
        holdEndAt: draft.holdEndAt ?? null,
        metrics: draft.metrics || {},
      };
      const res = await ReviewService.upsert(payload);
      setDataSource(res.source);
      setDraft(toDraftFromReview(res.item));
      setActiveId(res.item.id);
      await fetchReviews();
      toast.success(res.source === 'cloud' ? tt('contentUi.review.toast.savedCloud') : tt('contentUi.review.toast.savedLocal'));
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!activeId) return;
    try {
      const res = await ReviewService.remove(activeId);
      setDataSource(res.source);
      setDraft(toDraft({ tokenAddress: tokenAddress || '', tokenSymbol: tokenSymbol || '' }));
      setActiveId(null);
      await fetchReviews();
      toast.success(tt('contentUi.review.toast.deleted'));
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.deleteFailed'));
    }
  };

  const appendTagValue = (field: 'tagsText' | 'narrativeTagsText' | 'mistakesText', value: string) => {
    setDraft((prev) => {
      const current = parseListInput(String(prev[field] || ''));
      if (current.includes(value)) return prev;
      return { ...prev, [field]: [...current, value].join(', ') } as DraftState;
    });
  };

  const updateEngagementMetric = (field: 'likesCount' | 'favoritesCount' | 'commentsCount', value: string) => {
    const normalized = Math.max(0, Math.floor(Number(value || 0)));
    setDraft((prev) => {
      const base = { ...(prev.metrics || {}), [field]: normalized };
      const likes = Math.max(0, Math.floor(Number(base.likesCount || 0)));
      const favorites = Math.max(0, Math.floor(Number(base.favoritesCount || 0)));
      const comments = Math.max(0, Math.floor(Number(base.commentsCount || 0)));
      const engagementScore = Math.max(0, Math.min(100, Math.round(likes * 1 + favorites * 2 + comments * 3)));
      const nextMetrics = { ...base, engagementScore };
      return { ...prev, metrics: nextMetrics };
    });
  };

  const formatTime = (timestamp?: number | null) => {
    if (!timestamp) return '-';
    return new Date(timestamp * 1000).toLocaleString(dateLocale);
  };

  const formatNum = (value?: string | number | null, digits = 4) => {
    if (value === null || value === undefined || value === '') return '-';
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    return num.toLocaleString('en-US', { maximumFractionDigits: digits });
  };

  const formatUsd = (value?: string | number | null) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    return `$${num.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
  };

  const formatDuration = (seconds?: number | null) => {
    const sec = Number(seconds || 0);
    if (!Number.isFinite(sec) || sec <= 0) return '-';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    return parts.length > 0 ? parts.join(' ') : `${sec}s`;
  };

  const sourceBadge = dataSource === 'cloud'
    ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-emerald-300"><Cloud size={12} />Supabase</span>
    : <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-amber-300"><HardDrive size={12} />Local</span>;

  if (!visible) return null;

  return (
    <div
      className={`fixed z-[2147483647] ${isMaximized ? 'inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm' : ''}`}
      style={isMaximized ? undefined : { left: pos.x, top: pos.y }}
    >
      <div className={`${isMaximized ? 'w-[96%] h-[95%]' : 'w-[860px] h-[78vh]'} rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/20 flex flex-col text-[12px]`}>
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 cursor-grab flex-shrink-0"
          onPointerDown={(e) => {
            if (isMaximized) return;
            dragging.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: posRef.current.x,
              baseY: posRef.current.y,
            };
          }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-emerald-300" />
            <span className="font-semibold text-zinc-100">{tt('contentUi.review.title')}</span>
            {sourceBadge}
            <div className="ml-1 inline-flex rounded-md border border-zinc-700 bg-zinc-900/70 p-0.5">
              <button
                type="button"
                className={`px-2 py-1 rounded text-[11px] ${viewMode === 'input' ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-400 hover:text-zinc-200'}`}
                onClick={() => setViewMode('input')}
              >
                {tt('contentUi.review.action.input')}
              </button>
              <button
                type="button"
                className={`px-2 py-1 rounded text-[11px] ${viewMode === 'analysis' ? 'bg-cyan-500/20 text-cyan-300' : 'text-zinc-400 hover:text-zinc-200'}`}
                onClick={() => setViewMode('analysis')}
              >
                {tt('contentUi.review.action.analysis')}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-zinc-400 hover:text-zinc-200"
              onClick={() => setIsMaximized((v) => !v)}
              title={tt('contentUi.review.action.maximize')}
            >
              {isMaximized ? '↙' : '↗'}
            </button>
            <button
              type="button"
              className="text-zinc-400 hover:text-red-400"
              onClick={() => onVisibleChange(false)}
              title={tt('contentUi.review.action.close')}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-[212px_1fr] flex-1 min-h-0">
          <div className="border-r border-zinc-800 p-3 flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2 top-2.5 text-zinc-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tt('contentUi.review.placeholder.search')}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 pl-7 pr-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <button
                type="button"
                onClick={() => void fetchReviews()}
                className="rounded-md border border-zinc-700 p-2 text-zinc-300 hover:border-zinc-500"
                title={tt('contentUi.review.action.refresh')}
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>

            <div className="text-zinc-400 mb-2">{tt('contentUi.review.stats.total', [summary.total])}</div>
            <div className="flex-1 overflow-auto space-y-1.5 pr-1">
              {reviews.map((item) => (
                (() => {
                  const pnl = Number(item.metrics?.totalProfitPnl || 0);
                  const isCurrentToken = !!tokenAddress && item.tokenAddress.toLowerCase() === tokenAddress.toLowerCase();
                  const isProfit = pnl >= 0;
                  const cardCls = activeId === item.id
                    ? (isProfit ? 'border-emerald-500 bg-emerald-500/10' : 'border-rose-500 bg-rose-500/10')
                    : (isProfit ? 'border-zinc-800 hover:border-emerald-700/70' : 'border-zinc-800 hover:border-rose-700/70');
                  const currentCls = isCurrentToken && activeId !== item.id ? ' ring-1 ring-cyan-700/70' : '';
                  const pnlCls = isProfit ? 'text-emerald-300' : 'text-rose-300';
                  return (
                <button
                  key={item.id}
                  type="button"
                  className={`w-full text-left rounded-md border px-2 py-1.5 transition-colors ${cardCls}${currentCls}`}
                  onClick={() => {
                    setActiveId(item.id);
                    setDraft(toDraftFromReview(item));
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-zinc-100 truncate">{item.tokenSymbol || item.tokenAddress.slice(0, 6)}</span>
                    <span className="text-zinc-500 text-[10px] ml-2">{new Date(item.updatedAt * 1000).toLocaleDateString(dateLocale)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] text-cyan-300 shrink-0">{tt('contentUi.review.kpi.quality')}: {item.qualityScore ?? 0}</div>
                    <span className={`text-[10px] ${pnlCls}`}>
                      {isProfit ? '+' : ''}{formatNum(pnl * 100, 2)}%
                    </span>
                  </div>
                </button>
                  );
                })()
              ))}
              {reviews.length === 0 && (
                <div className="text-zinc-500 text-center py-8">{tt('contentUi.review.empty')}</div>
              )}
            </div>
          </div>

          <div className={`p-2 flex flex-col min-h-0 ${viewMode === 'input' ? 'overflow-auto' : 'overflow-auto'}`}>
            {viewMode === 'input' ? (
            <>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="col-span-2 flex items-center gap-2">
                <input
                  value={draft.reviewTitle}
                  onChange={(e) => setDraft((prev) => ({ ...prev, reviewTitle: e.target.value }))}
                  placeholder={tt('contentUi.review.placeholder.reviewTitle')}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <input
                value={draft.tokenAddress}
                onChange={(e) => setDraft((prev) => ({ ...prev, tokenAddress: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.tokenAddress')}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />
              <div>
                <input
                  value={draft.tokenSymbol}
                  onChange={(e) => setDraft((prev) => ({ ...prev, tokenSymbol: e.target.value }))}
                  placeholder={tt('contentUi.review.placeholder.tokenSymbol')}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="col-span-2 grid grid-cols-4 gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 p-1.5">
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.avgBuyPrice')}</div>
                  <div className="text-zinc-100">{formatUsd(draft.metrics?.avgBuyPrice)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.avgSellPrice')}</div>
                  <div className="text-zinc-100">{formatUsd(draft.metrics?.avgSellPrice)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.totalProfit')}</div>
                  <div className={`${Number(draft.metrics?.totalProfit || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {formatUsd(draft.metrics?.totalProfit)}
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.totalProfitPnl')}</div>
                  <div className={`${Number(draft.metrics?.totalProfitPnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {formatNum(Number(draft.metrics?.totalProfitPnl || 0) * 100, 2)}%
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.totalBuys')}</div>
                  <div className="text-zinc-100">{formatNum(draft.metrics?.historyTotalBuys, 0)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.totalSells')}</div>
                  <div className="text-zinc-100">{formatNum(draft.metrics?.historyTotalSells, 0)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.totalBuyCost')}</div>
                  <div className="text-zinc-100">{formatUsd(draft.metrics?.historyBoughtCost)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.totalSellIncome')}</div>
                  <div className="text-zinc-100">{formatUsd(draft.metrics?.historySoldIncome)}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.holdTime')}</div>
                  <div className="text-zinc-100">
                    {formatTime(draft.holdStartAt)} ~ {formatTime(draft.holdEndAt)} ({formatDuration(draft.metrics?.holdDurationSec)})
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.tokenPrice')}</div>
                  <div className="text-zinc-100">{formatUsd(draft.metrics?.tokenPrice)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.liquidity')}</div>
                  <div className="text-zinc-100">{formatUsd(draft.metrics?.liquidity)}</div>
                </div>
                <div>
                  <div className="text-zinc-500">{tt('contentUi.review.metrics.engagementScore')}</div>
                  <div className="text-cyan-300">{formatNum(draft.metrics?.engagementScore ?? 0, 0)}</div>
                </div>
              </div>

              <input
                value={draft.tagsText}
                onChange={(e) => setDraft((prev) => ({ ...prev, tagsText: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.tags')}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />
              <input
                value={draft.mistakesText}
                onChange={(e) => setDraft((prev) => ({ ...prev, mistakesText: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.mistakes')}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />

              <div className="col-span-2 flex flex-wrap gap-1">
                {tagSuggestions.tags.map((tag) => (
                  <button key={`tg-${tag}`} type="button" onClick={() => appendTagValue('tagsText', tag)} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-emerald-500 hover:text-emerald-300">
                    {tag}
                  </button>
                ))}
              </div>

              <input
                value={draft.narrativeTagsText}
                onChange={(e) => setDraft((prev) => ({ ...prev, narrativeTagsText: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.narrativeTags')}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />
              <div />

              <div className="col-span-2 flex flex-wrap gap-1">
                {tagSuggestions.narrative.map((tag) => (
                  <button key={`nt-${tag}`} type="button" onClick={() => appendTagValue('narrativeTagsText', tag)} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-cyan-500 hover:text-cyan-300">
                    {tag}
                  </button>
                ))}
                {tagSuggestions.mistakes.map((tag) => (
                  <button key={`mk-${tag}`} type="button" onClick={() => appendTagValue('mistakesText', tag)} className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-rose-500 hover:text-rose-300">
                    {tag}
                  </button>
                ))}
              </div>

              <textarea
                value={draft.buyLogic}
                onChange={(e) => setDraft((prev) => ({ ...prev, buyLogic: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.buyLogic')}
                className="col-span-2 h-[44px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />

              <textarea
                value={draft.sellLogic}
                onChange={(e) => setDraft((prev) => ({ ...prev, sellLogic: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.sellLogic')}
                className="col-span-2 h-[44px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />

              <textarea
                value={draft.summary}
                onChange={(e) => setDraft((prev) => ({ ...prev, summary: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.summary')}
                className="col-span-2 h-[44px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />
              <textarea
                value={draft.lessonLearned}
                onChange={(e) => setDraft((prev) => ({ ...prev, lessonLearned: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.lesson')}
                className="col-span-2 h-[44px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />
              <textarea
                value={draft.nextAction}
                onChange={(e) => setDraft((prev) => ({ ...prev, nextAction: e.target.value }))}
                placeholder={tt('contentUi.review.placeholder.nextAction')}
                className="col-span-2 h-[42px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
              />

              <div className="col-span-2 grid grid-cols-3 gap-1.5">
                <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-1.5">
                  <div className="text-zinc-400 mb-1">{tt('contentUi.review.form.executionScore', [draft.executionScore])}</div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draft.executionScore}
                    onChange={(e) => setDraft((prev) => ({ ...prev, executionScore: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-1.5">
                  <div className="text-zinc-400 mb-1">{tt('contentUi.review.form.emotionScore', [draft.emotionScore])}</div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draft.emotionScore}
                    onChange={(e) => setDraft((prev) => ({ ...prev, emotionScore: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
                <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-1.5">
                  <div className="text-zinc-400 mb-1">{tt('contentUi.review.form.confidenceScore', [draft.confidenceScore])}</div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draft.confidenceScore}
                    onChange={(e) => setDraft((prev) => ({ ...prev, confidenceScore: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
              </div>

            </div>
            <div className="mt-2 sticky bottom-0 z-10 border-t border-zinc-800 bg-[#0F0F11] pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={!activeId}
                className="inline-flex items-center gap-1 rounded-md border border-rose-800 px-3 py-1.5 text-rose-300 disabled:opacity-40"
              >
                <Trash2 size={13} />
                {tt('contentUi.review.action.delete')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-1.5 text-emerald-300 disabled:opacity-40"
              >
                <Save size={13} />
                {saving ? tt('contentUi.review.action.saving') : tt('contentUi.review.action.save')}
              </button>
            </div>
            </>
            ) : (
            <>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 h-[180px]">
                <div className="text-zinc-300 mb-1">{tt('contentUi.review.chart.mistakes')}</div>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={chartMistakes} dataKey="value" nameKey="name" outerRadius={58} labelLine={false}>
                      {chartMistakes.map((_, idx) => (
                        <Cell key={`m-${idx}`} fill={COLORS[idx % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 h-[180px]">
                <div className="text-zinc-300 mb-1">{tt('contentUi.review.chart.executionTrend')}</div>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartExecution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="name" stroke="#a1a1aa" tick={{ fontSize: 10 }} />
                    <YAxis stroke="#a1a1aa" domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="execution" fill="#10b981" />
                    <Bar dataKey="emotion" fill="#f59e0b" />
                    <Bar dataKey="confidence" fill="#60a5fa" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-6 gap-2">
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="text-zinc-500">{tt('contentUi.review.kpi.avgExecution')}</div>
                <div className="text-emerald-300 text-[14px] font-semibold">{summary.avgExecution}</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="text-zinc-500">{tt('contentUi.review.kpi.avgQuality')}</div>
                <div className="text-cyan-300 text-[14px] font-semibold">{summary.avgQuality}</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="text-zinc-500">{tt('contentUi.review.kpi.avgEngagement')}</div>
                <div className="text-sky-300 text-[14px] font-semibold">{summary.avgEngagement}</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="text-zinc-500">{tt('contentUi.review.kpi.avgEmotion')}</div>
                <div className="text-amber-300 text-[14px] font-semibold">{summary.avgEmotion}</div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="text-zinc-500">{tt('contentUi.review.kpi.avgPnl')}</div>
                <div className={`text-[14px] font-semibold ${summary.avgPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {(summary.avgPnl * 100).toFixed(2)}%
                </div>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="text-zinc-500">{tt('contentUi.review.kpi.total')}</div>
                <div className="text-zinc-100 text-[14px] font-semibold">{summary.total}</div>
              </div>
            </div>
            </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
