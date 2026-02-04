import { browser } from 'wxt/browser';
import { useEffect, useRef, useState } from 'react';
import { parseEther, formatEther } from 'viem';
import type { Settings, LimitOrder, LimitOrderScanStatus } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { call } from '@/utils/messaging';

type LimitTradePanelProps = {
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
  const [onlyCurrentToken, setOnlyCurrentToken] = useState(false);
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const [scanStatus, setScanStatus] = useState<LimitOrderScanStatus | null>(null);

  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const chainId = settings?.chainId ?? 56;
  const chain = settings?.chains?.[chainId];
  const buyPresets = chain?.buyPresets ?? ['0.1', '0.5', '1.0', '2.0'];
  const sellPresets = chain?.sellPresets ?? ['25', '50', '75', '100'];

  const statusText = (() => {
    if (!settings) return tt('contentUi.autotrade.statusSettingsNotLoaded');
    if (!isUnlocked) return tt('contentUi.autotrade.statusLocked');
    return tt('contentUi.autotrade.statusUnlocked');
  })();

  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : tt('contentUi.autotrade.walletNotConnected');

  const adjustPrice = (value: string, delta: number) => {
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return value;
    const next = v * (1 + delta);
    if (!Number.isFinite(next) || next <= 0) return value;
    return String(Number(next.toFixed(6)));
  };

  const jsLocale = locale === 'zh_TW' ? 'zh-TW' : locale === 'en' ? 'en-US' : 'zh-CN';
  const formatTime = (ms: number) => {
    try {
      return new Date(ms).toLocaleString(jsLocale, { hour12: false });
    } catch {
      return new Date(ms).toISOString();
    }
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
    const bps = o.sellPercentBps ?? 0;
    if (!bps) return '-';
    const pct = bps / 100;
    return `${pct}%`;
  };

  const formatStatus = (o: LimitOrder) => {
    if (o.status === 'open') return '等待触发';
    if (o.status === 'triggered') return '触发中';
    if (o.status === 'executed') return '已执行';
    if (o.status === 'failed') return '失败';
    if (o.status === 'cancelled') return '已取消';
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
    const timer = setInterval(() => {
      requestRefreshOrders().catch(() => { });
      requestRefreshScanStatus().catch(() => { });
    }, 3000);
    return () => {
      clearInterval(timer);
      browser.runtime.onMessage.removeListener(listener);
    };
  }, [visible, chainId, onlyCurrentToken, tokenAddress, settings]);

  useEffect(() => {
    if (!visible) return;
    const price = tokenPrice == null || !Number.isFinite(tokenPrice) || tokenPrice <= 0 ? 0 : tokenPrice;
    const formatted = String(Number(price.toFixed(6)));
    setBuyPrice((prev) => (prev ? prev : formatted));
    setSellPrice((prev) => (prev ? prev : formatted));
  }, [visible, tokenPrice]);

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
                <input
                  className="flex-1 w-[120px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  value={buyPrice}
                  onChange={(e) => setBuyPrice(e.target.value)}
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, -0.1))}
                  >
                    -10%
                  </button>
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, -0.2))}
                  >
                    -20%
                  </button>
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, -0.5))}
                  >
                    -50%
                  </button>
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-emerald-400"
                    onClick={() => setBuyPrice((v) => adjustPrice(v, -0.7))}
                  >
                    -70%
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
                        ? 'rounded border border-emerald-400 bg-emerald-500/20 py-1.5 text-center text-xs font-medium text-emerald-200 active:scale-95 transition-all'
                        : 'rounded border border-emerald-500/30 bg-emerald-500/10 py-1.5 text-center text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all'
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
                className="w-full px-2 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
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
                      triggerPriceUsd: trigger,
                      buyBnbAmountWei: amountWei,
                      tokenInfo,
                    },
                  });
                  setBuyAmount('');
                  await refreshOrders();
                }}
              >
                创建买入限价单
              </button>
            </div>

            <div className="flex-1 min-w-0 space-y-2 pl-3">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold text-red-300">
                  {tt('contentUi.autotrade.sellSection')}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-zinc-300">
                  <span>{formattedTokenBalance}</span>
                  <span className="text-amber-500 text-[11px]">
                    {tokenSymbol || tt('contentUi.common.token')}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  className="flex-1  w-[120px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  value={sellPrice}
                  onChange={(e) => setSellPrice(e.target.value)}
                />
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, 0.2))}
                  >
                    +20%
                  </button>
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, 0.5))}
                  >
                    +50%
                  </button>
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, 1))}
                  >
                    +100%
                  </button>
                  <button
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:border-red-400"
                    onClick={() => setSellPrice((v) => adjustPrice(v, 2))}
                  >
                    +200%
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
                        ? 'rounded border border-rose-300 bg-rose-500/20 py-1.5 text-center text-xs font-medium text-rose-200 active:scale-95 transition-all'
                        : 'rounded border border-rose-500/30 bg-rose-500/10 py-1.5 text-center text-xs font-medium text-rose-400 hover:bg-rose-500/20 active:scale-95 transition-all'
                    }
                    onClick={() => setSellPercent(val)}
                  >
                    {val}%
                  </button>
                ))}
              </div>

              <button
                type="button"
                disabled={sellCreateDisabled}
                className="w-full px-2 py-1.5 rounded border border-rose-500/30 bg-rose-500/10 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
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
                      triggerPriceUsd: trigger,
                      sellPercentBps: bps,
                      tokenInfo,
                    },
                  });
                  setSellPercent('');
                  await refreshOrders();
                }}
              >
                创建卖出限价单
              </button>
            </div>
          </div>
          <div className="pt-1">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="text-[11px] font-semibold text-zinc-200">
                  限价单列表
                </div>
                {scanStatus ? (
                  <div className="flex items-center gap-1 text-[10px] text-zinc-500 min-w-0">
                    <span
                      className={[
                        'h-2 w-2 rounded-full shrink-0',
                        scanStatus.running ? 'bg-emerald-400 animate-pulse' : scanStatus.lastScanOk ? 'bg-emerald-400/70' : 'bg-rose-400/80',
                      ].join(' ')}
                    />
                    <span className="shrink-0">
                      {scanStatus.running ? '扫描中' : scanStatus.lastScanOk ? '空闲' : '异常'}
                    </span>
                    <span className="shrink-0">·</span>
                    <span className="truncate" title={scanStatus.lastScanAtMs ? formatTime(scanStatus.lastScanAtMs) : ''}>
                      {scanStatus.lastScanAtMs ? `上次: ${formatTime(scanStatus.lastScanAtMs)}` : '上次: -'}
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
                  <span>只看当前代币{tokenSymbol ? `（${tokenSymbol}）` : ''}</span>
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
                    const res = await call(req);
                    setOrders(res.orders);
                  }}
                >
                  全部取消
                </button>
              </div>
            </div>

            <div className="max-h-[38vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-7 gap-2 text-zinc-400 border-b border-zinc-800 py-1 sticky top-0 bg-[#0F0F11]">
                <div className="font-medium truncate">代币</div>
                <div className="font-medium truncate">类型</div>
                <div className="font-medium truncate">触发价格</div>
                <div className="font-medium truncate">支付数量</div>
                <div className="font-medium truncate">预计获得</div>
                <div className="font-medium truncate">委托时间</div>
                <div className="font-medium text-right truncate">操作</div>
              </div>

              {filteredOrders.length ? filteredOrders.map((o) => (
                <div
                  key={o.id}
                  className={[
                    'grid grid-cols-7 gap-2 items-center border-b border-zinc-900 last:border-b-0 py-1',
                    o.status === 'executed' ? 'bg-emerald-500/5' : '',
                    o.status === 'failed' ? 'bg-rose-500/5' : '',
                  ].join(' ')}
                >
                  <div className="min-w-0 text-zinc-200">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold truncate">{o.tokenSymbol || tt('contentUi.common.token')}</span>
                      <span className="text-[10px] text-zinc-500 truncate">
                        {o.tokenAddress.slice(0, 6)}...{o.tokenAddress.slice(-4)}
                      </span>
                    </div>
                  </div>
                  <div className="min-w-0 truncate">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className={o.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}>
                        {o.side === 'buy' ? '买入' : '卖出'}
                      </span>
                      <span className={`inline-flex items-center rounded border px-1 py-0.5 text-[9px] leading-none ${statusBadgeClass(o)}`}>
                        {formatStatus(o)}
                      </span>
                    </div>
                    {o.status === 'executed' && o.txHash ? (
                      <div className="flex items-center gap-2 text-[10px] text-zinc-600 min-w-0">
                        <a
                          href={explorerTxUrl(o.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate hover:underline"
                          title={o.txHash}
                        >
                          Tx: {o.txHash.slice(0, 10)}...{o.txHash.slice(-8)}
                        </a>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-300 hover:border-emerald-400"
                          onClick={() => copyToClipboard(o.txHash!)}
                        >
                          {copiedValue === o.txHash ? '已复制' : '复制'}
                        </button>
                      </div>
                    ) : null}
                    {o.status === 'failed' && o.lastError ? (
                      <div className="flex items-center gap-2 text-[10px] text-rose-400/80 min-w-0">
                        <div className="truncate" title={o.lastError}>
                          Err: {o.lastError}
                        </div>
                        <button
                          type="button"
                          className="shrink-0 rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-300 hover:border-rose-400"
                          onClick={() => copyToClipboard(o.lastError!)}
                        >
                          {copiedValue === o.lastError ? '已复制' : '复制'}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="min-w-0 text-zinc-200">{String(o.triggerPriceUsd)}</div>
                  <div className="min-w-0 text-zinc-200">{formatPay(o)}</div>
                  <div className="min-w-0 text-zinc-200">-</div>
                  <div className="min-w-0 text-zinc-400">{formatTime(o.createdAtMs)}</div>
                  <div className="text-right">
                    <button
                      type="button"
                      disabled={o.status !== 'open' && o.status !== 'failed'}
                      className="px-1 py-0.5 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-rose-400 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={async () => {
                        const res = await call({ type: 'limitOrder:cancel', id: o.id });
                        setOrders(res.orders);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )) : (
                <div className="py-6 text-center text-zinc-500">
                  暂无委托订单
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
