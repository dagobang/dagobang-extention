import { browser } from 'wxt/browser';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseEther, formatEther, formatUnits } from 'viem';
import type { Settings, LimitOrder, LimitOrderCreateInput, LimitOrderScanStatus, LimitOrderType } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { TokenAPI } from '@/hooks/TokenAPI';
import { bscTokens } from '@/constants/tokens/chains/bsc';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { call } from '@/utils/messaging';
import { formatAmount, parseNumberLoose, formatTime } from '@/utils/format';

type LimitTradePanelProps = {
  platform: string;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  isUnlocked: boolean;
  address: string | null;
  tokenPrice?: number | null;
  formattedNativeBalance: string;
  formattedTokenBalance: string;
  tokenSymbol: string | null;
  tokenAddress: `0x${string}` | null;
  tokenInfo: TokenInfo | null;
};

export function LimitTradePanel({
  platform,
  visible,
  onVisibleChange,
  settings,
  isUnlocked,
  address,
  tokenPrice,
  formattedNativeBalance,
  formattedTokenBalance,
  tokenSymbol,
  tokenAddress,
  tokenInfo,
}: LimitTradePanelProps) {
  const panelWidth = 780;
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - panelWidth);
    const defaultY = 420;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_autotrade_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - panelWidth));
      const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
      setPos({ x: clampedX, y: clampedY });
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const nextX = dragging.current.baseX + dx;
      const nextY = dragging.current.baseY + dy;
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const key = 'dagobang_autotrade_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(posRef.current));
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

  const [buyPrice, setBuyPrice] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [buyAmount, setBuyAmount] = useState('');
  const [sellPercent, setSellPercent] = useState('');
  const [buyOrderType, setBuyOrderType] = useState<LimitOrderType>('low_buy');
  const [sellOrderType, setSellOrderType] = useState<LimitOrderType>('take_profit_sell');
  const [onlyCurrentToken, setOnlyCurrentToken] = useState(false);
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const [scanStatus, setScanStatus] = useState<LimitOrderScanStatus | null>(null);
  const [latestTokenPriceUsd, setLatestTokenPriceUsd] = useState<number | null>(null);
  const [priceByTokenKey, setPriceByTokenKey] = useState<Record<string, { priceUsd: number | null; ts: number }>>({});
  const priceByTokenKeyRef = useRef(priceByTokenKey);
  const priceFetchRef = useRef<{ inFlight: Set<string> }>({ inFlight: new Set() });
  const didImmediateListPriceFetchRef = useRef(false);
  const buyPriceRef = useRef(buyPrice);
  const sellPriceRef = useRef(sellPrice);
  const tokenPriceSnapshotRef = useRef<number | null>(null);
  const autoTriggerPriceRef = useRef<{ key: string | null; buy: string; sell: string; stage: 'none' | 'prop' | 'fetched' }>({
    key: null,
    buy: '',
    sell: '',
    stage: 'none',
  });

  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const chainId = settings?.chainId ?? 56;
  const chain = settings?.chains?.[chainId];
  const buyPresets = chain?.buyPresets ?? ['0.1', '0.5', '1.0', '2.0'];
  const sellPresets = chain?.sellPresets ?? ['25', '50', '75', '100'];
  const limitOrderScanIntervalMs = settings?.limitOrderScanIntervalMs ?? 3000;
  const limitOrderScanIntervalOptions = [
    { label: '1s', value: 1000 },
    { label: '3s', value: 3000 },
    { label: '5s', value: 5000 },
    { label: '10s', value: 10000 },
    { label: '30s', value: 30000 },
    { label: '60s', value: 60000 },
    { label: '120s', value: 120000 },
  ];

  const statusText = (() => {
    if (!settings) return tt('contentUi.autotrade.statusSettingsNotLoaded');
    if (!isUnlocked) return tt('contentUi.autotrade.statusLocked');
    return tt('contentUi.autotrade.statusUnlocked');
  })();

  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : tt('contentUi.autotrade.walletNotConnected');

  const formatAmountForInput = (value: number) => {
    const s = formatAmount(value, 4);
    return s === '-' ? '' : s;
  };

  const adjustPrice = (value: string, delta: number) => {
    const v = parseNumberLoose(value);
    if (v == null || v <= 0) return value;
    const next = v * (1 + delta);
    if (!Number.isFinite(next) || next <= 0) return value;
    const formatted = formatAmountForInput(next);
    return formatted || value;
  };

  const formatUsd = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '-';
    if (value < 0.000001) return value.toExponential(3);
    if (value < 1) return String(Number(value.toFixed(8)));
    return String(Number(value.toFixed(6)));
  };

  const toTokenKey = (chainId2: number, tokenAddress2: string) => `${chainId2}:${tokenAddress2.toLowerCase()}`;
  const getWNativeAddress = (chainId2: number) => {
    if (chainId2 === 56) return bscTokens.wbnb.address;
    return null;
  };

  const explorerTxUrl = (txHash: string) => {
    return `https://bscscan.com/tx/${txHash}`;
  };
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedValue(text);
      window.setTimeout(() => setCopiedValue((v) => (v === text ? null : v)), 1000);
    } catch {
    }
  };
  const filteredOrders = onlyCurrentToken && tokenAddress
    ? orders.filter((o) => o.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
    : orders;

  useEffect(() => {
    priceByTokenKeyRef.current = priceByTokenKey;
  }, [priceByTokenKey]);

  useEffect(() => {
    if (!visible) return;
    if (!tokenAddress) return;
    const v = tokenPrice != null && Number.isFinite(tokenPrice) && tokenPrice > 0 ? tokenPrice : null;
    if (v == null) return;
    const key = toTokenKey(chainId, tokenAddress);
    const now = Date.now();
    setPriceByTokenKey((prev) => {
      const cached = prev[key];
      if (cached && cached.priceUsd === v && now - cached.ts < 2000) return prev;
      return { ...prev, [key]: { priceUsd: v, ts: now } };
    });
  }, [visible, chainId, tokenAddress, tokenPrice]);

  useEffect(() => {
    buyPriceRef.current = buyPrice;
  }, [buyPrice]);

  useEffect(() => {
    sellPriceRef.current = sellPrice;
  }, [sellPrice]);

  useEffect(() => {
    if (!visible) didImmediateListPriceFetchRef.current = false;
  }, [visible]);

  const refreshOrders = async () => {
    if (!settings) return;
    const req = onlyCurrentToken && tokenAddress
      ? ({ type: 'limitOrder:list', chainId, tokenAddress } as const)
      : ({ type: 'limitOrder:list', chainId } as const);
    const res = await call(req);
    setOrders(res.orders);
  };
  const refreshScanStatus = async () => {
    if (!settings) return;
    const res = await call({ type: 'limitOrder:scanStatus', chainId } as const);
    const { ok: _ok, ...status } = res;
    setScanStatus(status);
    const prices = (status as any).pricesByTokenKey as undefined | Record<string, { priceUsd: number; ts: number }>;
    if (prices && typeof prices === 'object') {
      setPriceByTokenKey((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [k, v] of Object.entries(prices)) {
          if (!v || typeof v.priceUsd !== 'number' || typeof v.ts !== 'number') continue;
          const old = prev[k];
          if (!old || old.ts < v.ts || old.priceUsd !== v.priceUsd) {
            next[k] = { priceUsd: v.priceUsd, ts: v.ts };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  };
  const refreshRunningRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const requestRefreshOrders = async (minIntervalMs = 800) => {
    if (!visible) return;
    if (!settings) return;
    const now = Date.now();
    if (refreshRunningRef.current) return;
    if (now - lastRefreshAtRef.current < minIntervalMs) return;
    refreshRunningRef.current = true;
    lastRefreshAtRef.current = now;
    try {
      await refreshOrders();
    } finally {
      refreshRunningRef.current = false;
    }
  };
  const scanRefreshRunningRef = useRef(false);
  const lastScanRefreshAtRef = useRef(0);
  const requestRefreshScanStatus = async (minIntervalMs = 800) => {
    if (!visible) return;
    if (!settings) return;
    const now = Date.now();
    if (scanRefreshRunningRef.current) return;
    if (now - lastScanRefreshAtRef.current < minIntervalMs) return;
    scanRefreshRunningRef.current = true;
    lastScanRefreshAtRef.current = now;
    try {
      await refreshScanStatus();
    } finally {
      scanRefreshRunningRef.current = false;
    }
  };

  const parsePositiveNumber = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  };

  const toPercentBps = (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const bps = Math.round(n * 100);
    if (bps <= 0 || bps > 10000) return null;
    return bps;
  };

  const formatPay = (o: LimitOrder) => {
    if (o.side === 'buy') {
      const wei = o.buyBnbAmountWei ? BigInt(o.buyBnbAmountWei) : 0n;
      const v = Number(formatEther(wei));
      return Number.isFinite(v) && v > 0 ? `${v} BNB` : '-';
    }
    const fixedAmountWei = (() => {
      try {
        return o.sellTokenAmountWei ? BigInt(o.sellTokenAmountWei) : 0n;
      } catch {
        return 0n;
      }
    })();
    const bps = o.sellPercentBps ?? 0;
    const pct = Number.isFinite(bps) && bps > 0 ? (bps / 100) : null;
    if (fixedAmountWei > 0n && o.tokenInfo) {
      const decimals = typeof (o.tokenInfo as any).decimals === 'number' ? (o.tokenInfo as any).decimals : 18;
      const tokens = Number(formatUnits(fixedAmountWei, decimals));
      const sym = o.tokenSymbol || tt('contentUi.common.token');
      const amtText = Number.isFinite(tokens) && tokens > 0 ? `${formatAmount(tokens)} ${sym}` : '-';
      return pct != null ? `${amtText} (${pct}%)` : amtText;
    }
    if (pct != null) return `${pct}%`;
    return '-';
  };

  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const switchTokenInCurrentUrl = (nextTokenAddress: `0x${string}`) => {
    try {
      const href = window.location.href;
      const match = href.match(/0x[a-fA-F0-9]{40}/);
      if (!match) return;
      const current = match[0];
      if (current.toLowerCase() === nextTokenAddress.toLowerCase()) return;
      const nextHref = href.replace(new RegExp(escapeRegex(current), 'i'), nextTokenAddress);
      window.location.href = nextHref;
    } catch {
    }
  };

  const normalizeOrderType = (o: LimitOrder): LimitOrderType => {
    if (o.orderType === 'take_profit_sell' || o.orderType === 'stop_loss_sell' || o.orderType === 'trailing_stop_sell' || o.orderType === 'low_buy' || o.orderType === 'high_buy') {
      return o.orderType;
    }
    return o.side === 'buy' ? 'low_buy' : 'take_profit_sell';
  };

  const formatOrderType = (o: LimitOrder) => {
    const type = normalizeOrderType(o);
    if (type === 'take_profit_sell') return tt('contentUi.limitOrder.type.takeProfitSell');
    if (type === 'stop_loss_sell') return tt('contentUi.limitOrder.type.stopLossSell');
    if (type === 'trailing_stop_sell') return tt('contentUi.limitOrder.type.trailingStopSell');
    if (type === 'low_buy') return tt('contentUi.limitOrder.type.lowBuy');
    if (type === 'high_buy') return tt('contentUi.limitOrder.type.highBuy');
    return type;
  };

  const formatOrderTypeLines = (o: LimitOrder): [string, string] => {
    const type = normalizeOrderType(o);
    if (type === 'take_profit_sell') return [tt('contentUi.limitOrder.type.takeProfitSell'), tt('contentUi.limitOrder.typeLine.takeProfitSell')];
    if (type === 'stop_loss_sell') return [tt('contentUi.limitOrder.type.stopLossSell'), tt('contentUi.limitOrder.typeLine.stopLossSell')];
    if (type === 'trailing_stop_sell') return [tt('contentUi.limitOrder.type.trailingStopSell'), tt('contentUi.limitOrder.typeLine.trailingStopSell')];
    if (type === 'low_buy') return [tt('contentUi.limitOrder.typeLine.lowBuy1'), tt('contentUi.limitOrder.typeLine.lowBuy2')];
    if (type === 'high_buy') return [tt('contentUi.limitOrder.typeLine.highBuy1'), tt('contentUi.limitOrder.typeLine.highBuy2')];
    return [formatOrderType(o), ''];
  };

  const orderTypeColorClass = (o: LimitOrder) => {
    const type = normalizeOrderType(o);
    if (type === 'take_profit_sell') return 'text-emerald-300';
    if (type === 'stop_loss_sell') return 'text-rose-300';
    if (type === 'trailing_stop_sell') return 'text-amber-300';
    if (type === 'low_buy') return 'text-emerald-300';
    if (type === 'high_buy') return 'text-rose-300';
    return o.side === 'buy' ? 'text-emerald-300' : 'text-rose-300';
  };

  const formatStatus = (o: LimitOrder) => {
    if (o.status === 'open') return tt('contentUi.limitOrder.status.open');
    if (o.status === 'triggered') return tt('contentUi.limitOrder.status.triggered');
    if (o.status === 'executed') return tt('contentUi.limitOrder.status.executed');
    if (o.status === 'failed') return tt('contentUi.limitOrder.status.failed');
    if (o.status === 'cancelled') return tt('contentUi.limitOrder.status.cancelled');
    return o.status;
  };
  const statusBadgeClass = (o: LimitOrder) => {
    if (o.status === 'open') return 'border-zinc-700/70 bg-zinc-800/30 text-zinc-300';
    if (o.status === 'triggered') return 'border-amber-700/60 bg-amber-900/20 text-amber-300';
    if (o.status === 'executed') return 'border-emerald-700/60 bg-emerald-900/20 text-emerald-300';
    if (o.status === 'failed') return 'border-rose-700/60 bg-rose-900/20 text-rose-300';
    if (o.status === 'cancelled') return 'border-zinc-700/60 bg-zinc-900/20 text-zinc-400';
    return 'border-zinc-700/60 bg-zinc-900/20 text-zinc-400';
  };

  useEffect(() => {
    if (!visible) return;
    refreshOrders().catch(() => { });
    refreshScanStatus().catch(() => { });
  }, [visible, chainId, onlyCurrentToken, tokenAddress]);

  useLayoutEffect(() => {
    if (!visible) return;
    const key = `${chainId}:${tokenAddress ?? ''}`;
    if (autoTriggerPriceRef.current.key === key) return;
    tokenPriceSnapshotRef.current = tokenPrice != null && Number.isFinite(tokenPrice) && tokenPrice > 0 ? tokenPrice : null;
    autoTriggerPriceRef.current.key = key;
    autoTriggerPriceRef.current.buy = '';
    autoTriggerPriceRef.current.sell = '';
    autoTriggerPriceRef.current.stage = 'none';
    setBuyPrice('');
    setSellPrice('');
    buyPriceRef.current = '';
    sellPriceRef.current = '';
    setLatestTokenPriceUsd(null);
  }, [visible, chainId, tokenAddress]);

  useEffect(() => {
    if (!visible) return;
    if (!tokenAddress) return;
    const key = `${chainId}:${tokenAddress}`;
    const v = tokenPrice != null && Number.isFinite(tokenPrice) && tokenPrice > 0 ? tokenPrice : null;
    if (v == null) return;
    if (autoTriggerPriceRef.current.key !== key) return;
    if (autoTriggerPriceRef.current.stage === 'fetched') return;
    const tokenLower = tokenAddress.toLowerCase();
    const tokenInfoLower = tokenInfo?.address?.toLowerCase?.();
    const tokenInfoMatches = tokenInfoLower === tokenLower;
    const tokenPriceChangedSinceSwitch = tokenPriceSnapshotRef.current == null || tokenPriceSnapshotRef.current !== v;
    if (!tokenInfoMatches && !tokenPriceChangedSinceSwitch) return;

    setLatestTokenPriceUsd(v);
    const tokenKey = toTokenKey(chainId, tokenAddress);
    setPriceByTokenKey((prev) => ({ ...prev, [tokenKey]: { priceUsd: v, ts: Date.now() } }));

    if (buyPriceRef.current !== autoTriggerPriceRef.current.buy || sellPriceRef.current !== autoTriggerPriceRef.current.sell) return;
    const formatted = formatAmountForInput(v);
    if (!formatted) return;
    autoTriggerPriceRef.current.buy = formatted;
    autoTriggerPriceRef.current.sell = formatted;
    autoTriggerPriceRef.current.stage = 'fetched';
    setBuyPrice(formatted);
    setSellPrice(formatted);
  }, [visible, chainId, tokenAddress, tokenInfo, tokenPrice]);

  useEffect(() => {
    if (!visible) return;
    const listener = (message: any) => {
      if (message?.type === 'bg:stateChanged') {
        requestRefreshOrders().catch(() => { });
        requestRefreshScanStatus().catch(() => { });
      }
    };
    browser.runtime.onMessage.addListener(listener);
    requestRefreshOrders(0).catch(() => { });
    requestRefreshScanStatus(0).catch(() => { });
    const openOrders = scanStatus?.openOrders ?? 0;
    const ordersPollMs = openOrders > 0 ? Math.max(30000, limitOrderScanIntervalMs) : 120000;
    const ordersTimer = setInterval(() => {
      requestRefreshOrders().catch(() => { });
    }, ordersPollMs);
    const scanStatusPollMs = Math.max(5000, limitOrderScanIntervalMs);
    const scanStatusTimer = setInterval(() => {
      requestRefreshScanStatus().catch(() => { });
    }, scanStatusPollMs);
    return () => {
      clearInterval(ordersTimer);
      clearInterval(scanStatusTimer);
      browser.runtime.onMessage.removeListener(listener);
    };
  }, [visible, chainId, onlyCurrentToken, tokenAddress, settings, limitOrderScanIntervalMs, scanStatus?.openOrders]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;

    const runWithLimit = async <T,>(items: T[], limit: number, fn: (item: T) => Promise<void>) => {
      const queue = items.slice();
      const workers = Array.from({ length: Math.max(1, limit) }, async () => {
        while (queue.length) {
          const item = queue.shift();
          if (item === undefined) return;
          await fn(item);
        }
      });
      await Promise.all(workers);
    };

    const fetchOnce = async () => {
      const unique = new Map<string, { chainId: number; tokenAddress: string; tokenInfo: TokenInfo | null }>();
      for (const o of filteredOrders) {
        const key = toTokenKey(o.chainId, o.tokenAddress);
        if (!unique.has(key)) unique.set(key, { chainId: o.chainId, tokenAddress: o.tokenAddress, tokenInfo: o.tokenInfo ?? null });
      }
      for (const o of filteredOrders) {
        const wNative = getWNativeAddress(o.chainId);
        if (!wNative) continue;
        const key = toTokenKey(o.chainId, wNative);
        if (!unique.has(key)) unique.set(key, { chainId: o.chainId, tokenAddress: wNative, tokenInfo: null });
      }

      const tokenPriceValid = tokenPrice != null && Number.isFinite(tokenPrice) && tokenPrice > 0;
      if (tokenPriceValid && tokenAddress) {
        const addrLower = tokenAddress.toLowerCase();
        for (const o of filteredOrders) {
          if (o.tokenAddress.toLowerCase() !== addrLower) continue;
          unique.delete(toTokenKey(o.chainId, o.tokenAddress));
        }
      }

      const now = Date.now();
      const tasks = Array.from(unique.entries())
        .filter(([key, v]) => {
          if (priceFetchRef.current.inFlight.has(key)) return false;
          const cached = priceByTokenKeyRef.current[key];
          const wNative = getWNativeAddress(v.chainId);
          const ttl = wNative && toTokenKey(v.chainId, wNative) === key ? 60_000 : 10_000;
          if (cached && now - cached.ts < ttl) return false;
          return true;
        })
        .map(([, v]) => v);

      if (!tasks.length) return;

      await runWithLimit(tasks, 5, async (t) => {
        if (cancelled) return;
        const key = toTokenKey(t.chainId, t.tokenAddress);
        if (priceFetchRef.current.inFlight.has(key)) return;
        priceFetchRef.current.inFlight.add(key);
        try {
          const v = await TokenAPI.getTokenPriceUsd(platform, t.chainId, t.tokenAddress, t.tokenInfo);
          if (cancelled) return;
          setPriceByTokenKey((prev) => ({ ...prev, [key]: { priceUsd: v, ts: Date.now() } }));
        } finally {
          priceFetchRef.current.inFlight.delete(key);
        }
      });
    };

    if (!didImmediateListPriceFetchRef.current) {
      didImmediateListPriceFetchRef.current = true;
      if ((scanStatus?.openOrders ?? 0) <= 0) fetchOnce().catch(() => { });
    }
    if ((scanStatus?.openOrders ?? 0) > 0) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => fetchOnce().catch(() => { }), 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, filteredOrders, platform, scanStatus?.openOrders]);

  if (!visible) {
    return null;
  }

  const buyTrigger = parsePositiveNumber(buyPrice);
  const sellTrigger = parsePositiveNumber(sellPrice);
  const buyCreateDisabled = !settings || !isUnlocked || !tokenAddress || !tokenInfo || !buyAmount || buyTrigger == null;
  const sellBps = toPercentBps(sellPercent);
  const sellCreateDisabled = !settings || !isUnlocked || !tokenAddress || !tokenInfo || sellBps == null || sellTrigger == null;

  return (
    <div
      className="fixed z-[2147483647]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="w-[680px] max-w-[92vw] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/40 text-[12px]">
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-grab"
          onPointerDown={(e) => {
            dragging.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: posRef.current.x,
              baseY: posRef.current.y,
            };
          }}
        >
          <div className="flex flex-col">
            <div className="text-xs font-semibold text-emerald-300">{tt('contentUi.autotrade.title')}</div>
            <div className="text-[10px] text-zinc-500">{statusText} · {shortAddress}</div>
          </div>
          <button
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            {tt('contentUi.autotrade.close')}
          </button>
        </div>
        <div className="p-3 flex flex-col gap-3">
          <div className="flex gap-3">
            <div className="flex-1 min-w-0 space-y-2 pr-3 border-r border-zinc-800">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold text-emerald-300">
                  {tt('contentUi.autotrade.buySection')}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-emerald-400">
                  <span>{formattedNativeBalance}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  className="w-[110px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  value={buyOrderType}
                  onChange={(e) => setBuyOrderType(e.target.value as LimitOrderType)}
                >
                  <option value="low_buy">{tt('contentUi.limitOrder.type.lowBuy')}</option>
                  <option value="high_buy">{tt('contentUi.limitOrder.type.highBuy')}</option>
                </select>
                <input
                  className="flex-1 w-[90px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  value={buyPrice}
                  onChange={(e) => setBuyPrice(e.target.value)}
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="px-1 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, buyOrderType === 'high_buy' ? 0.1 : -0.1))}
                  >
                    {buyOrderType === 'high_buy' ? '+10%' : '-10%'}
                  </button>
                  <button
                    type="button"
                    className="px-1 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, buyOrderType === 'high_buy' ? 0.2 : -0.2))}
                  >
                    {buyOrderType === 'high_buy' ? '+20%' : '-20%'}
                  </button>
                  <button
                    type="button"
                    className="px-1 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, buyOrderType === 'high_buy' ? 0.5 : -0.5))}
                  >
                    {buyOrderType === 'high_buy' ? '+50%' : '-50%'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {buyPresets.map((val, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={
                      buyAmount === val
                        ? 'rounded border border-emerald-400 bg-emerald-500/20 py-1 text-center text-xs font-medium text-emerald-200 active:scale-95 transition-all'
                        : 'rounded border border-emerald-500/30 bg-emerald-500/10 py-1 text-center text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all'
                    }
                    onClick={() => setBuyAmount(val)}
                  >
                    {val}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={buyCreateDisabled}
                className="w-full px-2 py-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={async () => {
                  if (!tokenAddress || !tokenInfo) return;
                  const trigger = parsePositiveNumber(buyPrice);
                  if (trigger == null) return;
                  const amountWei = parseEther(buyAmount).toString();
                  await call({
                    type: 'limitOrder:create',
                    input: {
                      chainId,
                      tokenAddress,
                      tokenSymbol,
                      side: 'buy',
                      orderType: buyOrderType,
                      triggerPriceUsd: trigger,
                      buyBnbAmountWei: amountWei,
                      tokenInfo,
                    },
                  });
                  setBuyAmount('');
                  await refreshOrders();
                }}
              >
                {buyOrderType === 'high_buy' ? tt('contentUi.limitTradePanel.createHighBuy') : tt('contentUi.limitTradePanel.createLowBuy')}
              </button>
            </div>

            <div className="flex-1 min-w-0 space-y-2 pl-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold text-red-300">
                  {tt('contentUi.autotrade.sellSection')}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-zinc-300">
                  <span>{Number(formattedTokenBalance).toLocaleString()}</span>
                  <span className="text-amber-500 text-[11px]">
                    {tokenSymbol || tt('contentUi.common.token')}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  className="w-[110px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  value={sellOrderType}
                  onChange={(e) => setSellOrderType(e.target.value as LimitOrderType)}
                >
                  <option value="take_profit_sell">{tt('contentUi.limitOrder.type.takeProfitSell')}</option>
                  <option value="stop_loss_sell">{tt('contentUi.limitOrder.type.stopLossSell')}</option>
                </select>
                <input
                  className="flex-1  w-[90px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  value={sellPrice}
                  onChange={(e) => setSellPrice(e.target.value)}
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="px-1 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, sellOrderType === 'stop_loss_sell' ? -0.2 : 0.2))}
                  >
                    {sellOrderType === 'stop_loss_sell' ? '-20%' : '+20%'}
                  </button>
                  <button
                    type="button"
                    className="px-1 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, sellOrderType === 'stop_loss_sell' ? -0.5 : 0.5))}
                  >
                    {sellOrderType === 'stop_loss_sell' ? '-50%' : '+50%'}
                  </button>
                  <button
                    type="button"
                    className="px-1 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, sellOrderType === 'stop_loss_sell' ? -1 : 1))}
                  >
                    {sellOrderType === 'stop_loss_sell' ? '-100%' : '+100%'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {sellPresets.map((val, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={
                      sellPercent === val
                        ? 'rounded border border-rose-300 bg-rose-500/20 py-1 text-center text-xs font-medium text-rose-200 active:scale-95 transition-all'
                        : 'rounded border border-rose-500/30 bg-rose-500/10 py-1 text-center text-xs font-medium text-rose-400 hover:bg-rose-500/20 active:scale-95 transition-all'
                    }
                    onClick={() => setSellPercent(val)}
                  >
                    {val}%
                  </button>
                ))}
              </div>

              <div className="w-full flex items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={sellCreateDisabled}
                  className="flex-1 px-2 py-1 rounded border border-rose-500/30 bg-rose-500/10 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={async () => {
                    if (!tokenAddress || !tokenInfo) return;
                    const trigger = parsePositiveNumber(sellPrice);
                    const bps = toPercentBps(sellPercent);
                    if (trigger == null || bps == null) return;
                    await call({
                      type: 'limitOrder:create',
                      input: {
                        chainId,
                        tokenAddress,
                        tokenSymbol,
                        side: 'sell',
                        orderType: sellOrderType,
                        triggerPriceUsd: trigger,
                        sellPercentBps: bps,
                        tokenInfo,
                      },
                    });
                    setSellPercent('');
                    await refreshOrders();
                  }}
                >
                  {sellOrderType === 'stop_loss_sell' ? tt('contentUi.limitTradePanel.createStopLossSell') : tt('contentUi.limitTradePanel.createTakeProfitSell')}
                </button>
              </div>
            </div>
          </div>
          <div className="pt-1">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-[11px] font-semibold text-zinc-200">
                  {tt('contentUi.limitTradePanel.orderListTitle')}
                </div>
                {scanStatus ? (
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500 min-w-0">
                    <span
                      className={[
                        'h-2 w-2 rounded-full shrink-0 animate-pulse',
                        scanStatus.running ? 'bg-emerald-400 animate-pulse' : scanStatus.lastScanOk ? 'bg-emerald-400/70' : 'bg-rose-400/80',
                      ].join(' ')}
                    />
                    <span className="truncate" title={scanStatus.lastScanAtMs ? formatTime(scanStatus.lastScanAtMs, locale) : ''}>
                      {scanStatus.lastScanAtMs
                        ? tt('contentUi.limitTradePanel.lastScanAt', [formatTime(scanStatus.lastScanAtMs, locale)])
                        : tt('contentUi.limitTradePanel.lastScanAtEmpty')}
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 cursor-pointer select-none text-[11px] text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-emerald-500"
                    checked={onlyCurrentToken}
                    disabled={!tokenAddress}
                    onChange={(e) => setOnlyCurrentToken(e.target.checked)}
                  />
                  <span>
                    {tokenSymbol ? tt('contentUi.limitTradePanel.onlyCurrentTokenWithSymbol', [tokenSymbol]) : tt('contentUi.limitTradePanel.onlyCurrentToken')}
                  </span>
                </label>
                <label className="flex items-center gap-1 select-none text-[11px] text-zinc-300">
                  <span>{tt('contentUi.limitTradePanel.scanInterval')}</span>
                  <select
                    className="rounded border border-zinc-800 bg-zinc-950 px-1 py-1 text-[11px] text-zinc-200 outline-none"
                    value={String(limitOrderScanIntervalMs)}
                    disabled={!settings}
                    onChange={(e) => {
                      if (!settings) return;
                      const next = Number(e.target.value);
                      call({
                        type: 'settings:set',
                        settings: { ...settings, limitOrderScanIntervalMs: next },
                      }).finally(() => {
                        requestRefreshScanStatus(0);
                      });
                    }}
                  >
                    {limitOrderScanIntervalOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!orders.length}
                  className="px-2 py-1 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-rose-400 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={async () => {
                    if (!settings) return;
                    const req = onlyCurrentToken && tokenAddress
                      ? ({ type: 'limitOrder:cancelAll', chainId, tokenAddress } as const)
                      : ({ type: 'limitOrder:cancelAll', chainId } as const);
                    try {
                      await call(req);
                    } catch {
                    } finally {
                      await refreshOrders();
                    }
                  }}
                >
                  {tt('contentUi.limitTradePanel.cancelAll')}
                </button>
              </div>
            </div>

            <div className="max-h-[38vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.5fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.55fr)] gap-2 text-zinc-400 border-b border-zinc-800 py-1 sticky top-0 bg-[#0F0F11]">
                <div className="font-medium truncate">{tt('contentUi.limitTradePanel.table.token')}</div>
                <div className="font-medium truncate">{tt('contentUi.limitTradePanel.table.type')}</div>
                <div className="font-medium truncate">{tt('contentUi.limitTradePanel.table.triggerPrice')}</div>
                <div className="font-medium truncate">{tt('contentUi.limitTradePanel.table.payAmount')}</div>
                <div className="font-medium truncate">{tt('contentUi.limitTradePanel.table.createdAt')}</div>
                <div className="font-medium text-right truncate">{tt('contentUi.limitTradePanel.table.action')}</div>
              </div>

              {filteredOrders.length ? filteredOrders.map((o) => (
                <div
                  key={o.id}
                  className={[
                    'grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.5fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.55fr)] gap-2 items-center border-b border-zinc-900 last:border-b-0 py-1',
                    o.status === 'executed' ? 'bg-emerald-500/5' : '',
                    o.status === 'failed' ? 'bg-rose-500/5' : '',
                  ].join(' ')}
                >
                  <div className="min-w-0 text-zinc-200">
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        type="button"
                        className="font-semibold break-all hover:underline"
                        onClick={() => switchTokenInCurrentUrl(o.tokenAddress)}
                        title={o.tokenAddress}
                      >
                        {o.tokenSymbol || tt('contentUi.common.token')}
                      </button>
                      <span className="text-[10px] text-zinc-500 truncate">
                        {o.tokenAddress.slice(0, 6)}...{o.tokenAddress.slice(-4)}
                      </span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-start justify-start gap-1 min-w-0">
                      <div className="min-w-0 leading-tight">
                        <div className={`${orderTypeColorClass(o)} whitespace-normal break-words`}>
                          {formatOrderTypeLines(o)[0]}
                        </div>
                        <div className="text-[10px] text-zinc-500 whitespace-normal break-words">
                          {formatOrderTypeLines(o)[1]}
                        </div>
                      </div>
                      <span className={`shrink-0 inline-flex items-center rounded border px-1 py-0.5 text-[9px] leading-none ${statusBadgeClass(o)}`}>
                        {formatStatus(o)}
                      </span>
                    </div>
                    {o.txHash && (o.status === 'executed' || o.status === 'triggered' || o.status === 'failed') ? (
                      <div className="flex items-center gap-2 text-[10px] text-zinc-600 min-w-0">
                        <a
                          href={explorerTxUrl(o.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate hover:underline"
                          title={o.txHash}
                        >
                          {tt('contentUi.limitTradePanel.txPrefix', [`${o.txHash.slice(0, 10)}...${o.txHash.slice(-8)}`])}
                        </a>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-300 hover:border-emerald-400"
                          onClick={() => copyToClipboard(o.txHash!)}
                        >
                          {copiedValue === o.txHash ? tt('contentUi.limitTradePanel.copied') : tt('contentUi.limitTradePanel.copy')}
                        </button>
                      </div>
                    ) : null}
                    {o.status === 'failed' && o.lastError ? (
                      <div className="flex items-center gap-2 text-[10px] text-rose-400/80 min-w-0">
                        <div className="truncate" title={o.lastError}>
                          {tt('contentUi.limitTradePanel.errPrefix', [o.lastError])}
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-300 hover:border-rose-400"
                          onClick={() => copyToClipboard(o.lastError!)}
                        >
                          {copiedValue === o.lastError ? tt('contentUi.limitTradePanel.copied') : tt('contentUi.limitTradePanel.copy')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="min-w-0 text-zinc-200">
                    <div className="truncate" title={String(o.triggerPriceUsd)}>
                      {String(o.triggerPriceUsd)}
                    </div>
                    {(() => {
                      const key = toTokenKey(o.chainId, o.tokenAddress);
                      const cached = priceByTokenKey[key];
                      const loading = priceFetchRef.current.inFlight.has(key);
                      const v = cached?.priceUsd;
                      const text = loading ? '...' : v != null && v > 0 ? formatUsd(v) : '-';
                      return (
                        <div className="text-[10px] text-zinc-500 truncate" title={text}>
                          {tt('contentUi.limitTradePanel.currentPrice', [text])}
                        </div>
                      );
                    })()}
                  </div>
                  <div className="min-w-0 text-zinc-200">{formatPay(o)}</div>
                  <div className="min-w-0 text-zinc-400 text-[10px]" title={formatTime(o.createdAtMs, locale)}>
                    {formatTime(o.createdAtMs, locale)}
                  </div>
                  <div className="text-right flex items-center justify-end gap-1">
                    {o.status === 'failed' ? (
                      <button
                        type="button"
                        className="px-1 py-0.5 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={async () => {
                          try {
                            if (!o.tokenInfo) return;
                            const input: LimitOrderCreateInput = {
                              chainId: o.chainId,
                              tokenAddress: o.tokenAddress,
                              tokenSymbol: o.tokenSymbol ?? null,
                              side: o.side,
                              orderType: normalizeOrderType(o),
                              triggerPriceUsd: o.triggerPriceUsd,
                              buyBnbAmountWei: o.buyBnbAmountWei,
                              sellPercentBps: o.sellPercentBps,
                              sellTokenAmountWei: o.sellTokenAmountWei,
                              trailingStopBps: o.trailingStopBps,
                              trailingPeakPriceUsd: o.trailingPeakPriceUsd,
                              tokenInfo: o.tokenInfo,
                            };
                            await call({ type: 'limitOrder:create', input } as const);
                            await call({ type: 'limitOrder:cancel', id: o.id } as const);
                          } catch {
                          } finally {
                            await refreshOrders();
                          }
                        }}
                      >
                        {tt('common.retry')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="px-1 py-0.5 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-rose-400 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={async () => {
                        try {
                          await call({ type: 'limitOrder:cancel', id: o.id });
                        } catch {
                        } finally {
                          await refreshOrders();
                        }
                      }}
                    >
                      {tt('common.cancel')}
                    </button>
                  </div>
                </div>
              )) : (
                <div className="py-6 text-center text-zinc-500">
                  {tt('contentUi.limitTradePanel.empty')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
