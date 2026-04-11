import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlarmClockCheck, Crosshair, GripHorizontal, LineChart, NotebookPen, SatelliteDish } from 'lucide-react';
import type { Settings } from '@/types/extention';
import type { SiteInfo } from '@/utils/sites';
import { Logo } from '@/components/Logo';

export type FloatingToolbarProps = {
  siteInfo: SiteInfo;
  settings: Settings | null;
  onToggleXTrade: () => void;
  xTradeActive: boolean;
  onToggleLimitTrade: () => void;
  autotradeActive: boolean;
  onToggleRpc: () => void;
  rpcActive: boolean;
  onToggleDailyAnalysis: () => void;
  dailyAnalysisActive: boolean;
  onToggleReview: () => void;
  reviewActive: boolean;
};

function clampToolbarPos(pos: { x: number; y: number }, toolbarWidth: number) {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, pos.x), Math.max(0, width - toolbarWidth));
  const clampedY = Math.min(Math.max(0, pos.y), Math.max(0, height - 60));
  return { x: clampedX, y: clampedY };
}

export function FloatingToolbar({
  siteInfo,
  settings,
  onToggleXTrade,
  xTradeActive,
  onToggleLimitTrade,
  autotradeActive,
  onToggleRpc,
  rpcActive,
  onToggleDailyAnalysis,
  dailyAnalysisActive,
  onToggleReview,
  reviewActive,
}: FloatingToolbarProps) {
  const showToolbar = settings?.ui?.showToolbar ?? true;
  const toolbarWidth = 326;
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - toolbarWidth);
    const defaultY = 120;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_toolbar_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      setPos(clampToolbarPos(parsed, toolbarWidth));
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
        const key = 'dagobang_toolbar_pos';
        window.localStorage.setItem(key, JSON.stringify(clampToolbarPos(posRef.current, toolbarWidth)));
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

  if (!siteInfo.showBar) return null;
  if (!showToolbar) return null;

  const ToolBtn = (props: { active?: boolean; title: string; onClick: () => void; children: ReactNode }) => (
    <button
      type="button"
      className={
        props.active
          ? 'flex items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300 p-1'
          : 'flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 p-1 hover:border-zinc-500'
      }
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      title={props.title}
    >
      {props.children}
    </button>
  );

  return (
    <div
      className="fixed z-[2147483647] select-none rounded-full border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/30 font-sans flex items-center gap-2 px-3 py-2"
      style={{ left: pos.x, top: pos.y, width: `${toolbarWidth}px` }}
      onPointerDown={(e) => {
        dragging.current = {
          startX: e.clientX,
          startY: e.clientY,
          baseX: posRef.current.x,
          baseY: posRef.current.y,
        };
      }}
    >
      <div className="flex items-center">
        <Logo size={{ width: '20px', height: '20px' }} />
      </div>

      <div className="flex-1" />

      <ToolBtn active={autotradeActive} title="Limit Order" onClick={onToggleLimitTrade}>
        <AlarmClockCheck size={14} />
      </ToolBtn>

      <ToolBtn active={xTradeActive} title="Twitter Sinper" onClick={onToggleXTrade}>
        <Crosshair size={14} />
      </ToolBtn>

      <ToolBtn active={rpcActive} title="RPC" onClick={onToggleRpc}>
        <SatelliteDish size={14} />
      </ToolBtn>

      <ToolBtn active={dailyAnalysisActive} title="Daily Analysis" onClick={onToggleDailyAnalysis}>
        <LineChart size={14} />
      </ToolBtn>

      <ToolBtn active={reviewActive} title="Review" onClick={onToggleReview}>
        <NotebookPen size={14} />
      </ToolBtn>
    </div>
  );
}
