import { useEffect, useMemo, useState } from 'react';
import type { Settings, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { chainNames } from '@/constants/chains/chainName';
import { call } from '@/utils/messaging';
import { navigateToUrl, type SiteInfo, parsePlatformTokenLink } from '@/utils/sites';
import { formatBnbAmount, formatCompactNumber, formatShortAddress } from '@/utils/format';

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
  onClearHistory: () => void;
};

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

const resolveReasonLabel = (tt: (key: string, subs?: Array<string | number>) => string, reason: unknown) => {
  if (reason == null) return '-';
  const raw = String(reason).trim();
  if (!raw) return '-';
  const key = `contentUi.autoTradeStrategy.snipeHistoryReasonCode.${raw}`;
  const translated = tt(key);
  return translated === key ? raw : translated;
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
    const nextPct = clampPercent(s.sellPercent);
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
  onClearHistory,
}: XSniperHistoryViewProps) {
  const [keyword, setKeyword] = useState('');
  const [visibleCount, setVisibleCount] = useState(20);
  const [sellingKey, setSellingKey] = useState<string | null>(null);
  const normalizedKeyword = keyword.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!normalizedKeyword) return historyGroups;
    return historyGroups.filter((g) => {
      const symbol = String(g.parent.tokenSymbol ?? '').toLowerCase();
      const addr = String(g.parent.tokenAddress ?? '').toLowerCase();
      return symbol.includes(normalizedKeyword) || addr.includes(normalizedKeyword);
    });
  }, [historyGroups, normalizedKeyword]);

  useEffect(() => {
    setVisibleCount(20);
  }, [normalizedKeyword, historyGroups.length]);

  const visibleGroups = useMemo(() => filteredGroups.slice(0, visibleCount), [filteredGroups, visibleCount]);
  const canLoadMore = visibleCount < filteredGroups.length;

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
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.snipeHistoryTitle')}</div>
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
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setKeyword('');
            }}
          >
            {tt('contentUi.autoTradeStrategy.snipeHistorySearchClear')}
          </button>
        ) : null}
      </div>
      {buyHistory.length ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px] text-zinc-400">
          {(() => {
            const list = buyHistory.filter((x) => x && x.side !== 'sell');
            const total = list.length;
            const dry = list.filter((x) => x.dryRun === true).length;
            const confirmFail = list.filter((x) => x.reason === 'ws_confirm_failed').length;
            const collect = (key: 'eval10s' | 'eval30s' | 'eval60s') =>
              list
                .map((x) => (x as any)[key]?.pnlMcapPct)
                .filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[];
            const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
            const winRate = (arr: number[]) => (arr.length ? arr.filter((x) => x > 0).length / arr.length : null);
            const a10 = collect('eval10s');
            const a30 = collect('eval30s');
            const a60 = collect('eval60s');
            const fmtPct = (v: number | null) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
            const fmtRate = (v: number | null) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
            return (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <span>{tt('contentUi.autoTradeStrategy.snipeHistorySummaryRecords')} {total}</span>
                <span>{tt('contentUi.autoTradeStrategy.snipeHistorySummaryDry')} {dry}</span>
                <span>{tt('contentUi.autoTradeStrategy.snipeHistorySummaryWsRejected')} {confirmFail}</span>
                <span>10s {tt('contentUi.autoTradeStrategy.snipeHistorySummaryAvg')} {fmtPct(avg(a10))} {tt('contentUi.autoTradeStrategy.snipeHistorySummaryWinRate')} {fmtRate(winRate(a10))}</span>
                <span>30s {tt('contentUi.autoTradeStrategy.snipeHistorySummaryAvg')} {fmtPct(avg(a30))} {tt('contentUi.autoTradeStrategy.snipeHistorySummaryWinRate')} {fmtRate(winRate(a30))}</span>
                <span>60s {tt('contentUi.autoTradeStrategy.snipeHistorySummaryAvg')} {fmtPct(avg(a60))} {tt('contentUi.autoTradeStrategy.snipeHistorySummaryWinRate')} {fmtRate(winRate(a60))}</span>
              </div>
            );
          })()}
        </div>
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
                  const sellDisabledBase = !settings || !isUnlocked || r.dryRun === true;
                  const sellingForRecord = sellingKey != null && sellingKey.startsWith(`${r.id}:`);
                  const tweetAtMs = typeof r.tweetAtMs === 'number' && Number.isFinite(r.tweetAtMs) ? r.tweetAtMs : null;
                  const tweetUrl = typeof r.tweetUrl === 'string' && r.tweetUrl.trim() ? r.tweetUrl.trim() : buildTweetUrlFallback(r);

                  return (
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[12px] text-zinc-200">
                          {r.dryRun ? (
                            <span className="mr-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                              {tt('contentUi.autoTradeStrategy.snipeHistoryDry')}
                            </span>
                          ) : null}
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
                          <div>{formatTs(r.tsMs)}</div>
                          {tweetAtMs != null ? (
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
                                ? r.sellPercent == null ? '-' : `${r.sellPercent.toFixed(2)}%`
                                : formatBnbAmount(r.buyAmountBnb)}
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
                            <span className="text-zinc-200">{(r as any).eval10s?.pnlMcapPct == null ? '-' : `${(r as any).eval10s.pnlMcapPct >= 0 ? '+' : ''}${(r as any).eval10s.pnlMcapPct.toFixed(2)}%`}</span>{' '}
                            / {(r as any).eval30s?.pnlMcapPct == null ? '-' : `${(r as any).eval30s.pnlMcapPct >= 0 ? '+' : ''}${(r as any).eval30s.pnlMcapPct.toFixed(2)}%`}{' '}
                            / {(r as any).eval60s?.pnlMcapPct == null ? '-' : `${(r as any).eval60s.pnlMcapPct >= 0 ? '+' : ''}${(r as any).eval60s.pnlMcapPct.toFixed(2)}%`}
                          </div>
                          {r.reason ? (
                            <div className="col-span-3 text-[11px] text-amber-200/90">
                              {tt('contentUi.autoTradeStrategy.snipeHistoryReason')}: {resolveReasonLabel(tt, r.reason)}
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
                        ? `${tt('contentUi.autoTradeStrategy.snipeHistorySellPercent')}: ${c.sellPercent == null ? '-' : `${c.sellPercent.toFixed(2)}%`}`
                        : `${tt('contentUi.autoTradeStrategy.snipeHistoryBuyAmount')}: ${formatBnbAmount(c.buyAmountBnb)}`;
                      return (
                        <div key={c.id} className="flex items-start justify-between gap-2 text-[11px] text-zinc-400">
                          <div className="min-w-0">
                            <span className={`mr-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                            <span className="text-zinc-300">{primary}</span>
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
