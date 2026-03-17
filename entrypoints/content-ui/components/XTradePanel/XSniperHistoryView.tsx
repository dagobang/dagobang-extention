import type { Settings, XSniperBuyRecord } from '@/types/extention';
import { navigateToUrl, type SiteInfo, parsePlatformTokenLink } from '@/utils/sites';

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
  sellingKey: string | null;
  onSellByPercent: (record: XSniperBuyRecord, pct: number) => void;
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

const formatCompact = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const fmt = (v: number, s: string) => `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)}${s}`;
  if (abs >= 1e9) return fmt(n / 1e9, 'B');
  if (abs >= 1e6) return fmt(n / 1e6, 'M');
  if (abs >= 1e3) return fmt(n / 1e3, 'K');
  return String(Math.round(n));
};

const formatBnb = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '-';
  const s = (n >= 1 ? n.toFixed(4) : n.toFixed(6)).replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
};

const formatUsd = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const raw = abs >= 1 ? n.toFixed(4) : abs >= 0.01 ? n.toFixed(6) : n.toFixed(8);
  const s = raw.replace(/0+$/, '').replace(/\.$/, '');
  return `$${s || '0'}`;
};

const shortAddr = (addr: string) => {
  const a = String(addr || '').trim();
  if (!a) return '';
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
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
  sellingKey,
  onSellByPercent,
  onClearHistory,
}: XSniperHistoryViewProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.snipeHistoryTitle')}</div>
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
                <span>记录 {total}</span>
                <span>Dry {dry}</span>
                <span>WS拒绝 {confirmFail}</span>
                <span>10s 平均 {fmtPct(avg(a10))} 胜率 {fmtRate(winRate(a10))}</span>
                <span>30s 平均 {fmtPct(avg(a30))} 胜率 {fmtRate(winRate(a30))}</span>
                <span>60s 平均 {fmtPct(avg(a60))} 胜率 {fmtRate(winRate(a60))}</span>
              </div>
            );
          })()}
        </div>
      ) : null}
      {historyGroups.length === 0 ? (
        <div className="text-[12px] text-zinc-500">{tt('contentUi.autoTradeStrategy.snipeHistoryEmpty')}</div>
      ) : (
        <div className="space-y-2">
          {historyGroups.slice(0, 20).map((g) => {
            const r = g.parent;
            return (
              <div key={g.key} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                {(() => {
                  const latest = latestTokenByAddr[String(r.tokenAddress).toLowerCase()] ?? null;
                  const isSell = r.side === 'sell';
                  const orderMcap = typeof r.marketCapUsd === 'number' ? r.marketCapUsd : null;
                  const latestMcap = latest && typeof latest.marketCapUsd === 'number' ? (latest.marketCapUsd as number) : null;
                  const recordAthMcap = typeof r.athMarketCapUsd === 'number' && Number.isFinite(r.athMarketCapUsd) ? r.athMarketCapUsd : null;
                  const athMcap = recordAthMcap ?? (athMcapByAddr[String(r.tokenAddress).toLowerCase()] ?? null);
                  const pnlPct =
                    orderMcap != null && latestMcap != null && orderMcap > 0
                      ? ((latestMcap / orderMcap) - 1) * 100
                      : null;
                  const pnlText = pnlPct == null || !Number.isFinite(pnlPct) ? '-' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
                  const pnlClass =
                    pnlPct == null || !Number.isFinite(pnlPct)
                      ? 'text-zinc-400'
                      : pnlPct >= 0
                        ? 'text-emerald-300'
                        : 'text-rose-300';
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
                  const tokenLabel =
                    (() => {
                      const sym = r.tokenSymbol ? String(r.tokenSymbol).trim() : '';
                      const name = r.tokenName ? String(r.tokenName).trim() : '';
                      if (sym && name && sym !== name) return `${sym} (${name})`;
                      return sym || name || shortAddr(r.tokenAddress);
                    })();
                  const tokenLink = siteInfo ? parsePlatformTokenLink(siteInfo, r.tokenAddress) : '';
                  const entryPriceUsd = typeof r.entryPriceUsd === 'number' ? r.entryPriceUsd : null;
                  const latestPriceUsd = latest && typeof latest.priceUsd === 'number' ? (latest.priceUsd as number) : null;
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
                          <span className="text-zinc-500">{shortAddr(r.tokenAddress)}</span>
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
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                        <div>
                          {isSell
                            ? `${tt('contentUi.autoTradeStrategy.snipeHistorySellPercent')}: ${r.sellPercent == null ? '-' : `${r.sellPercent.toFixed(2)}%`}`
                            : `${tt('contentUi.autoTradeStrategy.snipeHistoryBuyAmount')}: ${formatBnb(r.buyAmountBnb)}`}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryPrice')}: {formatUsd(entryPriceUsd)}
                          {latestPriceUsd != null ? <span className="text-zinc-500"> → {formatUsd(latestPriceUsd)}</span> : null}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryMarketCap')}: {formatCompact(r.marketCapUsd)}
                          {latestMcap != null ? <span className="text-zinc-500"> → {formatCompact(latestMcap)}</span> : null}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryMarketCap')} ATH: {athMcap == null ? '-' : formatCompact(athMcap)}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryHolders')}: {formatCompact(r.holders)}
                          {latest && typeof latest.holders === 'number' ? (
                            <span className="text-zinc-500"> → {formatCompact(latest.holders)}</span>
                          ) : null}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryDevHold')}:{' '}
                          {r.devHoldPercent == null ? '-' : `${r.devHoldPercent.toFixed(2)}%`}
                          {latest && typeof latest.devHoldPercent === 'number' ? (
                            <span className="text-zinc-500"> → {latest.devHoldPercent.toFixed(2)}%</span>
                          ) : null}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryDevSold')}:{' '}
                          {r.devHasSold === true ? 'Y' : r.devHasSold === false ? 'N' : '-'}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryKol')}: {formatCompact(r.kol)}
                          {latest && typeof latest.kol === 'number' ? (
                            <span className="text-zinc-500"> → {formatCompact(latest.kol)}</span>
                          ) : null}
                        </div>
                        <div>
                          24h 成交额: {formatCompact((r as any).vol24hUsd)}
                        </div>
                        <div>
                          24h 净买入: {formatCompact((r as any).netBuy24hUsd)}
                        </div>
                        <div>
                          24h 买卖: {typeof (r as any).buyTx24h === 'number' ? (r as any).buyTx24h : '-'} / {typeof (r as any).sellTx24h === 'number' ? (r as any).sellTx24h : '-'}
                          {typeof (r as any).buyTx24h === 'number' && typeof (r as any).sellTx24h === 'number' && (r as any).sellTx24h > 0 ? (
                            <span className="text-zinc-500"> (b/s {((r as any).buyTx24h / (r as any).sellTx24h).toFixed(2)})</span>
                          ) : null}
                        </div>
                        <div>
                          聪明钱: {typeof (r as any).smartMoney === 'number' ? (r as any).smartMoney : '-'}
                        </div>
                        <div className={pnlClass}>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryPnlMcap')}: {pnlText}
                        </div>
                        <div className={pnlAthClass}>
                          PNL(ATH): {pnlAthText}
                        </div>
                        <div>
                          {tt('contentUi.autoTradeStrategy.snipeHistoryUser')}: {r.userScreen ? String(r.userScreen) : '-'}
                        </div>
                        <div>
                          WS确认: {typeof (r as any).confirmWindowMs === 'number' && (r as any).confirmWindowMs > 0 ? `${(r as any).confirmWindowMs}ms` : '-'}{' '}
                          {typeof (r as any).confirmMcapChangePct === 'number' ? (
                            <span className="text-zinc-500">ΔMC {(r as any).confirmMcapChangePct >= 0 ? '+' : ''}{(r as any).confirmMcapChangePct.toFixed(2)}%</span>
                          ) : null}
                          {typeof (r as any).confirmHoldersDelta === 'number' ? (
                            <span className="text-zinc-500"> ΔHD {(r as any).confirmHoldersDelta >= 0 ? '+' : ''}{(r as any).confirmHoldersDelta.toFixed(0)}</span>
                          ) : null}
                          {typeof (r as any).confirmBuySellRatio === 'number' ? (
                            <span className="text-zinc-500"> b/s {(r as any).confirmBuySellRatio.toFixed(2)}</span>
                          ) : null}
                        </div>
                        <div>
                          10/30/60s: {(r as any).eval10s?.pnlMcapPct == null ? '-' : `${(r as any).eval10s.pnlMcapPct >= 0 ? '+' : ''}${(r as any).eval10s.pnlMcapPct.toFixed(2)}%`}{' '}
                          / {(r as any).eval30s?.pnlMcapPct == null ? '-' : `${(r as any).eval30s.pnlMcapPct >= 0 ? '+' : ''}${(r as any).eval30s.pnlMcapPct.toFixed(2)}%`}{' '}
                          / {(r as any).eval60s?.pnlMcapPct == null ? '-' : `${(r as any).eval60s.pnlMcapPct >= 0 ? '+' : ''}${(r as any).eval60s.pnlMcapPct.toFixed(2)}%`}
                        </div>
                        {r.reason ? (
                          <div className="col-span-2 text-[11px] text-amber-200/90">
                            reason: {String(r.reason)}
                          </div>
                        ) : null}
                      </div>
                      {!isSell ? (
                        <div className="mt-2 grid grid-cols-4 gap-2">
                          {[10, 25, 50, 100].map((pct) => {
                            const key = `${r.id}:${pct}`;
                            const busy = sellingKey === key || sellingForRecord;
                            return (
                              <button
                                key={pct}
                                type="button"
                                className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
                                disabled={sellDisabledBase || busy}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  onSellByPercent(r, pct);
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
                          if (c.reason === 'time_stop') return { text: 'TP/SL', cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30' };
                          if (c.reason === 'staged_abort') return { text: 'ABORT', cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30' };
                          return { text: 'SELL', cls: 'bg-rose-500/15 text-rose-200 border-rose-500/30' };
                        }
                        if (c.reason === 'staged_scout') return { text: 'SCOUT', cls: 'bg-violet-500/15 text-violet-200 border-violet-500/30' };
                        if (c.reason === 'staged_add') return { text: 'ADD', cls: 'bg-sky-500/15 text-sky-200 border-sky-500/30' };
                        if (c.reason === 'ws_confirm_failed') return { text: 'WS', cls: 'bg-amber-500/15 text-amber-200 border-amber-500/30' };
                        return { text: 'SUB', cls: 'bg-zinc-500/15 text-zinc-200 border-zinc-500/30' };
                      })();
                      const isSell = c.side === 'sell';
                      const primary = isSell
                        ? `${tt('contentUi.autoTradeStrategy.snipeHistorySellPercent')}: ${c.sellPercent == null ? '-' : `${c.sellPercent.toFixed(2)}%`}`
                        : `${tt('contentUi.autoTradeStrategy.snipeHistoryBuyAmount')}: ${formatBnb(c.buyAmountBnb)}`;
                      return (
                        <div key={c.id} className="flex items-start justify-between gap-2 text-[11px] text-zinc-400">
                          <div className="min-w-0">
                            <span className={`mr-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>{badge.text}</span>
                            <span className="text-zinc-300">{primary}</span>
                            {c.reason ? <span className="ml-2 text-amber-200/80">({String(c.reason)})</span> : null}
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
        </div>
      )}
    </div>
  );
}
