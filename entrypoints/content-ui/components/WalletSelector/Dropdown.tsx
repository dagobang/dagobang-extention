import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Coins, Copy } from 'lucide-react';
import { formatUnits } from 'viem';
import type { Account } from '@/types/extention';

type WalletSelectorDropdownProps = {
  open: boolean;
  selectedTradeWallets: `0x${string}`[];
  walletAccounts: Account[];
  activeWalletAddress: `0x${string}` | null;
  onToggleTradeWallet: (address: `0x${string}`) => void;
  walletNativeBalancesWei: Record<string, string>;
  walletTokenBalancesWei: Record<string, string>;
  tokenDecimals: number | null;
  className?: string;
  onRequestClose: () => void;
};

const formatWeiToText = (wei: string | undefined, decimals: number, maxFraction = 4) => {
  try {
    const raw = formatUnits(BigInt(wei || '0'), decimals);
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return '0';
    if (num >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return num.toLocaleString(undefined, { maximumFractionDigits: maxFraction });
  } catch {
    return '0';
  }
};

const getBnbBalanceToneClass = (wei: string | undefined) => {
  const value = BigInt(wei || '0');
  const oneBnb = 10n ** 18n;
  const oneTenthBnb = oneBnb / 10n;
  if (value >= oneBnb) return 'text-emerald-300';
  if (value >= oneTenthBnb) return 'text-cyan-300';
  if (value > 0n) return 'text-amber-300';
  return 'text-zinc-500';
};

export function WalletSelectorDropdown({
  open,
  selectedTradeWallets,
  walletAccounts,
  activeWalletAddress,
  onToggleTradeWallet,
  walletNativeBalancesWei,
  walletTokenBalancesWei,
  tokenDecimals,
  className,
  onRequestClose,
}: WalletSelectorDropdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (!rootRef.current) return;
      const target = ev.target as Node | null;
      if (target && !rootRef.current.contains(target)) {
        onRequestClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open, onRequestClose]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className={className || 'absolute left-2 right-2 top-1 z-30 rounded-lg border border-zinc-700 bg-[#141416] p-2 shadow-xl'}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => e.stopPropagation()}
    >
      <div className="mb-2 text-[11px] text-zinc-400">
        已选钱包 {selectedTradeWallets.length}/{walletAccounts.length}
      </div>
      <div className="dagobang-scrollbar max-h-56 overflow-auto space-y-1 pr-1">
        {walletAccounts.map((acc) => {
          const checked = selectedTradeWallets.some((addr) => addr.toLowerCase() === acc.address.toLowerCase());
          const isActive = !!activeWalletAddress && activeWalletAddress.toLowerCase() === acc.address.toLowerCase();
          const addrLower = acc.address.toLowerCase();
          const nativeWei = walletNativeBalancesWei[addrLower];
          const nativeBal = formatWeiToText(walletNativeBalancesWei[addrLower], 18, 4);
          const tokenBal = formatWeiToText(walletTokenBalancesWei[addrLower], tokenDecimals ?? 18, 4);
          const bnbToneClass = getBnbBalanceToneClass(nativeWei);
          return (
            <div
              key={acc.address}
              className={checked ? 'rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1.5' : 'rounded-md border border-zinc-700 px-2 py-1.5'}
            >
              <label className="flex cursor-pointer items-center gap-2 text-[12px] text-zinc-200">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-900"
                  checked={checked}
                  onChange={() => onToggleTradeWallet(acc.address)}
                />
                <span className="min-w-0 flex-1">
                  <span className="truncate font-medium">
                    {acc.name || 'Wallet'} {isActive ? '(当前)' : ''}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-zinc-400">
                    {acc.address.slice(0, 6)}...{acc.address.slice(-4)}
                    <Copy size={10} />
                  </span>
                </span>
                <span className="text-right leading-tight">
                  <span className="flex items-center justify-end gap-1 text-zinc-100">
                    <Coins size={11} />
                    {tokenBal}
                  </span>
                  <span className={`text-[11px] ${bnbToneClass}`}>{nativeBal} BNB</span>
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
