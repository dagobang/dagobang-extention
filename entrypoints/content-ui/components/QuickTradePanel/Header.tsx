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
} from 'lucide-react';
import type { PointerEvent } from 'react';
import { Logo } from '@/components/Logo';
import type { SiteInfo } from '@/utils/sites';
import { WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';

type HeaderProps = {
  siteInfo: SiteInfo;
  onDragStart: (e: PointerEvent) => void;
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
  keyboardShortcutsEnabled,
  onToggleKeyboardShortcuts,
  walletSelectorVisible,
  walletSelectorOpen,
  walletSelectedCount,
  walletTotalCount,
  onToggleWalletSelector,
}: HeaderProps) {
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
            dailyAnalysisActive
              ? 'flex items-center justify-center rounded-full bg-purple-500/20 text-purple-300 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-purple-300 p-1 hover:border-purple-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleDailyAnalysis();
          }}
          title='Daily Analysis'
        >
          <LineChart size={14} />
        </button>

        <button
          type="button"
          className={
            reviewActive
              ? 'flex items-center justify-center rounded-full bg-cyan-500/20 text-cyan-300 p-1'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-cyan-300 p-1 hover:border-cyan-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleReview();
          }}
          title='Review'
        >
          <NotebookPen size={14} />
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
              className="cursor-pointer hover:text-zinc-200 ml-2"
              onClick={(e) => {
                e.stopPropagation();
                onEditToggle();
              }}
            />
          ))}
      </div>

      <div className="flex items-center gap-2">
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
