import type { Account } from '@/types/extention';
import type { ChainAddress } from '@/types/chain/address';
import { WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';
import { MAX_AUTO_SELL_RULES } from './constants';
import type { AutoSellRule } from './types';

type WalletSellSectionProps = {
  walletAccounts: Account[];
  deployWallet: ChainAddress | null;
  onDeployWalletChange: (address: ChainAddress) => void;
  deployWalletSelectorOpen: boolean;
  onToggleDeployWalletSelector: () => void;
  selectedDeployWallet: Account | null;
  activeWalletAddress: ChainAddress | null;
  defaultBuyBnb: string;
  onDefaultBuyBnbChange: (value: string) => void;
  buyAmountLabel: string;
  buyAmountHint?: string;
  autoSellEnabled: boolean;
  onAutoSellEnabledChange: (enabled: boolean) => void;
  autoSellRules: AutoSellRule[];
  onAddAutoSellRule: () => void;
  onRemoveAutoSellRule: (index: number) => void;
  onUpdateAutoSellRule: (index: number, patch: Partial<AutoSellRule>) => void;
};

export function WalletSellSection({
  walletAccounts,
  deployWallet,
  onDeployWalletChange,
  deployWalletSelectorOpen,
  onToggleDeployWalletSelector,
  selectedDeployWallet,
  activeWalletAddress,
  defaultBuyBnb,
  onDefaultBuyBnbChange,
  buyAmountLabel,
  buyAmountHint,
  autoSellEnabled,
  onAutoSellEnabledChange,
  autoSellRules,
  onAddAutoSellRule,
  onRemoveAutoSellRule,
  onUpdateAutoSellRule,
}: WalletSellSectionProps) {
  return (
    <div className="space-y-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5">
      <div className="text-[12px] font-semibold text-emerald-200">钱包 + 卖出设置</div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] text-zinc-400">发币钱包（单选）</div>
          <WalletSelectorTrigger
            walletSelectorOpen={deployWalletSelectorOpen}
            walletSelectedCount={deployWallet ? 1 : 0}
            walletTotalCount={walletAccounts.length}
            onToggleWalletSelector={onToggleDeployWalletSelector}
            title="选择发币钱包"
          />
        </div>
        <div className="text-[11px] text-zinc-500">
          {selectedDeployWallet
            ? `已指定：${selectedDeployWallet.name || 'Wallet'} (${selectedDeployWallet.address.slice(0, 6)}...${selectedDeployWallet.address.slice(-4)})`
            : `未指定，使用当前钱包${activeWalletAddress ? ` (${activeWalletAddress.slice(0, 6)}...${activeWalletAddress.slice(-4)})` : ''}`}
        </div>
        {deployWalletSelectorOpen ? (
          <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-1 dagobang-scrollbar">
            {walletAccounts.map((acc) => {
              const selected = String(deployWallet || '').toLowerCase() === acc.address.toLowerCase();
              const isActive = !!activeWalletAddress && activeWalletAddress.toLowerCase() === acc.address.toLowerCase();
              return (
                <button
                  key={acc.address}
                  type="button"
                  className={`w-full rounded px-2 py-1 text-left text-[12px] ${selected ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-200 hover:bg-zinc-800'}`}
                  onClick={() => onDeployWalletChange(acc.address)}
                >
                  {acc.name || 'Wallet'} {isActive ? '(当前)' : ''} ({acc.address.slice(0, 6)}...{acc.address.slice(-4)})
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="space-y-1">
        <div className="text-[11px] text-zinc-400">{buyAmountLabel}</div>
        <input
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
          value={defaultBuyBnb}
          onChange={(e) => onDefaultBuyBnbChange(e.target.value)}
          placeholder="按 BNB 预算填写，例如 0.1"
        />
        {buyAmountHint && (
          <div className="text-[10px] text-zinc-500">{buyAmountHint}</div>
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-zinc-300">
        <label className="inline-flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={autoSellEnabled}
            onChange={(e) => onAutoSellEnabledChange(e.target.checked)}
          />
          <span>自动卖出（按市值目标创建挂单）</span>
        </label>
      </div>

      {autoSellEnabled && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-zinc-400">市值目标配置（最多 5 条）</div>
            <button
              type="button"
              className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
              onClick={onAddAutoSellRule}
              disabled={autoSellRules.length >= MAX_AUTO_SELL_RULES}
            >
              + 添加
            </button>
          </div>
          <div className="space-y-1">
            {autoSellRules.map((rule, idx) => (
              <div key={idx} className="grid grid-cols-[44px_minmax(0,1fr)_minmax(0,88px)_24px] gap-2 items-center">
                <div className="text-[11px] text-zinc-500">TP{idx + 1}</div>
                <input
                  className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none"
                  value={rule.marketCapUsd}
                  onChange={(e) => onUpdateAutoSellRule(idx, { marketCapUsd: e.target.value })}
                  placeholder="触发市值 USD"
                />
                <input
                  className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none"
                  value={rule.sellPercent}
                  onChange={(e) => onUpdateAutoSellRule(idx, { sellPercent: e.target.value })}
                  placeholder="卖出%"
                />
                <button
                  type="button"
                  className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                  onClick={() => onRemoveAutoSellRule(idx)}
                  disabled={autoSellRules.length <= 1}
                  title="删除"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
