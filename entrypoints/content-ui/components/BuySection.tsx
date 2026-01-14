import { Zap, Fuel, Sliders } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { ChainCoinIcon } from '@/components/Coins';
import { t, type Locale } from '@/utils/i18n';

type BuySectionProps = {
  formattedNativeBalance: string;
  busy: boolean;
  isUnlocked: boolean;
  onBuy: (amountStr: string) => void;
  settings: Settings | null;
  onToggleMode: () => void;
  onToggleGas: () => void;
  onToggleSlippage: () => void;
  isEditing: boolean;
  onUpdatePreset: (index: number, val: string) => void;
  draftPresets?: string[];
  locale: Locale;
  gmgnVisible: boolean;
  gmgnEnabled: boolean;
  onToggleGmgn: () => void;
};

export function BuySection({
  formattedNativeBalance,
  busy,
  isUnlocked,
  onBuy,
  settings,
  onToggleMode,
  onToggleGas,
  onToggleSlippage,
  isEditing,
  onUpdatePreset,
  draftPresets,
  locale,
  gmgnVisible,
  gmgnEnabled,
  onToggleGmgn,
}: BuySectionProps) {
  const buyPresets = isEditing && draftPresets ? draftPresets : (settings?.chains[settings.chainId]?.buyPresets || ['0.01', '0.2', '0.5', '1.0']);
  const slippageBps = settings?.chains[settings.chainId]?.slippageBps ?? 4000;
  const slippageLabel =
    slippageBps === 3000
      ? t('contentUi.slippage.low', locale)
      : slippageBps === 4000
        ? t('contentUi.slippage.default', locale)
        : slippageBps === 5000
          ? t('contentUi.slippage.medium', locale)
          : t('contentUi.slippage.high', locale);
  const slippagePct = (slippageBps / 100).toFixed(0);
  const executionMode = settings?.chains[settings.chainId].executionMode === 'turbo' ? 'turbo' : 'default';
  const chainSettings = settings?.chains[settings.chainId];
  const gasPreset = chainSettings?.buyGasPreset ?? chainSettings?.gasPreset ?? 'standard';
  const defaultGasGwei = { slow: '0.06', standard: '0.12', fast: '1', turbo: '5' } as const;
  const gasValue =
    (chainSettings?.buyGasGwei && chainSettings.buyGasGwei[gasPreset]) ||
    defaultGasGwei[gasPreset as keyof typeof defaultGasGwei];

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-200 text-sm">{t('contentUi.section.buy', locale)}</span>
          {gmgnVisible && (
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3 w-3 accent-emerald-500"
                checked={gmgnEnabled}
                onChange={onToggleGmgn}
              />
              <span>{t('contentUi.gmgnOrder', locale)}</span>
            </label>
          )}
        </div>
        <div className="flex items-center gap-1 text-[14px] text-emerald-400">
          <ChainCoinIcon chainId={settings?.chainId} size={{ width: '12px', height: '12px' }} />
          <span>{formattedNativeBalance}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-2">
        {buyPresets.map((amt, idx) => (
          isEditing ? (
            <input
              key={idx}
              className="w-full rounded border border-emerald-500/30 bg-zinc-900 py-1.5 text-center text-xs font-medium text-emerald-400 outline-none focus:border-emerald-500 select-text"
              value={amt}
              onChange={(e) => onUpdatePreset(idx, e.target.value)}
            />
          ) : (
            <button
              key={idx}
              disabled={busy || !isUnlocked}
              onClick={() => onBuy(amt)}
              className="rounded border border-emerald-500/30 bg-emerald-500/10 py-1.5 text-center text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {amt}
            </button>
          )
        ))}
      </div>

      <div className="flex items-center justify-between text-[12px] text-zinc-500">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
            title={t('contentUi.slippage.toggleMode', locale)}
            onClick={onToggleMode}
          >
            <Zap size={10} />
            <span>{t(`contentUi.mode.${executionMode}`, locale)}</span>
          </div>
          <div
            className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
            title={t('contentUi.slippage.toggleGas', locale)}
            onClick={onToggleGas}
          >
            <Fuel size={10} />
            <span>
              {t(`popup.settings.gas.${gasPreset}`, locale)} {gasValue} gwei
            </span>
          </div>

        </div>
        <div
          className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
          title={t('contentUi.slippage.toggleSlippage', locale)}
          onClick={onToggleSlippage}
        >
          <Sliders size={10} />
          <span>{slippageLabel}{slippagePct}%</span>
        </div>
      </div>
    </div>
  );
}
