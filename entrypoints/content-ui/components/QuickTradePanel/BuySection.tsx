import { useState } from 'react';
import { Zap, Fuel, Sliders } from 'lucide-react';
import { ChainId } from '@/constants/chains/chainId';
import { getNativeSymbol } from '@/constants/chains/runtime';
import type { AdvancedAutoSellConfig, Settings } from '@/types/extention';
import { SymbolCoinIcon } from '@/components/Coins';
import { formatPriceValue } from '@/utils/format';
import { t, type Locale } from '@/utils/i18n';
import { AutoSell } from './AutoSell';
import { getDynamicGasPreview } from './useDynamicGasPreview';

type BuySectionProps = {
  formattedNativeBalance: string;
  baseSymbol: string;
  baseTokenPriceUsd: number | null;
  quotedUsdValues?: Array<number | null>;
  quotedTokenAmounts?: Array<number | null>;
  tokenPriceUsd: number | null;
  tokenSymbol: string | null;
  previewRouteLabel: string | null;
  isAltfunLayout?: boolean;
  busy: boolean;
  isUnlocked: boolean;
  onBuy: (amountStr: string, presetIndex: number) => void;
  settings: Settings | null;
  dynamicGasBasePriceWei: bigint | null;
  onToggleMode: () => void;
  onToggleGas: () => void;
  onTogglePriorityFeePreset: () => void;
  onToggleSlippage: () => void;
  isEditing: boolean;
  onUpdatePreset: (index: number, val: string) => void;
  draftPresets?: string[];
  locale: Locale;
  showHotkeys?: boolean;
  hotkeyLabels?: [string, string, string, string];
  childPresetActiveWalletCounts?: [number, number, number, number];
  childPresetTooltipTexts?: [string, string, string, string];
  gmgnVisible: boolean;
  gmgnEnabled: boolean;
  onToggleGmgn: () => void;
  advancedAutoSell: AdvancedAutoSellConfig | null;
  onUpdateAdvancedAutoSell: (next: AdvancedAutoSellConfig) => void;
};

export function BuySection({
  formattedNativeBalance,
  baseSymbol,
  baseTokenPriceUsd,
  quotedUsdValues,
  quotedTokenAmounts,
  tokenPriceUsd,
  tokenSymbol,
  previewRouteLabel,
  isAltfunLayout = false,
  busy,
  isUnlocked,
  onBuy,
  settings,
  dynamicGasBasePriceWei,
  onToggleMode,
  onToggleGas,
  onTogglePriorityFeePreset,
  onToggleSlippage,
  isEditing,
  onUpdatePreset,
  draftPresets,
  locale,
  showHotkeys,
  hotkeyLabels,
  childPresetActiveWalletCounts,
  childPresetTooltipTexts,
  gmgnVisible,
  gmgnEnabled,
  onToggleGmgn,
  advancedAutoSell,
  onUpdateAdvancedAutoSell,
}: BuySectionProps) {
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
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
  const slippageText = executionMode === 'turbo' ? t('contentUi.slippage.none', locale) : `${slippageLabel}${slippagePct}%`;
  const chainSettings = settings?.chains[settings.chainId];
  const gasPreset = chainSettings?.buyGasPreset ?? chainSettings?.gasPreset ?? 'standard';
  const defaultGasGwei = { slow: '0.06', standard: '0.12', fast: '1', turbo: '5' } as const;
  const gasValue =
    (chainSettings?.buyGasGwei && chainSettings.buyGasGwei[gasPreset]) ||
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
  const priorityPresets = chainSettings?.buyPriorityFeePresets ?? {
    none: '0',
    slow: '0.000025',
    standard: '0.00004',
    fast: '0.0001',
  };
  const priorityPreset = (['none', 'slow', 'standard', 'fast'] as const).includes((chainSettings as any)?.buyPriorityFeePreset)
    ? (chainSettings as any).buyPriorityFeePreset as 'none' | 'slow' | 'standard' | 'fast'
    : 'standard';
  const priorityValue = priorityPresets[priorityPreset] ?? '0';
  const priorityPresetLabel = t(`contentUi.priorityFee.${priorityPreset}`, locale);
  const nativeSymbol = getNativeSymbol(settings?.chainId ?? ChainId.BNB);
  const showPriorityFee = settings?.chainId !== ChainId.HYPER;
  const isHypeBaseSymbol = baseSymbol === 'HYPE' || baseSymbol === 'WHYPE';

  const canEditAdvanced = !!settings && !!isUnlocked && !isEditing;
  const activePreviewAmount = (() => {
    const raw = String(buyPresets[activePreviewIndex] ?? '').replace(/,/g, '').trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  })();
  const fallbackPreviewUsd = activePreviewAmount != null && baseTokenPriceUsd && baseTokenPriceUsd > 0
    ? activePreviewAmount * baseTokenPriceUsd
    : null;
  const fallbackPreviewTokens = fallbackPreviewUsd != null && tokenPriceUsd && tokenPriceUsd > 0
    ? fallbackPreviewUsd / tokenPriceUsd
    : null;
  const activePreviewUsd = quotedUsdValues?.[activePreviewIndex] ?? fallbackPreviewUsd;
  const activePreviewTokens = quotedTokenAmounts?.[activePreviewIndex] ?? fallbackPreviewTokens;
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
          <span className={`font-bold text-zinc-200 ${isAltfunLayout ? 'text-[15px]' : 'text-sm'}`}>{t('contentUi.section.buy', locale)}</span>
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
        <div className={`flex items-center gap-1 ${isAltfunLayout ? 'text-[16px]' : 'text-[14px]'} text-emerald-400`}>
          <SymbolCoinIcon
            symbol={baseSymbol}
            chainId={settings?.chainId}
            size={{
              width: isAltfunLayout
                ? (isHypeBaseSymbol ? '14px' : '13px')
                : (isHypeBaseSymbol ? '13px' : '12px'),
              height: isAltfunLayout
                ? (isHypeBaseSymbol ? '14px' : '13px')
                : (isHypeBaseSymbol ? '13px' : '12px'),
            }}
          />
          <span>{formattedNativeBalance} {baseSymbol}</span>
        </div>
      </div>

      <div className={`grid grid-cols-4 gap-2 ${isAltfunLayout ? 'mb-2' : 'mb-1.5'}`}>
        {buyPresets.map((amt, idx) => (
          isEditing ? (
            <input
              key={idx}
              className={`w-full rounded border border-emerald-500/30 bg-zinc-900 text-center font-medium text-emerald-400 outline-none focus:border-emerald-500 select-text ${isAltfunLayout ? 'py-2 text-[13px]' : 'py-1.5 text-xs'}`}
              value={amt}
              onChange={(e) => onUpdatePreset(idx, e.target.value)}
            />
          ) : (
            <button
              key={idx}
              disabled={busy || !isUnlocked}
              onClick={() => onBuy(amt, idx)}
              onMouseEnter={() => setActivePreviewIndex(idx)}
              onFocus={() => setActivePreviewIndex(idx)}
              className={`relative rounded border border-emerald-500/30 bg-emerald-500/10 text-center font-medium text-emerald-400 hover:bg-emerald-500/20 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isAltfunLayout ? 'py-2 text-[13px]' : 'py-1.5 text-xs'}`}
              title={childPresetTooltipTexts?.[idx]}
            >
              {!!childPresetActiveWalletCounts?.[idx] && childPresetActiveWalletCounts[idx] > 0 && (
                <span className="absolute left-1 top-0.5 rounded-full bg-emerald-400/20 px-1 text-[10px] leading-3 text-emerald-300">
                  {childPresetActiveWalletCounts[idx]}
                </span>
              )}
              {showHotkeys && hotkeyLabels?.[idx] && (
                <span className="absolute right-1 top-0.5 text-[12px] font-semibold text-zinc-300">
                  {hotkeyLabels[idx]}
                </span>
              )}
              {amt}
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
              {activePreviewAmount != null ? `${formatAmount(activePreviewAmount)} ${baseSymbol}` : '--'}
            </span>
            <span className="ml-1 text-zinc-500">
              ≈ {formatUsd(activePreviewUsd)}
            </span>
          </div>
          <div className="min-w-0 truncate text-right text-emerald-300/90">
            ≈ {formatAmount(activePreviewTokens)} {tokenSymbol || t('contentUi.common.token', locale)}
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
            className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
            title={t('contentUi.slippage.toggleSlippage', locale)}
            onClick={onToggleSlippage}
          >
            <Sliders size={10} />
            <span>{slippageText}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <AutoSell canEdit={canEditAdvanced} locale={locale} value={advancedAutoSell} onChange={onUpdateAdvancedAutoSell} />
        </div>
      </div>
    </div>
  );
}
