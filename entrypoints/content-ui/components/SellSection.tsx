import { Zap, Fuel, RefreshCw, Sliders } from 'lucide-react';
import type { Settings } from '@/types/extention';
import { t, type Locale } from '@/utils/i18n';

type SellSectionProps = {
  formattedTokenBalance: string;
  tokenSymbol: string | null;
  busy: boolean;
  isUnlocked: boolean;
  onSell: (pct: number) => void;
  settings: Settings | null;
  onToggleMode: () => void;
  onToggleGas: () => void;
  onToggleSlippage: () => void;
  onApprove: () => void;
  isEditing: boolean;
  onUpdatePreset: (index: number, val: string) => void;
  draftPresets?: string[];
  locale: Locale;
  gmgnVisible: boolean;
  gmgnEnabled: boolean;
  onToggleGmgn: () => void;
};

export function SellSection({
  formattedTokenBalance,
  tokenSymbol,
  busy,
  isUnlocked,
  onSell,
  settings,
  onToggleMode,
  onToggleGas,
  onToggleSlippage,
  onApprove,
  isEditing,
  onUpdatePreset,
  draftPresets,
  locale,
  gmgnVisible,
  gmgnEnabled,
  onToggleGmgn,
}: SellSectionProps) {
  const sellPresets = isEditing && draftPresets ? draftPresets : (settings?.chains[settings.chainId]?.sellPresets || ['10', '25', '50', '100']);
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
  const gasPreset = chainSettings?.sellGasPreset ?? chainSettings?.gasPreset ?? 'standard';
  const defaultGasGwei = { slow: '0.06', standard: '0.12', fast: '1', turbo: '5' } as const;
  const gasValue =
    (chainSettings?.sellGasGwei && chainSettings.sellGasGwei[gasPreset]) ||
    defaultGasGwei[gasPreset as keyof typeof defaultGasGwei];

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-200 text-sm">{t('contentUi.section.sell', locale)}</span>
          {gmgnVisible && (
            <label className="flex items-center gap-1 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3 w-3 accent-rose-500"
                checked={gmgnEnabled}
                onChange={onToggleGmgn}
              />
              <span>{t('contentUi.gmgnOrder', locale)}</span>
            </label>
          )}
        </div>
        <div className="flex items-center gap-1 text-[14px] text-zinc-300">
          <span>{Number(formattedTokenBalance).toLocaleString()}</span>
          <span className="text-amber-500 text-[12px]">{tokenSymbol || t('contentUi.common.token', locale)}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-2">
        {sellPresets.map((pct, idx) => (
          isEditing ? (
            <div key={idx} className="relative">
              <input
                type="number"
                className="w-full rounded border border-rose-500/30 bg-zinc-900 py-1.5 text-center text-xs font-medium text-rose-400 outline-none focus:border-rose-500 pr-3 select-text"
                value={pct}
                onChange={(e) => onUpdatePreset(idx, e.target.value)}
              />
              <span className="absolute right-1 top-1.5 text-[12px] text-zinc-500">%</span>
            </div>
          ) : (
            <button
              key={idx}
              disabled={busy || !isUnlocked}
              onClick={() => onSell(Number(pct))}
              className="rounded border border-rose-500/30 bg-rose-500/10 py-1.5 text-center text-xs font-medium text-rose-400 hover:bg-rose-500/20 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pct}%
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

          <div
            className="flex items-center gap-1 cursor-pointer hover:text-amber-400 text-zinc-500"
            title={t('contentUi.slippage.toggleSlippage', locale)}
            onClick={onToggleSlippage}
          >
            <Sliders size={10} />
            <span>{slippageLabel}{slippagePct}%</span>
          </div>
        </div>
        <button
          onClick={onApprove}
          className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
          title={t('contentUi.approve.title', locale)}
        >
          <RefreshCw size={10} />
          <span>{t('contentUi.approve.button', locale)}</span>
        </button>
      </div>
    </div>
  );
}
