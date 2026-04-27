import { Wallet, ChevronDown } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type WalletSelectorTriggerProps = {
  walletSelectorOpen: boolean;
  walletSelectedCount: number;
  walletTotalCount: number;
  onToggleWalletSelector: () => void;
  title?: string;
};

export function WalletSelectorTrigger({
  walletSelectorOpen,
  walletSelectedCount,
  walletTotalCount,
  onToggleWalletSelector,
  title = 'Trade wallets',
}: WalletSelectorTriggerProps) {
  return (
    <button
      type="button"
      className={
        walletSelectorOpen
          ? 'inline-flex items-center gap-1 rounded-md bg-emerald-500/20 px-2 py-1 text-emerald-300'
          : 'inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-zinc-200 hover:border-emerald-400'
      }
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
        e.stopPropagation();
      }}
      onClick={(e: ReactPointerEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onToggleWalletSelector();
      }}
      title={title}
    >
      <Wallet size={13} />
      <span className="text-[12px] font-medium">{walletSelectedCount}/{walletTotalCount}</span>
      <ChevronDown size={12} className={walletSelectorOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
    </button>
  );
}
