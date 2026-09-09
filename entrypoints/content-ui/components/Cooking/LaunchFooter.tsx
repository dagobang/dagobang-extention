import type { Account } from '@/types/extention';
import type { CookingLastLaunch } from '@/utils/cookingLaunchWallets';
import { formatLaunchTokenBalance } from './helpers';
import type { CookingLaunchPlatform } from './types';

type LaunchFooterProps = {
  launching: boolean;
  selectedPlatform: CookingLaunchPlatform;
  onSubmit: () => void;
  lastLaunch: CookingLastLaunch | null;
  lastLaunchWallet: Account | null;
  launchBalanceWei: string;
  launchSelling: boolean;
  onSellPercent: (pct: number) => void;
  onClearLastLaunch: () => void;
};

function submitLabel(platform: CookingLaunchPlatform, launching: boolean) {
  if (launching) return '发射处理中...';
  if (platform === 'fourmeme') return '发布到 Four';
  if (platform === 'flap') return '发布到 Flap';
  if (platform === 'flap_stocks') return '发布到 Flap Stocks';
  return '发布到 OpenFour 4Stock';
}

export function LaunchFooter({
  launching,
  selectedPlatform,
  onSubmit,
  lastLaunch,
  lastLaunchWallet,
  launchBalanceWei,
  launchSelling,
  onSellPercent,
  onClearLastLaunch,
}: LaunchFooterProps) {
  return (
    <div className="border-t border-zinc-800 p-3">
      <button
        className="w-full rounded-md bg-emerald-500 text-[13px] font-semibold text-black py-2.5 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        onClick={onSubmit}
        disabled={launching}
      >
        {submitLabel(selectedPlatform, launching)}
      </button>

      {lastLaunch ? (
        <div className="mt-3 space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-rose-200">发币钱包快捷卖出</div>
              <div className="truncate text-[11px] text-zinc-300">
                {lastLaunch.symbol || lastLaunch.name || '新代币'}
                <span className="ml-1 text-zinc-500">
                  {lastLaunch.tokenAddress.slice(0, 6)}...{lastLaunch.tokenAddress.slice(-4)}
                </span>
              </div>
              <div className="text-[10px] text-zinc-500">
                {lastLaunchWallet?.name || '发币钱包'}
                {' '}
                ({lastLaunch.walletAddress.slice(0, 6)}...{lastLaunch.walletAddress.slice(-4)})
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-300"
              onClick={onClearLastLaunch}
            >
              关闭
            </button>
          </div>
          <div className="flex items-center justify-between text-[12px] text-zinc-200">
            <span>余额</span>
            <span>
              {formatLaunchTokenBalance(launchBalanceWei)}
              {' '}
              <span className="text-amber-400">{lastLaunch.symbol || 'TOKEN'}</span>
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {[10, 20, 50, 100].map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={launchSelling || launching || launchBalanceWei === '0'}
                className="rounded border border-rose-500/30 bg-rose-500/10 py-1 text-center text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => onSellPercent(pct)}
              >
                {pct}%
              </button>
            ))}
          </div>
          <div className="text-[10px] text-zinc-500">
            这里永远用发币钱包卖出，不会改快捷交易面板当前选中的钱包。
          </div>
        </div>
      ) : null}
    </div>
  );
}
