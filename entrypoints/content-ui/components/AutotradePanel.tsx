import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { call } from '@/utils/messaging';
import type { Settings, AutoTradeConfig } from '@/types/extention';

type AutotradePanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  isUnlocked: boolean;
  address: string | null;
};

function createLocalConfig(settings: Settings | null): AutoTradeConfig {
  const base = settings?.autoTrade;
  if (!base) {
    return {
      enabled: false,
      buyAmountBnb: '0.05',
      maxMarketCapUsd: '',
      minLiquidityUsd: '',
      minHolders: '',
      maxTokenAgeMinutes: '',
      maxDevHoldPercent: '',
      blockIfDevSell: true,
      autoSellEnabled: false,
      takeProfitMultiple: '2',
      stopLossMultiple: '0.5',
      maxHoldMinutes: '',
    };
  }
  return { ...base };
}

export function AutotradePanel({ visible, onVisibleChange, settings, isUnlocked, address }: AutotradePanelProps) {
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

  const [config, setConfig] = useState<AutoTradeConfig>(() => createLocalConfig(settings));

  useEffect(() => {
    setConfig(createLocalConfig(settings));
  }, [settings]);

  const handleSave = async () => {
    if (!settings) {
      toast.error('设置尚未加载', { icon: '❌' });
      return;
    }
    try {
      const nextSettings: Settings = {
        ...settings,
        autoTrade: { ...config },
      };
      await call({ type: 'settings:set', settings: nextSettings } as any);
      toast.success('自动交易设置已保存', { icon: '✅' });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : '保存失败';
      toast.error(msg, { icon: '❌' });
    }
  };

  const statusText = (() => {
    if (!settings) return '设置未加载';
    if (!isUnlocked) return '钱包未解锁';
    return config.enabled ? '自动交易已开启' : '自动交易已关闭';
  })();

  const shortAddress = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '未连接';

  if (!visible) {
    return null;
  }

  return (
    <div
      className="fixed z-[2147483647]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="w-[320px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/40 text-[12px]">
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
            <div className="text-xs font-semibold text-emerald-300">Auto Trade</div>
            <div className="text-[10px] text-zinc-500">{statusText}</div>
          </div>
          <button
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            关闭
          </button>
        </div>
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div>钱包</div>
            <div className="font-mono text-[11px] text-zinc-200">{shortAddress}</div>
          </div>
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div>状态</div>
            <button
              className={
                config.enabled
                  ? 'px-2 py-0.5 rounded-full bg-emerald-500 text-[11px] font-semibold text-black'
                  : 'px-2 py-0.5 rounded-full border border-zinc-700 text-[11px] text-emerald-300 hover:border-emerald-400'
              }
              onClick={() => {
                setConfig((c) => ({ ...c, enabled: !c.enabled }));
              }}
            >
              {config.enabled ? '已开启' : '已关闭'}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">单笔买入（BNB）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.buyAmountBnb}
                onChange={(e) => setConfig((c) => ({ ...c, buyAmountBnb: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">最大市值（USD）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.maxMarketCapUsd}
                onChange={(e) => setConfig((c) => ({ ...c, maxMarketCapUsd: e.target.value }))}
                placeholder="留空不限"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">最小流动性（USD）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.minLiquidityUsd}
                onChange={(e) => setConfig((c) => ({ ...c, minLiquidityUsd: e.target.value }))}
                placeholder="留空不限"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">最少持有人数</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.minHolders}
                onChange={(e) => setConfig((c) => ({ ...c, minHolders: e.target.value }))}
                placeholder="留空不限"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">最大代币年龄（分钟）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.maxTokenAgeMinutes}
                onChange={(e) => setConfig((c) => ({ ...c, maxTokenAgeMinutes: e.target.value }))}
                placeholder="留空不限"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">开发者最大持仓（%）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.maxDevHoldPercent}
                onChange={(e) => setConfig((c) => ({ ...c, maxDevHoldPercent: e.target.value }))}
                placeholder="留空不限"
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div>禁止开发者已卖出</div>
            <button
              className={
                config.blockIfDevSell
                  ? 'px-2 py-0.5 rounded-full bg-red-500 text-[11px] font-semibold text-black'
                  : 'px-2 py-0.5 rounded-full border border-zinc-700 text-[11px] text-red-300 hover:border-red-400'
              }
              onClick={() => {
                setConfig((c) => ({ ...c, blockIfDevSell: !c.blockIfDevSell }));
              }}
            >
              {config.blockIfDevSell ? '已开启' : '已关闭'}
            </button>
          </div>

          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div>自动卖出</div>
            <button
              className={
                config.autoSellEnabled
                  ? 'px-2 py-0.5 rounded-full bg-emerald-500 text-[11px] font-semibold text-black'
                  : 'px-2 py-0.5 rounded-full border border-zinc-700 text-[11px] text-emerald-300 hover:border-emerald-400'
              }
              onClick={() => {
                setConfig((c) => ({ ...c, autoSellEnabled: !c.autoSellEnabled }));
              }}
            >
              {config.autoSellEnabled ? '已开启' : '已关闭'}
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">止盈倍数</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.takeProfitMultiple}
                onChange={(e) => setConfig((c) => ({ ...c, takeProfitMultiple: e.target.value }))}
                placeholder="如 2"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">止损倍数</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.stopLossMultiple}
                onChange={(e) => setConfig((c) => ({ ...c, stopLossMultiple: e.target.value }))}
                placeholder="如 0.5"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">最长持仓（分钟）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={config.maxHoldMinutes}
                onChange={(e) => setConfig((c) => ({ ...c, maxHoldMinutes: e.target.value }))}
                placeholder="留空不限"
              />
            </div>
          </div>

          <button
            className="w-full mt-2 rounded-md bg-emerald-500 text-[12px] font-semibold text-black py-2 hover:bg-emerald-400 disabled:opacity-60"
            type="button"
            onClick={handleSave}
            disabled={!settings}
          >
            保存自动交易设置
          </button>
        </div>
      </div>
    </div>
  );
}
