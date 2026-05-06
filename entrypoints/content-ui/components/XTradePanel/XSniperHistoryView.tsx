import { useEffect, useMemo, useState } from 'react';
import type { Settings, XSniperBuyRecord, XSniperEvalPoint } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { chainNames } from '@/constants/chains/chainName';
import { extractLaunchpadPlatform } from '@/constants/launchpad';
import { call } from '@/utils/messaging';
import { navigateToUrl, type SiteInfo, parsePlatformTokenLink } from '@/utils/sites';
import { formatBnbAmount, formatCompactNumber, formatShortAddress } from '@/utils/format';
import { XSniperWsStatusSection } from './XSniperWsStatusSection';
import { LaunchpadPlatformBadge } from './LaunchpadPlatformBadge';
import { XSniperHistorySummaryPanel, type SummaryRunMode } from './XSniperHistorySummaryPanel';

type HistoryGroup = { key: string; parent: XSniperBuyRecord; children: XSniperBuyRecord[] };

type XSniperHistoryViewProps = {
  siteInfo: SiteInfo | null;
  settings: Settings | null;
  isUnlocked: boolean;
  canEdit: boolean;
  tt: (key: string, subs?: Array<string | number>) => string;
  buyHistory: XSniperBuyRecord[];
  historyGroups: HistoryGroup[];
  latestTokenByAddr: Record<string, any>;
  athMcapByAddr: Record<string, number>;
  wsStatus: any;
  wsMonitorEnabled: boolean;
  showTweetTime?: boolean;
  twitterSnipeEnabled: boolean;
  taskModeEnabled?: boolean;
  twitterSnipeDryRun: boolean;
  onTwitterSnipeEnabledChange: (next: boolean) => void;
  onTaskModeEnabledChange?: (next: boolean) => void;
  onTwitterSnipeDryRunChange: (next: boolean) => void;
  onOpenConfig?: () => void;
  onOpenTaskManager?: () => void;
  onOpenCreateTask?: () => void;
  onClearHistory: () => void;
};

const XSNIPER_EVAL_WINDOWS = [
  { key: 'eval3s', label: '3s' },
  { key: 'eval5s', label: '5s' },
  { key: 'eval8s', label: '8s' },
  { key: 'eval10s', label: '10s' },
  { key: 'eval15s', label: '15s' },
  { key: 'eval20s', label: '20s' },
  { key: 'eval25s', label: '25s' },
  { key: 'eval30s', label: '30s' },
  { key: 'eval60s', label: '60s' },
] as const satisfies ReadonlyArray<{ key: keyof XSniperBuyRecord; label: string }>;

const buildTweetUrlFallback = (record: XSniperBuyRecord): string => {
  const id = String(record.signalTweetId ?? '').trim();
  if (!/^\d{6,}$/.test(id)) return '';
  const user = String(record.userScreen ?? '')
    .trim()
    .replace(/^@/, '');
  if (user) return `https://x.com/${encodeURIComponent(user)}/status/${id}`;
  return `https://x.com/i/web/status/${id}`;
};

const formatTs = (tsMs: number) => {
  try {
    return new Date(tsMs).toLocaleString();
  } catch {
    return String(tsMs);
  }
};

const clampPercent = (value: unknown) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
};

const getSellPercentOfOriginal = (record: XSniperBuyRecord) => {
  const fromOriginal = Number((record as any).sellPercentOfOriginal);
  if (Number.isFinite(fromOriginal)) return clampPercent(fromOriginal);
  return clampPercent(record.sellPercent);
};

const formatSellPercentText = (record: XSniperBuyRecord) => {
  const original = Number((record as any).sellPercentOfOriginal);
  const current = Number((record as any).sellPercentOfCurrent);
  if (Number.isFinite(original) && Number.isFinite(current)) {
    return `${clampPercent(original).toFixed(2)}% (orig) / ${clampPercent(current).toFixed(2)}% (curr)`;
  }
  const fallback = Number(record.sellPercent);
  if (Number.isFinite(fallback)) return `${clampPercent(fallback).toFixed(2)}%`;
  return '-';
};

const resolveReasonLabel = (tt: (key: string, subs?: Array<string | number>) => string, reason: unknown) => {
  if (reason == null) return '-';
  const raw = String(reason).trim();
  if (!raw) return '-';
  const key = `contentUi.autoTradeStrategy.snipeHistoryReasonCode.${raw}`;
  const translated = tt(key);
  if (translated !== key) return translated;
  const fallbackMap: Record<string, string> = {
    rapid_take_profit: '里程碑分批止盈',
    rapid_stop_loss: '硬止损',
    rapid_trailing_stop: '地板清仓',
    position_reduced_manually: '手动减仓',
    position_closed_manually: '手动全平（仓位归零）',
  };
  return fallbackMap[raw] ?? raw;
};

const getEvalPoint = (record: XSniperBuyRecord, key: keyof XSniperBuyRecord): XSniperEvalPoint | null => {
  const value = (record as any)[key];
  if (!value || typeof value !== 'object') return null;
  const atMs = Number((value as any).atMs);
  if (!Number.isFinite(atMs) || atMs <= 0) return null;
  return value as XSniperEvalPoint;
};

const formatEvalPnl = (record: XSniperBuyRecord, key: keyof XSniperBuyRecord) => {
  const pnlPct = getEvalPoint(record, key)?.pnlMcapPct;
  if (typeof pnlPct !== 'number' || !Number.isFinite(pnlPct)) return '-';
  return `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
};

const resolveWalletDisplay = (input: { record: XSniperBuyRecord; settings: Settings | null }) => {
  const walletAddress = String((input.record as any).walletAddress || '').trim().toLowerCase();
  if (!walletAddress) return '未记录(默认当前钱包)';
  const accounts = Array.isArray((input.settings as any)?.wallet?.accounts) ? (input.settings as any).wallet.accounts : [];
  const account = accounts.find((acc: any) => String(acc?.address || '').trim().toLowerCase() === walletAddress);
  const alias = String(((input.settings as any)?.wallet?.accountAliases || {})?.[walletAddress] || '').trim();
  const name = String(account?.name || '').trim() || alias || 'Wallet';
  return `${name} (${formatShortAddress(walletAddress)})`;
};

const computeWeightedPnlPct = (input: {
  entryMcap: number | null;
  latestMcap: number | null;
  sellRecords: XSniperBuyRecord[];
}) => {
  const entry = input.entryMcap;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) {
    return { pnlPct: null as number | null, soldPct: 0, remainPct: 100, mode: 'unrealized' as 'unrealized' | 'mixed' | 'realized' };
  }
  const sortedSells = input.sellRecords
    .filter((x) => x && x.side === 'sell')
    .slice()
    .sort((a, b) => (Number(a.tsMs) || 0) - (Number(b.tsMs) || 0));
  let soldPct = 0;
  let pricedSoldPct = 0;
  let weightedRoi = 0;
  for (const s of sortedSells) {
    const nextPct = getSellPercentOfOriginal(s);
    const effectivePct = Math.min(nextPct, Math.max(0, 100 - soldPct));
    if (!(effectivePct > 0)) continue;
    const sellMcap = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : input.latestMcap;
    if (sellMcap != null && Number.isFinite(sellMcap) && sellMcap > 0) {
      weightedRoi += (effectivePct / 100) * ((sellMcap / entry) - 1);
      pricedSoldPct += effectivePct;
    }
    soldPct += effectivePct;
  }
  const remainPct = Math.max(0, 100 - soldPct);
  if (remainPct > 0 && input.latestMcap != null && Number.isFinite(input.latestMcap) && input.latestMcap > 0) {
    weightedRoi += (remainPct / 100) * ((input.latestMcap / entry) - 1);
  }
  const mode: 'unrealized' | 'mixed' | 'realized' =
    soldPct <= 0 ? 'unrealized' : remainPct <= 0 ? 'realized' : 'mixed';
  if (pricedSoldPct < soldPct && (remainPct <= 0 || input.latestMcap == null || !Number.isFinite(input.latestMcap) || input.latestMcap <= 0)) {
    return { pnlPct: null as number | null, soldPct, remainPct, mode };
  }
  return { pnlPct: weightedRoi * 100, soldPct, remainPct, mode };
};

export function XSniperHistoryView({
  siteInfo,
  settings,
  isUnlocked,
  canEdit,
  tt,
  buyHistory,
  historyGroups,
  latestTokenByAddr,
  athMcapByAddr,
  wsStatus,
  wsMonitorEnabled,
  showTweetTime = true,
  twitterSnipeEnabled,
  taskModeEnabled = true,
  twitterSnipeDryRun,
  onTwitterSnipeEnabledChange,
  onTaskModeEnabledChange,
  onTwitterSnipeDryRunChange,
  onOpenConfig,
  onOpenTaskManager,
  onOpenCreateTask,
  onClearHistory,
}: XSniperHistoryViewProps) {
  const [keyword, setKeyword] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);
  const [sellingKey, setSellingKey] = useState<string | null>(null);
  const [wsExpanded, setWsExpanded] = useState(false);
  const [showWsLogs, setShowWsLogs] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [summaryRunMode, setSummaryRunMode] = useState<SummaryRunMode>('live');
  const [strategyModeFilter, setStrategyModeFilter] = useState<'all' | 'auto_filter' | 'xmode_task'>('all');
  const normalizedKeyword = keyword.trim().toLowerCase();
  const taskSummaryText = useMemo(() => {
    const rawTasks = (settings as any)?.autoTrade?.newCoinSnipe?.xmodeTasks;
    const tasks = Array.isArray(rawTasks) ? rawTasks : [];
    const total = tasks.filter((x) => x && typeof x === 'object').length;
    const running = tasks.filter((x) => x && typeof x === 'object' && (x as any).enabled !== false).length;
    return `${running}/${total}`;
  }, [settings]);

  const filteredGroups = useMemo(() => {
    return historyGroups.filter((g) => {
      const mode = g.parent.strategyMode === 'xmode_task' ? 'xmode_task' : 'auto_filter';
      if (strategyModeFilter !== 'all' && mode !== strategyModeFilter) return false;
      if (!normalizedKeyword) return true;
      const symbol = String(g.parent.tokenSymbol ?? '').toLowerCase();
      const addr = String(g.parent.tokenAddress ?? '').toLowerCase();
      return symbol.includes(normalizedKeyword) || addr.includes(normalizedKeyword);
    });
  }, [historyGroups, normalizedKeyword, strategyModeFilter]);

  useEffect(() => {
    setVisibleCount(20);
  }, [normalizedKeyword, strategyModeFilter, historyGroups.length]);

  const visibleGroups = useMemo(() => filteredGroups.slice(0, visibleCount), [filteredGroups, visibleCount]);
  const canLoadMore = visibleCount < filteredGroups.length;
  const summaryData = useMemo(() => {
    const summaryGroups = filteredGroups.filter((g) => {
      if (!g || !g.parent || g.parent.side === 'sell') return false;
      if (summaryRunMode === 'live') return g.parent.dryRun !== true;
      if (summaryRunMode === 'dry') return g.parent.dryRun === true;
      return true;
    });
    const summaryParents = summaryGroups.map((g) => g.parent).filter((x) => x && x.side !== 'sell');
    const total = summaryParents.length;
    const dry = summaryParents.filter((x) => x.dryRun === true).length;
    const live = summaryParents.filter((x) => x.dryRun !== true).length;
    const confirmFail = summaryParents.filter((x) => x.reason === 'ws_confirm_failed').length;
    const collect = (key: keyof XSniperBuyRecord) =>
      summaryParents
        .map((x) => getEvalPoint(x, key)?.pnlMcapPct)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const winRate = (arr: number[]) => (arr.length ? arr.filter((x) => x > 0).length / arr.length : null);
    const weightedStats = summaryGroups.map((g) => {
      const r = g.parent;
      const entryMcap = typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) ? r.marketCapUsd : null;
      const latest = latestTokenByAddr[String(r.tokenAddress || '').toLowerCase()] ?? null;
      const latestMcap = latest && typeof latest.marketCapUsd === 'number' && Number.isFinite(latest.marketCapUsd)
        ? Number(latest.marketCapUsd)
        : null;
      const sellRecords = g.children.filter((x) => x && x.side === 'sell');
      const weighted = computeWeightedPnlPct({ entryMcap, latestMcap, sellRecords });
      const reasonStats = sellRecords.reduce(
        (acc, s) => {
          const reason = String(s.reason || '').trim();
          if (reason === 'rapid_take_profit') acc.tp += 1;
          else if (reason === 'rapid_stop_loss') acc.sl += 1;
          else if (reason === 'rapid_trailing_stop') acc.floor += 1;
          else acc.other += 1;
          return acc;
        },
        { tp: 0, sl: 0, floor: 0, other: 0 }
      );
      return {
        pnlPct: weighted.pnlPct,
        mode: weighted.mode,
        soldPct: weighted.soldPct,
        remainPct: weighted.remainPct,
        sellCount: sellRecords.length,
        athPnlPct: (() => {
          const recordAthMcap = typeof r.athMarketCapUsd === 'number' && Number.isFinite(r.athMarketCapUsd) ? r.athMarketCapUsd : null;
          const athMcap = recordAthMcap ?? (athMcapByAddr[String(r.tokenAddress || '').toLowerCase()] ?? null);
          if (entryMcap == null || !Number.isFinite(entryMcap) || entryMcap <= 0) return null;
          if (athMcap == null || !Number.isFinite(athMcap) || athMcap <= 0) return null;
          return ((athMcap / entryMcap) - 1) * 100;
        })(),
        ...reasonStats,
      };
    });
    const weightedPnlValues = weightedStats
      .map((x) => x.pnlPct)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const athPnlValues = summaryGroups
      .map((g) => {
        const r = g.parent;
        const entryMcap = typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) ? r.marketCapUsd : null;
        const recordAthMcap = typeof r.athMarketCapUsd === 'number' && Number.isFinite(r.athMarketCapUsd) ? r.athMarketCapUsd : null;
        const athMcap = recordAthMcap ?? (athMcapByAddr[String(r.tokenAddress || '').toLowerCase()] ?? null);
        if (entryMcap == null || !Number.isFinite(entryMcap) || entryMcap <= 0) return null;
        if (athMcap == null || !Number.isFinite(athMcap) || athMcap <= 0) return null;
        return ((athMcap / entryMcap) - 1) * 100;
      })
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const takeProfitTriggeredGroups = weightedStats.filter((x) => x.tp > 0).length;
    const stopLossOnlyGroups = weightedStats.filter((x) => x.sl > 0 && x.tp === 0).length;
    const stopLossGroups = weightedStats.filter((x) => x.sl > 0);
    const reboundAfterStopLossCount = stopLossGroups.filter((x) => (x.athPnlPct ?? 0) > 0).length;
    const givebackRate = (() => {
      const base = avg(athPnlValues);
      const realized = avg(weightedPnlValues);
      if (base == null || !Number.isFinite(base) || base <= 0) return null;
      if (realized == null || !Number.isFinite(realized)) return null;
      return Math.max(0, Math.min(1, (base - realized) / base));
    })();

    return {
      total,
      dry,
      live,
      confirmFail,
      weightedPnlAvg: avg(weightedPnlValues),
      weightedWinRate: winRate(weightedPnlValues),
      weightedSamples: weightedPnlValues.length,
      athPnlAvg: avg(athPnlValues),
      athWinRate: winRate(athPnlValues),
      athSamples: athPnlValues.length,
      winCount: weightedPnlValues.filter((x) => x > 0).length,
      lossCount: weightedPnlValues.filter((x) => x < 0).length,
      flatCount: weightedPnlValues.filter((x) => x === 0).length,
      realizedCount: weightedStats.filter((x) => x.mode === 'realized').length,
      mixedCount: weightedStats.filter((x) => x.mode === 'mixed').length,
      unrealizedCount: weightedStats.filter((x) => x.mode === 'unrealized').length,
      avgSoldPct: avg(weightedStats.map((x) => x.soldPct)),
      avgRemainPct: avg(weightedStats.map((x) => x.remainPct)),
      sellParticipationRate: total > 0 ? weightedStats.filter((x) => x.sellCount > 0).length / total : null,
      avgSellCount: avg(weightedStats.map((x) => x.sellCount)),
      tpCount: weightedStats.reduce((acc, x) => acc + x.tp, 0),
      slCount: weightedStats.reduce((acc, x) => acc + x.sl, 0),
      floorCount: weightedStats.reduce((acc, x) => acc + x.floor, 0),
      otherReasonCount: weightedStats.reduce((acc, x) => acc + x.other, 0),
      takeProfitTriggeredRate: total > 0 ? takeProfitTriggeredGroups / total : null,
      stopLossOnlyRate: total > 0 ? stopLossOnlyGroups / total : null,
      stopLossGroupCount: stopLossGroups.length,
      reboundAfterStopLossCount,
      reboundAfterStopLossRate: stopLossGroups.length > 0 ? reboundAfterStopLossCount / stopLossGroups.length : null,
      givebackRate,
      evalMetrics: XSNIPER_EVAL_WINDOWS.map((window) => {
        const values = collect(window.key);
        return {
          label: window.label,
          avg: avg(values),
          winRate: winRate(values),
          samples: values.length,
        };
      }),
    };
  }, [filteredGroups, latestTokenByAddr, athMcapByAddr, summaryRunMode]);

  const sellByPercent = async (record: XSniperBuyRecord, pct: number) => {
    if (!settings) return;
    if (!isUnlocked) return;
    const chainId = typeof record.chainId === 'number' ? record.chainId : settings.chainId;
    const tokenAddressNormalized = String(record.tokenAddress || '').toLowerCase() as `0x${string}`;
    if (!tokenAddressNormalized || !tokenAddressNormalized.startsWith('0x')) return;

    const percentBps = Math.max(1, Math.min(10000, Math.floor(pct * 100)));
    const isTurbo = settings.chains[chainId]?.executionMode === 'turbo';

    const key = `${record.id}:${pct}`;
    setSellingKey(key);
    try {
      const state = await call({ type: 'bg:getState' } as const);
      const address = state?.wallet?.address;
      if (!address) throw new Error('Wallet not ready');

      const balRes = await call({ type: 'token:getBalance', tokenAddress: tokenAddressNormalized, address } as const);
      const balanceWei = BigInt(balRes.balanceWei || '0');
      if (balanceWei <= 0n) throw new Error('No balance');

      const meta = await call({ type: 'token:getMeta', tokenAddress: tokenAddressNormalized } as const);
      const chain = chainNames[chainId] ?? String(chainId);
      const httpTokenInfoRes = await call({
        type: 'token:getTokenInfo:fourmemeHttp',
        platform: siteInfo?.platform ?? 'gmgn',
        chain,
        address: tokenAddressNormalized,
      } as const);

      const tokenInfo: TokenInfo =
        httpTokenInfoRes.tokenInfo ??
        ({
          chain,
          address: tokenAddressNormalized,
          name: record.tokenName ? String(record.tokenName) : meta.symbol,
          symbol: record.tokenSymbol ? String(record.tokenSymbol) : meta.symbol,
          decimals: Number(meta.decimals) || 18,
          logo: '',
          launchpad: '',
          launchpad_progress: 0,
          launchpad_platform: '',
          launchpad_status: 1,
          quote_token: '',
        } as TokenInfo);

      const approveRes = await call({
        type: 'tx:approveMaxForSellIfNeeded',
        chainId,
        tokenAddress: tokenAddressNormalized,
        tokenInfo,
      } as const);
      if (approveRes.txHash) {
        const receipt = await call({ type: 'tx:waitForReceipt', hash: approveRes.txHash, chainId } as const);
        if (!receipt.ok) {
          const detail = receipt.revertReason || receipt.error?.shortMessage || receipt.error?.message;
          throw new Error(detail || 'Approve failed');
        }
      }

      const tokenAmountWei = isTurbo ? '0' : ((balanceWei * BigInt(pct)) / 100n).toString();
      const sellRes = await call({
        type: 'tx:sell',
        input: {
          chainId,
          tokenAddress: tokenAddressNormalized,
          tokenAmountWei,
          sellPercentBps: isTurbo ? percentBps : undefined,
          expectedTokenInWei: isTurbo ? balanceWei.toString() : undefined,
          tokenInfo,
        },
      } as const);
      if (!sellRes.ok) {
        const detail = sellRes.revertReason || sellRes.error?.shortMessage || sellRes.error?.message;
        throw new Error(detail || 'Sell failed');
      }
      const triggerSource = String((record as any)?.triggerSource || '').trim();
      const manualSellType = triggerSource
        ? 'newCoinSniper:manualPositionSold'
        : 'xsniper:manualPositionSold';
      await call({
        type: manualSellType as any,
        input: {
          chainId,
          tokenAddress: tokenAddressNormalized,
          sellPercent: pct,
          txHash: (sellRes as any)?.txHash,
        },
      } as const);
    } finally {
      setSellingKey((prev) => (prev === key ? null : prev));
    }
  };

  const onExportHistory = () => {
    try {
      const blob = new Blob([JSON.stringify(buyHistory, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.href = url;
      a.download = `xsniper-history-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
    }
  };

  return (
    <div className="dagobang-scrollbar space-y-2">
      <div className="rounded-md border border-zinc-800 bg-zinc-900/30 p-2">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-zinc-300">
            <label
              className="flex items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-900/60 px-2 py-1"
              title={wsMonitorEnabled ? tt('contentUi.autoTradeStrategy.twitterSnipeEnabledDesc') : tt('contentUi.xMonitor.wsMonitorDisabledSniperTip')}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-emerald-500"
                checked={twitterSnipeEnabled}
                disabled={!canEdit || !wsMonitorEnabled}
                onChange={(e) => onTwitterSnipeEnabledChange(e.target.checked)}
              />
              <span className={!canEdit || !wsMonitorEnabled ? 'text-zinc-500' : ''}>{tt('contentUi.autoTradeStrategy.twitterSnipeEnabledShort')}</span>
            </label>
            <label
              className="flex items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-900/60 px-2 py-1"
              title={tt('contentUi.autoTradeStrategy.twitterSnipeDryRun')}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-amber-500"
                checked={twitterSnipeDryRun}
                disabled={!canEdit}
                onChange={(e) => onTwitterSnipeDryRunChange(e.target.checked)}
              />
              <span>{tt('contentUi.autoTradeStrategy.twitterSnipeDryRunShort')}</span>
            </label>
            {onTaskModeEnabledChange ? (
              <label className="flex items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-900/60 px-2 py-1" title="任务狙击开关">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-sky-500"
                  checked={taskModeEnabled}
                  disabled={!canEdit}
                  onChange={(e) => onTaskModeEnabledChange(e.target.checked)}
                />
                <span>任务狙击启用</span>
              </label>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setWsExpanded((v) => !v);
              }}
            >
              {wsExpanded ? '收起WS' : '展开WS'}
            </button>
            <button
              type="button"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSummaryExpanded((v) => !v);
              }}
            >
              {summaryExpanded ? '收起统计' : '展开统计'}
            </button>
            {onOpenConfig ? (
              <button
                type="button"
                className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 py-1 text-[12px] text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                disabled={!canEdit}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenConfig();
                }}
              >
                {tt('contentUi.autoTradeStrategy.snipeSettings')}
              </button>
            ) : null}
            {onOpenTaskManager ? (
              <button
                type="button"
                className="rounded-md border border-sky-500/50 bg-sky-500/15 px-2 py-1 text-[12px] text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
                disabled={!canEdit}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenTaskManager();
                }}
              >
                任务管理({taskSummaryText})
              </button>
            ) : null}
            {onOpenCreateTask ? (
              <button
                type="button"
                className="rounded-md border border-emerald-400/70 bg-emerald-500/25 px-2.5 py-1 text-[12px] font-semibold text-emerald-100 shadow-[0_0_0_1px_rgba(16,185,129,0.25)] hover:bg-emerald-500/35 disabled:opacity-50"
                disabled={!canEdit}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenCreateTask();
                }}
              >
                + 添加任务
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {wsExpanded ? (
        <XSniperWsStatusSection
          wsStatus={wsStatus}
          showLogs={showWsLogs}
          tt={tt}
          onToggleLogs={() => setShowWsLogs((v) => !v)}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={tt('contentUi.autoTradeStrategy.snipeHistorySearchPlaceholder')}
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-500"
        />
        {keyword ? (
          <button
            type="button"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setKeyword('');
            }}
          >
            {tt('contentUi.autoTradeStrategy.snipeHistorySearchClear')}
          </button>
        ) : null}
        <select
          value={strategyModeFilter}
          onChange={(e) => setStrategyModeFilter((e.target.value as 'all' | 'auto_filter' | 'xmode_task') || 'all')}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
        >
          <option value="all">全部模式</option>
          <option value="auto_filter">自动狙击</option>
          <option value="xmode_task">任务模式</option>
        </select>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            disabled={buyHistory.length === 0}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onExportHistory();
            }}
          >
            {tt('contentUi.autoTradeStrategy.snipeHistoryExportJson')}
          </button>
          <button
            type="button"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            disabled={!canEdit || buyHistory.length === 0}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClearHistory();
            }}
          >
            {tt('contentUi.autoTradeStrategy.snipeHistoryClear')}
          </button>
        </div>
      </div>
      {summaryExpanded && buyHistory.length > 0 ? (
        <XSniperHistorySummaryPanel
          tt={tt}
          data={summaryData}
          runMode={summaryRunMode}
          onRunModeChange={setSummaryRunMode}
        />
      ) : null}
      {filteredGroups.length === 0 ? (
        <div className="text-[12px] text-zinc-500">{tt('contentUi.autoTradeStrategy.snipeHistoryEmpty')}</div>
      ) : (
        <div className="space-y-2">
          {visibleGroups.map((g) => {
            const r = g.parent;
            return (
              <div key={g.key} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                {(() => {
                  const latest = latestTokenByAddr[String(r.tokenAddress).toLowerCase()] ?? null;
                  const isSell = r.side === 'sell';
                  const orderMcap = typeof r.marketCapUsd === 'number' ? r.marketCapUsd : null;
                  const latestMcap = latest && typeof latest.marketCapUsd === 'number' ? (latest.marketCapUsd as number) : null;
                  const sellRecords = g.children.filter((x) => x && x.side === 'sell');
                  const weightedPnl = computeWeightedPnlPct({ entryMcap: orderMcap, latestMcap, sellRecords });
                  const recordAthMcap = typeof r.athMarketCapUsd === 'number' && Number.isFinite(r.athMarketCapUsd) ? r.athMarketCapUsd : null;
                  const athMcap = recordAthMcap ?? (athMcapByAddr[String(r.tokenAddress).toLowerCase()] ?? null);
                  const launchpadPlatform = extractLaunchpadPlatform(r as any) ?? extractLaunchpadPlatform(latest as any);
                  const pnlPct = weightedPnl.pnlPct;
                  const pnlText = pnlPct == null || !Number.isFinite(pnlPct) ? '-' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
                  const pnlClass =
                    pnlPct == null || !Number.isFinite(pnlPct)
                      ? 'text-zinc-400'
                      : pnlPct >= 0
                        ? 'text-emerald-300'
                        : 'text-rose-300';
                  const pnlCardTone =
                    pnlPct == null || !Number.isFinite(pnlPct)
                      ? 'border-zinc-700 bg-zinc-900/70'
                      : pnlPct >= 0
                        ? 'border-emerald-500/35 bg-emerald-500/10'
                        : 'border-rose-500/35 bg-rose-500/10';
                  const pnlAthPct =
                    orderMcap != null && athMcap != null && Number.isFinite(athMcap) && orderMcap > 0
                      ? ((athMcap / orderMcap) - 1) * 100
                      : null;
                  const pnlAthText =
                    pnlAthPct == null || !Number.isFinite(pnlAthPct) ? '-' : `${pnlAthPct >= 0 ? '+' : ''}${pnlAthPct.toFixed(2)}%`;
                  const pnlAthClass =
                    pnlAthPct == null || !Number.isFinite(pnlAthPct)
                      ? 'text-zinc-400'
                      : pnlAthPct >= 0
                        ? 'text-emerald-300'
                        : 'text-rose-300';
                  const pnlAthCardTone =
                    pnlAthPct == null || !Number.isFinite(pnlAthPct)
                      ? 'border-zinc-700 bg-zinc-900/70'
                      : pnlAthPct >= 0
                        ? 'border-emerald-500/25 bg-emerald-500/5'
                        : 'border-rose-500/25 bg-rose-500/5';
                  const tokenLabel =
                    (() => {
                      const sym = r.tokenSymbol ? String(r.tokenSymbol).trim() : '';
                      const name = r.tokenName ? String(r.tokenName).trim() : '';
                      if (sym && name && sym !== name) return `${sym} (${name})`;
                      return sym || name || formatShortAddress(r.tokenAddress);
                    })();
                  const tokenLink = siteInfo ? parsePlatformTokenLink(siteInfo, r.tokenAddress) : '';
                  const walletDisplay = resolveWalletDisplay({ record: r, settings });
                  const sellDisabledBase = !settings || !isUnlocked || r.dryRun === true;
                  const sellingForRecord = sellingKey != null && sellingKey.startsWith(`${r.id}:`);
                  const tweetAtMs = typeof r.tweetAtMs === 'number' && Number.isFinite(r.tweetAtMs) ? r.tweetAtMs : null;
                  const tweetUrl = typeof r.tweetUrl === 'string' && r.tweetUrl.trim() ? r.tweetUrl.trim() : buildTweetUrlFallback(r);
                  const buySubmittedAtMs =
                    r.side === 'buy'
                    && typeof (r as any).buySubmittedAtMs === 'number'
                    && Number.isFinite((r as any).buySubmittedAtMs)
                    && Number((r as any).buySubmittedAtMs) > 0
                      ? Number((r as any).buySubmittedAtMs)
                      : null;

                  return (
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[12px] text-zinc-200">
                          {r.dryRun ? (
                            <span className="mr-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                              {tt('contentUi.autoTradeStrategy.snipeHistoryDry')}
                            </span>
                          ) : null}
                          <span
                            className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${r.strategyMode === 'xmode_task'
                              ? 'bg-sky-500/20 text-sky-200'
                              : 'bg-zinc-700/40 text-zinc-300'
                              }`}
                          >
                            {r.strategyMode === 'xmode_task' ? '任务模式' : '自动模式'}
                          </span>
                          <a
                            href={tokenLink || '#'}
                            className="hover:underline"
                            onClick={(e) => {
                              if (!tokenLink) return;
                              e.preventDefault();
                              e.stopPropagation();
                              navigateToUrl(tokenLink);
                            }}
                          >
                            {tokenLabel}
                          </a>{' '}
                          <span className="text-zinc-500">{formatShortAddress(r.tokenAddress)}</span>
                        </div>
                        <div className="text-right text-[11px] text-zinc-500">
                          <div>{r.side === 'buy' ? `提交: ${formatTs(buySubmittedAtMs ?? r.tsMs)}` : formatTs(r.tsMs)}</div>
                          {showTweetTime && tweetAtMs != null ? (
                            <div>
                              {tt('contentUi.autoTradeStrategy.snipeHistoryTweet')}: {' '}
                              {tweetUrl ? (
                                <a
                                  href={tweetUrl}
                                  className="text-zinc-400 hover:underline"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    navigateToUrl(tweetUrl);
                                  }}
                                >
                                  {formatTs(tweetAtMs)}
                                </a>
                              ) : (
                                <span className="text-zinc-400">{formatTs(tweetAtMs)}</span>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-1.5 space-y-1.5">
                        <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                          <div className={`rounded-md border px-2 py-1 ${pnlCardTone}`}>
                            <div className="text-[10px] text-zinc-400">{tt('contentUi.autoTradeStrategy.snipeHistoryPnlMcap')}</div>
                            <div className={`text-[14px] font-semibold leading-tight ${pnlClass}`}>{pnlText}</div>
                          </div>
                          <div className={`rounded-md border px-2 py-1 ${pnlAthCardTone}`}>
                            <div className="text-[10px] text-zinc-400">{tt('contentUi.autoTradeStrategy.snipeHistoryPnlAth')}</div>
                            <div className={`text-[14px] font-semibold leading-tight ${pnlAthClass}`}>{pnlAthText}</div>
                          </div>
                          <div className="rounded-md border border-zinc-700 bg-zinc-900/70 px-2 py-1">
                            <div className="text-[10px] text-zinc-400">{tt('contentUi.autoTradeStrategy.snipeHistoryPosition')}</div>
                            <div className="text-[14px] font-semibold leading-tight text-zinc-200">
                              {weightedPnl.soldPct.toFixed(1)}% / {weightedPnl.remainPct.toFixed(1)}%
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-x-2 gap-y-1 rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5 text-[11px] text-zinc-300">
                          <div>
                            <span className="text-emerald-300/80">{isSell ? tt('contentUi.autoTradeStrategy.snipeHistorySellPercent') : tt('contentUi.autoTradeStrategy.snipeHistoryBuyAmount')}:</span>{' '}
                            <span className="text-zinc-200">
                              {isSell
                                ? formatSellPercentText(r)
                                : formatBnbAmount(r.buyAmountNative)}
                            </span>
                          </div>
                          <div>
                            <span className="text-amber-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryMarketCap')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber(r.marketCapUsd) ?? '-'}</span>
                            {latestMcap != null ? <span className="text-zinc-500"> → {formatCompactNumber(latestMcap) ?? '-'}</span> : null}
                          </div>
                          <div>
                            <span className="text-amber-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryMarketCap')} ATH:</span>{' '}
                            <span className="text-zinc-200">{athMcap == null ? '-' : (formatCompactNumber(athMcap) ?? '-')}</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">{tt('contentUi.autoTradeStrategy.snipeHistoryUser')}:</span>{' '}
                            <span className="text-zinc-300">{r.userScreen ? String(r.userScreen) : '-'}</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">钱包:</span>{' '}
                            <span className="text-zinc-300">{walletDisplay}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-zinc-500">Launchpad:</span>{' '}
                            <LaunchpadPlatformBadge platform={launchpadPlatform} />
                          </div>
                          <div>
                            <span className="text-violet-300/80">{tt('contentUi.autoTradeStrategy.snipeHistorySmartMoney')}:</span>{' '}
                            <span className="text-zinc-200">{typeof (r as any).smartMoney === 'number' ? (r as any).smartMoney : '-'}</span>
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryHolders')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber(r.holders) ?? '-'}</span>
                            {latest && typeof latest.holders === 'number' ? (
                              <span className="text-zinc-500"> → {formatCompactNumber(latest.holders) ?? '-'}</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryDevHold')}:</span>{' '}
                            <span className="text-zinc-200">{r.devHoldPercent == null ? '-' : `${r.devHoldPercent.toFixed(2)}%`}</span>
                            {latest && typeof latest.devHoldPercent === 'number' ? (
                              <span className="text-zinc-500"> → {latest.devHoldPercent.toFixed(2)}%</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryDevMaxBuy')}:</span>{' '}
                            <span className="text-zinc-200">
                              {typeof (r as any).devMaxBuyPercent === 'number' && Number.isFinite((r as any).devMaxBuyPercent)
                                ? `${Number((r as any).devMaxBuyPercent).toFixed(2)}%`
                                : '-'}
                            </span>
                            {latest && typeof (latest as any).devMaxBuyPercent === 'number' ? (
                              <span className="text-zinc-500"> → {Number((latest as any).devMaxBuyPercent).toFixed(2)}%</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryViewerCount')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber((r as any).viewerCount) ?? '-'}</span>
                            {latest && typeof (latest as any).viewerCount === 'number' ? (
                              <span className="text-zinc-500"> → {formatCompactNumber((latest as any).viewerCount) ?? '-'}</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryDevCreatedCount')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber((r as any).devCreatedTokenCount) ?? '-'}</span>
                            {latest && typeof (latest as any).devCreatedTokenCount === 'number' ? (
                              <span className="text-zinc-500"> → {formatCompactNumber((latest as any).devCreatedTokenCount) ?? '-'}</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryDevSold')}:</span>{' '}
                            <span className="text-zinc-200">
                              {r.devHasSold === true ? tt('contentUi.autoTradeStrategy.snipeHistoryYes') : r.devHasSold === false ? tt('contentUi.autoTradeStrategy.snipeHistoryNo') : '-'}
                            </span>
                          </div>
                          <div>
                            <span className="text-cyan-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryKol')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber(r.kol) ?? '-'}</span>
                            {latest && typeof latest.kol === 'number' ? (
                              <span className="text-zinc-500"> → {formatCompactNumber(latest.kol) ?? '-'}</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-orange-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryVolume24h')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber((r as any).vol24hUsd) ?? '-'}</span>
                          </div>
                          <div>
                            <span className="text-orange-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryNetBuy24h')}:</span>{' '}
                            <span className="text-zinc-200">{formatCompactNumber((r as any).netBuy24hUsd) ?? '-'}</span>
                          </div>
                          <div className="col-span-3">
                            <span className="text-orange-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryBuySell24h')}:</span>{' '}
                            <span className="text-zinc-200">{typeof (r as any).buyTx24h === 'number' ? (r as any).buyTx24h : '-'} / {typeof (r as any).sellTx24h === 'number' ? (r as any).sellTx24h : '-'}</span>
                            {typeof (r as any).buyTx24h === 'number' && typeof (r as any).sellTx24h === 'number' && (r as any).sellTx24h > 0 ? (
                              <span className="text-zinc-500"> ({tt('contentUi.autoTradeStrategy.snipeHistoryBuySellRatioShort')} {((r as any).buyTx24h / (r as any).sellTx24h).toFixed(2)})</span>
                            ) : null}
                          </div>
                          <div className="col-span-3 border-t border-zinc-800 pt-1 text-zinc-400">
                            <span className="text-indigo-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryWsConfirm')}:</span>{' '}
                            <span className="text-zinc-200">{typeof (r as any).confirmWindowMs === 'number' && (r as any).confirmWindowMs > 0 ? `${(r as any).confirmWindowMs}ms` : '-'}</span>{' '}
                            {typeof (r as any).confirmMcapChangePct === 'number' ? (
                              <span className="text-zinc-500">{tt('contentUi.autoTradeStrategy.snipeHistoryDeltaMcapShort')} {(r as any).confirmMcapChangePct >= 0 ? '+' : ''}{(r as any).confirmMcapChangePct.toFixed(2)}%</span>
                            ) : null}
                            {typeof (r as any).confirmHoldersDelta === 'number' ? (
                              <span className="text-zinc-500"> {tt('contentUi.autoTradeStrategy.snipeHistoryDeltaHoldersShort')} {(r as any).confirmHoldersDelta >= 0 ? '+' : ''}{(r as any).confirmHoldersDelta.toFixed(0)}</span>
                            ) : null}
                            {typeof (r as any).confirmBuySellRatio === 'number' ? (
                              <span className="text-zinc-500"> {tt('contentUi.autoTradeStrategy.snipeHistoryBuySellRatioShort')} {(r as any).confirmBuySellRatio.toFixed(2)}</span>
                            ) : null}
                          </div>
                          <div className="col-span-3 text-zinc-400">
                            <span className="text-indigo-300/80">{tt('contentUi.autoTradeStrategy.snipeHistoryEvalWindow')}:</span>{' '}
                            {XSNIPER_EVAL_WINDOWS.map((window, index) => (
                              <span key={window.key}>
                                {index > 0 ? ' / ' : ''}
                                <span className="text-zinc-500">{window.label}</span> <span className="text-zinc-200">{formatEvalPnl(r, window.key)}</span>
                              </span>
                            ))}
                          </div>
                          {r.reason ? (
                            <div className="col-span-3 text-[11px] text-amber-200/90">
                              {tt('contentUi.autoTradeStrategy.snipeHistoryReason')}: {resolveReasonLabel(tt, r.reason)}
                            </div>
                          ) : null}
                          {r.strategyMode === 'xmode_task' ? (
                            <div className="col-span-3 text-[11px] text-sky-200/90">
                              任务: {r.taskName || r.taskId || '-'}
                              {Array.isArray(r.matchKeywords) && r.matchKeywords.length ? ` | 关键词: ${r.matchKeywords.join(', ')}` : ''}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      {!isSell ? (
                        <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                          {[10, 25, 50, 100].map((pct) => {
                            const key = `${r.id}:${pct}`;
                            const busy = sellingKey === key || sellingForRecord;
                            return (
                              <button
                                key={pct}
                                type="button"
                                className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
                                disabled={sellDisabledBase || busy}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void sellByPercent(r, pct);
                                }}
                              >
                                {pct}%
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                {g.children.length ? (
                  <div className="mt-2 space-y-1 border-l border-zinc-800/80 pl-3">
                    {g.children.slice(0, 12).map((c) => {
                      const badge = (() => {
                        if (c.side === 'sell') {
                          if (c.reason === 'rapid_take_profit') {
                            return {
                              text: resolveReasonLabel(tt, c.reason),
                              cls: 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30',
                            };
                          }
                          if (c.reason === 'rapid_stop_loss') {
                            return {
                              text: resolveReasonLabel(tt, c.reason),
                              cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
                            };
                          }
                          if (c.reason === 'rapid_trailing_stop') {
                            return {
                              text: resolveReasonLabel(tt, c.reason),
                              cls: 'bg-violet-500/15 text-violet-200 border-violet-500/30',
                            };
                          }
                          return {
                            text: tt('contentUi.autoTradeStrategy.snipeHistoryBadgeSell'),
                            cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30',
                          };
                        }
                        if (c.reason === 'ws_confirm_failed') {
                          return {
                            text: tt('contentUi.autoTradeStrategy.snipeHistoryBadgeWs'),
                            cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
                          };
                        }
                        return { text: tt('contentUi.autoTradeStrategy.snipeHistoryBadgeSub'), cls: 'bg-zinc-500/15 text-zinc-200 border-zinc-500/30' };
                      })();
                      const isSell = c.side === 'sell';
                      const primary = isSell
                        ? `${tt('contentUi.autoTradeStrategy.snipeHistorySellPercent')}: ${formatSellPercentText(c)}`
                        : `${tt('contentUi.autoTradeStrategy.snipeHistoryBuyAmount')}: ${formatBnbAmount(c.buyAmountNative)}`;
                      const showTriggerMcap =
                        isSell
                        && (c.reason === 'rapid_take_profit' || c.reason === 'rapid_stop_loss' || c.reason === 'rapid_trailing_stop')
                        && typeof c.marketCapUsd === 'number'
                        && Number.isFinite(c.marketCapUsd);
                      return (
                        <div key={c.id} className="flex items-start justify-between gap-2 text-[11px] text-zinc-400">
                          <div className="min-w-0">
                            <span className={`mr-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                            <span className="text-zinc-300">{primary}</span>
                            {showTriggerMcap ? (
                              <span className="ml-2 text-amber-300/80">
                                {tt('contentUi.autoTradeStrategy.snipeHistoryMarketCap')}: {formatCompactNumber(c.marketCapUsd) ?? '-'}
                              </span>
                            ) : null}
                            {c.reason ? <span className="ml-2 text-amber-200/80">({resolveReasonLabel(tt, c.reason)})</span> : null}
                          </div>
                          <div className="shrink-0 text-[10px] text-zinc-500">{formatTs(c.tsMs)}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
          {canLoadMore ? (
            <button
              type="button"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-zinc-800"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setVisibleCount((prev) => prev + 20);
              }}
            >
              {tt('contentUi.autoTradeStrategy.snipeHistoryLoadMore')} ({visibleCount}/{filteredGroups.length})
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
