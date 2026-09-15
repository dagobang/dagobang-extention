import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, ChevronDown, Fuel, RefreshCw, Sliders, Zap } from 'lucide-react';
import { ChainId } from '@/constants/chains/chainId';
import { getNativeSymbol } from '@/constants/chains/runtime';
import type { QuickTradeRouteHop, Settings } from '@/types/extention';
import type { ChainAddress } from '@/types/chain/address';
import { formatPriceValue } from '@/utils/format';
import { t, type Locale } from '@/utils/i18n';
import {
  DEFAULT_SOLANA_TIP_PRESET_VALUES,
  getSolanaTipMinimumNative,
  getSolanaTipProviderLabel,
} from '@/utils/solanaTip';
import { getDynamicGasPreview } from './useDynamicGasPreview';
import { RoutePreviewHint } from './RoutePreviewHint';

type TransferRecipientOption = {
  address: ChainAddress;
  name: string;
  isActive?: boolean;
};

export type SellSectionProps = {
  formattedTokenBalance: string;
  tokenBalanceAmount: number | null;
  tokenSymbol: string | null;
  baseSymbol: string;
  baseTokenPriceUsd: number | null;
  quotedUsdValues?: Array<number | null>;
  quotedBaseAmounts?: Array<number | null>;
  tokenPriceUsd: number | null;
  previewRouteLabel: string | null;
  previewRouteHops?: QuickTradeRouteHop[] | null;
  previewRouteLoading?: boolean;
  isAltfunLayout?: boolean;
  approveStatus: 'ready' | 'approving' | 'approved';
  approveStatusTitle: string;
  busy: boolean;
  isUnlocked: boolean;
  actionReady?: boolean;
  actionDisabledTitle?: string;
  onSell: (pct: number) => void;
  settings: Settings | null;
  dynamicGasBasePriceWei: bigint | null;
  onToggleMode: () => void;
  onToggleGas: () => void;
  onTogglePriorityFeePreset: () => void;
  onToggleTipPreset: () => void;
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
  showApproveAction?: boolean;
  transferEnabled?: boolean;
  onTransfer?: (pct: number, toAddress: ChainAddress) => void;
  transferRecipients?: TransferRecipientOption[];
  defaultTransferRecipient?: ChainAddress | null;
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
  previewRouteHops,
  previewRouteLoading = false,
  isAltfunLayout = false,
  approveStatus,
  approveStatusTitle,
  busy,
  isUnlocked,
  actionReady = true,
  actionDisabledTitle,
  onSell,
  settings,
  dynamicGasBasePriceWei,
  onToggleMode,
  onToggleGas,
  onTogglePriorityFeePreset,
  onToggleTipPreset,
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
  showApproveAction = true,
  transferEnabled = false,
  onTransfer,
  transferRecipients = [],
  defaultTransferRecipient = null,
}: SellSectionProps) {
  const chainId = settings?.chainId ?? ChainId.BNB;
  const transferRecipientStorageKey = `dagobang_quick_transfer_recipient_v1:${chainId}`;
  const [activePreviewIndex, setActivePreviewIndex] = useState(0);
  const [actionTab, setActionTab] = useState<'sell' | 'transfer'>('sell');
  const [transferRecipient, setTransferRecipient] = useState<ChainAddress | ''>('');
  const [transferDropdownOpen, setTransferDropdownOpen] = useState(false);
  const transferDropdownRef = useRef<HTMLDivElement | null>(null);
  const transferRecipientHydratedKeyRef = useRef<string | null>(null);
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
  const priorityValueNum = Number(priorityValue || '0');
  const hasPriorityFeeEnabled = Number.isFinite(priorityValueNum) && priorityValueNum > 0;
  const nativeSymbol = getNativeSymbol(settings?.chainId ?? ChainId.BNB);
  const isSolana = settings?.chainId === ChainId.SOL;
  const priorityFeeUiLabel = 'PF';
  const submitChannel = chainSettings?.submitChannel ?? 'protectRpcs';
  const showPriorityFee = settings?.chainId !== ChainId.HYPER && settings?.chainId !== ChainId.RH && (isSolana || (submitChannel !== 'protectRpcs' && submitChannel !== 'mixed'));
  const enabledTipProviders = Array.isArray(chainSettings?.solanaSwqos?.providers)
    ? chainSettings!.solanaSwqos!.providers.filter((item) => item?.enabled)
    : [];
  const activeTipProviderType = enabledTipProviders.length === 1 ? enabledTipProviders[0]?.type : null;
  const showTip = isSolana && !!chainSettings?.solanaSwqos?.enabled && enabledTipProviders.length === 1 && !!activeTipProviderType;
  const tipPresets = chainSettings?.sellTipPresets ?? DEFAULT_SOLANA_TIP_PRESET_VALUES;
  const tipPreset = (['none', 'slow', 'standard', 'fast'] as const).includes((chainSettings as any)?.sellTipPreset)
    ? (chainSettings as any).sellTipPreset as 'none' | 'slow' | 'standard' | 'fast'
    : 'none';
  const tipValue = tipPresets[tipPreset] ?? DEFAULT_SOLANA_TIP_PRESET_VALUES[tipPreset];
  const tipPresetLabel = t(`contentUi.priorityFee.${tipPreset}`, locale);
  const tipValueNum = Number(tipValue || '0');
  const hasTipEnabled = Number.isFinite(tipValueNum) && tipValueNum > 0;
  const tipProviderLabel = showTip ? getSolanaTipProviderLabel(activeTipProviderType as any) : 'SWQoS';
  const tipMinimumNative = showTip ? getSolanaTipMinimumNative(activeTipProviderType as any) : '0.001';
  const tipTitle = `${locale === 'en' ? 'Tip' : 'Tip'}: ${tipPresetLabel} ${tipValue} ${nativeSymbol}\n${locale === 'en'
      ? (!hasTipEnabled
          ? `Tip is disabled. Tip is only available on SWQoS with a single active provider. Current provider: ${tipProviderLabel}. Minimum recommended tip: ${tipMinimumNative} ${nativeSymbol}.`
          : `Tip transfer is enabled and will be sent to ${tipProviderLabel}. Minimum provider tip: ${tipMinimumNative} ${nativeSymbol}.`)
      : (!hasTipEnabled
          ? `当前 Tip 已关闭。Tip 仅在 SWQoS 且单一 Provider 下生效。当前 Provider: ${tipProviderLabel}。该通道最低 Tip: ${tipMinimumNative} ${nativeSymbol}。`
          : `当前已启用 Tip，会在交易里插入一笔 ${tipProviderLabel} 的 Tip transfer。该通道最低 Tip: ${tipMinimumNative} ${nativeSymbol}。`)}`;
  const priorityTitle = `${t('contentUi.priorityFee.toggle', locale)}: ${priorityPresetLabel} ${priorityValue} ${nativeSymbol}\n${locale === 'en'
      ? (isSolana
          ? (!hasPriorityFeeEnabled
              ? 'PF: Enable a higher priority fee to improve confirmation priority on Solana.'
              : 'PF is enabled and will be added as Solana priority fee for faster confirmation.')
          : (!hasPriorityFeeEnabled
              ? 'Tip: Enable PF on Blox/Razor, otherwise confirmation may be slow.'
              : 'MEV protection is stronger when PF stays enabled on Blox/Razor.'))
      : (isSolana
          ? (!hasPriorityFeeEnabled
              ? '建议：提高优先费可提升 Solana 交易确认优先级。'
              : '当前已启用 PF，会作为 Solana 优先费参与交易确认。')
          : (!hasPriorityFeeEnabled
              ? '建议：当前通道开启 PF，否则确认可能较慢。'
              : '当前已启用 PF，更适合防夹场景。'))}`;
  const slippageTitle = t('contentUi.slippage.toggleSlippage', locale);
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
  const approveLabel = approveStatus === 'approved'
    ? (locale === 'en' ? 'Approved' : '已授权')
    : approveStatus === 'approving'
      ? (locale === 'en' ? 'Approving' : '授权中')
      : t('contentUi.approve.button', locale);
  const approveClassName = approveStatus === 'approved'
    ? 'text-emerald-400'
    : approveStatus === 'approving'
      ? 'text-cyan-300'
      : 'text-zinc-500 hover:text-zinc-300';
  const approveDisabled = !isUnlocked || busy || approveStatus === 'approving';
  const approveIcon = approveStatus === 'approved'
    ? <CheckCircle2 size={10} />
    : <RefreshCw size={10} className={approveStatus === 'approving' ? 'animate-spin' : undefined} />;
  const sellBlockedByApproval = submitChannel === 'blox' && approveStatus === 'approving';
  const sellBlockedByReadiness = !actionReady;
  const isTransferTab = actionTab === 'transfer' && transferEnabled;
  const transferReady = !!transferRecipient && !!onTransfer;
  const sellDisabled = isTransferTab
    ? (busy || !isUnlocked || !transferReady)
    : (busy || !isUnlocked || sellBlockedByApproval || sellBlockedByReadiness);
  const sellDisabledTitle = sellBlockedByApproval
    ? (locale === 'en' ? 'Blox sell is disabled until approval is mined.' : 'Blox 通道授权中，需等待授权生效后才能卖出')
    : sellBlockedByReadiness
      ? actionDisabledTitle
      : (isTransferTab && !transferReady)
        ? (locale === 'en' ? 'Select recipient wallet first' : '请先选择接收钱包')
        : undefined;
  const selectedRecipient = useMemo(
    () => transferRecipients.find((item) => item.address === transferRecipient) ?? null,
    [transferRecipient, transferRecipients],
  );

  useEffect(() => {
    if (!transferEnabled && actionTab === 'transfer') {
      setActionTab('sell');
    }
  }, [actionTab, transferEnabled]);

  useEffect(() => {
    let storedRecipient = '';
    try {
      storedRecipient = String(window.localStorage.getItem(transferRecipientStorageKey) || '').trim();
    } catch { }
    const storedRecipientValid = !!storedRecipient && transferRecipients.some((item) => item.address === storedRecipient);
    const nextDefault = (() => {
      if (storedRecipientValid) {
        return storedRecipient as ChainAddress;
      }
      if (defaultTransferRecipient && transferRecipients.some((item) => item.address === defaultTransferRecipient)) {
        return defaultTransferRecipient;
      }
      return transferRecipients[0]?.address ?? '';
    })();

    if (transferRecipientHydratedKeyRef.current !== transferRecipientStorageKey) {
      transferRecipientHydratedKeyRef.current = transferRecipientStorageKey;
      setTransferRecipient(nextDefault);
      return;
    }

    const currentStillValid = !!transferRecipient && transferRecipients.some((item) => item.address === transferRecipient);
    if (!currentStillValid && transferRecipient !== nextDefault) {
      setTransferRecipient(nextDefault);
    }
  }, [defaultTransferRecipient, transferRecipient, transferRecipientStorageKey, transferRecipients]);

  useEffect(() => {
    if (!transferRecipient) return;
    try {
      window.localStorage.setItem(transferRecipientStorageKey, transferRecipient);
    } catch { }
  }, [transferRecipient, transferRecipientStorageKey]);

  useEffect(() => {
    if (!transferDropdownOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!transferDropdownRef.current) return;
      if (!transferDropdownRef.current.contains(event.target as Node)) {
        setTransferDropdownOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [transferDropdownOpen]);

  return (
    <div className={isAltfunLayout ? 'p-3' : 'p-2.5'}>
      <div className={`mb-1.5 flex items-center justify-between ${isAltfunLayout ? 'text-[13px]' : 'text-xs'}`}>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950/70 p-0.5">
            <button
              type="button"
              className={`${isAltfunLayout ? 'px-2.5 py-1 text-[12px]' : 'px-2 py-0.5 text-[11px]'} rounded-md font-semibold transition-colors ${actionTab === 'sell' ? 'bg-rose-500/14 text-rose-300' : 'text-zinc-400 hover:text-zinc-200'}`}
              onClick={() => setActionTab('sell')}
            >
              {t('contentUi.section.sell', locale)}
            </button>
            {transferEnabled ? (
              <button
                type="button"
                className={`${isAltfunLayout ? 'px-2.5 py-1 text-[12px]' : 'px-2 py-0.5 text-[11px]'} rounded-md font-semibold transition-colors ${actionTab === 'transfer' ? 'bg-sky-500/14 text-sky-300' : 'text-zinc-400 hover:text-zinc-200'}`}
                onClick={() => setActionTab('transfer')}
              >
                {t('contentUi.section.transfer', locale)}
              </button>
            ) : null}
          </div>
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
          <span>{formattedTokenBalance}</span>
          <span className={`text-amber-500 ${isAltfunLayout ? 'text-[13px]' : 'text-[12px]'}`}>{tokenSymbol || t('contentUi.common.token', locale)}</span>
        </div>
      </div>

      <div className={`grid grid-cols-4 gap-1.5 ${isAltfunLayout ? 'mb-1.5' : 'mb-1.5'}`}>
        {sellPresets.map((pct, idx) => (
          isEditing ? (
            <div key={idx} className="relative">
              <input
                type="number"
                  className={`w-full rounded border border-rose-500/30 bg-zinc-900 text-center font-medium text-rose-400 outline-none focus:border-rose-500 pr-3 select-text ${isAltfunLayout ? 'py-1.5 text-[13px]' : 'py-1 text-xs'}`}
                value={pct}
                onChange={(e) => onUpdatePreset(idx, e.target.value)}
              />
              <span className="absolute right-1 top-1.5 text-[12px] text-zinc-500">%</span>
            </div>
          ) : (
            <button
              key={idx}
              disabled={sellDisabled}
              title={sellDisabledTitle}
              onClick={() => {
                const value = Number(pct);
                if (isTransferTab) {
                  if (transferRecipient && onTransfer) onTransfer(value, transferRecipient);
                  return;
                }
                onSell(value);
              }}
              onMouseEnter={() => setActivePreviewIndex(idx)}
              onFocus={() => setActivePreviewIndex(idx)}
                className={`relative rounded border text-center font-medium leading-none active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${isTransferTab ? 'border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20' : 'border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'} ${isAltfunLayout ? 'py-1.5 text-[13px]' : 'py-1 text-xs'}`}
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
        className={`mb-1.5 text-zinc-400 ${isTransferTab ? 'border-sky-500/10 bg-sky-500/[0.04]' : 'border-rose-500/10 bg-rose-500/[0.04]'} ${isAltfunLayout ? 'px-2.5 py-1 text-[12px]' : 'px-2 py-1 text-[11px]'}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate">
            <span className="text-zinc-200">
              {activePreviewPct != null ? `${formatAmount(activePreviewPct)}% ${tokenSymbol || t('contentUi.common.token', locale)}` : '--'}
            </span>
            <span className="ml-1 text-zinc-500">
              ≈ {formatUsd(activePreviewUsd)}
            </span>
          </div>
          {!isTransferTab ? (
            <RoutePreviewHint label={previewRouteLabel} hops={previewRouteHops} loading={previewRouteLoading} tone="sell" locale={locale} />
          ) : null}
          {isTransferTab ? (
            <div className="min-w-0 text-right text-sky-300/85">
              {transferRecipients.length > 0 ? (
                <div ref={transferDropdownRef} className="relative inline-flex max-w-full items-center gap-1 text-[11px]">
                  <span className="shrink-0">{t('contentUi.transfer.to', locale)}</span>
                  <button
                    type="button"
                    className="inline-flex min-w-0 max-w-[152px] items-center gap-1 rounded-md border border-sky-500/20 bg-sky-500/[0.06] px-2 py-0.5 text-[11px] text-sky-200 transition-colors hover:border-sky-400/40 hover:bg-sky-500/[0.09]"
                    disabled={busy || transferRecipients.length <= 0}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTransferDropdownOpen((prev) => !prev);
                    }}
                  >
                    <span className="truncate">{selectedRecipient?.name || selectedRecipient?.address.slice(0, 6) || t('contentUi.transfer.noRecipient', locale)}</span>
                    <ChevronDown size={12} className={`shrink-0 transition-transform ${transferDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {transferDropdownOpen ? (
                    <div
                      className="absolute right-0 top-[calc(100%+6px)] z-30 min-w-[190px] max-w-[240px] overflow-hidden rounded-xl border border-zinc-800 bg-[#121317] shadow-[0_18px_40px_rgba(0,0,0,0.45)]"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <div className="max-h-56 overflow-y-auto py-1">
                        {transferRecipients.map((item) => {
                          const active = item.address === transferRecipient;
                          return (
                            <button
                              key={item.address}
                              type="button"
                              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${active ? 'bg-sky-500/12 text-sky-200' : 'text-zinc-200 hover:bg-white/5'}`}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setTransferRecipient(item.address);
                                setTransferDropdownOpen(false);
                              }}
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[12px] font-medium">{item.name || 'Wallet'}</div>
                                <div className="truncate text-[10px] text-zinc-500">
                                  {item.address.slice(0, 6)}...{item.address.slice(-4)}
                                </div>
                              </div>
                              {active ? <Check size={12} className="shrink-0 text-sky-300" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <span className="text-zinc-500">{t('contentUi.transfer.noRecipient', locale)}</span>
              )}
            </div>
          ) : (
            <div className="min-w-0 truncate text-right text-rose-300/85">
              ≈ {formatAmount(activePreviewBaseAmount)} {baseSymbol}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-[12px] text-zinc-500">
        <div className="flex items-center gap-2">
          {!isTransferTab ? (
            <>
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
                  title={priorityTitle}
                  onClick={showPriorityFee ? onTogglePriorityFeePreset : undefined}
                >
                  <span className="text-[10px] font-semibold">{priorityFeeUiLabel}</span>
                  <span className="whitespace-nowrap">{priorityPresetLabel}</span>
                </div>
              ) : null}
              {showTip ? (
                <div
                  className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
                  title={tipTitle}
                  onClick={onToggleTipPreset}
                >
                  <span className="text-[10px] font-semibold">Tip</span>
                  <span className="whitespace-nowrap">{tipPresetLabel}</span>
                </div>
              ) : null}
              <div
                className="flex items-center gap-1 cursor-pointer hover:text-amber-400 text-zinc-500"
                title={slippageTitle}
                onClick={onToggleSlippage}
              >
                <Sliders size={10} />
                <span>{slippageText}</span>
              </div>
            </>
          ) : (
            <div
              className="flex items-center gap-1 cursor-pointer hover:text-zinc-300"
              title={gasTitle}
              onClick={onToggleGas}
            >
              <Fuel size={10} />
              <span className="whitespace-nowrap">{gasLabel}</span>
            </div>
          )}
        </div>
        {!isTransferTab && showApproveAction ? (
          <button
            onClick={onApprove}
            disabled={approveDisabled}
            className={`flex items-center gap-1 transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${approveClassName}`}
            title={approveStatusTitle || t('contentUi.approve.title', locale)}
          >
            {approveIcon}
            <span>{approveLabel}</span>
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
