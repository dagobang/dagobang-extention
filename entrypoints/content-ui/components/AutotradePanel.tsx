import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@/types/extention';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';

type AutotradePanelProps = {
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

export function AutotradePanel({
  visible,
  onVisibleChange,
  settings,
  isUnlocked,
  address,
  tokenPrice,
  formattedNativeBalance,
  formattedTokenBalance,
  tokenSymbol,
}: AutotradePanelProps) {
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
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
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 340));
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

  useEffect(() => {
    if (!visible) return;
    if (tokenPrice == null || !Number.isFinite(tokenPrice) || tokenPrice <= 0) return;
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
      <div className="w-[330px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/40 text-[12px]">
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
            <div className="text-[10px] text-zinc-500">{statusText}</div>
          </div>
          <button
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            {tt('contentUi.autotrade.close')}
          </button>
        </div>
        <div className="p-3 space-y-3">
          <div className="space-y-3">
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
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
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
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {buyPresets.map((val, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="rounded border border-emerald-500/30 bg-emerald-500/10 py-1.5 text-center text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all"
                  onClick={() => setBuyAmount(val)}
                >
                  {val}
                </button>
              ))}
            </div>
          </div>

          <div className="h-px bg-zinc-800" />

          <div className="space-y-3">
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
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
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
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {sellPresets.map((val, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="rounded border border-rose-500/30 bg-rose-500/10 py-1.5 text-center text-xs font-medium text-rose-400 hover:bg-rose-500/20 active:scale-95 transition-all"
                  onClick={() => setSellPercent(val)}
                >
                  {val}%
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
