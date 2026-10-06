import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { X, RefreshCw, Save, Trash2, Search, Cloud, HardDrive } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { parseCurrentUrl, parsePlatformTokenLink } from '@/utils/sites';
import GmgnAPI from '@/hooks/GmgnAPI';
import type { ReviewMetrics, TradeReview, TradeReviewUpsertInput } from '@/types/review';
import { ReviewService } from '@/services/review';
import { isSolanaAddress, normalizeAddress, normalizeAddressKey } from '@/services/xSniper/engine/metrics';
import {
  CATALYSTS,
  CATALYST_RESULTS,
  NARRATIVES,
  formatCap,
  formatReviewTime,
  groupCeilingStats,
  isCatalyst,
  isCatalystResult,
  isCompleteSample,
  isNarrative,
  normalizeUnixSeconds,
  reviewCeiling,
  reviewChainLabel,
  resolveReviewTag,
  type CeilingGroup,
} from '@/services/review/sample';

type ReviewPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  address: string | null;
  chain: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenName: string | null;
};

type DraftState = {
  id?: string;
  reviewTitle: string;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  launchpad: string;
  visibility: 'private' | 'public';
  tags: string[];
  narrative: string;
  catalyst: string;
  catalystNote: string;
  catalystResult: string;
  peakMarketCap: number | null;
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
  notionPageId: string;
  notionSyncedHash: string;
  metrics: ReviewMetrics;
};

function toDraft(initial?: Partial<DraftState>): DraftState {
  return {
    id: initial?.id,
    reviewTitle: initial?.reviewTitle || '',
    chain: initial?.chain || '',
    tokenAddress: initial?.tokenAddress || '',
    tokenSymbol: initial?.tokenSymbol || '',
    tokenName: initial?.tokenName || '',
    launchpad: initial?.launchpad || '',
    visibility: initial?.visibility || 'private',
    tags: initial?.tags || [],
    narrative: initial?.narrative || '',
    catalyst: initial?.catalyst || '',
    catalystNote: initial?.catalystNote || '',
    catalystResult: initial?.catalystResult || '',
    peakMarketCap: initial?.peakMarketCap ?? null,
    mistakes: initial?.mistakes || [],
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
    notionPageId: initial?.notionPageId || '',
    notionSyncedHash: initial?.notionSyncedHash || '',
    metrics: initial?.metrics || {},
  };
}

function toDraftFromReview(item: TradeReview): DraftState {
  const peak = Number(item.peakMarketCap);
  const entry = String(item.buyLogic || '').trim() || String(item.catalystNote || '').trim();
  return toDraft({
    id: item.id,
    reviewTitle: item.reviewTitle,
    chain: item.chain,
    tokenAddress: item.tokenAddress,
    tokenSymbol: item.tokenSymbol,
    tokenName: item.tokenName || '',
    launchpad: item.launchpad || '',
    visibility: item.visibility,
    tags: item.tags || [],
    narrative: item.narrative || '',
    catalyst: item.catalyst || '',
    catalystNote: item.catalystNote || '',
    catalystResult: item.catalystResult || '',
    peakMarketCap: Number.isFinite(peak) && peak > 0 ? peak : null,
    mistakes: item.mistakes || [],
    emotionScore: item.emotionScore,
    executionScore: item.executionScore,
    confidenceScore: item.confidenceScore,
    buyLogic: entry,
    sellLogic: item.sellLogic,
    summary: item.summary,
    lessonLearned: item.lessonLearned,
    nextAction: item.nextAction,
    holdStartAt: item.holdStartAt ?? null,
    holdEndAt: item.holdEndAt ?? null,
    notionPageId: item.notionPageId || '',
    notionSyncedHash: item.notionSyncedHash || '',
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

function sameTokenAddress(left: string, right: string): boolean {
  const a = normalizeAddressKey(left);
  const b = normalizeAddressKey(right);
  if (a && b && a === b) return true;
  return isSolanaAddress(left) && isSolanaAddress(right) && left.toLowerCase() === right.toLowerCase();
}

function shortAddress(addr: string) {
  if (!addr || addr.length < 10) return addr || '-';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function isPlaceholderSymbol(symbol: string, tokenAddress: string): boolean {
  const text = String(symbol || '').trim();
  if (!text) return true;
  const address = String(tokenAddress || '').trim();
  if (!address) return /^0x[a-fA-F0-9]{40}$/.test(text) || isSolanaAddress(text);
  if (text.toLowerCase() === address.toLowerCase()) return true;
  if (/^0x[a-fA-F0-9]{40}$/.test(text) || isSolanaAddress(text)) return true;
  return text === shortAddress(address);
}

function pickTokenSymbol(current: string, tokenAddress: string, ...candidates: Array<string | null | undefined>): string {
  if (!isPlaceholderSymbol(current, tokenAddress)) return current;
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text && !isPlaceholderSymbol(text, tokenAddress)) return text;
  }
  return '';
}

function mergeTagOptions(presets: readonly string[], used: string[], current: string): string[] {
  const options = [...presets];
  const seen = new Set<string>(presets);
  for (const value of [...used, current]) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    options.push(text);
  }
  return options;
}

function tokenPageLink(tokenAddress: string) {
  try {
    const info = parseCurrentUrl(window.location.href);
    if (!info || !tokenAddress) return '';
    return parsePlatformTokenLink(info, tokenAddress);
  } catch {
    return '';
  }
}

function ChoiceRow({
  options,
  value,
  onChange,
  labelOf,
  activeClass,
  addPlaceholder,
}: {
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  labelOf: (option: string) => string;
  activeClass: string;
  addPlaceholder?: string;
}) {
  const [adding, setAdding] = useState('');
  const commit = () => {
    const next = adding.trim();
    setAdding('');
    if (!next) return;
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(active ? '' : option)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${active ? activeClass : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'}`}
          >
            {labelOf(option)}
          </button>
        );
      })}
      {addPlaceholder ? (
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            commit();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={addPlaceholder}
          className="h-6 w-[4.5rem] rounded-full border border-dashed border-zinc-600 bg-transparent px-2 text-[11px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:w-28 focus:border-zinc-400"
        />
      ) : null}
    </div>
  );
}

function SampleTable({
  title,
  groups,
  labelOf,
  headers,
  empty,
}: {
  title: string;
  groups: CeilingGroup[];
  labelOf: (key: string) => string;
  headers: { key: string; count: string; above: string; low: string; median: string };
  empty: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="text-zinc-300 mb-1">{title}</div>
      {groups.length === 0 ? (
        <div className="text-zinc-500 py-3">{empty}</div>
      ) : (
        <div className="overflow-auto">
          <div className="grid grid-cols-[1.4fr_52px_88px_88px_88px] gap-1 text-[10px] text-zinc-500 px-1">
            <div>{headers.key}</div>
            <div className="text-right">{headers.count}</div>
            <div className="text-right">{headers.above}</div>
            <div className="text-right">{headers.low}</div>
            <div className="text-right">{headers.median}</div>
          </div>
          {groups.map((group) => (
            <div
              key={group.key}
              className={`grid grid-cols-[1.4fr_52px_88px_88px_88px] gap-1 px-1 py-1 text-[11px] border-t border-zinc-800/80 ${group.reliable ? 'text-zinc-100' : 'text-zinc-500'}`}
            >
              <div className="truncate">{labelOf(group.key)}</div>
              <div className="text-right">{group.count}</div>
              <div className="text-right text-emerald-300/90">{Math.round(group.aboveRate * 100)}% · {group.above}</div>
              <div className="text-right text-rose-300/90">{Math.round(group.lowRate * 100)}% · {group.low}</div>
              <div className="text-right">{formatCap(group.medianPeak)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

class ReviewPanelBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: '' };

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || 'unknown');
    return { message };
  }

  componentDidCatch(error: unknown) {
    console.error('Review panel crashed', error);
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <div className="fixed z-[2147483647] right-3 top-24 w-72 rounded-lg border border-rose-800 bg-[#0F0F11] p-3 text-[12px] text-rose-200 shadow-lg">
        复盘面板加载失败：{this.state.message}
      </div>
    );
  }
}

export function ReviewPanel(props: ReviewPanelProps) {
  return (
    <ReviewPanelBoundary key={props.visible ? 'open' : 'closed'}>
      <ReviewPanelBody {...props} />
    </ReviewPanelBoundary>
  );
}

function ReviewPanelBody({
  visible,
  onVisibleChange,
  settings,
  address,
  chain: pageChain,
  tokenAddress,
  tokenSymbol,
  tokenName,
}: ReviewPanelProps) {
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const [isMaximized, setIsMaximized] = useState(false);
  const [search, setSearch] = useState('');
  const [reviews, setReviews] = useState<TradeReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dataSource, setDataSource] = useState<'cloud' | 'local'>('local');
  const [viewMode, setViewMode] = useState<'input' | 'analysis' | 'summary'>('input');
  const [chainFilter, setChainFilter] = useState<'all' | 'BSC' | 'SOL' | 'RH'>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const pageSymbol = tokenSymbol && !isPlaceholderSymbol(tokenSymbol, tokenAddress || '') ? tokenSymbol : '';
  const pageName = String(tokenName || '').trim();
  const [draft, setDraft] = useState<DraftState>(() => toDraft({
    tokenAddress: tokenAddress || '',
    tokenSymbol: pageSymbol,
    tokenName: pageName,
  }));
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    return { x: Math.max(0, (width - 860) / 2), y: 90 };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const lessonScoreRef = useRef<Record<string, number>>({});

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
      const res = await ReviewService.list({
        walletAddress: address,
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

  const resolveActiveChain = async () => {
    const fromPage = String(pageChain || '').trim();
    if (fromPage) return fromPage;
    return (await GmgnAPI.getChain()) || 'bsc';
  };

  const applyHoldingDetail = async (targetTokenAddress: string, chain: string, silent: boolean) => {
    if (!address || !targetTokenAddress || !chain) return;
    try {
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
      const tokenPrice = Number(detail.token?.price || 0);
      const totalSupply = Number(detail.token?.total_supply || 0);
      const marketCap = tokenPrice > 0 && totalSupply > 0 ? tokenPrice * totalSupply : 0;
      const holdStartAt = normalizeUnixSeconds(detail.start_holding_at);
      const holdEndAt = normalizeUnixSeconds(detail.end_holding_at);
      const holdDurationSec = holdStartAt && holdEndAt ? Math.max(0, holdEndAt - holdStartAt) : null;
      setDraft((prev) => {
        if (prev.tokenAddress && !sameTokenAddress(prev.tokenAddress, targetTokenAddress)) return prev;
        return {
        ...prev,
        chain: prev.chain && reviewChainLabel(prev.chain) === reviewChainLabel(chain) ? prev.chain : chain,
        tokenAddress: normalizeAddress(targetTokenAddress) ?? targetTokenAddress,
        tokenSymbol: pickTokenSymbol(prev.tokenSymbol, targetTokenAddress, detail.token?.symbol, (detail as { token_basic_stats?: { symbol?: string } }).token_basic_stats?.symbol, (detail as { symbol?: string }).symbol),
        tokenName: prev.tokenName || String(detail.token?.name || (detail as { token_basic_stats?: { name?: string } }).token_basic_stats?.name || (detail as { name?: string }).name || '').trim(),
        launchpad: prev.launchpad || detail.token?.launchpad || detail.token?.launchpad_platform || '',
        holdStartAt,
        holdEndAt,
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
          holdStartAt,
          holdEndAt,
          lastActiveTimestamp: detail.last_active_timestamp,
          tokenPrice: detail.token?.price || '',
          totalSupply: detail.token?.total_supply || '',
          tokenLogo: detail.token?.logo || '',
          marketCap: marketCap > 0 ? String(marketCap) : '0',
          liquidity: detail.token?.liquidity || '',
          avgBuyPrice: avgBuyPrice > 0 ? String(avgBuyPrice) : '0',
          avgSellPrice: avgSellPrice > 0 ? String(avgSellPrice) : '0',
          holdDurationSec,
        },
      };
      });
      if (!silent) toast.success(tt('contentUi.review.toast.autofillSuccess'));
    } catch (err: any) {
      if (!silent) toast.error(err?.message || tt('contentUi.review.toast.autofillFailed'));
    }
  };

  const applyTokenProfile = async (chain: string, targetTokenAddress: string) => {
    if (!chain || !targetTokenAddress) return;
    try {
      const info = await GmgnAPI.getTokenTradeInfo(chain, targetTokenAddress);
      const symbol = isPlaceholderSymbol(String(info?.symbol || ''), targetTokenAddress) ? '' : String(info?.symbol || '').trim();
      const name = String(info?.name || '').trim();
      const launchpad = String(info?.launchpad || '').trim();
      const logo = String(info?.logo || '').trim();
      if (!symbol && !name && !logo) return;
      setDraft((prev) => {
        if (prev.tokenAddress && !sameTokenAddress(prev.tokenAddress, targetTokenAddress)) return prev;
        const nextSymbol = pickTokenSymbol(prev.tokenSymbol, prev.tokenAddress || targetTokenAddress, symbol);
        if (nextSymbol && !isPlaceholderSymbol(prev.tokenSymbol, prev.tokenAddress || targetTokenAddress) && prev.tokenName && (prev.metrics?.tokenLogo || !logo)) return prev;
        return {
          ...prev,
          tokenSymbol: nextSymbol,
          tokenName: prev.tokenName || name,
          launchpad: prev.launchpad || launchpad,
          reviewTitle: prev.reviewTitle || `${nextSymbol || name || targetTokenAddress.slice(0, 6)} ${tt('contentUi.review.form.defaultTitleSuffix')}`,
          metrics: {
            ...(prev.metrics || {}),
            tokenLogo: prev.metrics?.tokenLogo || logo,
          },
        };
      });
    } catch {
    }
  };

  const pullAth = async (chain: string, targetTokenAddress: string) => {
    if (!chain || !targetTokenAddress) return;
    try {
      const ath = await GmgnAPI.getTokenAthMarketCap(chain, targetTokenAddress);
      if (ath == null || ath <= 0) return;
      setDraft((prev) => {
        if (prev.tokenAddress && !sameTokenAddress(prev.tokenAddress, targetTokenAddress)) return prev;
        const next = Math.max(prev.peakMarketCap || 0, ath);
        return next === prev.peakMarketCap ? prev : { ...prev, peakMarketCap: next };
      });
    } catch {
    }
  };

  const resolveTokenReview = async () => {
    if (!visible || !address) return;
    const currentToken = normalizeAddress(tokenAddress || '') || String(tokenAddress || '').trim();
    if (!currentToken) {
      await fetchReviews();
      return;
    }
    setLoading(true);
    try {
      const chain = await resolveActiveChain();
      const exact = await ReviewService.list({
        walletAddress: address,
        tokenAddress: currentToken,
        limit: 8,
      });
      setDataSource(exact.source);
      const item = exact.items.find((row) => reviewChainLabel(row.chain) === reviewChainLabel(chain)) || exact.items[0];
      if (item) {
        const next = toDraftFromReview(item);
        next.tokenAddress = currentToken;
        if (reviewChainLabel(chain) === 'SOL' && isSolanaAddress(currentToken) && reviewChainLabel(next.chain) !== 'SOL') {
          next.chain = chain;
        }
        setActiveId(item.id);
        setDraft(next);
        const missingTimes = !normalizeUnixSeconds(item.holdStartAt ?? item.metrics?.holdStartAt);
        const missingPosition = !Number(item.metrics?.historyBoughtCost);
        if (missingTimes || missingPosition) void applyHoldingDetail(currentToken, chain, true);
        void applyTokenProfile(chain, currentToken);
        void pullAth(chain, currentToken);
      } else {
        setActiveId(null);
        setDraft(toDraft({
          chain,
          tokenAddress: currentToken,
          tokenSymbol: tokenSymbol && !isPlaceholderSymbol(tokenSymbol, currentToken) ? tokenSymbol : '',
          tokenName: String(tokenName || '').trim(),
          reviewTitle: `${(tokenSymbol && !isPlaceholderSymbol(tokenSymbol, currentToken) ? tokenSymbol : String(tokenName || '').trim() || currentToken.slice(0, 6))} ${tt('contentUi.review.form.defaultTitleSuffix')}`,
        }));
        void applyTokenProfile(chain, currentToken);
        await applyHoldingDetail(currentToken, chain, true);
        void pullAth(chain, currentToken);
      }
      const full = await ReviewService.list({
        walletAddress: address,
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
  }, [visible, address, tokenAddress, pageChain]);

  useEffect(() => {
    if (!visible || !address) return;
    const timer = window.setTimeout(() => {
      void fetchReviews();
    }, 280);
    return () => window.clearTimeout(timer);
  }, [search]);

  const buildPayload = async (): Promise<TradeReviewUpsertInput | null> => {
    if (!address) {
      toast.error(tt('contentUi.review.toast.walletRequired'));
      return null;
    }
    const tokenAddr = draft.tokenAddress.trim();
    if (!tokenAddr) {
      toast.error(tt('contentUi.review.toast.tokenRequired'));
      return null;
    }
    if (!draft.narrative.trim()) {
      toast.error(tt('contentUi.review.sample.needNarrative'));
      return null;
    }
    if (!draft.catalyst.trim()) {
      toast.error(tt('contentUi.review.sample.needCatalyst'));
      return null;
    }
    if (!isCatalystResult(draft.catalystResult)) {
      toast.error(tt('contentUi.review.sample.needResult'));
      return null;
    }
    if (!draft.buyLogic.trim()) {
      toast.error(tt('contentUi.review.sample.needBuy'));
      return null;
    }
    if (!draft.sellLogic.trim()) {
      toast.error(tt('contentUi.review.sample.needSell'));
      return null;
    }
    const chain = draft.chain || (await resolveActiveChain());
    const opened = normalizeUnixSeconds(draft.holdStartAt ?? draft.metrics?.holdStartAt);
    const closed = normalizeUnixSeconds(draft.holdEndAt ?? draft.metrics?.holdEndAt);
    const walletAddress = normalizeAddress(address) ?? address.trim();
    const storedToken = normalizeAddress(tokenAddr) ?? tokenAddr;
    return {
      id: draft.id,
      walletAddress,
      chain,
      tokenAddress: storedToken,
      tokenSymbol: draft.tokenSymbol.trim() || 'UNKNOWN',
      tokenName: draft.tokenName.trim(),
      launchpad: draft.launchpad.trim(),
      visibility: draft.visibility,
      reviewTitle: draft.reviewTitle.trim() || `${draft.tokenSymbol || tokenAddr.slice(0, 6)} ${tt('contentUi.review.form.defaultTitleSuffix')}`,
      tags: draft.tags,
      narrativeTags: [draft.narrative],
      narrative: draft.narrative,
      catalyst: draft.catalyst,
      catalystNote: draft.buyLogic.trim(),
      catalystResult: draft.catalystResult,
      peakMarketCap: draft.peakMarketCap,
      notionPageId: draft.notionPageId,
      notionSyncedHash: draft.notionSyncedHash,
      mistakes: draft.mistakes,
      emotionScore: Math.min(100, Math.max(0, Math.round(draft.emotionScore))),
      executionScore: Math.min(100, Math.max(0, Math.round(draft.executionScore))),
      confidenceScore: Math.min(100, Math.max(0, Math.round(draft.confidenceScore))),
      buyLogic: draft.buyLogic.trim(),
      sellLogic: draft.sellLogic.trim(),
      summary: draft.summary.trim(),
      lessonLearned: draft.lessonLearned.trim(),
      nextAction: draft.nextAction.trim(),
      holdStartAt: opened,
      holdEndAt: closed,
      metrics: {
        ...(draft.metrics || {}),
        holdStartAt: opened,
        holdEndAt: closed,
        holdDurationSec: opened && closed ? Math.max(0, closed - opened) : (draft.metrics?.holdDurationSec ?? null),
      },
    };
  };

  const handleSave = async (quiet = false): Promise<TradeReview | null> => {
    const payload = await buildPayload();
    if (!payload) return null;
    setSaving(true);
    try {
      const res = await ReviewService.upsert(payload);
      setDataSource(res.source);
      setDraft(toDraftFromReview(res.item));
      setActiveId(res.item.id);
      await fetchReviews();
      if (!quiet) toast.success(res.source === 'cloud' ? tt('contentUi.review.toast.savedCloud') : tt('contentUi.review.toast.savedLocal'));
      return res.item;
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.saveFailed'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!activeId) return;
    try {
      const res = await ReviewService.remove(activeId);
      setDataSource(res.source);
      setDraft(toDraft({
        tokenAddress: tokenAddress || '',
        tokenSymbol: tokenSymbol && !isPlaceholderSymbol(tokenSymbol, tokenAddress || '') ? tokenSymbol : '',
        tokenName: String(tokenName || '').trim(),
      }));
      setActiveId(null);
      await fetchReviews();
      toast.success(tt('contentUi.review.toast.deleted'));
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.deleteFailed'));
    }
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

  const labelNarrative = (option: string) => {
    const text = String(option || '').trim();
    return isNarrative(text) ? tt(`contentUi.review.sample.narrativeOpt.${text}`) : (text || '-');
  };
  const labelCatalyst = (option: string) => {
    const text = String(option || '').trim();
    return isCatalyst(text) ? tt(`contentUi.review.sample.catalystOpt.${text}`) : (text || '-');
  };
  const labelResult = (option: string) => {
    const text = String(option || '').trim();
    return isCatalystResult(text) ? tt(`contentUi.review.sample.resultOpt.${text}`) : (text || '-');
  };
  const labelCeiling = (option: string) => tt(`contentUi.review.sample.ceiling.${option}`);
  const narrativeOptions = useMemo(
    () => mergeTagOptions(NARRATIVES, reviews.map((item) => item.narrative), draft.narrative),
    [reviews, draft.narrative],
  );
  const catalystOptions = useMemo(
    () => mergeTagOptions(CATALYSTS, reviews.map((item) => item.catalyst), draft.catalyst),
    [reviews, draft.catalyst],
  );

  const scopedReviews = useMemo(() => {
    if (chainFilter === 'all') return reviews;
    return reviews.filter((item) => reviewChainLabel(item.chain) === chainFilter);
  }, [reviews, chainFilter]);

  const completeScoped = useMemo(
    () => scopedReviews.filter((item) => isCompleteSample(item) && item.peakMarketCap != null),
    [scopedReviews],
  );

  const missingPeak = scopedReviews.length - completeScoped.length;

  const narrativeGroups = useMemo(() => groupCeilingStats(completeScoped.map((item) => ({
    key: `${reviewChainLabel(item.chain)}|${item.narrative}`,
    peak: item.peakMarketCap || 0,
  }))), [completeScoped]);

  const catalystGroups = useMemo(() => groupCeilingStats(completeScoped.map((item) => ({
    key: `${reviewChainLabel(item.chain)}|${item.catalyst}`,
    peak: item.peakMarketCap || 0,
  }))), [completeScoped]);

  const resultGroups = useMemo(() => groupCeilingStats(completeScoped.map((item) => ({
    key: `${item.catalyst}|${item.catalystResult}`,
    peak: item.peakMarketCap || 0,
  }))), [completeScoped]);

  const tableHeaders = {
    key: tt('contentUi.review.sample.colKey'),
    count: tt('contentUi.review.sample.colCount'),
    above: tt('contentUi.review.sample.colAbove'),
    low: tt('contentUi.review.sample.colLow'),
    median: tt('contentUi.review.sample.colMedian'),
  };

  const sourceBadge = dataSource === 'cloud'
    ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-emerald-300"><Cloud size={12} />Supabase</span>
    : <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-1 text-amber-300"><HardDrive size={12} />Local</span>;
  const totalSupplyNum = Number(draft.metrics?.totalSupply || 0);
  const avgBuyNum = Number(draft.metrics?.avgBuyPrice || 0);
  const avgSellNum = Number(draft.metrics?.avgSellPrice || 0);
  const buyCap = totalSupplyNum > 0 && avgBuyNum > 0 ? avgBuyNum * totalSupplyNum : 0;
  const sellCap = totalSupplyNum > 0 && avgSellNum > 0 ? avgSellNum * totalSupplyNum : 0;
  const parsedPeak = draft.peakMarketCap;
  const ceiling = reviewCeiling(parsedPeak);
  const symbolText = isPlaceholderSymbol(draft.tokenSymbol, draft.tokenAddress) ? '' : draft.tokenSymbol.trim();
  const nameText = draft.tokenName.trim();
  const primaryLabel = symbolText || nameText || '-';
  const secondaryLabel = symbolText && nameText && symbolText !== nameText ? nameText : '';
  const tokenDetailLink = tokenPageLink(draft.tokenAddress || '');

  const lessonRows = useMemo(() => {
    return reviews
      .map((item) => ({
        item,
        text: String(item.lessonLearned || '').trim(),
        score: Number.isFinite(Number(item.metrics?.lessonScore)) ? Number(item.metrics?.lessonScore) : 0,
      }))
      .filter((row) => row.text)
      .sort((a, b) => b.score - a.score || (b.item.updatedAt || 0) - (a.item.updatedAt || 0));
  }, [reviews]);

  const adjustLessonScore = async (item: TradeReview, delta: number) => {
    const base = lessonScoreRef.current[item.id] ?? (Number(item.metrics?.lessonScore) || 0);
    const score = base + delta;
    lessonScoreRef.current[item.id] = score;
    const metrics = { ...(item.metrics || {}), lessonScore: score };
    const next = { ...item, metrics };
    setReviews((prev) => prev.map((row) => row.id === item.id ? { ...row, metrics } : row));
    if (draft.id === item.id) setDraft((prev) => ({ ...prev, metrics }));
    try {
      const res = await ReviewService.upsert(next);
      const savedScore = lessonScoreRef.current[item.id];
      const saved = savedScore === score
        ? res.item
        : { ...res.item, metrics: { ...(res.item.metrics || {}), lessonScore: savedScore } };
      setReviews((prev) => prev.map((row) => row.id === saved.id ? saved : row));
      setDataSource(res.source);
      if (draft.id === saved.id && savedScore === score) setDraft(toDraftFromReview(saved));
    } catch (err: any) {
      toast.error(err?.message || tt('contentUi.review.toast.saveFailed'));
    }
  };

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
              <button
                type="button"
                className={`px-2 py-1 rounded text-[11px] ${viewMode === 'summary' ? 'bg-amber-500/20 text-amber-300' : 'text-zinc-400 hover:text-zinc-200'}`}
                onClick={() => setViewMode('summary')}
              >
                {tt('contentUi.review.action.summary')}
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

            <div className="text-zinc-400 mb-2">{tt('contentUi.review.stats.total', [reviews.length])}</div>
            <div className="flex-1 overflow-auto space-y-1.5 pr-1">
              {reviews.map((item) => {
                const pnl = Number(item.metrics?.totalProfitPnl || 0);
                const isCurrentToken = !!tokenAddress && normalizeAddressKey(item.tokenAddress) === normalizeAddressKey(tokenAddress);
                const isProfit = pnl >= 0;
                const cardCls = activeId === item.id
                  ? (isProfit ? 'border-emerald-500 bg-emerald-500/10' : 'border-rose-500 bg-rose-500/10')
                  : (isProfit ? 'border-zinc-800 hover:border-emerald-700/70' : 'border-zinc-800 hover:border-rose-700/70');
                const currentCls = isCurrentToken && activeId !== item.id ? ' ring-1 ring-cyan-700/70' : '';
                const pnlCls = isProfit ? 'text-emerald-300' : 'text-rose-300';
                const itemCeiling = reviewCeiling(item.peakMarketCap);
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
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-zinc-100 truncate">{item.tokenSymbol || String(item.tokenAddress || '').slice(0, 6) || '-'}</span>
                      <span className="text-zinc-500 text-[10px] shrink-0">{reviewChainLabel(item.chain)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-zinc-400 truncate">
                        {item.narrative ? labelNarrative(item.narrative) : '-'}
                        {itemCeiling ? ` · ${labelCeiling(itemCeiling)}` : ''}
                      </span>
                      <span className={`text-[10px] shrink-0 ${pnlCls}`}>
                        {isProfit ? '+' : ''}{formatNum(pnl * 100, 2)}%
                      </span>
                    </div>
                  </button>
                );
              })}
              {reviews.length === 0 && (
                <div className="text-zinc-500 text-center py-8">{tt('contentUi.review.empty')}</div>
              )}
            </div>
          </div>

          <div className="p-2 flex flex-col min-h-0 overflow-auto">
            {viewMode === 'input' ? (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-0.5">{tt('contentUi.review.form.tokenSymbol')}</div>
                    <div className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 flex items-center gap-2 min-w-0">
                      {draft.metrics?.tokenLogo ? (
                        <img src={draft.metrics.tokenLogo} alt={primaryLabel} className="w-6 h-6 rounded-full object-cover shrink-0" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-zinc-700/70 flex items-center justify-center text-[10px] text-zinc-200 shrink-0">
                          {(primaryLabel === '-' ? '?' : primaryLabel).slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex items-center gap-1.5 text-zinc-200 truncate">
                        {tokenDetailLink ? (
                          <a href={tokenDetailLink} target="_blank" rel="noreferrer" className="text-cyan-300 hover:text-cyan-200 underline-offset-2 hover:underline shrink-0">
                            {primaryLabel}
                          </a>
                        ) : (
                          <span className="text-cyan-300 shrink-0">{primaryLabel}</span>
                        )}
                        {secondaryLabel ? (
                          <>
                            <span className="text-zinc-400">·</span>
                            <span className="truncate">{secondaryLabel}</span>
                          </>
                        ) : null}
                        <span className="text-zinc-500">·</span>
                        <span className="text-zinc-400 shrink-0">{shortAddress(draft.tokenAddress || '')}</span>
                      </div>
                    </div>
                  </div>

                  <div className="col-span-2 rounded-md border border-zinc-800 bg-zinc-900/35 p-1.5">
                    <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                      <div>
                        <div className="text-zinc-500/75 text-[11px]">{tt('contentUi.review.metrics.buySellMarketCap')}</div>
                        <div className="text-zinc-100">{formatCap(buyCap)} / {formatCap(sellCap)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-500/75 text-[11px]">{tt('contentUi.review.metrics.buySellCount')}</div>
                        <div className="text-zinc-100">{formatNum(draft.metrics?.historyTotalBuys, 0)} / {formatNum(draft.metrics?.historyTotalSells, 0)}</div>
                      </div>
                      <div>
                        <div className="text-zinc-500/75 text-[11px]">{tt('contentUi.review.metrics.buySellAmount')}</div>
                        <div className="text-zinc-100">{formatUsd(draft.metrics?.historyBoughtCost)} / {formatUsd(draft.metrics?.historySoldIncome)}</div>
                      </div>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <div className={`${Number(draft.metrics?.totalProfit || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                        {tt('contentUi.review.metrics.totalProfit')}: {formatUsd(draft.metrics?.totalProfit)} ({formatNum(Number(draft.metrics?.totalProfitPnl || 0) * 100, 2)}%)
                      </div>
                      <div className="text-zinc-400">{tt('contentUi.review.metrics.holdTime')}: {formatDuration(draft.metrics?.holdDurationSec)}</div>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-zinc-400">
                      <div>{tt('contentUi.review.metrics.openTime')}: {formatReviewTime(draft.holdStartAt ?? draft.metrics?.holdStartAt)}</div>
                      <div>{tt('contentUi.review.metrics.closeTime')}: {formatReviewTime(draft.holdEndAt ?? draft.metrics?.holdEndAt)}</div>
                    </div>
                  </div>

                  <div className="col-span-2 rounded-md border border-zinc-800 bg-zinc-900/35 px-2 py-1.5 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-zinc-500/75 text-[11px]">ATH</div>
                      <div className="text-zinc-100">
                        {formatCap(parsedPeak)}
                        {ceiling ? ` · ${labelCeiling(ceiling)}` : ''}
                      </div>
                    </div>
                    <div className="text-right text-[11px] text-zinc-400">
                      {parsedPeak
                        ? (sellCap > 0 ? tt('contentUi.review.sample.sellVsAth', [Math.round((sellCap / parsedPeak) * 100)]) : '')
                        : tt('contentUi.review.sample.athMissing')}
                    </div>
                  </div>

                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-1">{tt('contentUi.review.sample.narrative')}</div>
                    <ChoiceRow
                      options={narrativeOptions}
                      value={draft.narrative}
                      onChange={(narrative) => setDraft((prev) => ({ ...prev, narrative: resolveReviewTag(narrative, NARRATIVES, labelNarrative) }))}
                      labelOf={labelNarrative}
                      activeClass="border-emerald-500 bg-emerald-500/15 text-emerald-200"
                      addPlaceholder={tt('contentUi.review.sample.addTag')}
                    />
                  </div>

                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-1">{tt('contentUi.review.sample.catalyst')}</div>
                    <ChoiceRow
                      options={catalystOptions}
                      value={draft.catalyst}
                      onChange={(catalyst) => setDraft((prev) => ({ ...prev, catalyst: resolveReviewTag(catalyst, CATALYSTS, labelCatalyst) }))}
                      labelOf={labelCatalyst}
                      activeClass="border-cyan-500 bg-cyan-500/15 text-cyan-200"
                      addPlaceholder={tt('contentUi.review.sample.addTag')}
                    />
                  </div>

                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-1">{tt('contentUi.review.sample.result')}</div>
                    <ChoiceRow
                      options={CATALYST_RESULTS}
                      value={draft.catalystResult}
                      onChange={(catalystResult) => setDraft((prev) => ({ ...prev, catalystResult }))}
                      labelOf={labelResult}
                      activeClass="border-amber-500 bg-amber-500/15 text-amber-200"
                    />
                  </div>

                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-0.5">{tt('contentUi.review.form.buyLogic')}</div>
                    <textarea
                      value={draft.buyLogic}
                      onChange={(e) => setDraft((prev) => ({ ...prev, buyLogic: e.target.value }))}
                      placeholder={tt('contentUi.review.placeholder.buyLogic')}
                      className="w-full h-[52px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-0.5">{tt('contentUi.review.form.sellLogic')}</div>
                    <textarea
                      value={draft.sellLogic}
                      onChange={(e) => setDraft((prev) => ({ ...prev, sellLogic: e.target.value }))}
                      placeholder={tt('contentUi.review.placeholder.sellLogic')}
                      className="w-full h-[52px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="col-span-2">
                    <div className="text-zinc-500/75 text-[11px] mb-0.5">{tt('contentUi.review.form.lessonLearned')}</div>
                    <textarea
                      value={draft.lessonLearned}
                      onChange={(e) => setDraft((prev) => ({ ...prev, lessonLearned: e.target.value }))}
                      placeholder={tt('contentUi.review.placeholder.lesson')}
                      className="w-full h-[52px] rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-zinc-100 focus:outline-none focus:border-emerald-500"
                    />
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
            ) : viewMode === 'analysis' ? (
              <>
                <div className="flex items-center gap-1 mb-2">
                  {(['all', 'BSC', 'SOL', 'RH'] as const).map((chain) => (
                    <button
                      key={chain}
                      type="button"
                      onClick={() => setChainFilter(chain)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${chainFilter === chain ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200' : 'border-zinc-700 text-zinc-400'}`}
                    >
                      {chain === 'all' ? tt('contentUi.review.sample.chainAll') : chain}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-zinc-500 mb-2">
                  {tt('contentUi.review.sample.minSample')}
                  {missingPeak > 0 ? ` · ${tt('contentUi.review.sample.missingPeak', [missingPeak])}` : ''}
                </div>
                <div className="space-y-2">
                  <SampleTable
                    title={tt('contentUi.review.sample.tableNarrative')}
                    groups={narrativeGroups}
                    headers={tableHeaders}
                    empty={tt('contentUi.review.sample.emptyStats')}
                    labelOf={(key) => {
                      const [chain, narrative] = key.split('|');
                      return `${chain} · ${labelNarrative(narrative || '')}`;
                    }}
                  />
                  <SampleTable
                    title={tt('contentUi.review.sample.tableCatalyst')}
                    groups={catalystGroups}
                    headers={tableHeaders}
                    empty={tt('contentUi.review.sample.emptyStats')}
                    labelOf={(key) => {
                      const [chain, catalyst] = key.split('|');
                      return `${chain} · ${labelCatalyst(catalyst || '')}`;
                    }}
                  />
                  <SampleTable
                    title={tt('contentUi.review.sample.tableResult')}
                    groups={resultGroups}
                    headers={tableHeaders}
                    empty={tt('contentUi.review.sample.emptyStats')}
                    labelOf={(key) => {
                      const [catalyst, result] = key.split('|');
                      return `${labelCatalyst(catalyst || '')} · ${labelResult(result || '')}`;
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 overflow-auto space-y-1.5 pr-1">
                {lessonRows.length === 0 ? (
                  <div className="text-zinc-500 text-center py-8">{tt('contentUi.review.summary.empty')}</div>
                ) : lessonRows.map((row) => (
                  <div key={row.item.id} className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1.5">
                    <div className="flex items-center gap-1 shrink-0 pt-0.5">
                      <button
                        type="button"
                        className="h-5 w-5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                        onClick={() => void adjustLessonScore(row.item, -1)}
                      >
                        -
                      </button>
                      <span className={`w-6 text-center ${row.score > 0 ? 'text-emerald-300' : row.score < 0 ? 'text-rose-300' : 'text-zinc-400'}`}>{row.score}</span>
                      <button
                        type="button"
                        className="h-5 w-5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                        onClick={() => void adjustLessonScore(row.item, 1)}
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        setActiveId(row.item.id);
                        setDraft(toDraftFromReview(row.item));
                        setViewMode('input');
                      }}
                    >
                      <div className="text-zinc-100 whitespace-pre-wrap">{row.text}</div>
                      <div className="mt-0.5 text-[10px] text-zinc-500">
                        {row.item.tokenSymbol || String(row.item.tokenAddress || '').slice(0, 6)} · {reviewChainLabel(row.item.chain)}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
