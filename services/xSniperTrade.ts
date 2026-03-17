import { parseEther } from 'viem';
import { browser } from 'wxt/browser';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { defaultSettings } from '@/utils/defaults';
import { chainNames } from '@/constants/chains/chainName';
import type { UnifiedSignalToken, UnifiedTwitterSignal } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { FourmemeAPI } from '@/services/api/fourmeme';
import { TokenFourmemeService } from '@/services/token/fourmeme';
import { TokenFlapService } from '@/services/token/flap';
import { TokenService } from '@/services/token';
import { buildStrategySellOrderInputs, buildStrategyTrailingSellOrderInputs } from '@/services/limitOrders/advancedAutoSell';
import { cancelAllSellLimitOrdersForToken, createLimitOrder } from '@/services/limitOrders/store';

type TokenMetrics = {
  tokenAddress?: `0x${string}`;
  tokenSymbol?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  createdAtMs?: number;
  firstSeenAtMs?: number;
  updatedAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devHasSold?: boolean;
  priceUsd?: number;
};

type XSniperBuyRecord = {
  id: string;
  side?: 'buy' | 'sell';
  tsMs: number;
  tweetAtMs?: number;
  tweetUrl?: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountBnb?: number;
  sellPercent?: number;
  sellTokenAmountWei?: string;
  txHash?: `0x${string}`;
  entryPriceUsd?: number;
  dryRun?: boolean;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  createdAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devHasSold?: boolean;
  confirmWindowMs?: number;
  confirmMcapChangePct?: number;
  confirmHoldersDelta?: number;
  confirmBuySellRatio?: number;
  eval10s?: { atMs: number; marketCapUsd?: number; holders?: number; pnlMcapPct?: number };
  eval30s?: { atMs: number; marketCapUsd?: number; holders?: number; pnlMcapPct?: number };
  eval60s?: { atMs: number; marketCapUsd?: number; holders?: number; pnlMcapPct?: number };
  userScreen?: string;
  userName?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  reason?: string;
};

const parseNumber = (v: string | null | undefined) => {
  if (!v) return null;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return null;
  return n;
};

const parseKNumber = (v: string | null | undefined) => {
  const n = parseNumber(v);
  if (n == null) return null;
  return n * 1000;
};

const sanitizeMarketCapUsd = (v: unknown) => {
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  return v >= 3000 ? v : null;
};

const computeTickerLen = (symbol: string) => {
  let total = 0;
  for (const ch of symbol) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCjk =
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) ||
      (cp >= 0x2b740 && cp <= 0x2b81f) ||
      (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0x2ceb0 && cp <= 0x2ebef) ||
      (cp >= 0x2f800 && cp <= 0x2fa1f);
    total += isCjk ? 2 : 1;
  }
  return total;
};

const normalizeAddress = (addr: string | null | undefined): `0x${string}` | null => {
  if (!addr) return null;
  const trimmed = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
};

const getSignalTimeMs = (signal?: UnifiedTwitterSignal): number | null => {
  if (!signal) return null;
  const received = typeof (signal as any).receivedAtMs === 'number' ? (signal as any).receivedAtMs : null;
  if (received != null && Number.isFinite(received)) return received;
  const ts = typeof (signal as any).ts === 'number' ? (signal as any).ts : null;
  if (ts != null && Number.isFinite(ts)) return ts;
  return null;
};

const buildTweetUrl = (signal?: UnifiedTwitterSignal): string | undefined => {
  if (!signal) return undefined;
  const id = String(signal.tweetId ?? '').trim();
  if (!/^\d{6,}$/.test(id)) return undefined;
  const user = String(signal.userScreen ?? '')
    .trim()
    .replace(/^@/, '');
  if (user) return `https://x.com/${encodeURIComponent(user)}/status/${id}`;
  return `https://x.com/i/web/status/${id}`;
};

const shouldBuyByConfig = (metrics: TokenMetrics, config: any, signalAtMs?: number | null, orderAtMs?: number | null) => {
  if (!metrics || !config) return false;
  const marketCapUsd = sanitizeMarketCapUsd(metrics.marketCapUsd);
  const minMcap = parseKNumber(config.minMarketCapUsd);
  const maxMcap = parseKNumber(config.maxMarketCapUsd);
  if (minMcap != null && marketCapUsd == null) return false;
  if (maxMcap != null && marketCapUsd == null) return false;
  if (minMcap != null && marketCapUsd != null && marketCapUsd < minMcap) return false;
  if (maxMcap != null && marketCapUsd != null && marketCapUsd > maxMcap) return false;

  const minHolders = parseNumber(config.minHolders);
  const maxHolders = parseNumber(config.maxHolders);
  if (minHolders != null && metrics.holders == null) return false;
  if (maxHolders != null && metrics.holders == null) return false;
  if (minHolders != null && metrics.holders != null && metrics.holders < minHolders) return false;
  if (maxHolders != null && metrics.holders != null && metrics.holders > maxHolders) return false;

  const minKol = parseNumber(config.minKol);
  const maxKol = parseNumber(config.maxKol);
  if (minKol != null && metrics.kol == null) return false;
  if (maxKol != null && metrics.kol == null) return false;
  if (minKol != null && metrics.kol != null && metrics.kol < minKol) return false;
  if (maxKol != null && metrics.kol != null && metrics.kol > maxKol) return false;

  const minTickerLenRaw = parseNumber(config.minTickerLen);
  const maxTickerLenRaw = parseNumber(config.maxTickerLen);
  const minTickerLen = minTickerLenRaw != null ? Math.max(0, Math.floor(minTickerLenRaw)) : null;
  const maxTickerLen = maxTickerLenRaw != null ? Math.max(0, Math.floor(maxTickerLenRaw)) : null;
  if (minTickerLen != null || maxTickerLen != null) {
    const symbol = typeof metrics.tokenSymbol === 'string' ? metrics.tokenSymbol.trim() : '';
    if (!symbol) return false;
    const len = computeTickerLen(symbol);
    if (minTickerLen != null && len < minTickerLen) return false;
    if (maxTickerLen != null && len > maxTickerLen) return false;
  }

  const minAgeSecRaw = parseNumber(config.minTokenAgeSeconds);
  const maxAgeSec = parseNumber(config.maxTokenAgeSeconds);
  const minAgeSec = minAgeSecRaw ?? (maxAgeSec != null ? 0 : null);
  const firstSeenAtMs = typeof metrics.firstSeenAtMs === 'number' && metrics.firstSeenAtMs > 0 ? metrics.firstSeenAtMs : null;
  const createdAtMs = typeof metrics.createdAtMs === 'number' && metrics.createdAtMs > 0 ? metrics.createdAtMs : null;
  const tokenAtMs = createdAtMs ?? firstSeenAtMs;
  if ((minAgeSec != null || maxAgeSec != null) && tokenAtMs == null) return false;
  if (tokenAtMs != null && (minAgeSec != null || maxAgeSec != null)) {
    const ref = typeof signalAtMs === 'number' && Number.isFinite(signalAtMs) ? signalAtMs : null;
    if (ref == null) return false;
    const tokenDelayFromTweetMs = tokenAtMs - ref;
    if (minAgeSec != null && tokenDelayFromTweetMs < minAgeSec * 1000) return false;
    if (maxAgeSec != null && tokenDelayFromTweetMs > maxAgeSec * 1000) return false;
  }

  const minOrderDelaySec = minAgeSec;
  const maxOrderDelaySec = maxAgeSec;
  if (minOrderDelaySec != null || maxOrderDelaySec != null) {
    const ref = typeof signalAtMs === 'number' && Number.isFinite(signalAtMs) ? signalAtMs : null;
    const now = typeof orderAtMs === 'number' && Number.isFinite(orderAtMs) ? orderAtMs : Date.now();
    if (ref == null) return false;
    const orderDelayMs = now - ref;
    if (orderDelayMs < 0) return false;
    if (minOrderDelaySec != null && orderDelayMs < minOrderDelaySec * 1000) return false;
    if (maxOrderDelaySec != null && orderDelayMs > maxOrderDelaySec * 1000) return false;
  }

  const minDevPct = parseNumber(config.minDevHoldPercent);
  const maxDevPct = parseNumber(config.maxDevHoldPercent);
  const devHoldPct = typeof metrics.devHoldPercent === 'number' && Number.isFinite(metrics.devHoldPercent) ? metrics.devHoldPercent : null;
  if (minDevPct != null) {
    if (devHoldPct == null) return false;
    if (devHoldPct < minDevPct) return false;
  }
  if (maxDevPct != null) {
    if (devHoldPct == null) return false;
    if (devHoldPct > maxDevPct) return false;
  }
  if (config.blockIfDevSell && metrics.devHasSold === true) return false;
  return true;
};

export const createXSniperTrade = (deps: { onStateChanged: () => void }) => {
  const BOUGHT_ONCE_TTL_MS = 6 * 60 * 60 * 1000;
  const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_xsniper_bought_once_v1';
  const HISTORY_STORAGE_KEY = 'dagobang_xsniper_order_history_v1';
  const HISTORY_LIMIT = 200;

  let boughtOnceLoaded = false;
  const boughtOnceAtMs = new Map<string, number>();
  const buyInFlight = new Set<string>();
  const wsConfirmFailDedupe = new Map<string, number>();
  const wsSnapshotsByAddr = new Map<string, Array<{
    atMs: number;
    marketCapUsd?: number;
    holders?: number;
    vol24hUsd?: number;
    netBuy24hUsd?: number;
    buyTx24h?: number;
    sellTx24h?: number;
    smartMoney?: number;
  }>>();
  const stagedPositions = new Map<string, {
    chainId: number;
    tokenAddress: `0x${string}`;
    dryRun: boolean;
    openedAtMs: number;
    scoutAmountBnb: number;
    addAmountBnb: number;
    lastMetrics?: TokenMetrics;
    entryMcapUsd?: number;
    tweetAtMs?: number;
    tweetUrl?: string;
    tweetType?: string;
    channel?: string;
    signalId?: string;
    signalEventId?: string;
    signalTweetId?: string;
  }>();
  const stagedAddTimers = new Map<string, number>();
  const timeStopTimers = new Map<string, number>();

  const shouldLogWsConfirmFail = (key: string, nowMs: number) => {
    const last = wsConfirmFailDedupe.get(key);
    if (typeof last === 'number' && Number.isFinite(last) && nowMs - last < 20_000) return false;
    wsConfirmFailDedupe.set(key, nowMs);
    if (wsConfirmFailDedupe.size > 800) {
      const entries = Array.from(wsConfirmFailDedupe.entries()).sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < Math.min(200, entries.length); i++) wsConfirmFailDedupe.delete(entries[i][0]);
    }
    return true;
  };

  const pushWsSnapshot = (tokenAddress: `0x${string}`, metrics: TokenMetrics) => {
    const atMsRaw = typeof metrics.updatedAtMs === 'number' && metrics.updatedAtMs > 0 ? metrics.updatedAtMs : Date.now();
    const list = wsSnapshotsByAddr.get(tokenAddress) ?? [];
    const last = list.length ? list[list.length - 1] : null;
    if (last && Math.abs(last.atMs - atMsRaw) < 200) return;
    const next = list.concat({
      atMs: atMsRaw,
      marketCapUsd: metrics.marketCapUsd,
      holders: metrics.holders,
      vol24hUsd: metrics.vol24hUsd,
      netBuy24hUsd: metrics.netBuy24hUsd,
      buyTx24h: metrics.buyTx24h,
      sellTx24h: metrics.sellTx24h,
      smartMoney: metrics.smartMoney,
    });
    const keepMs = 2 * 60 * 1000;
    const cutoff = atMsRaw - keepMs;
    const trimmed = next.filter((x) => x.atMs >= cutoff).slice(-80);
    wsSnapshotsByAddr.set(tokenAddress, trimmed);
  };

  const getWsWindowStats = (tokenAddress: `0x${string}`, nowMs: number, windowMs: number) => {
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
    return {
      windowMs,
      hasCoverage,
      mcapChangePct,
      holdersDelta,
      buySellRatio,
      vol24hUsd: typeof cur.vol24hUsd === 'number' && Number.isFinite(cur.vol24hUsd) ? cur.vol24hUsd : null,
      netBuy24hUsd: typeof cur.netBuy24hUsd === 'number' && Number.isFinite(cur.netBuy24hUsd) ? cur.netBuy24hUsd : null,
      smartMoney: typeof cur.smartMoney === 'number' && Number.isFinite(cur.smartMoney) ? cur.smartMoney : null,
      snapshotAtMs: cur.atMs,
      baseAtMs: base?.atMs ?? null,
      marketCapUsd: cur.marketCapUsd,
      holders: cur.holders,
    };
  };

  const getWsDrawdownPctSince = (tokenAddress: `0x${string}`, sinceMs: number) => {
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

  const scheduleTimeStopIfEnabled = (posKey: string, strategy: any) => {
    if (strategy?.timeStopEnabled !== true) return;
    if (timeStopTimers.has(posKey)) return;
    const seconds = Math.max(1, Math.min(3600, Math.floor(parseNumber(strategy?.timeStopSeconds) ?? 0)));
    if (!(seconds > 0)) return;
    const timer = setTimeout(async () => {
      timeStopTimers.delete(posKey);
      const pos = stagedPositions.get(posKey);
      if (!pos) return;
      const minPnlPct = parseNumber(strategy?.timeStopMinPnlPct) ?? 0;
      const sellPct = Math.max(0, Math.min(100, parseNumber(strategy?.timeStopSellPercent) ?? 100));
      const snaps = wsSnapshotsByAddr.get(pos.tokenAddress) ?? [];
      const cur = snaps.length ? snaps[snaps.length - 1] : null;
      const curMcap = typeof cur?.marketCapUsd === 'number' && Number.isFinite(cur.marketCapUsd) ? cur.marketCapUsd : null;
      const entryMcap = typeof pos.entryMcapUsd === 'number' && Number.isFinite(pos.entryMcapUsd) ? pos.entryMcapUsd : null;
      if (curMcap == null || entryMcap == null || entryMcap <= 0) return;
      const pnlPct = ((curMcap - entryMcap) / entryMcap) * 100;
      if (!(pnlPct <= minPnlPct)) {
        stagedPositions.delete(posKey);
        return;
      }
      stagedPositions.delete(posKey);
      await tryTimeStopSellOnce({ chainId: pos.chainId, tokenAddress: pos.tokenAddress, percent: sellPct, pos, reason: 'time_stop' });
    }, seconds * 1000) as any;
    timeStopTimers.set(posKey, timer as any);
  };

  const scheduleStagedAddIfEnabled = (posKey: string, strategy: any) => {
    if (strategy?.stagedEntryEnabled !== true) return;
    if (stagedAddTimers.has(posKey)) return;
    const minDelayMs = Math.max(0, Math.min(60_000, Math.floor(parseNumber(strategy?.stagedEntryMinDelayMs) ?? 0)));
    const maxDelayMs = Math.max(500, Math.min(120_000, Math.floor(parseNumber(strategy?.stagedEntryMaxDelayMs) ?? 0)));
    const maxDrawdownPct = Math.max(0, Math.min(99.9, Math.abs(parseNumber(strategy?.stagedEntryMaxDrawdownPct) ?? 0)));
    const tickMs = 500;
    const timer = setInterval(async () => {
      const pos = stagedPositions.get(posKey);
      if (!pos) {
        const id = stagedAddTimers.get(posKey);
        if (id) clearInterval(id as any);
        stagedAddTimers.delete(posKey);
        return;
      }
      const now = Date.now();
      const ageMs = now - pos.openedAtMs;
      if (ageMs < minDelayMs) return;
      if (ageMs > maxDelayMs) {
        const id = stagedAddTimers.get(posKey);
        if (id) clearInterval(id as any);
        stagedAddTimers.delete(posKey);
        return;
      }

      if (maxDrawdownPct > 0) {
        const dd = getWsDrawdownPctSince(pos.tokenAddress, pos.openedAtMs);
        if (typeof dd === 'number' && Number.isFinite(dd) && dd <= -maxDrawdownPct) {
          const id = stagedAddTimers.get(posKey);
          if (id) clearInterval(id as any);
          stagedAddTimers.delete(posKey);
          stagedPositions.delete(posKey);
          await tryTimeStopSellOnce({ chainId: pos.chainId, tokenAddress: pos.tokenAddress, percent: 100, pos, reason: 'staged_abort' });
          return;
        }
      }

      const confirm = computeWsConfirm(pos.tokenAddress, now, strategy);
      if (!confirm.pass) return;

      const id = stagedAddTimers.get(posKey);
      if (id) clearInterval(id as any);
      stagedAddTimers.delete(posKey);

      const ok = await tryAutoBuyOnce({
        chainId: pos.chainId,
        tokenAddress: pos.tokenAddress,
        metrics: (pos.lastMetrics ?? { tokenAddress: pos.tokenAddress }) as any,
        strategy,
        signal: {
          ts: typeof pos.tweetAtMs === 'number' ? pos.tweetAtMs : pos.openedAtMs,
          receivedAtMs: typeof pos.tweetAtMs === 'number' ? pos.tweetAtMs : pos.openedAtMs,
          tweetType: pos.tweetType,
          channel: pos.channel,
          id: pos.signalId,
          eventId: pos.signalEventId,
          tweetId: pos.signalTweetId,
        } as any,
        stage: 'add',
        amountBnbOverride: pos.addAmountBnb,
      });
      if (ok) {
        stagedPositions.set(posKey, { ...pos, addAmountBnb: 0 });
      }
    }, tickMs) as any;
    stagedAddTimers.set(posKey, timer as any);
  };

  const loadBoughtOnceIfNeeded = async () => {
    if (boughtOnceLoaded) return;
    boughtOnceLoaded = true;
    try {
      const res = await browser.storage.local.get(BOUGHT_ONCE_STORAGE_KEY);
      const raw = (res as any)?.[BOUGHT_ONCE_STORAGE_KEY];
      if (!raw || typeof raw !== 'object') return;
      const now = Date.now();
      for (const [key, ts] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key !== 'string') continue;
        const n = typeof ts === 'number' ? ts : Number(ts);
        if (!Number.isFinite(n)) continue;
        if (now - n > BOUGHT_ONCE_TTL_MS) continue;
        boughtOnceAtMs.set(key, n);
      }
    } catch {
    }
  };

  const persistBoughtOnce = async () => {
    try {
      const now = Date.now();
      const obj: Record<string, number> = {};
      for (const [k, ts] of boughtOnceAtMs) {
        if (now - ts > BOUGHT_ONCE_TTL_MS) continue;
        obj[k] = ts;
      }
      await browser.storage.local.set({ [BOUGHT_ONCE_STORAGE_KEY]: obj } as any);
    } catch {
    }
  };

  const pushHistory = async (record: XSniperBuyRecord) => {
    try {
      const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
      const raw = (res as any)?.[HISTORY_STORAGE_KEY];
      const list = Array.isArray(raw) ? raw.slice() : [];
      list.unshift(record);
      await browser.storage.local.set({ [HISTORY_STORAGE_KEY]: list.slice(0, HISTORY_LIMIT) } as any);
    } catch {
    }
  };

  const loadHistory = async (): Promise<XSniperBuyRecord[]> => {
    try {
      const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
      const raw = (res as any)?.[HISTORY_STORAGE_KEY];
      return Array.isArray(raw) ? (raw as XSniperBuyRecord[]) : [];
    } catch {
      return [];
    }
  };

  const maybeUpdateEvaluationsFromSnapshot = async (tokenAddress: `0x${string}`, nowMs: number) => {
    const snapshots = wsSnapshotsByAddr.get(tokenAddress) ?? [];
    const cur = snapshots.length ? snapshots[snapshots.length - 1] : null;
    if (!cur) return;
    const curMcap = typeof cur.marketCapUsd === 'number' && Number.isFinite(cur.marketCapUsd) ? cur.marketCapUsd : null;
    const curHolders = typeof cur.holders === 'number' && Number.isFinite(cur.holders) ? cur.holders : null;
    if (curMcap == null && curHolders == null) return;
    const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
    const raw = (res as any)?.[HISTORY_STORAGE_KEY];
    const historyList: XSniperBuyRecord[] = Array.isArray(raw) ? raw.slice() : [];
    let changed = false;
    for (let i = 0; i < historyList.length; i++) {
      const r = historyList[i];
      if (!r || r.side !== 'buy') continue;
      if (r.tokenAddress !== tokenAddress) continue;
      if (typeof r.tsMs !== 'number' || r.tsMs <= 0) continue;
      const ageMs = nowMs - r.tsMs;
      if (ageMs < 10_000) continue;
      const entryMcap = typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) ? r.marketCapUsd : null;
      const buildEval = () => {
        const pnlMcapPct = (() => {
          if (entryMcap == null || curMcap == null || entryMcap <= 0) return undefined;
          return ((curMcap - entryMcap) / entryMcap) * 100;
        })();
        return { atMs: nowMs, marketCapUsd: curMcap ?? undefined, holders: curHolders ?? undefined, pnlMcapPct };
      };
      if (ageMs >= 10_000 && !r.eval10s) {
        r.eval10s = buildEval();
        changed = true;
      }
      if (ageMs >= 30_000 && !r.eval30s) {
        r.eval30s = buildEval();
        changed = true;
      }
      if (ageMs >= 60_000 && !r.eval60s) {
        r.eval60s = buildEval();
        changed = true;
      }
    }
    if (changed) {
      await browser.storage.local.set({ [HISTORY_STORAGE_KEY]: historyList.slice(0, HISTORY_LIMIT) } as any);
    }
  };

  const computeWsConfirm = (tokenAddress: `0x${string}`, nowMs: number, strategy: any) => {
    const enabled = strategy?.wsConfirmEnabled !== false;
    if (!enabled) return { pass: true, stats: null as any, windowMs: 0 };
    const windowMs = Math.max(500, Math.min(60_000, parseNumber(strategy?.wsConfirmWindowMs) ?? 5000));
    const stats = getWsWindowStats(tokenAddress, nowMs, windowMs);
    const minMcapChangePct = parseNumber(strategy?.wsConfirmMinMcapChangePct) ?? 0;
    const minHoldersDelta = parseNumber(strategy?.wsConfirmMinHoldersDelta) ?? 0;
    const minBuySellRatio = parseNumber(strategy?.wsConfirmMinBuySellRatio) ?? 0;
    const minNetBuy24hUsd = parseNumber(strategy?.wsConfirmMinNetBuy24hUsd) ?? 0;
    const minVol24hUsd = parseNumber(strategy?.wsConfirmMinVol24hUsd) ?? 0;
    const minSmartMoney = parseNumber(strategy?.wsConfirmMinSmartMoney) ?? 0;

    const requireNumberAtLeast = (v: number | null | undefined, min: number) => {
      if (!(min > 0)) return true;
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      return v >= min;
    };

    if (!stats) {
      const pass = !(minMcapChangePct > 0 || minHoldersDelta > 0 || minBuySellRatio > 0 || minNetBuy24hUsd > 0 || minVol24hUsd > 0 || minSmartMoney > 0);
      return { pass, stats: null as any, windowMs };
    }

    if ((minMcapChangePct > 0 || minHoldersDelta > 0) && stats.hasCoverage !== true) {
      return { pass: false, stats, windowMs };
    }

    const pass =
      requireNumberAtLeast(stats.mcapChangePct, minMcapChangePct) &&
      requireNumberAtLeast(stats.holdersDelta, minHoldersDelta) &&
      requireNumberAtLeast(stats.buySellRatio, minBuySellRatio) &&
      requireNumberAtLeast(stats.netBuy24hUsd, minNetBuy24hUsd) &&
      requireNumberAtLeast(stats.vol24hUsd, minVol24hUsd) &&
      requireNumberAtLeast(stats.smartMoney, minSmartMoney);

    return { pass, stats, windowMs };
  };

  const broadcastToTabs = async (message: any) => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, message).catch(() => { });
      }
    } catch {
    }
  };

  const broadcastToActiveTabs = async (message: any) => {
    try {
      const tabs = await browser.tabs.query({ active: true });
      for (const tab of tabs) {
        if (!tab.id) continue;
        browser.tabs.sendMessage(tab.id, message).catch(() => { });
      }
    } catch {
    }
  };

  const normalizeAutoTrade = (input: any) => {
    const defaults = defaultSettings().autoTrade;
    if (!input) return defaults;
    return {
      ...defaults,
      ...input,
      triggerSound: {
        ...defaults.triggerSound,
        ...(input as any).triggerSound,
      },
      twitterSnipe: {
        ...defaults.twitterSnipe,
        ...(input as any).twitterSnipe,
      },
    };
  };

  const getKey = (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean; stage?: 'full' | 'scout' | 'add' }) => {
    const dry = opts?.dry === true;
    const stage = opts?.stage ?? 'full';
    return `${dry ? 'dry:' : ''}${chainId}:${tokenAddress.toLowerCase()}:${stage}`;
  };

  const isFlapAddress = (addr: string) => {
    const low = addr.toLowerCase();
    return low.endsWith('7777') || low.endsWith('8888');
  };

  const fetchTokenInfoFresh = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    const chain = chainNames[chainId as any] ?? 'bsc';

    if (isFlapAddress(tokenAddress)) {
      try {
        const state = await TokenFlapService.getTokenInfo(chainId, tokenAddress);
        const meta = await TokenService.getMeta(tokenAddress);
        const quote = state.quoteTokenAddress && state.quoteTokenAddress !== '0x0000000000000000000000000000000000000000'
          ? state.quoteTokenAddress
          : '';
        return {
          chain,
          address: tokenAddress,
          name: '',
          symbol: String(meta.symbol ?? ''),
          decimals: Number(meta.decimals ?? 18),
          logo: '',
          launchpad: 'flap',
          launchpad_progress: Number(state.progress ?? 0),
          launchpad_platform: 'flap',
          launchpad_status: Number(state.status ?? 0),
          quote_token: '',
          quote_token_address: quote,
          pool_pair: state.pool || '',
          dex_type: 'flap',
          tokenPrice: {
            price: '0',
            marketCap: '0',
            timestamp: Date.now(),
          },
        };
      } catch {
        return null;
      }
    }

    try {
      const info = await FourmemeAPI.getTokenInfo(chain, tokenAddress);
      if (!info) return null;
      try {
        const onchain = await TokenFourmemeService.getTokenInfo(chainId, tokenAddress);
        if (onchain?.quote) info.quote_token_address = String(onchain.quote);
        if (onchain?.aiCreator !== undefined) (info as any).aiCreator = onchain.aiCreator;
      } catch {}
      return info;
    } catch {
      return null;
    }
  };

  const buildGenericTokenInfo = async (chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    try {
      const chain = chainNames[chainId as any] ?? 'bsc';
      const meta = await TokenService.getMeta(tokenAddress);
      return {
        chain,
        address: tokenAddress,
        name: '',
        symbol: String(meta.symbol ?? ''),
        decimals: Number(meta.decimals ?? 18),
        logo: '',
        launchpad: '',
        launchpad_progress: 0,
        launchpad_platform: '',
        launchpad_status: 1,
        quote_token: '',
        quote_token_address: '',
        pool_pair: '',
        dex_type: '',
        tokenPrice: {
          price: '0',
          marketCap: '0',
          timestamp: Date.now(),
        },
      };
    } catch {
      return null;
    }
  };

  const getEntryPriceUsd = async (
    chainId: number,
    tokenAddress: `0x${string}`,
    tokenInfo: TokenInfo,
    fallback: number | null,
    fallbackMcapUsd: number | null,
  ) => {
    try {
      const q = await TokenService.getTokenPriceUsdFromRpc({
        chainId,
        tokenAddress,
        tokenInfo,
        cacheTtlMs: 0,
      } as any);
      const n = typeof q === 'number' ? q : Number(q);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
    }
    if (fallback != null && Number.isFinite(fallback) && fallback > 0) return fallback;
    const p = Number(tokenInfo?.tokenPrice?.price ?? 0);
    const mcap = Number(fallbackMcapUsd ?? tokenInfo?.tokenPrice?.marketCap ?? 0);
    if (Number.isFinite(p) && p > 0) {
      if (Number.isFinite(mcap) && mcap > 0) {
        const impliedSupply = mcap / p;
        if (Number.isFinite(impliedSupply) && impliedSupply > 0 && impliedSupply <= 1e15) return p;
      } else {
        return p;
      }
    }
    return null;
  };

  const placeAutoSellOrdersIfEnabled = async (chainId: number, tokenAddress: `0x${string}`, tokenInfo: TokenInfo, basePriceUsd: number) => {
    const settings = await SettingsService.get();
    const cfg = (settings as any).advancedAutoSell;
    if (!cfg?.enabled) return;

    await cancelAllSellLimitOrdersForToken(chainId, tokenAddress);
    const orders = buildStrategySellOrderInputs({
      config: cfg,
      chainId,
      tokenAddress,
      tokenSymbol: tokenInfo.symbol,
      tokenInfo,
      basePriceUsd,
    });
    const trailing = buildStrategyTrailingSellOrderInputs({
      config: cfg,
      chainId,
      tokenAddress,
      tokenSymbol: tokenInfo.symbol,
      tokenInfo,
      basePriceUsd,
    });

    const all = trailing ? [...orders, trailing] : orders;
    if (!all.length) return;
    await Promise.all(all.map((o) => createLimitOrder(o)));
  };

  const tryAutoBuyOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    metrics: TokenMetrics;
    strategy: any;
    signal?: UnifiedTwitterSignal;
    stage?: 'full' | 'scout' | 'add';
    amountBnbOverride?: number;
    stagedPlan?: { scoutAmountBnb: number; addAmountBnb: number; openedAtMs: number };
  }) => {
    await loadBoughtOnceIfNeeded();
    const dryRun = input.strategy?.dryRun === true;
    const stage = input.stage ?? 'full';
    const key = getKey(input.chainId, input.tokenAddress, { dry: dryRun, stage });
    if (boughtOnceAtMs.has(key)) return false;
    if (buyInFlight.has(key)) return false;
    buyInFlight.add(key);
    try {
      const amountNumber = (typeof input.amountBnbOverride === 'number' && Number.isFinite(input.amountBnbOverride)
        ? input.amountBnbOverride
        : (parseNumber(input.strategy.buyAmountBnb) ?? 0));
      if (amountNumber <= 0) return false;

      const confirmNowMs = Date.now();
      const confirm = computeWsConfirm(input.tokenAddress, confirmNowMs, input.strategy);
      if (!confirm.pass) {
        if (dryRun) {
          const sigKey = typeof input.signal?.id === 'string' && input.signal.id.trim() ? input.signal.id.trim() : '';
          const dedupe = `${sigKey}:${input.chainId}:${input.tokenAddress.toLowerCase()}`;
          if (shouldLogWsConfirmFail(dedupe, confirmNowMs)) {
            const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
            const tweetUrl = buildTweetUrl(input.signal);
            const record: XSniperBuyRecord = {
              id: `${confirmNowMs}-${Math.random().toString(16).slice(2)}`,
              side: 'buy',
              tsMs: confirmNowMs,
              tweetAtMs,
              tweetUrl,
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              tokenSymbol: input.metrics.tokenSymbol,
              buyAmountBnb: amountNumber,
              dryRun: true,
              reason: 'ws_confirm_failed',
              marketCapUsd: input.metrics.marketCapUsd,
              liquidityUsd: input.metrics.liquidityUsd,
              holders: input.metrics.holders,
              kol: input.metrics.kol,
              vol24hUsd: input.metrics.vol24hUsd,
              netBuy24hUsd: input.metrics.netBuy24hUsd,
              buyTx24h: input.metrics.buyTx24h,
              sellTx24h: input.metrics.sellTx24h,
              smartMoney: input.metrics.smartMoney,
              createdAtMs: input.metrics.createdAtMs,
              devAddress: input.metrics.devAddress,
              devHoldPercent: input.metrics.devHoldPercent,
              devHasSold: input.metrics.devHasSold,
              confirmWindowMs: confirm.windowMs,
              confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
              confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
              confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
              userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
              userName: input.signal?.userName ? String(input.signal.userName) : undefined,
              tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
              channel: input.signal?.channel ? String(input.signal.channel) : undefined,
              signalId: input.signal?.id ? String(input.signal.id) : undefined,
              signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
              signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
            };
            void pushHistory(record);
            void broadcastToTabs({ type: 'bg:xsniper:buy', record });
          }
        }
        return false;
      }

      const status = await WalletService.getStatus();
      if (!dryRun && (status.locked || !status.address)) return false;

      const tokenInfo = (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ?? (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) return false;

      const refreshedMcap = Number(tokenInfo?.tokenPrice?.marketCap ?? 0);
      const sanitizedRefreshedMcap = sanitizeMarketCapUsd(refreshedMcap);
      const sanitizedInputMcap = sanitizeMarketCapUsd(input.metrics.marketCapUsd);
      const refreshedMetrics: TokenMetrics = {
        ...input.metrics,
        tokenAddress: input.tokenAddress,
        marketCapUsd: sanitizedRefreshedMcap ?? sanitizedInputMcap ?? undefined,
        priceUsd: input.metrics.priceUsd,
      };
      const signalAtMs = getSignalTimeMs(input.signal);
      if (!shouldBuyByConfig(refreshedMetrics, input.strategy, signalAtMs, Date.now())) return false;

      if (dryRun) {
        const entryPriceUsd = await getEntryPriceUsd(
          input.chainId,
          input.tokenAddress,
          tokenInfo,
          refreshedMetrics.priceUsd ?? null,
          refreshedMetrics.marketCapUsd ?? null,
        );
        boughtOnceAtMs.set(key, Date.now());
        void persistBoughtOnce();
        deps.onStateChanged();

        if (stage === 'scout' && input.stagedPlan) {
          const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
          stagedPositions.set(posKey, {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            dryRun: true,
            openedAtMs: input.stagedPlan.openedAtMs,
            scoutAmountBnb: input.stagedPlan.scoutAmountBnb,
            addAmountBnb: input.stagedPlan.addAmountBnb,
            lastMetrics: refreshedMetrics,
            entryMcapUsd: refreshedMetrics.marketCapUsd,
            tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
            tweetUrl: buildTweetUrl(input.signal),
            tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
            channel: input.signal?.channel ? String(input.signal.channel) : undefined,
            signalId: input.signal?.id ? String(input.signal.id) : undefined,
            signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
            signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          });
          scheduleStagedAddIfEnabled(posKey, input.strategy);
          scheduleTimeStopIfEnabled(posKey, input.strategy);
        } else if (stage === 'full' && input.strategy?.timeStopEnabled === true) {
          const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
          stagedPositions.set(posKey, {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            dryRun: true,
            openedAtMs: Date.now(),
            scoutAmountBnb: amountNumber,
            addAmountBnb: 0,
            lastMetrics: refreshedMetrics,
            entryMcapUsd: refreshedMetrics.marketCapUsd,
            tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
            tweetUrl: buildTweetUrl(input.signal),
            tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
            channel: input.signal?.channel ? String(input.signal.channel) : undefined,
            signalId: input.signal?.id ? String(input.signal.id) : undefined,
            signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
            signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          });
          scheduleTimeStopIfEnabled(posKey, input.strategy);
        }

        const now = Date.now();
        const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
        const tweetUrl = buildTweetUrl(input.signal);
        const record: XSniperBuyRecord = {
          id: `${now}-${Math.random().toString(16).slice(2)}`,
          side: 'buy',
          tsMs: now,
          tweetAtMs,
          tweetUrl,
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : undefined,
          tokenName: tokenInfo.name ? String(tokenInfo.name) : undefined,
          buyAmountBnb: amountNumber,
          txHash: undefined,
          entryPriceUsd: entryPriceUsd ?? undefined,
          dryRun: true,
          marketCapUsd: refreshedMetrics.marketCapUsd,
          liquidityUsd: refreshedMetrics.liquidityUsd,
          holders: refreshedMetrics.holders,
          kol: refreshedMetrics.kol,
          vol24hUsd: refreshedMetrics.vol24hUsd,
          netBuy24hUsd: refreshedMetrics.netBuy24hUsd,
          buyTx24h: refreshedMetrics.buyTx24h,
          sellTx24h: refreshedMetrics.sellTx24h,
          smartMoney: refreshedMetrics.smartMoney,
          createdAtMs: refreshedMetrics.createdAtMs,
          devAddress: refreshedMetrics.devAddress,
          devHoldPercent: refreshedMetrics.devHoldPercent,
          devHasSold: refreshedMetrics.devHasSold,
          confirmWindowMs: confirm.windowMs,
          confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
          confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
          confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
          userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
          userName: input.signal?.userName ? String(input.signal.userName) : undefined,
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          reason: stage === 'scout' ? 'staged_scout' : (stage === 'add' ? 'staged_add' : undefined),
        };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return true;
      }

      const amountWei = parseEther(String(amountNumber));
      const rsp = await TradeService.buy({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        bnbAmountWei: amountWei.toString(),
        tokenInfo,
      } as any);
      void broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'buy',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      const entryPriceUsd = await getEntryPriceUsd(
        input.chainId,
        input.tokenAddress,
        tokenInfo,
        refreshedMetrics.priceUsd ?? null,
        refreshedMetrics.marketCapUsd ?? null,
      );
      boughtOnceAtMs.set(key, Date.now());
      void persistBoughtOnce();
      deps.onStateChanged();

      if (stage === 'scout' && input.stagedPlan) {
        const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
        stagedPositions.set(posKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          dryRun: false,
          openedAtMs: input.stagedPlan.openedAtMs,
          scoutAmountBnb: input.stagedPlan.scoutAmountBnb,
          addAmountBnb: input.stagedPlan.addAmountBnb,
          lastMetrics: refreshedMetrics,
          entryMcapUsd: refreshedMetrics.marketCapUsd,
          tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
          tweetUrl: buildTweetUrl(input.signal),
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        });
        scheduleStagedAddIfEnabled(posKey, input.strategy);
        scheduleTimeStopIfEnabled(posKey, input.strategy);
      } else if (stage === 'full' && input.strategy?.timeStopEnabled === true) {
        const posKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
        stagedPositions.set(posKey, {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          dryRun: false,
          openedAtMs: Date.now(),
          scoutAmountBnb: amountNumber,
          addAmountBnb: 0,
          lastMetrics: refreshedMetrics,
          entryMcapUsd: refreshedMetrics.marketCapUsd,
          tweetAtMs: getSignalTimeMs(input.signal) ?? undefined,
          tweetUrl: buildTweetUrl(input.signal),
          tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
          channel: input.signal?.channel ? String(input.signal.channel) : undefined,
          signalId: input.signal?.id ? String(input.signal.id) : undefined,
          signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
          signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        });
        scheduleTimeStopIfEnabled(posKey, input.strategy);
      }

      const now = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const record: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'buy',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : undefined,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : undefined,
        buyAmountBnb: amountNumber,
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
        entryPriceUsd: entryPriceUsd ?? undefined,
        dryRun: false,
        marketCapUsd: refreshedMetrics.marketCapUsd,
        liquidityUsd: refreshedMetrics.liquidityUsd,
        holders: refreshedMetrics.holders,
        kol: refreshedMetrics.kol,
        vol24hUsd: refreshedMetrics.vol24hUsd,
        netBuy24hUsd: refreshedMetrics.netBuy24hUsd,
        buyTx24h: refreshedMetrics.buyTx24h,
        sellTx24h: refreshedMetrics.sellTx24h,
        smartMoney: refreshedMetrics.smartMoney,
        createdAtMs: refreshedMetrics.createdAtMs,
        devAddress: refreshedMetrics.devAddress,
        devHoldPercent: refreshedMetrics.devHoldPercent,
        devHasSold: refreshedMetrics.devHasSold,
        confirmWindowMs: confirm.windowMs,
        confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
        confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
        confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
        userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
        userName: input.signal?.userName ? String(input.signal.userName) : undefined,
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        reason: stage === 'scout' ? 'staged_scout' : (stage === 'add' ? 'staged_add' : undefined),
      };
      void pushHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });

      if (stage !== 'scout' && input.strategy?.autoSellEnabled && entryPriceUsd != null && entryPriceUsd > 0) {
        try {
          await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
          await placeAutoSellOrdersIfEnabled(input.chainId, input.tokenAddress, tokenInfo, entryPriceUsd);
        } catch {}
      }

      console.log('XSniperTrade buy tx', (rsp as any)?.txHash ?? '');
      return true;
    } finally {
      buyInFlight.delete(key);
    }
  };

  const matchesTwitterFilters = (signal: UnifiedTwitterSignal, strategy: any) => {
    const type = (() => {
      const raw = signal.tweetType === 'delete_post' ? (signal.sourceTweetType ?? null) : signal.tweetType;
      if (raw === 'repost') return 'retweet';
      if (raw === 'tweet') return 'tweet';
      if (raw === 'reply') return 'reply';
      if (raw === 'quote') return 'quote';
      if (raw === 'follow') return 'follow';
      return '';
    })();
    const allowedTypes = Array.isArray(strategy?.interactionTypes) ? strategy.interactionTypes.map((x: any) => String(x).toLowerCase()) : [];
    if (allowedTypes.length && !allowedTypes.includes(type)) return false;

    const targetUsers = Array.isArray(strategy?.targetUsers) ? strategy.targetUsers.map((x: any) => String(x).toLowerCase()).filter(Boolean) : [];
    if (!targetUsers.length) return true;

    const screen = String(signal.userScreen ?? '').replace(/^@/, '').toLowerCase();
    const name = String(signal.userName ?? '').toLowerCase();
    return targetUsers.some((u: string) => u === screen || u === name);
  };

  const metricsFromUnifiedToken = (t: UnifiedSignalToken): TokenMetrics | null => {
    const tokenAddress = normalizeAddress(t.tokenAddress);
    if (!tokenAddress) return null;
    const now = Date.now();
    const createdAtMsRaw = typeof (t as any).createdAtMs === 'number' ? (t as any).createdAtMs : undefined;
    const firstSeenAtMsRaw = typeof (t as any).firstSeenAtMs === 'number' ? (t as any).firstSeenAtMs : undefined;
    const createdAtMs = typeof createdAtMsRaw === 'number' && createdAtMsRaw > 0 ? createdAtMsRaw : undefined;
    const firstSeenAtMs = typeof firstSeenAtMsRaw === 'number' && firstSeenAtMsRaw > 0 ? firstSeenAtMsRaw : undefined;
    const tokenAtMs = firstSeenAtMs ?? createdAtMs;
    const tokenAgeMsForDev = tokenAtMs != null ? now - tokenAtMs : null;

    const devHoldPercentRaw = typeof (t as any).devHoldPercent === 'number' ? (t as any).devHoldPercent : undefined;
    let devHoldPercent =
      typeof devHoldPercentRaw === 'number' && Number.isFinite(devHoldPercentRaw)
        ? devHoldPercentRaw >= 0 && devHoldPercentRaw <= 1
          ? devHoldPercentRaw * 100
          : devHoldPercentRaw
        : undefined;
    if (devHoldPercent == null && tokenAgeMsForDev != null && tokenAgeMsForDev > 3000) devHoldPercent = 0;
    return {
      tokenAddress,
      tokenSymbol: typeof (t as any).tokenSymbol === 'string' ? String((t as any).tokenSymbol) : undefined,
      marketCapUsd: sanitizeMarketCapUsd((t as any).marketCapUsd) ?? undefined,
      liquidityUsd: typeof (t as any).liquidityUsd === 'number' ? (t as any).liquidityUsd : undefined,
      holders: typeof (t as any).holders === 'number' ? (t as any).holders : undefined,
      kol: typeof (t as any).kol === 'number' ? (t as any).kol : undefined,
      vol24hUsd: typeof (t as any).vol24hUsd === 'number' ? (t as any).vol24hUsd : undefined,
      netBuy24hUsd: typeof (t as any).netBuy24hUsd === 'number' ? (t as any).netBuy24hUsd : undefined,
      buyTx24h: typeof (t as any).buyTx24h === 'number' ? (t as any).buyTx24h : undefined,
      sellTx24h: typeof (t as any).sellTx24h === 'number' ? (t as any).sellTx24h : undefined,
      smartMoney: typeof (t as any).smartMoney === 'number' ? (t as any).smartMoney : undefined,
      createdAtMs,
      firstSeenAtMs,
      updatedAtMs: typeof (t as any).updatedAtMs === 'number' && (t as any).updatedAtMs > 0 ? (t as any).updatedAtMs : undefined,
      devAddress: normalizeAddress((t as any).devAddress) ?? undefined,
      devHoldPercent,
      devHasSold: typeof (t as any).devHasSold === 'boolean'
        ? (t as any).devHasSold
        : (typeof (t as any).devTokenStatus === 'string' ? String((t as any).devTokenStatus).toLowerCase().includes('sell') : undefined),
      priceUsd: typeof (t as any).priceUsd === 'number' ? (t as any).priceUsd : undefined,
    };
  };

  const pickTokensToBuyFromSignal = (signal: UnifiedTwitterSignal, strategy: any) => {
    const tokens = Array.isArray(signal.tokens) ? (signal.tokens as UnifiedSignalToken[]) : [];
    const now = Date.now();
    const signalAtMs = getSignalTimeMs(signal) ?? now;
    const perTweetMax = Math.max(0, Math.floor(parseNumber(strategy?.buyNewCaCount) ?? 0));
    if (perTweetMax <= 0) return [];
    const scanLimit = Math.min(500, tokens.length);
    const unique: UnifiedSignalToken[] = [];
    const seen = new Set<string>();
    for (const t of tokens) {
      const addr = typeof (t as any)?.tokenAddress === 'string' ? String((t as any).tokenAddress).trim() : '';
      const key = addr.toLowerCase();
      if (!addr) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(t);
      if (unique.length >= scanLimit) break;
    }

    const candidates = unique
      .map((t) => {
        const m = metricsFromUnifiedToken(t);
        if (m?.tokenAddress) {
          pushWsSnapshot(m.tokenAddress, m);
          void maybeUpdateEvaluationsFromSnapshot(m.tokenAddress, now);
        }
        return { t, m };
      })
      .filter((x) => {
        if (!x.m?.tokenAddress) return false;
        if (!shouldBuyByConfig(x.m, strategy, signalAtMs, now)) return false;
        const confirm = computeWsConfirm(x.m.tokenAddress, now, strategy);
        return confirm.pass;
      });

    candidates.sort((a, b) => {
      const ma = typeof a.m?.marketCapUsd === 'number' ? a.m.marketCapUsd : 0;
      const mb = typeof b.m?.marketCapUsd === 'number' ? b.m.marketCapUsd : 0;
      if (mb !== ma) return mb - ma;
      const ta = typeof (a.t as any).firstSeenAtMs === 'number' ? (a.t as any).firstSeenAtMs : 0;
      const tb = typeof (b.t as any).firstSeenAtMs === 'number' ? (b.t as any).firstSeenAtMs : 0;
      return ta - tb;
    });

    if (strategy?.dryRun === true) {
      return candidates;
    }
    const ogCount = Math.max(0, Math.floor(parseNumber(strategy?.buyOgCount) ?? 0));
    const maxCount = perTweetMax;
    let leftNew = perTweetMax;
    let leftOg = ogCount;

    const picked: typeof candidates = [];
    const pickedKey = new Set<string>();
    for (const c of candidates) {
      if (picked.length >= maxCount) break;
      const key = String(c.m!.tokenAddress).toLowerCase();
      if (pickedKey.has(key)) continue;
      const first = typeof (c.t as any).firstSeenAtMs === 'number' ? (c.t as any).firstSeenAtMs : now;
      const isNew = now - first <= 60_000;
      if (isNew && leftNew > 0) {
        leftNew -= 1;
        picked.push(c);
        pickedKey.add(key);
      } else if (!isNew && leftOg > 0) {
        leftOg -= 1;
        picked.push(c);
        pickedKey.add(key);
      }
    }

    for (const c of candidates) {
      if (picked.length >= maxCount) break;
      const key = String(c.m!.tokenAddress).toLowerCase();
      if (pickedKey.has(key)) continue;
      picked.push(c);
      pickedKey.add(key);
    }

    return picked;
  };

  const deleteSellInFlight = new Set<string>();
  const timeStopSellInFlight = new Set<string>();

  const tryTimeStopSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    pos: (typeof stagedPositions extends Map<any, infer V> ? V : never);
    reason: 'time_stop' | 'staged_abort';
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;

    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${bps}:${input.reason}`;
    if (timeStopSellInFlight.has(dedupeKey)) return;
    timeStopSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs: input.pos.tweetAtMs,
        tweetUrl: input.pos.tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.pos.dryRun,
        tweetType: input.pos.tweetType,
        channel: input.pos.channel,
        signalId: input.pos.signalId,
        signalEventId: input.pos.signalEventId,
        signalTweetId: input.pos.signalTweetId,
        reason: input.reason,
      };

      if (input.pos.dryRun) {
        void pushHistory(baseRecord);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record: baseRecord });
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        const record = { ...baseRecord, dryRun: false, reason: 'wallet_locked' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const tokenInfo =
        (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        const record = { ...baseRecord, dryRun: false, reason: 'token_info_missing' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      let balanceWei = 0n;
      try {
        balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
      } catch {
        balanceWei = 0n;
      }

      if (balanceWei <= 0n) {
        const record = { ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      let amountWei = (balanceWei * BigInt(bps)) / 10000n;
      if (amountWei > balanceWei) amountWei = balanceWei;
      const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = !!(tokenInfo as any)?.launchpad && platform.includes('fourmeme') && (tokenInfo as any).launchpad_status !== 1;
      if (!isTurbo && isInnerFourMeme && amountWei > 0n) {
        amountWei = (amountWei / 1000000000n) * 1000000000n;
      }
      if (!isTurbo && amountWei <= 0n) {
        const record = { ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      try {
        await cancelAllSellLimitOrdersForToken(input.chainId, input.tokenAddress);
      } catch {}
      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
      } catch {}
      const rsp = await TradeService.sell({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenAmountWei: amountWei.toString(),
        tokenInfo,
        sellPercentBps: bps,
      } as any);
      void broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      const record: XSniperBuyRecord = {
        ...baseRecord,
        dryRun: false,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      };
      void pushHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });
    } finally {
      timeStopSellInFlight.delete(dedupeKey);
    }
  };

  const tryDeleteTweetSellOnce = async (input: {
    chainId: number;
    tokenAddress: `0x${string}`;
    percent: number;
    signal: UnifiedTwitterSignal;
    relatedBuy?: XSniperBuyRecord;
    dryRun: boolean;
  }) => {
    const percent = Math.max(0, Math.min(100, Number(input.percent)));
    if (!Number.isFinite(percent) || percent <= 0) return;
    const bps = Math.floor(percent * 100);
    if (!(bps > 0)) return;

    const dedupeKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${String(input.signal.eventId ?? '')}:${String(input.signal.tweetId ?? '')}:${bps}`;
    if (deleteSellInFlight.has(dedupeKey)) return;
    deleteSellInFlight.add(dedupeKey);
    try {
      const now = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const baseRecord: XSniperBuyRecord = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'sell',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenSymbol: input.relatedBuy?.tokenSymbol,
        tokenName: input.relatedBuy?.tokenName,
        sellPercent: percent,
        sellTokenAmountWei: undefined,
        txHash: undefined,
        dryRun: input.dryRun,
        tweetType: input.signal.tweetType,
        channel: input.signal.channel,
        signalId: input.signal.id,
        signalEventId: input.signal.eventId,
        signalTweetId: input.signal.tweetId,
      };

      if (input.dryRun) {
        const record = { ...baseRecord, reason: 'dry_run' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const status = await WalletService.getStatus();
      if (status.locked || !status.address) {
        const record = { ...baseRecord, dryRun: false, reason: 'wallet_locked' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const tokenInfo =
        (await fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
        (await buildGenericTokenInfo(input.chainId, input.tokenAddress));
      if (!tokenInfo) {
        const record = { ...baseRecord, dryRun: false, reason: 'token_info_missing' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      const settings = await SettingsService.get();
      const isTurbo = (settings as any).chains?.[input.chainId]?.executionMode === 'turbo';
      let balanceWei = 0n;
      try {
        balanceWei = BigInt(await TokenService.getBalance(input.tokenAddress, status.address));
      } catch {
        balanceWei = 0n;
      }

      if (balanceWei <= 0n) {
        const record = { ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'no_balance' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      let amountWei = (balanceWei * BigInt(bps)) / 10000n;
      if (amountWei > balanceWei) amountWei = balanceWei;
      const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = !!(tokenInfo as any)?.launchpad && platform.includes('fourmeme') && (tokenInfo as any).launchpad_status !== 1;
      if (!isTurbo && isInnerFourMeme && amountWei > 0n) {
        amountWei = (amountWei / 1000000000n) * 1000000000n;
      }
      if (!isTurbo && amountWei <= 0n) {
        const record = { ...baseRecord, dryRun: false, sellTokenAmountWei: '0', reason: 'invalid_amount' };
        void pushHistory(record);
        void broadcastToTabs({ type: 'bg:xsniper:buy', record });
        return;
      }

      try {
        await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo);
      } catch {}
      const rsp = await TradeService.sell({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenAmountWei: amountWei.toString(),
        tokenInfo,
        sellPercentBps: bps,
      } as any);
      void broadcastToActiveTabs({
        type: 'bg:tradeSuccess',
        source: 'xsniper',
        side: 'sell',
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        txHash: (rsp as any)?.txHash,
      });

      const record: XSniperBuyRecord = {
        ...baseRecord,
        dryRun: false,
        tokenSymbol: tokenInfo.symbol ? String(tokenInfo.symbol) : baseRecord.tokenSymbol,
        tokenName: tokenInfo.name ? String(tokenInfo.name) : baseRecord.tokenName,
        sellTokenAmountWei: amountWei.toString(),
        txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      };
      void pushHistory(record);
      void broadcastToTabs({ type: 'bg:xsniper:buy', record });
    } finally {
      deleteSellInFlight.delete(dedupeKey);
    }
  };

  const handleTwitterSignal = async (signal: UnifiedTwitterSignal) => {
    try {
      const settings = await SettingsService.get();
      const config = normalizeAutoTrade((settings as any).autoTrade);
      if (!config) return;
      if (config.wsMonitorEnabled === false) return;
      const strategy = config.twitterSnipe;
      if (!strategy) return;
      if (strategy.enabled === false) return;
      if (!matchesTwitterFilters(signal, strategy)) return;

      if (signal.tweetType === 'delete_post') {
        const pct = parseNumber(strategy.deleteTweetSellPercent) ?? 0;
        const percent = Math.max(0, Math.min(100, pct));
        if (!(percent > 0)) return;

        const delEventId = String(signal.eventId ?? '').trim();
        const delTweetId = String(signal.tweetId ?? '').trim();
        if (!delEventId && !delTweetId) return;

        const history = await loadHistory();
        const matchedBuys = history.filter((r) => {
          if (!r) return false;
          if (r.side && r.side !== 'buy') return false;
          const ev = typeof r.signalEventId === 'string' ? r.signalEventId.trim() : '';
          const tw = typeof r.signalTweetId === 'string' ? r.signalTweetId.trim() : '';
          if (delEventId && ev && ev === delEventId) return true;
          if (delTweetId && tw && tw === delTweetId) return true;
          return false;
        });
        for (const r of matchedBuys) {
          const addr = normalizeAddress(r.tokenAddress);
          if (!addr) continue;
          await tryDeleteTweetSellOnce({
            chainId: r.chainId ?? settings.chainId,
            tokenAddress: addr,
            percent,
            signal,
            relatedBuy: r,
            dryRun: strategy.dryRun === true,
          });
        }
        return;
      }

      const picked = pickTokensToBuyFromSignal(signal, strategy);
      for (const { m } of picked) {
        if (!m?.tokenAddress) continue;
        if (strategy?.stagedEntryEnabled === true) {
          const total = parseNumber(strategy?.buyAmountBnb) ?? 0;
          const scoutPct = Math.max(1, Math.min(99, parseNumber(strategy?.stagedEntryScoutPercent) ?? 25));
          const scoutAmount = total > 0 ? (total * scoutPct) / 100 : 0;
          const addAmount = total > 0 ? Math.max(0, total - scoutAmount) : 0;
          const openedAtMs = Date.now();
          if (scoutAmount > 0 && addAmount > 0) {
            await tryAutoBuyOnce({
              chainId: settings.chainId,
              tokenAddress: m.tokenAddress,
              metrics: m,
              strategy,
              signal,
              stage: 'scout',
              amountBnbOverride: scoutAmount,
              stagedPlan: { scoutAmountBnb: scoutAmount, addAmountBnb: addAmount, openedAtMs },
            });
          } else {
            await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
          }
        } else {
          await tryAutoBuyOnce({ chainId: settings.chainId, tokenAddress: m.tokenAddress, metrics: m, strategy, signal });
        }
      }
    } catch (e) {
      console.error('XSniperTrade twitter signal handler error', e);
    }
  };

  return { handleTwitterSignal };
};
