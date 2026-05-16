import { useEffect, useRef, useState } from 'react';
import { AtSign, Coins, Crosshair, HardHat, Rocket, X } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { XSniperContent } from './XSinper';
import { XMonitorContent } from './XMonitor';
import { XTokenSniperContent } from './XTokenSniper';
import { XNewCoinSniperContent } from './XNewCoinSniper';
import { NewPoolMonitorContent } from './NewPoolMonitor';

type XTradePanelProps = {
  siteInfo: SiteInfo | null;
  visible: boolean;
  activeTab?: 'xmonitor' | 'xsniper' | 'xtokensniper' | 'xnewcoinsniper' | 'xnewpoolmonitor' | 'xhistory';
  onActiveTabChange?: (tab: 'xmonitor' | 'xsniper' | 'xtokensniper' | 'xnewcoinsniper' | 'xnewpoolmonitor' | 'xhistory') => void;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  isUnlocked: boolean;
  newPoolMonitorDisplayMode: 'floating' | 'tab';
  onNewPoolMonitorDisplayModeChange: (mode: 'floating' | 'tab') => void;
};

type XTradeMainTab = 'xmonitor' | 'xsniper' | 'xtokensniper' | 'xnewcoinsniper' | 'xnewpoolmonitor';

const PANEL_MIN_HEIGHT = 420;
const PANEL_DEFAULT_HEIGHT = 640;

const clampHeight = (value: number, panelTop: number) => {
  const viewportHeight = window.innerHeight || 0;
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, viewportHeight - Math.max(0, panelTop) - 12);
  return Math.min(Math.max(PANEL_MIN_HEIGHT, value), maxHeight);
};

const clampPos = (value: { x: number; y: number }, panelWidth: number, panelHeight: number) => {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, value.x), Math.max(0, width - panelWidth));
  const clampedY = Math.min(Math.max(0, value.y), Math.max(0, height - panelHeight));
  return { x: clampedX, y: clampedY };
};

const normalizeMainTab = (tab?: 'xmonitor' | 'xsniper' | 'xtokensniper' | 'xnewcoinsniper' | 'xnewpoolmonitor' | 'xhistory'): XTradeMainTab => {
  if (tab === 'xnewpoolmonitor') return 'xnewpoolmonitor';
  if (tab === 'xnewcoinsniper') return 'xnewcoinsniper';
  if (tab === 'xtokensniper') return 'xtokensniper';
  if (tab === 'xmonitor') return 'xmonitor';
  return 'xsniper';
};

const resolvePanelWidth = (tab: XTradeMainTab, viewportWidth: number) => {
  const base = tab === 'xsniper' || tab === 'xtokensniper' || tab === 'xnewcoinsniper' ? 560 : 380;
  const maxAllowed = Math.max(320, viewportWidth - 24);
  return Math.min(base, maxAllowed);
};

const TAB_ITEMS: Array<{
  key: XTradeMainTab;
  title: string;
  icon: typeof AtSign;
}> = [
  { key: 'xmonitor', title: '推特监控', icon: AtSign },
  { key: 'xsniper', title: '推特狙击', icon: Crosshair },
  { key: 'xnewpoolmonitor', title: '新池监控', icon: HardHat },
  { key: 'xtokensniper', title: '代币狙击', icon: Coins },
  { key: 'xnewcoinsniper', title: '新币狙击', icon: Rocket },
];

export function XTradePanel({
  siteInfo,
  visible,
  activeTab: activeTabProp,
  onActiveTabChange,
  onVisibleChange,
  settings,
  isUnlocked,
  newPoolMonitorDisplayMode,
  onNewPoolMonitorDisplayModeChange,
}: XTradePanelProps) {
  const [activeTab, setActiveTab] = useState<XTradeMainTab>(() => normalizeMainTab(activeTabProp));
  const [showSniperConfigModal, setShowSniperConfigModal] = useState(false);
  const [newCoinModalMode, setNewCoinModalMode] = useState<'config' | 'task' | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth || 0);
  const panelWidth = resolvePanelWidth(activeTab, viewportWidth || 0);
  const [panelHeight, setPanelHeight] = useState(() => clampHeight(PANEL_DEFAULT_HEIGHT, 120));
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - panelWidth);
    const defaultY = 120;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const panelHeightRef = useRef(panelHeight);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const resizing = useRef<null | { startY: number; baseHeight: number }>(null);
  const applyTab = (next: XTradeMainTab) => {
    setActiveTab(next);
    onActiveTabChange?.(next);
  };

  useEffect(() => {
    if (!activeTabProp) return;
    setActiveTab(normalizeMainTab(activeTabProp));
  }, [activeTabProp]);

  useEffect(() => {
    if (visible) return;
    setShowSniperConfigModal(false);
    setNewCoinModalMode(null);
  }, [visible]);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    panelHeightRef.current = panelHeight;
  }, [panelHeight]);

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth || 0);
      const nextHeight = clampHeight(panelHeightRef.current, posRef.current.y);
      setPanelHeight(nextHeight);
      setPos((prev) => clampPos(prev, panelWidth, nextHeight));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [panelWidth]);

  useEffect(() => {
    try {
      const rawHeight = window.localStorage.getItem('dagobang_xtrade_panel_height');
      const storedHeight = rawHeight ? Number(rawHeight) : NaN;
      const key = 'dagobang_xtrade_panel_pos';
      const stored = window.localStorage.getItem(key);
      const parsed = stored ? JSON.parse(stored) : null;
      const nextPos = parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number'
        ? { x: parsed.x, y: parsed.y }
        : posRef.current;
      const nextHeight = Number.isFinite(storedHeight)
        ? clampHeight(storedHeight, nextPos.y)
        : clampHeight(panelHeightRef.current, nextPos.y);
      setPanelHeight(nextHeight);
      setPos(clampPos(nextPos, panelWidth, nextHeight));
    } catch {
    }
  }, [panelWidth]);

  useEffect(() => {
    setPos((prev) => clampPos(prev, panelWidth, panelHeightRef.current));
  }, [panelWidth]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current) {
        const dx = e.clientX - dragging.current.startX;
        const dy = e.clientY - dragging.current.startY;
        const nextX = dragging.current.baseX + dx;
        const nextY = dragging.current.baseY + dy;
        setPos(clampPos({ x: nextX, y: nextY }, panelWidth, panelHeightRef.current));
        return;
      }
      if (resizing.current) {
        const dy = e.clientY - resizing.current.startY;
        setPanelHeight(clampHeight(resizing.current.baseHeight + dy, posRef.current.y));
      }
    };
    const onUp = () => {
      const didDrag = !!dragging.current;
      const didResize = !!resizing.current;
      dragging.current = null;
      resizing.current = null;
      if (!didDrag && !didResize) return;
      try {
        const key = 'dagobang_xtrade_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(posRef.current));
        window.localStorage.setItem('dagobang_xtrade_panel_height', String(panelHeightRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panelWidth]);

  if (!visible) return null;

  const contentMaxHeight = Math.max(260, panelHeight - 68 - 14);

  return (
    <div
      className="fixed z-[2147483647] flex select-none overflow-hidden rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/25 font-sans"
      style={{
        left: pos.x,
        top: pos.y,
        width: `${panelWidth}px`,
        height: `${panelHeight}px`,
        flexDirection: 'column',
        ['--dagobang-xtrade-content-max-h' as any]: `${contentMaxHeight}px`,
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800/60 cursor-grab"
        onPointerDown={(e) => {
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: posRef.current.x,
            baseY: posRef.current.y,
          };
        }}
      >
        <div className="dagobang-scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {TAB_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={
                  active
                    ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/14 text-emerald-300 shadow-[inset_0_-2px_0_0_rgba(16,185,129,0.45)]'
                    : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/30 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                }
                onClick={() => applyTab(item.key)}
                title={item.title}
                aria-label={item.title}
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>
        {activeTab === 'xnewpoolmonitor' ? (
          <button
            type="button"
            className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-950/30 px-2 py-1 text-[10px] text-zinc-300 hover:border-zinc-600"
            onClick={() => onNewPoolMonitorDisplayModeChange(newPoolMonitorDisplayMode === 'tab' ? 'floating' : 'tab')}
            title={newPoolMonitorDisplayMode === 'tab' ? '切换为独立浮窗' : '切换为 Tab'}
          >
            {newPoolMonitorDisplayMode === 'tab' ? '独立' : 'Tab'}
          </button>
        ) : null}
        <button className="shrink-0 text-zinc-400 hover:text-zinc-200" onClick={() => onVisibleChange(false)}>
          <X size={16} />
        </button>
      </div>

      <XMonitorContent siteInfo={siteInfo} active={activeTab === 'xmonitor'} settings={settings} />
      <XSniperContent
        siteInfo={siteInfo}
        active={activeTab === 'xsniper'}
        view="history"
        showWsStatusInHistory
        onOpenConfig={() => setShowSniperConfigModal(true)}
        settings={settings}
        isUnlocked={isUnlocked}
      />
      <XTokenSniperContent
        siteInfo={siteInfo}
        active={activeTab === 'xtokensniper'}
        settings={settings}
        isUnlocked={isUnlocked}
      />
      <XNewCoinSniperContent
        siteInfo={siteInfo}
        active={activeTab === 'xnewcoinsniper'}
        view="history"
        onOpenConfig={() => setNewCoinModalMode('config')}
        onOpenTaskManager={() => setNewCoinModalMode('task')}
        settings={settings}
        isUnlocked={isUnlocked}
      />
      <NewPoolMonitorContent
        siteInfo={siteInfo}
        active={activeTab === 'xnewpoolmonitor'}
        settings={settings}
      />
      <div
        className="flex shrink-0 cursor-ns-resize justify-center border-t border-zinc-800/60 px-4 py-1.5"
        onPointerDown={(e) => {
          e.stopPropagation();
          resizing.current = {
            startY: e.clientY,
            baseHeight: panelHeightRef.current,
          };
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          const nextHeight = clampHeight(PANEL_DEFAULT_HEIGHT, posRef.current.y);
          setPanelHeight(nextHeight);
          try {
            window.localStorage.setItem('dagobang_xtrade_panel_height', String(nextHeight));
          } catch {
          }
        }}
        title="拖动调整高度，双击恢复默认高度"
      >
        <div className="h-1 w-14 rounded-full bg-zinc-700/80" />
      </div>
      {showSniperConfigModal ? (
        <div className="fixed inset-0 z-[2147483648] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/30">
            <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-3">
              <div className="text-[13px] font-semibold text-emerald-300">推特狙击设置</div>
              <button
                type="button"
                className="text-zinc-400 hover:text-zinc-200"
                onClick={() => setShowSniperConfigModal(false)}
              >
                <X size={16} />
              </button>
            </div>
            <XSniperContent
              siteInfo={siteInfo}
              active={showSniperConfigModal}
              view="config"
              settings={settings}
              isUnlocked={isUnlocked}
            />
          </div>
        </div>
      ) : null}
      {newCoinModalMode ? (
        <div className="fixed inset-0 z-[2147483648] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/30">
            <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-3">
              <div className="text-[13px] font-semibold text-emerald-300">
                {newCoinModalMode === 'task' ? '任务管理' : '新币狙击设置'}
              </div>
              <button
                type="button"
                className="text-zinc-400 hover:text-zinc-200"
                onClick={() => setNewCoinModalMode(null)}
              >
                <X size={16} />
              </button>
            </div>
            <XNewCoinSniperContent
              siteInfo={siteInfo}
              active={Boolean(newCoinModalMode)}
              view="config"
              configMode={newCoinModalMode === 'task' ? 'task' : 'full'}
              settings={settings}
              isUnlocked={isUnlocked}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
