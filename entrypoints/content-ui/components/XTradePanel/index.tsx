import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { XSniperContent } from './XSinper';
import { XMonitorContent } from './XMonitor';

type XTradePanelProps = {
  siteInfo: SiteInfo | null;
  visible: boolean;
  activeTab?: 'xmonitor' | 'xsniper' | 'xhistory';
  onActiveTabChange?: (tab: 'xmonitor' | 'xsniper' | 'xhistory') => void;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  isUnlocked: boolean;
};

const clampPos = (value: { x: number; y: number }, panelWidth: number) => {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, value.x), Math.max(0, width - panelWidth));
  const clampedY = Math.min(Math.max(0, value.y), Math.max(0, height - 80));
  return { x: clampedX, y: clampedY };
};

export function XTradePanel({
  siteInfo,
  visible,
  activeTab: activeTabProp,
  onActiveTabChange,
  onVisibleChange,
  settings,
  isUnlocked,
}: XTradePanelProps) {
  const [activeTab, setActiveTab] = useState<'xmonitor' | 'xsniper' | 'xhistory'>(() => activeTabProp ?? 'xmonitor');
  const panelWidth = activeTab === 'xhistory' ? 520 : 360;
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - panelWidth);
    const defaultY = 120;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const applyTab = (next: 'xmonitor' | 'xsniper' | 'xhistory') => {
    setActiveTab(next);
    onActiveTabChange?.(next);
  };

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_xtrade_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      setPos(clampPos(parsed, panelWidth));
    } catch {
    }
  }, [panelWidth]);

  useEffect(() => {
    setPos((prev) => clampPos(prev, panelWidth));
  }, [panelWidth]);

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
        const key = 'dagobang_xtrade_panel_pos';
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

  if (!visible) return null;

  return (
    <div
      className="fixed z-[2147483647] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/25 font-sans"
      style={{ left: pos.x, top: pos.y, width: `${panelWidth}px` }}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-800/60 cursor-grab"
        onPointerDown={(e) => {
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: posRef.current.x,
            baseY: posRef.current.y,
          };
        }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={
              activeTab === 'xmonitor'
                ? 'rounded-full border border-emerald-500/50 bg-emerald-500/20 px-3 py-1 text-[12px] text-emerald-200'
                : 'rounded-full border border-zinc-700 px-3 py-1 text-[12px] text-zinc-300 hover:border-zinc-500'
            }
            onClick={() => applyTab('xmonitor')}
          >
            推特监控
          </button>
          <button
            type="button"
            className={
              activeTab === 'xsniper'
                ? 'rounded-full border border-emerald-500/50 bg-emerald-500/20 px-3 py-1 text-[12px] text-emerald-200'
                : 'rounded-full border border-zinc-700 px-3 py-1 text-[12px] text-zinc-300 hover:border-zinc-500'
            }
            onClick={() => applyTab('xsniper')}
          >
            推特狙击
          </button>
          <button
            type="button"
            className={
              activeTab === 'xhistory'
                ? 'rounded-full border border-emerald-500/50 bg-emerald-500/20 px-3 py-1 text-[12px] text-emerald-200'
                : 'rounded-full border border-zinc-700 px-3 py-1 text-[12px] text-zinc-300 hover:border-zinc-500'
            }
            onClick={() => applyTab('xhistory')}
          >
            订单/仓位
          </button>
        </div>
        <button className="text-zinc-400 hover:text-zinc-200" onClick={() => onVisibleChange(false)}>
          <X size={16} />
        </button>
      </div>

      <XMonitorContent siteInfo={siteInfo} active={activeTab === 'xmonitor'} settings={settings} />
      <XSniperContent
        siteInfo={siteInfo}
        active={activeTab === 'xsniper' || activeTab === 'xhistory'}
        view={activeTab === 'xhistory' ? 'history' : 'config'}
        settings={settings}
        isUnlocked={isUnlocked}
      />
    </div>
  );
}
