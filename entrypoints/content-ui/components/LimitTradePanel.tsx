import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@/types/extention';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';

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
};

type MockLimitOrder = {
  id: string;
  tokenSymbol: string;
  tokenAddress: string;
  side: 'buy' | 'sell';
  triggerPrice: number;
  payAmount: string;
  paySymbol: string;
  expectedReceive: string;
  receiveSymbol: string;
  createdAtMs: number;
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
  const [orders, setOrders] = useState<MockLimitOrder[]>(() => {
    const now = Date.now();
    const currentSym = tokenSymbol || 'TOKEN';
    const base: MockLimitOrder[] = [
      {
        id: 'o1',
        tokenSymbol: currentSym,
        tokenAddress: '0x1111111111111111111111111111111111111111',
        side: 'buy',
        triggerPrice: 0.0000123,
        payAmount: '0.20',
        paySymbol: 'BNB',
        expectedReceive: '158000',
        receiveSymbol: currentSym,
        createdAtMs: now - 2 * 60 * 1000,
      },
      {
        id: 'o2',
        tokenSymbol: currentSym,
        tokenAddress: '0x1111111111111111111111111111111111111111',
        side: 'sell',
        triggerPrice: 0.0000235,
        payAmount: '25%',
        paySymbol: currentSym,
        expectedReceive: '0.45',
        receiveSymbol: 'BNB',
        createdAtMs: now - 15 * 60 * 1000,
      },
      {
        id: 'o3',
        tokenSymbol: 'FOO',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        side: 'buy',
        triggerPrice: 0.12,
        payAmount: '50',
        paySymbol: 'USDT',
        expectedReceive: '420',
        receiveSymbol: 'FOO',
        createdAtMs: now - 60 * 60 * 1000,
      },
      {
        id: 'o4',
        tokenSymbol: 'BAR',
        tokenAddress: '0x3333333333333333333333333333333333333333',
        side: 'sell',
        triggerPrice: 1.05,
        payAmount: '100%',
        paySymbol: 'BAR',
        expectedReceive: '0.98',
        receiveSymbol: 'BNB',
        createdAtMs: now - 3 * 60 * 60 * 1000,
      },
    ];
    return base;
  });

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

  const filteredOrders = onlyCurrentToken && tokenSymbol
    ? orders.filter((o) => o.tokenSymbol === tokenSymbol)
    : orders;

  useEffect(() => {
    if (!visible) return;
    if (tokenPrice == null || !Number.isFinite(tokenPrice) || tokenPrice <= 0) tokenPrice = 0;
    const formatted = String(Number(tokenPrice.toFixed(6)));
    setBuyPrice((prev) => (prev ? prev : formatted));
    setSellPrice((prev) => (prev ? prev : formatted));
  }, [visible, tokenPrice]);

  if (!visible) {
    return null;
  }

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
            </div>
          </div>
          <div className="pt-1">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[11px] font-semibold text-zinc-200">
                限价单列表
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 cursor-pointer select-none text-[11px] text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-emerald-500"
                    checked={onlyCurrentToken}
                    disabled={!tokenSymbol}
                    onChange={(e) => setOnlyCurrentToken(e.target.checked)}
                  />
                  <span>只看当前代币{tokenSymbol ? `（${tokenSymbol}）` : ''}</span>
                </label>
                <button
                  type="button"
                  disabled={!orders.length}
                  className="px-2 py-1 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-rose-400 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => setOrders([])}
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
                <div key={o.id} className="grid grid-cols-7 gap-2 items-center border-b border-zinc-900 last:border-b-0 py-1">
                  <div className="min-w-0 text-zinc-200">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold truncate">{o.tokenSymbol}</span>
                      <span className="text-[10px] text-zinc-500 truncate">
                        {o.tokenAddress.slice(0, 6)}...{o.tokenAddress.slice(-4)}
                      </span>
                    </div>
                  </div>
                  <div className="min-w-0 truncate">
                    <span className={o.side === 'buy' ? 'text-emerald-300' : 'text-rose-300'}>
                      {o.side === 'buy' ? '买入' : '卖出'}
                    </span>
                  </div>
                  <div className="min-w-0 text-zinc-200">{String(o.triggerPrice)}</div>
                  <div className="min-w-0 text-zinc-200">{o.payAmount} {o.paySymbol}</div>
                  <div className="min-w-0 text-zinc-200">{o.expectedReceive} {o.receiveSymbol}</div>
                  <div className="min-w-0 text-zinc-400">{formatTime(o.createdAtMs)}</div>
                  <div className="text-right">
                    <button
                      type="button"
                      className="px-1 py-0.5 rounded border border-zinc-700 text-[11px] text-zinc-300 hover:border-rose-400"
                      onClick={() => setOrders((prev) => prev.filter((x) => x.id !== o.id))}
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
