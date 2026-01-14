import {
  Pencil,
  X,
  GripHorizontal,
  Check,
  Zap,
  Flame,
} from 'lucide-react';
import type { PointerEvent } from 'react';
import { Logo } from '@/components/Logo';

type HeaderProps = {
  onDragStart: (e: PointerEvent) => void;
  onMinimize: () => void;
  isEditing: boolean;
  onEditToggle: () => void;
  onToggleCooking: () => void;
  cookingActive: boolean;
  onToggleAutotrade: () => void;
  autotradeActive: boolean;
  onToggleRpc: () => void;
  rpcActive: boolean;
};

export function Header({
  onDragStart,
  onMinimize,
  isEditing,
  onEditToggle,
  onToggleCooking,
  cookingActive,
  onToggleAutotrade,
  autotradeActive,
  onToggleRpc,
  rpcActive,
}: HeaderProps) {
  return (
    <div
      className="flex-shrink-0 flex cursor-grab items-center justify-between px-3 py-2 border-b border-zinc-800/50"
      onPointerDown={onDragStart}
    >
      <div className="flex items-center gap-2 text-zinc-400">
        <div className="flex items-center">
          <Logo size={{ width: '24px', height: '24px' }} />
        </div>

        {/* <button
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
            onToggleAutotrade();
          }}
        >
          <Zap size={14} />
        </button> */}

        {/* <button
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
        >
          <Flame size={14} />
        </button> */}

        <button
          type="button"
          className={
            rpcActive
              ? 'flex items-center justify-center rounded-full bg-sky-500/20 text-sky-300 px-2 py-1 text-[11px] font-semibold'
              : 'flex items-center justify-center rounded-full border border-zinc-700 text-sky-300 px-2 py-1 text-[11px] hover:border-sky-400'
          }
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleRpc();
          }}
        >
          RPC
        </button>

        {isEditing ? (
          <Check
            size={14}
            className="cursor-pointer text-emerald-500 hover:text-emerald-400"
            onClick={(e) => {
              e.stopPropagation();
              onEditToggle();
            }}
          />
        ) : (
          <Pencil
            size={14}
            className="cursor-pointer hover:text-zinc-200"
            onClick={(e) => {
              e.stopPropagation();
              onEditToggle();
            }}
          />
        )}
      </div>

      {/* Drag Handle */}
      <div className="-translate-x-1/2 text-zinc-600">
        <GripHorizontal size={16} />
      </div>

      <div className="flex items-center gap-2">
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
