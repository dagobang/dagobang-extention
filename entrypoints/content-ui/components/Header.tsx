import {
  Pencil, X,
  GripHorizontal,
  Check
} from 'lucide-react';
import type { PointerEvent } from 'react';
import { Logo } from '@/components/Logo';

type HeaderProps = {
  onDragStart: (e: PointerEvent) => void;
  onMinimize: () => void;
  isEditing: boolean;
  onEditToggle: () => void;
};

export function Header({ onDragStart, onMinimize, isEditing, onEditToggle }: HeaderProps) {
  return (
    <div
      className="flex-shrink-0 flex cursor-grab items-center justify-between px-3 py-2 border-b border-zinc-800/50"
      onPointerDown={onDragStart}
    >
      <div className="flex items-center gap-3 text-zinc-400">
        <div className="flex items-center">
          <Logo size={{ width: '24px', height: '24px' }} />
        </div>
        
        {isEditing ? (
          <Check
            size={14}
            className="cursor-pointer text-emerald-500 hover:text-emerald-400"
            onClick={onEditToggle}
          />
        ) : (
          <Pencil
            size={14}
            className="cursor-pointer hover:text-zinc-200"
            onClick={onEditToggle}
          />
        )}
      </div>

      {/* Drag Handle */}
      <div className="absolute left-1/2 -translate-x-1/2 text-zinc-600">
        <GripHorizontal size={16} />
      </div>

      <div className="flex items-center gap-2">
        {/* <div className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[12px] text-zinc-300">
          <Wallet size={10} />
          <span>1</span>
        </div>
        <SettingsIcon size={14} className="text-zinc-400 hover:text-zinc-200 cursor-pointer" /> */}
        <X size={16} className="text-zinc-400 hover:text-red-400 cursor-pointer" onClick={onMinimize} />
      </div>
    </div>
  );
}
