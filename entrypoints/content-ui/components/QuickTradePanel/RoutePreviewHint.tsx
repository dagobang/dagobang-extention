import { AlertTriangle, LoaderCircle, Route } from 'lucide-react';
import type { QuickTradeRouteHop } from '@/types/extention';
import { t, type Locale } from '@/utils/i18n';
import { preferRouteTokenSymbol } from '@/utils/quoteTokenLabels';

const LOW_LIQUIDITY_USD_WARN = 10_000;
const UNISWAP_V4_DYNAMIC_FEE_FLAG = 0x800000;

function formatHopFee(fee?: number | null): string | null {
  if (!(typeof fee === 'number') || !Number.isFinite(fee) || fee < 0) return null;
  const hasDynamic = (fee & UNISWAP_V4_DYNAMIC_FEE_FLAG) !== 0;
  const staticFee = fee & ~UNISWAP_V4_DYNAMIC_FEE_FLAG;
  // PoolKey.fee == 0x800000 is the dynamic-fee flag, NOT 838.86%.
  if (hasDynamic && staticFee === 0) return '动态';
  const display = staticFee > 0 ? staticFee : fee;
  if (!(display > 0)) return null;
  const pct = display / 10000;
  const text = pct >= 1 ? pct.toFixed(pct % 1 === 0 ? 0 : 2) : pct.toFixed(pct >= 0.1 ? 2 : 3);
  return `${text.replace(/\.?0+$/, '')}%`;
}

function isLowLiquidityUsd(value?: number | null): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < LOW_LIQUIDITY_USD_WARN;
}

function formatLiquidityUsd(value?: number | null): string | null {
  if (!(typeof value === 'number') || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2).replace(/\.?0+$/, '')}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.?0+$/, '')}K`;
  return `$${value.toFixed(value >= 100 ? 0 : 2).replace(/\.?0+$/, '')}`;
}

function shortAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function sameHopToken(left?: string | null, right?: string | null): boolean {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

export function reverseQuickTradeRouteHops(hops: QuickTradeRouteHop[] | null | undefined): QuickTradeRouteHop[] | null {
  if (!hops?.length) return null;
  return hops
    .map((hop) => ({
      tokenIn: hop.tokenOut,
      tokenOut: hop.tokenIn,
      tokenInSymbol: hop.tokenOutSymbol,
      tokenOutSymbol: hop.tokenInSymbol,
      dexLabel: hop.dexLabel,
      poolAddress: hop.poolAddress,
      fee: hop.fee,
      liquidityUsd: hop.liquidityUsd,
    }))
    .reverse();
}

export function labelQuickTradeRouteHops(hops: QuickTradeRouteHop[] | null | undefined): string | null {
  if (!hops?.length) return null;
  return [hops[0].tokenInSymbol, ...hops.map((hop) => hop.tokenOutSymbol)].join(' → ');
}

const DEX_LABEL_RANK: Record<string, number> = {
  V4: 4,
  pons: 3,
  V3: 3,
  V2: 1,
  DEX: 0,
};

function preferDexLabel(base?: string | null, extra?: string | null): string {
  const left = String(base || '').trim();
  const right = String(extra || '').trim();
  if (!right) return left;
  if (!left) return right;
  return (DEX_LABEL_RANK[right] ?? 0) >= (DEX_LABEL_RANK[left] ?? 0) ? right : left;
}

export function mergeQuickTradeRouteHops(
  base: QuickTradeRouteHop[] | null | undefined,
  extra: QuickTradeRouteHop[] | null | undefined,
): QuickTradeRouteHop[] | null {
  if (!base?.length) return extra?.length ? extra : null;
  if (!extra?.length) return base;

  const overlayHop = (hop: QuickTradeRouteHop, match?: QuickTradeRouteHop) => {
    if (!match) return hop;
    return {
      ...hop,
      tokenInSymbol: preferRouteTokenSymbol(match.tokenInSymbol, hop.tokenInSymbol) ?? hop.tokenInSymbol,
      tokenOutSymbol: preferRouteTokenSymbol(match.tokenOutSymbol, hop.tokenOutSymbol) ?? hop.tokenOutSymbol,
      dexLabel: (match.poolAddress || (typeof match.liquidityUsd === 'number' && match.liquidityUsd > 0))
        ? (match.dexLabel || hop.dexLabel)
        : preferDexLabel(hop.dexLabel, match.dexLabel),
      poolAddress: hop.poolAddress || match.poolAddress,
      fee: hop.fee ?? match.fee,
      liquidityUsd: hop.liquidityUsd ?? match.liquidityUsd,
    };
  };

  const samePath = extra.length === base.length
    && extra.every((hop, index) => (
      sameHopToken(hop.tokenIn, base[index]?.tokenIn)
      && sameHopToken(hop.tokenOut, base[index]?.tokenOut)
    ));

  if (!samePath) {
    const extraStartsWithPay = extra.length > 0 && sameHopToken(extra[0]?.tokenIn, base[0]?.tokenIn);
    const extraEndsWithToken = extra.length > 0
      && sameHopToken(extra[extra.length - 1]?.tokenOut, base[base.length - 1]?.tokenOut);
    if (!extraStartsWithPay && extraEndsWithToken) {
      return base.map((hop) => overlayHop(
        hop,
        extra.find((item) => (
          sameHopToken(item.tokenIn, hop.tokenIn) && sameHopToken(item.tokenOut, hop.tokenOut)
        )),
      ));
    }
    return extra.map((hop) => overlayHop(
      hop,
      base.find((item) => (
        sameHopToken(item.tokenIn, hop.tokenIn) && sameHopToken(item.tokenOut, hop.tokenOut)
      )),
    ));
  }

  return base.map((hop) => {
    const match = extra.find((item) => (
      sameHopToken(item.tokenIn, hop.tokenIn) && sameHopToken(item.tokenOut, hop.tokenOut)
    ));
    if (!match) return hop;
    return {
      ...hop,
      tokenInSymbol: preferRouteTokenSymbol(match.tokenInSymbol, hop.tokenInSymbol) ?? hop.tokenInSymbol,
      tokenOutSymbol: preferRouteTokenSymbol(match.tokenOutSymbol, hop.tokenOutSymbol) ?? hop.tokenOutSymbol,
      dexLabel: (match.poolAddress || (typeof match.liquidityUsd === 'number' && match.liquidityUsd > 0))
        ? (match.dexLabel || hop.dexLabel)
        : preferDexLabel(hop.dexLabel, match.dexLabel),
      poolAddress: match.poolAddress || hop.poolAddress,
      fee: match.fee ?? hop.fee,
      liquidityUsd: match.liquidityUsd ?? hop.liquidityUsd,
    };
  });
}

export function RoutePreviewHint({
  label,
  hops,
  loading = false,
  tone = 'buy',
  locale,
}: {
  label: string | null;
  hops?: QuickTradeRouteHop[] | null;
  loading?: boolean;
  tone?: 'buy' | 'sell';
  locale: Locale;
}) {
  if (loading && !hops?.length) {
    const toneClass = tone === 'sell'
      ? 'border-rose-500/20 bg-rose-500/10 text-rose-300/90'
      : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300/90';
    return (
      <div className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-4 ${toneClass}`}>
        <LoaderCircle size={10} strokeWidth={2.2} className="animate-spin" />
        <span>{t('contentUi.route.loading', locale)}</span>
      </div>
    );
  }
  if (!hops?.length && !label) return null;
  const toneClass = tone === 'sell'
    ? 'border-rose-500/20 bg-rose-500/10 text-rose-300/90 hover:text-rose-200'
    : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300/90 hover:text-emerald-200';
  const textToneClass = tone === 'sell'
    ? 'text-rose-300/85 hover:text-rose-200'
    : 'text-emerald-300/85 hover:text-emerald-200';

  return (
    <div className="group relative shrink-0 cursor-help outline-none" tabIndex={0}>
      {hops?.length ? (
        <div className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] leading-4 ${toneClass}`}>
          <Route size={10} strokeWidth={2.2} />
          <span>{t('contentUi.route.badge', locale)}</span>
        </div>
      ) : (
        <div className={`whitespace-nowrap text-[10px] leading-4 ${textToneClass}`}>
          {label}
        </div>
      )}
      {hops?.length ? (
        <div className="pointer-events-none absolute left-1/2 top-full z-50 hidden w-max min-w-[220px] max-w-[300px] -translate-x-1/2 pt-1 group-hover:block group-focus-within:block">
          <div className="rounded-lg border border-zinc-800 bg-[#121317] px-2.5 py-2 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
            <div className="mb-1.5 flex flex-wrap items-center gap-x-0.5 gap-y-1">
              {[hops[0].tokenInSymbol, ...hops.map((hop) => hop.tokenOutSymbol)].map((symbol, index) => (
                <span key={`${symbol}-${index}`} className="inline-flex items-center">
                  {index > 0 ? <span className="px-0.5 text-[10px] text-zinc-600">›</span> : null}
                  <span className={`rounded px-1 py-px text-[10px] leading-4 ${tone === 'sell' ? 'bg-rose-500/10 text-rose-200' : 'bg-emerald-500/10 text-emerald-200'}`}>
                    {symbol}
                  </span>
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              {hops.map((hop, index) => {
                const feeText = formatHopFee(hop.fee);
                const liquidityText = formatLiquidityUsd(hop.liquidityUsd);
                const lowLiquidity = isLowLiquidityUsd(hop.liquidityUsd);
                return (
                  <div key={`${hop.tokenIn}-${hop.tokenOut}-${index}`} className="min-w-0">
                    <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-200">
                      <span>{hop.tokenInSymbol} → {hop.tokenOutSymbol}</span>
                      <span className="shrink-0 text-[10px] text-zinc-500">
                        {hop.dexLabel}{feeText ? ` ${feeText}` : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 font-mono text-[10px] text-zinc-500">
                      <span>{hop.poolAddress ? shortAddress(hop.poolAddress) : '—'}</span>
                      {liquidityText ? (
                        <span className={`inline-flex shrink-0 items-center gap-0.5 ${lowLiquidity ? 'text-rose-400' : 'text-zinc-400'}`}>
                          {lowLiquidity ? <AlertTriangle size={9} strokeWidth={2.4} /> : null}
                          {t('contentUi.route.liquidity', locale)} {liquidityText}
                          {lowLiquidity ? ` · ${t('contentUi.route.lowLiquidity', locale)}` : ''}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
