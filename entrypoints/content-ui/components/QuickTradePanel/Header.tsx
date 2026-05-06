import {
  Pencil,
  X,
  Check,
  LineChart,
  SatelliteDish,
  AlarmClockCheck,
  Keyboard,
  Crosshair,
  NotebookPen,
  Flame,
  MoreHorizontal,
} from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Logo } from '@/components/Logo';
import type { SiteInfo } from '@/utils/sites';
import { WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';

type HeaderProps = {
  siteInfo: SiteInfo;
  onDragStart: (e: ReactPointerEvent) => void;
  onMinimize: () => void;
  isEditing: boolean;
  onEditToggle: () => void;
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
  onToggleCooking: () => void;
  cookingActive: boolean;
  keyboardShortcutsEnabled: boolean;
  onToggleKeyboardShortcuts: () => void;
  walletSelectorVisible: boolean;
  walletSelectorOpen: boolean;
  walletSelectedCount: number;
  walletTotalCount: number;
  onToggleWalletSelector: () => void;
};

export function Header({
  siteInfo,
  onDragStart,
  onMinimize,
  isEditing,
  onEditToggle,
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
  onToggleCooking,
  cookingActive,
  keyboardShortcutsEnabled,
  onToggleKeyboardShortcuts,
  walletSelectorVisible,
  walletSelectorOpen,
  walletSelectedCount,
  walletTotalCount,
  onToggleWalletSelector,
}: HeaderProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (target && moreRef.current && !moreRef.current.contains(target)) {
        setMoreOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [moreOpen]);

  return (
    <div
      className="flex-shrink-0 flex cursor-grab items-center justify-between px-3 py-2 border-b border-zinc-800/50"
      onPointerDown={onDragStart}
    >
      <div className="flex items-center gap-1 text-zinc-400">

        <div className="flex items-center">
          <Logo size={{ width: '24px', height: '24px' }} />
        </div>
        {!siteInfo.showBar && <button
          type="button"
          className={
            keyboardShortcutsEnabled
              ? 'flex items-center justify-center rounded-full bg-amber-500/20 text-amber-300 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-amber-300 p-1 hover:border-amber-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleKeyboardShortcuts();
          }}
          title="Keyboard shortcuts"
        >
          <Keyboard size={14} />
        </button>
        }

        <button
          type="button"
          className={
            autotradeActive
              ? 'flex items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-emerald-300 p-1 hover:border-emerald-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleLimitTrade();
          }}
          title='Limit Order'
        >
          <AlarmClockCheck size={14} />
        </button>

        <button
          type="button"
          className={
            xTradeActive
              ? 'flex items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-emerald-300 p-1 hover:border-emerald-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleXTrade();
          }}
          title="Twitter Sinper"
        >
          <Crosshair size={14} />
        </button>

        <button
          type="button"
          className={
            rpcActive
              ? 'flex items-center justify-center rounded-full bg-sky-500/20 text-sky-300 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-sky-300 p-1 hover:border-sky-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleRpc();
          }}
          title='RPC'
        >
          <SatelliteDish size={14} />
        </button>

        <button
          type="button"
          className={
            cookingActive
              ? 'flex items-center justify-center rounded-full bg-amber-500/20 text-amber-300 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-amber-300 p-1 hover:border-amber-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCooking();
          }}
          title="Cooking"
        >
          <Flame size={14} />
        </button>

        {!siteInfo.showBar && (
          isEditing ? (
            <Check
              size={14}
              className="cursor-pointer text-emerald-500 hover:text-emerald-400 ml-2"
              onClick={(e) => {
                e.stopPropagation();
                onEditToggle();
              }}
            />
          ) : (
            <Pencil
              size={14}
              className="cursor-pointer hover:text-zinc-200 ml-1"
              onClick={(e) => {
                e.stopPropagation();
                onEditToggle();
              }}
            />
          ))}
      </div>

      <div className="flex items-center gap-2">
        <div ref={moreRef} className="relative">
          <button
            type="button"
            className={
              moreOpen || dailyAnalysisActive || reviewActive
                ? 'flex items-center justify-center rounded-full bg-emerald-500/20 text-emerald-300 p-1'
                : 'flex items-center justify-center rounded-full border border-zinc-700 text-zinc-300 p-1 hover:border-zinc-500'
            }
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              setMoreOpen((v) => !v);
            }}
            title="More"
          >
            <MoreHorizontal size={14} />
          </button>
          {moreOpen && (
            <div
              className="absolute right-0 top-8 z-50 w-36 rounded-lg border border-zinc-700 bg-[#141416] p-1.5 shadow-xl"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] ${dailyAnalysisActive ? 'bg-purple-500/15 text-purple-300' : 'text-zinc-200 hover:bg-zinc-800'}`}
                onClick={() => {
                  onToggleDailyAnalysis();
                  setMoreOpen(false);
                }}
              >
                <LineChart size={13} />
                Daily
              </button>
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] ${reviewActive ? 'bg-cyan-500/15 text-cyan-300' : 'text-zinc-200 hover:bg-zinc-800'}`}
                onClick={() => {
                  onToggleReview();
                  setMoreOpen(false);
                }}
              >
                <NotebookPen size={13} />
                Review
              </button>
            </div>
          )}
        </div>
        {walletSelectorVisible && (
          <WalletSelectorTrigger
            walletSelectorOpen={walletSelectorOpen}
            walletSelectedCount={walletSelectedCount}
            walletTotalCount={walletTotalCount}
            onToggleWalletSelector={onToggleWalletSelector}
          />
        )}
        <X
          size={16}
          className="text-zinc-400 hover:text-red-400 cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onMinimize();
          }}
        />
      </div>
    </div>
  );
}
