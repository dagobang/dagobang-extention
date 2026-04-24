import type { TokenMetrics } from '@/services/xSniper/engine/metrics';
import { parseNumber } from '@/services/xSniper/engine/metrics';

export type WsSnapshot = {
  atMs: number;
  marketCapUsd?: number;
  holders?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
};

export const shouldLogWsConfirmFail = (wsConfirmFailDedupe: Map<string, number>, key: string, nowMs: number) => {
  const last = wsConfirmFailDedupe.get(key);
  if (typeof last === 'number' && Number.isFinite(last) && nowMs - last < 20_000) return false;
  wsConfirmFailDedupe.set(key, nowMs);
  if (wsConfirmFailDedupe.size > 800) {
    const entries = Array.from(wsConfirmFailDedupe.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < Math.min(200, entries.length); i++) wsConfirmFailDedupe.delete(entries[i][0]);
  }
  return true;
};

export const pushWsSnapshot = (input: {
  tokenAddress: `0x${string}`;
  metrics: TokenMetrics;
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>;
  nowMs?: number;
  onUpdated: (tokenAddress: `0x${string}`, atMs: number) => void;
}) => {
  const atMsRaw = typeof input.metrics.updatedAtMs === 'number' && input.metrics.updatedAtMs > 0 ? input.metrics.updatedAtMs : (input.nowMs ?? Date.now());
  const list = input.wsSnapshotsByAddr.get(input.tokenAddress) ?? [];
  const last = list.length ? list[list.length - 1] : null;
  if (last && Math.abs(last.atMs - atMsRaw) < 200) return;
  const next = list.concat({
    atMs: atMsRaw,
    marketCapUsd: input.metrics.marketCapUsd,
    holders: input.metrics.holders,
    vol24hUsd: input.metrics.vol24hUsd,
    netBuy24hUsd: input.metrics.netBuy24hUsd,
    buyTx24h: input.metrics.buyTx24h,
    sellTx24h: input.metrics.sellTx24h,
    smartMoney: input.metrics.smartMoney,
  });
  const keepMs = 2 * 60 * 1000;
  const cutoff = atMsRaw - keepMs;
  const trimmed = next.filter((x) => x.atMs >= cutoff).slice(-80);
  input.wsSnapshotsByAddr.set(input.tokenAddress, trimmed);
  input.onUpdated(input.tokenAddress, atMsRaw);
};

export const getWsWindowStats = (
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>,
  tokenAddress: `0x${string}`,
  nowMs: number,
  windowMs: number
) => {
  const list = wsSnapshotsByAddr.get(tokenAddress) ?? [];
  if (!list.length) return null;
  const cutoff = nowMs - windowMs;
  const cur = list[list.length - 1];
  let base: (typeof cur) | null = null;
  let hasCoverage = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.atMs <= cutoff) {
      base = s;
      hasCoverage = true;
      break;
    }
  }
  if (!base) base = list[0] ?? null;
  const mcapChangePct = (() => {
    const c = Number(cur.marketCapUsd);
    const b = Number(base?.marketCapUsd);
    if (!Number.isFinite(c) || !Number.isFinite(b) || b <= 0) return null;
    return ((c - b) / b) * 100;
  })();
  const holdersDelta = (() => {
    const c = Number(cur.holders);
    const b = Number(base?.holders);
    if (!Number.isFinite(c) || !Number.isFinite(b)) return null;
    return c - b;
  })();
  const buySellRatio = (() => {
    const b = Number(cur.buyTx24h);
    const s = Number(cur.sellTx24h);
    if (!Number.isFinite(b) || !Number.isFinite(s)) return null;
    if (s <= 0) return b > 0 ? 999 : null;
    return b / s;
  })();
  const volMcapRatio = (() => {
    const vol = Number(cur.vol24hUsd);
    const mcap = Number(cur.marketCapUsd);
    if (!Number.isFinite(vol) || !Number.isFinite(mcap) || mcap <= 0) return null;
    return vol / mcap;
  })();
  const netBuyMcapRatio = (() => {
    const netBuy = Number(cur.netBuy24hUsd);
    const mcap = Number(cur.marketCapUsd);
    if (!Number.isFinite(netBuy) || !Number.isFinite(mcap) || mcap <= 0) return null;
    return netBuy / mcap;
  })();
  return {
    windowMs,
    hasCoverage,
    mcapChangePct,
    holdersDelta,
    buySellRatio,
    volMcapRatio,
    netBuyMcapRatio,
    vol24hUsd: typeof cur.vol24hUsd === 'number' && Number.isFinite(cur.vol24hUsd) ? cur.vol24hUsd : null,
    netBuy24hUsd: typeof cur.netBuy24hUsd === 'number' && Number.isFinite(cur.netBuy24hUsd) ? cur.netBuy24hUsd : null,
    smartMoney: typeof cur.smartMoney === 'number' && Number.isFinite(cur.smartMoney) ? cur.smartMoney : null,
    snapshotAtMs: cur.atMs,
    baseAtMs: base?.atMs ?? null,
    marketCapUsd: cur.marketCapUsd,
    holders: cur.holders,
  };
};

export const getWsDrawdownPctSince = (
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>,
  tokenAddress: `0x${string}`,
  sinceMs: number
) => {
  const list = wsSnapshotsByAddr.get(tokenAddress) ?? [];
  if (!list.length) return null;
  const cur = list[list.length - 1];
  const curMcap = typeof cur.marketCapUsd === 'number' && Number.isFinite(cur.marketCapUsd) ? cur.marketCapUsd : null;
  if (curMcap == null || curMcap <= 0) return null;
  let ath = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.atMs < sinceMs) break;
    const m = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : 0;
    if (m > ath) ath = m;
  }
  if (!(ath > 0)) return null;
  return ((curMcap - ath) / ath) * 100;
};

export const computeWsConfirm = (
  wsSnapshotsByAddr: Map<string, WsSnapshot[]>,
  tokenAddress: `0x${string}`,
  nowMs: number,
  strategy: any
) => {
  const enabled = strategy?.wsConfirmEnabled !== false;
  if (!enabled) return { pass: true, stats: null as any, windowMs: 0 };
  const windowMs = Math.max(500, Math.min(60_000, parseNumber(strategy?.wsConfirmWindowMs) ?? 5000));
  const stats = getWsWindowStats(wsSnapshotsByAddr, tokenAddress, nowMs, windowMs);
  const minMcapChangePct = parseNumber(strategy?.wsConfirmMinMcapChangePct) ?? 0;
  const maxMcapChangePctRaw = parseNumber(strategy?.wsConfirmMaxMcapChangePct);
  const maxMcapChangePct = typeof maxMcapChangePctRaw === 'number' && Number.isFinite(maxMcapChangePctRaw)
    ? maxMcapChangePctRaw
    : null;
  const minHoldersDelta = parseNumber(strategy?.wsConfirmMinHoldersDelta) ?? 0;
  const minBuySellRatio = parseNumber(strategy?.wsConfirmMinBuySellRatio) ?? 0;
  const minNetBuy24hUsd = parseNumber(strategy?.wsConfirmMinNetBuy24hUsd) ?? 0;
  const minVol24hUsd = parseNumber(strategy?.wsConfirmMinVol24hUsd) ?? 0;
  const minVolMcapRatio = parseNumber(strategy?.wsConfirmMinVolMcapRatio) ?? 0;
  const minNetBuyMcapRatio = parseNumber(strategy?.wsConfirmMinNetBuyMcapRatio) ?? 0;
  const minSmartMoney = parseNumber(strategy?.wsConfirmMinSmartMoney) ?? 0;

  const requireNumberAtLeast = (v: number | null | undefined, min: number) => {
    if (!(min > 0)) return true;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    return v >= min;
  };
  const requireNumberAtMost = (v: number | null | undefined, max: number | null) => {
    if (!(typeof max === 'number' && Number.isFinite(max))) return true;
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    return v <= max;
  };

  if (!stats) {
    const pass = !(
      minMcapChangePct > 0 ||
      typeof maxMcapChangePct === 'number' ||
      minHoldersDelta > 0 ||
      minBuySellRatio > 0 ||
      minNetBuy24hUsd > 0 ||
      minVol24hUsd > 0 ||
      minVolMcapRatio > 0 ||
      minNetBuyMcapRatio > 0 ||
      minSmartMoney > 0
    );
    return { pass, stats: null as any, windowMs };
  }

  if ((minMcapChangePct > 0 || minHoldersDelta > 0) && stats.hasCoverage !== true) {
    return { pass: false, stats, windowMs };
  }

  const pass =
    requireNumberAtLeast(stats.mcapChangePct, minMcapChangePct) &&
    requireNumberAtMost(stats.mcapChangePct, maxMcapChangePct) &&
    requireNumberAtLeast(stats.holdersDelta, minHoldersDelta) &&
    requireNumberAtLeast(stats.buySellRatio, minBuySellRatio) &&
    requireNumberAtLeast(stats.netBuy24hUsd, minNetBuy24hUsd) &&
    requireNumberAtLeast(stats.vol24hUsd, minVol24hUsd) &&
    requireNumberAtLeast(stats.volMcapRatio, minVolMcapRatio) &&
    requireNumberAtLeast(stats.netBuyMcapRatio, minNetBuyMcapRatio) &&
    requireNumberAtLeast(stats.smartMoney, minSmartMoney);

  return { pass, stats, windowMs };
};
