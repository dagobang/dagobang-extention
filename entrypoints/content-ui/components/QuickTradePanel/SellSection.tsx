import { useState } from 'react';
import { Zap, Fuel, RefreshCw, Sliders } from 'lucide-react';
import { ChainId } from '@/constants/chains/chainId';
import { getNativeSymbol } from '@/constants/chains/runtime';
import type { Settings } from '@/types/extention';
import { formatPriceValue } from '@/utils/format';
import { t, type Locale } from '@/utils/i18n';
import { getDynamicGasPreview } from './useDynamicGasPreview';

type SellSectionProps = {
  formattedTokenBalance: string;
  tokenBalanceAmount: number | null;
  tokenSymbol: string | null;
  baseSymbol: string;
  baseTokenPriceUsd: number | null;
  quotedUsdValues?: Array<number | null>;
  quotedBaseAmounts?: Array<number | null>;
  tokenPriceUsd: number | null;
  previewRouteLabel: string | null;
  isAltfunLayout?: boolean;
  busy: boolean;
  isUnlocked: boolean;
  onSell: (pct: number) => void;
  settings: Settings | null;
  dynamicGasBasePriceWei: bigint | null;
  onToggleMode: () => void;
  onToggleGas: () => void;
  onTogglePriorityFeePreset: () => void;
  onToggleSlippage: () => void;
  onApprove: () => void;
  isEditing: boolean;
  onUpdatePreset: (index: number, val: string) => void;
  draftPresets?: string[];
  locale: Locale;
  showHotkeys?: boolean;
  hotkeyLabels?: [string, string, string, string];
  gmgnVisible: boolean;
  gmgnEnabled: boolean;
  onToggleGmgn: () => void;
};

export function SellSection({
  formattedTokenBalance,
  tokenBalanceAmount,
  tokenSymbol,
  baseSymbol,
  baseTokenPriceUsd,
  quotedUsdValues,
  quotedBaseAmounts,
  tokenPriceUsd,
  previewRouteLabel,
  isAltfunLayout = false,
  busy,
  isUnlocked,
  onSell,
  settings,
  dynamicGasBasePriceWei,
  onToggleMode,
  onToggleGas,
  onTogglePriorityFeePreset,
  onToggleSlippage,
  onApprove,
  isEditing,
  onUpdatePreset,
  draftPresets,
  locale,
  showHotkeys,
  hotkeyLabels,
  gmgnVisible,
  gmgnEnabled,
  onToggleGmgn,
}: SellSectionProps) {
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
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
  const slippageText = executionMode === 'turbo' ? t('contentUi.slippage.none', locale) : `${slippageLabel}${slippagePct}%`;
  const chainSettings = settings?.chains[settings.chainId];
  const gasPreset = chainSettings?.sellGasPreset ?? chainSettings?.gasPreset ?? 'standard';
  const defaultGasGwei = { slow: '0.06', standard: '0.12', fast: '1', turbo: '5' } as const;
  const gasValue =
    (chainSettings?.sellGasGwei && chainSettings.sellGasGwei[gasPreset]) ||
    defaultGasGwei[gasPreset as keyof typeof defaultGasGwei];
  const isDynamicGas = chainSettings?.gasPriceMode === 'dynamic';
  const dynamicMultiplierMap: Record<string, string> = {
    slow: '1.0x',
    standard: '1.1x',
    fast: '1.2x',
    turbo: '1.4x',
  };
  const dynamicMultiplierLabel = dynamicMultiplierMap[gasPreset] ?? '1.0x';
  const gasLabel = isDynamicGas
    ? `${t(`popup.settings.gas.${gasPreset}`, locale)} ${dynamicMultiplierLabel}`
    : t(`popup.settings.gas.${gasPreset}`, locale);
  const dynamicGasPreview = getDynamicGasPreview(dynamicGasBasePriceWei, gasPreset);
  const gasTitle = isDynamicGas
    ? `${t('contentUi.slippage.toggleGas', locale)}: ${gasLabel} (Dynamic)\n当前 gasPrice: ${dynamicGasPreview.baseGasPriceGweiText} Gwei\n倍率后 gasPrice: ${dynamicGasPreview.multipliedGasPriceGweiText} Gwei`
    : `${t('contentUi.slippage.toggleGas', locale)}: ${gasLabel} ${gasValue} gwei`;
  const priorityPresets = chainSettings?.sellPriorityFeePresets ?? {
    none: '0',
    slow: '0.000025',
    standard: '0.00004',
    fast: '0.0001',
  };
  const priorityPreset = (['none', 'slow', 'standard', 'fast'] as const).includes((chainSettings as any)?.sellPriorityFeePreset)
    ? (chainSettings as any).sellPriorityFeePreset as 'none' | 'slow' | 'standard' | 'fast'
    : 'standard';
  const priorityValue = priorityPresets[priorityPreset] ?? '0';
  const priorityPresetLabel = t(`contentUi.priorityFee.${priorityPreset}`, locale);
  const nativeSymbol = getNativeSymbol(settings?.chainId ?? ChainId.BNB);
  const showPriorityFee = settings?.chainId !== ChainId.HYPER;
  const activePreviewPct = (() => {
    const raw = String(sellPresets[activePreviewIndex] ?? '').replace(/,/g, '').trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  })();
  const activePreviewTokenAmount = activePreviewPct != null && tokenBalanceAmount != null
    ? (tokenBalanceAmount * activePreviewPct) / 100
    : null;
  const fallbackPreviewUsd = activePreviewTokenAmount != null && tokenPriceUsd && tokenPriceUsd > 0
    ? activePreviewTokenAmount * tokenPriceUsd
    : null;
  const fallbackPreviewBaseAmount = fallbackPreviewUsd != null && baseTokenPriceUsd && baseTokenPriceUsd > 0
    ? fallbackPreviewUsd / baseTokenPriceUsd
    : null;
  const activePreviewUsd = quotedUsdValues?.[activePreviewIndex] ?? fallbackPreviewUsd;
  const activePreviewBaseAmount = quotedBaseAmounts?.[activePreviewIndex] ?? fallbackPreviewBaseAmount;
  const formatUsd = (value: number | null) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return '--';
    const text = formatPriceValue(value, 2, 4);
    return text === '-' ? '--' : `$${text}`;
  };
  const formatAmount = (value: number | null) => {
    if (value == null || !Number.isFinite(value) || value <= 0) return '--';
    if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const text = formatPriceValue(value, 4, 4);
    return text === '-' ? '--' : text;
  };

  return (
    <div className={isAltfunLayout ? 'p-3.5' : 'p-3'}>
      <div className={`mb-2 flex items-center justify-between ${isAltfunLayout ? 'text-[13px]' : 'text-xs'}`}>
        <div className="flex items-center gap-2">
          <span className={`font-bold text-zinc-200 ${isAltfunLayout ? 'text-[15px]' : 'text-sm'}`}>{t('contentUi.section.sell', locale)}</span>
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
        <div className={`flex items-center gap-1 text-zinc-300 ${isAltfunLayout ? 'text-[16px]' : 'text-[14px]'}`}>
          <span>{Number(formattedTokenBalance).toLocaleString()}</span>
          <span className={`text-amber-500 ${isAltfunLayout ? 'text-[13px]' : 'text-[12px]'}`}>{tokenSymbol || t('contentUi.common.token', locale)}</span>
        </div>
      </div>

      <div className={`grid grid-cols-4 gap-2 ${isAltfunLayout ? 'mb-2.5' : 'mb-2'}`}>
        {sellPresets.map((pct, idx) => (
          isEditing ? (
            <div key={idx} className="relative">
              <input
                type="number"
                className={`w-full rounded border border-rose-500/30 bg-zinc-900 text-center font-medium text-rose-400 outline-none focus:border-rose-500 pr-3 select-text ${isAltfunLayout ? 'py-2 text-[13px]' : 'py-1.5 text-xs'}`}
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
              onMouseEnter={() => setActivePreviewIndex(idx)}
              onFocus={() => setActivePreviewIndex(idx)}
              className={`relative rounded border border-rose-500/30 bg-rose-500/10 text-center font-medium text-rose-400 hover:bg-rose-500/20 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isAltfunLayout ? 'py-2 text-[13px]' : 'py-1.5 text-xs'}`}
            >
              {showHotkeys && hotkeyLabels?.[idx] && (
                <span className="absolute right-1 top-0.5 text-[12px] font-semibold text-zinc-300">
                  {hotkeyLabels[idx]}
                </span>
              )}
              {pct}%
            </button>
          )
        ))}
      </div>

      <div
        className={`mb-2 rounded-md border border-zinc-800/80 bg-zinc-950/65 text-zinc-400 ${isAltfunLayout ? 'px-3 py-1.5 text-[12px]' : 'px-2.5 py-1 text-[11px]'}`}
        title={previewRouteLabel || undefined}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 truncate">
            <span className="text-zinc-300">
              {activePreviewPct != null ? `${formatAmount(activePreviewPct)}% ${tokenSymbol || t('contentUi.common.token', locale)}` : '--'}
            </span>
            <span className="ml-1 text-zinc-500">
              ≈ {formatUsd(activePreviewUsd)}
            </span>
          </div>
          <div className="min-w-0 truncate text-right text-rose-300/90">
            ≈ {formatAmount(activePreviewBaseAmount)} {baseSymbol}
          </div>
        </div>
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
            title={gasTitle}
            onClick={onToggleGas}
          >
            <Fuel size={10} />
            <span className="whitespace-nowrap">{gasLabel}</span>
          </div>
          {showPriorityFee ? (
            <div
              className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
              title={`${t('contentUi.priorityFee.toggle', locale)}: ${priorityPresetLabel} ${priorityValue} ${nativeSymbol}`}
              onClick={onTogglePriorityFeePreset}
            >
              <span className="text-[10px] font-semibold">PF</span>
              <span className="whitespace-nowrap">{priorityPresetLabel}</span>
            </div>
          ) : null}

          <div
            className="flex items-center gap-1 cursor-pointer hover:text-amber-400 text-zinc-500"
            title={t('contentUi.slippage.toggleSlippage', locale)}
            onClick={onToggleSlippage}
          >
            <Sliders size={10} />
            <span>{slippageText}</span>
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
