import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Account, AutoTradeInteractionType, AutoTradeTwitterSnipePreset } from '@/types/extention';
import { WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';

const interactionOptions: Array<{ value: AutoTradeInteractionType; labelKey: string }> = [
  { value: 'tweet', labelKey: 'contentUi.autoTradeStrategy.interaction.tweet' },
  { value: 'reply', labelKey: 'contentUi.autoTradeStrategy.interaction.reply' },
  { value: 'quote', labelKey: 'contentUi.autoTradeStrategy.interaction.quote' },
  { value: 'retweet', labelKey: 'contentUi.autoTradeStrategy.interaction.retweet' },
  { value: 'follow', labelKey: 'contentUi.autoTradeStrategy.interaction.follow' },
];

type XSniperBasicSectionProps = {
  open: boolean;
  canEdit: boolean;
  twitterSnipe: any;
  targetUsersInput: string;
  presetJsonInput: string;
  activeSnipePresetId: string;
  snipePresets: AutoTradeTwitterSnipePreset[];
  activeSnipePreset: AutoTradeTwitterSnipePreset | null;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  onAddPresetFromCurrent: () => void;
  onRemoveActivePreset: () => void;
  onApplyActivePreset: (id: string) => void;
  onActivePresetNameChange: (name: string) => void;
  onPresetJsonInputChange: (value: string) => void;
  onImportPresetFromJson: () => void;
  onExportActivePresetAsJson: () => void;
  onTargetUsersInputChange: (value: string) => void;
  onInteractionTypeChange: (interactionType: AutoTradeInteractionType, checked: boolean) => void;
  onBuyAmountNativeChange: (value: string) => void;
  onBuyNewCaCountChange: (value: string) => void;
  walletSelectorOpen: boolean;
  walletAccounts: Account[];
  activeWalletAddress: `0x${string}` | null;
  selectedWalletAddress?: `0x${string}`;
  onToggleWalletSelector: () => void;
  onSelectWalletAddress: (address?: `0x${string}`) => void;
};

export function XSniperBasicSection({
  open,
  canEdit,
  twitterSnipe,
  targetUsersInput,
  presetJsonInput,
  activeSnipePresetId,
  snipePresets,
  activeSnipePreset,
  tt,
  onToggle,
  onAddPresetFromCurrent,
  onRemoveActivePreset,
  onApplyActivePreset,
  onActivePresetNameChange,
  onPresetJsonInputChange,
  onImportPresetFromJson,
  onExportActivePresetAsJson,
  onTargetUsersInputChange,
  onInteractionTypeChange,
  onBuyAmountNativeChange,
  onBuyNewCaCountChange,
  walletSelectorOpen,
  walletAccounts,
  activeWalletAddress,
  selectedWalletAddress,
  onToggleWalletSelector,
  onSelectWalletAddress,
}: XSniperBasicSectionProps) {
  const selectedWallet = walletAccounts.find((acc) => acc.address.toLowerCase() === String(selectedWalletAddress || '').toLowerCase()) ?? null;
  return (
    <div className="space-y-2 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>基础策略与方案</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
      <div className="space-y-2">
    <div className="space-y-2 pb-3 border-b border-zinc-800/60">
      <div>
        <div className="text-xs text-zinc-500">{tt('contentUi.autoTradeStrategy.twitterSnipeDesc')}</div>
      </div>
      <div className="space-y-2 rounded-md border border-zinc-800/70 bg-zinc-900/30 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] text-zinc-400">参数方案</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
              disabled={!canEdit}
              onClick={onAddPresetFromCurrent}
            >
              新建
            </button>
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-rose-200 hover:border-rose-400 disabled:opacity-50"
              disabled={!canEdit || !activeSnipePreset || snipePresets.length <= 1}
              onClick={onRemoveActivePreset}
            >
              删除
            </button>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <select
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
            value={activeSnipePresetId}
            disabled={!canEdit}
            onChange={(e) => onApplyActivePreset(e.target.value)}
          >
            {snipePresets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
            placeholder="方案名称"
            value={activeSnipePreset?.name ?? ''}
            disabled={!canEdit || !activeSnipePreset}
            onChange={(e) => onActivePresetNameChange(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <div className="text-[11px] text-zinc-500">导入/导出JSON</div>
          <textarea
            className="h-16 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] outline-none"
            value={presetJsonInput}
            disabled={!canEdit}
            placeholder='{"name":"趋势盘","strategy":{...}}'
            onChange={(e) => onPresetJsonInputChange(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
              disabled={!canEdit}
              onClick={onImportPresetFromJson}
            >
              导入JSON
            </button>
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
              disabled={!canEdit || !activeSnipePreset}
              onClick={onExportActivePresetAsJson}
            >
              导出JSON
            </button>
          </div>
        </div>
        <div className="text-[11px] text-zinc-500">仅运行当前选中的方案，其他方案只保存不执行</div>
      </div>
      <div className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-900/30 p-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] text-zinc-400">交易钱包</div>
          <WalletSelectorTrigger
            walletSelectorOpen={walletSelectorOpen}
            walletSelectedCount={selectedWalletAddress ? 1 : 0}
            walletTotalCount={walletAccounts.length}
            onToggleWalletSelector={onToggleWalletSelector}
            title="选择狙击交易钱包"
          />
        </div>
        <div className="text-[11px] text-zinc-500">
          {selectedWallet
            ? `已指定：${selectedWallet.name || 'Wallet'} (${selectedWallet.address.slice(0, 6)}...${selectedWallet.address.slice(-4)})`
            : `未指定，使用当前钱包${activeWalletAddress ? ` (${activeWalletAddress.slice(0, 6)}...${activeWalletAddress.slice(-4)})` : ''}`}
        </div>
        {walletSelectorOpen ? (
          <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-1">
            <button
              type="button"
              className={`w-full rounded px-2 py-1 text-left text-[12px] ${!selectedWalletAddress ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-200 hover:bg-zinc-800'}`}
              onClick={() => onSelectWalletAddress(undefined)}
              disabled={!canEdit}
            >
              使用当前钱包
            </button>
            {walletAccounts.map((acc) => {
              const selected = String(selectedWalletAddress || '').toLowerCase() === acc.address.toLowerCase();
              const isActive = !!activeWalletAddress && activeWalletAddress.toLowerCase() === acc.address.toLowerCase();
              return (
                <button
                  key={acc.address}
                  type="button"
                  className={`w-full rounded px-2 py-1 text-left text-[12px] ${selected ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-200 hover:bg-zinc-800'}`}
                  onClick={() => onSelectWalletAddress(acc.address)}
                  disabled={!canEdit}
                >
                  {acc.name || 'Wallet'} {isActive ? '(当前)' : ''} ({acc.address.slice(0, 6)}...{acc.address.slice(-4)})
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <label className="block space-y-1">
        <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.targetUsers')}</div>
        <textarea
          className="h-20 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
          value={targetUsersInput}
          disabled={!canEdit}
          aria-multiline={true}
          onChange={(e) => onTargetUsersInputChange(e.target.value)}
        />
      </label>
      <div className="space-y-1">
        <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.interactionTypes')}</div>
        <div className="flex flex-wrap gap-2">
          {interactionOptions.map((option) => {
            const checked = !!twitterSnipe?.interactionTypes.includes(option.value);
            return (
              <label key={option.value} className="flex items-center gap-1 text-[12px] text-zinc-300">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-amber-500"
                  checked={checked}
                  disabled={!canEdit}
                  onChange={(e) => onInteractionTypeChange(option.value, e.target.checked)}
                />
                {tt(option.labelKey)}
              </label>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.strategyBuyAmount')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={twitterSnipe?.buyAmountNative ?? ''}
            disabled={!canEdit}
            onChange={(e) => onBuyAmountNativeChange(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">买入CA数量</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={twitterSnipe?.buyNewCaCount ?? ''}
            disabled={!canEdit}
            onChange={(e) => onBuyNewCaCountChange(e.target.value)}
          />
        </label>
      </div>
      </div>
      </div>
      ) : null}
    </div>
  );
}
