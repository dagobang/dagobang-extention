import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Account, QuickBuyPresetOverride, Settings } from '@/types/extention';
import type { ChainAddress } from '@/types/chain/address';
import type { SiteInfo } from '@/utils/sites';
import type { Locale } from '@/utils/i18n';
import { Header } from './Header';
import { BuySection } from './BuySection';
import { SellSection, type SellSectionProps } from './SellSection';
import { Overlays } from './Overlays';
import { FooterStats, type FooterHoldingStats } from './FooterStats';
import { Logo } from '@/components/Logo';
import { WalletSelectorDropdown } from '@/entrypoints/content-ui/components/WalletSelector';
import type { ChannelSwitcherItem } from './ChannelSwitcher';

type QuickTradePanelProps = {
  minimized: boolean;
  pos: { x: number; y: number };
  onMinimizedDragStart: (e: ReactPointerEvent) => void;
  onMinimizedClick: () => void;
  onDragStart: (e: ReactPointerEvent) => void;
  onMinimize: () => void;
  isEditing: boolean;
  onEditToggle: () => void;
  onToggleXTrade: () => void;
  xTradeActive: boolean;
  onToggleLimitTrade: () => void;
  autotradeActive: boolean;
  onToggleRpc: () => void;
  rpcActive: boolean;
  onToggleDailyAnalysis: () => void;
  dailyAnalysisActive: boolean;
  onToggleReview: () => void;
  reviewActive: boolean;
  onToggleCooking: () => void;
  cookingActive: boolean;
  keyboardShortcutsEnabled: boolean;
  onToggleKeyboardShortcuts: () => void;
  formattedNativeBalance: string;
  tradeBaseSymbol: string;
  tradeBasePriceUsd: number | null;
  buyPreviewQuotedUsd: Array<number | null>;
  buyPreviewQuotedTokenAmounts: Array<number | null>;
  busy: boolean;
  isUnlocked: boolean;
  onBuy: (amountStr: string, presetIndex: number) => void;
  settings: Settings | null;
  channelActiveKey: string;
  channelOptions: ChannelSwitcherItem[];
  onSelectChannel: (key: string) => void;
  prewarmIndicatorState?: 'hidden' | 'warming' | 'done';
  prewarmIndicatorTitle?: string;
  dynamicGasBasePriceWei: bigint | null;
  onToggleMode: () => void;
  onToggleBuyGas: () => void;
  onToggleSellGas: () => void;
  onToggleBuyPriorityFeePreset: () => void;
  onToggleSellPriorityFeePreset: () => void;
  onToggleSlippage: () => void;
  onUpdateBuyPreset: (idx: number, value: string) => void;
  draftBuyPresets: string[];
  quickBuyAdvancedEnabled: boolean;
  quickBuyPresetOverrides: QuickBuyPresetOverride[];
  onToggleQuickBuyAdvanced: () => void;
  onToggleQuickBuyPresetGas: (presetIndex: number) => void;
  onToggleQuickBuyPresetPriorityFee: (presetIndex: number) => void;
  onUpdateSellPreset: (idx: number, value: string) => void;
  draftSellPresets: string[];
  locale: Locale;
  showBuyHotkeys: boolean;
  showSellHotkeys: boolean;
  gmgnBuyEnabled: boolean;
  gmgnSellEnabled: boolean;
  onToggleGmgnBuy: () => void;
  onToggleGmgnSell: () => void;
  advancedAutoSell: Settings['advancedAutoSell'] | null;
  onUpdateAdvancedAutoSell: (next: Settings['advancedAutoSell']) => void;
  formattedTokenBalance: string;
  tokenBalanceAmount: number | null;
  tokenPriceUsd: number | null;
  sellPreviewQuotedUsd: Array<number | null>;
  sellPreviewQuotedBaseAmounts: Array<number | null>;
  tokenSymbol: string | null;
  buyPreviewRoute: string | null;
  sellPreviewRoute: string | null;
  approveStatus: 'ready' | 'approving' | 'approved';
  approveStatusTitle: string;
  onSell: (pct: number) => void;
  onApprove: () => void;
  siteInfo: SiteInfo;
  onUnlock: () => void;
  walletAccounts: Account[];
  activeWalletAddress: ChainAddress | null;
  selectedTradeWallets: ChainAddress[];
  onToggleTradeWallet: (address: ChainAddress) => void;
  multiWalletBuyMode: 'uniform' | 'child_custom';
  childWalletBuyPresetAmountsNative: Record<string, string[]>;
  childPresetActiveWalletCounts: [number, number, number, number];
  childPresetTooltipTexts: [string, string, string, string];
  onChangeMultiWalletBuyMode: (mode: 'uniform' | 'child_custom') => void;
  onUpdateChildWalletBuyPresetAmount: (address: ChainAddress, presetIndex: number, amountNative: string) => void;
  walletNativeBalancesWei: Record<string, string>;
  walletTokenBalancesWei: Record<string, string>;
  tokenDecimals: number | null;
  nativeSymbol: string;
  nativeDecimals?: number;
  holdingStats?: FooterHoldingStats | null;
  onOpenWalletSelector?: () => void;
};

export function QuickTradePanel({
  minimized,
  pos,
  onMinimizedDragStart,
  onMinimizedClick,
  onDragStart,
  onMinimize,
  isEditing,
  onEditToggle,
  onToggleXTrade,
  xTradeActive,
  onToggleLimitTrade,
  autotradeActive,
  onToggleRpc,
  rpcActive,
  onToggleDailyAnalysis,
  dailyAnalysisActive,
  onToggleReview,
  reviewActive,
  onToggleCooking,
  cookingActive,
  keyboardShortcutsEnabled,
  onToggleKeyboardShortcuts,
  formattedNativeBalance,
  tradeBaseSymbol,
  tradeBasePriceUsd,
  buyPreviewQuotedUsd,
  buyPreviewQuotedTokenAmounts,
  busy,
  isUnlocked,
  onBuy,
  settings,
  channelActiveKey,
  channelOptions,
  onSelectChannel,
  prewarmIndicatorState,
  prewarmIndicatorTitle,
  dynamicGasBasePriceWei,
  onToggleMode,
  onToggleBuyGas,
  onToggleSellGas,
  onToggleBuyPriorityFeePreset,
  onToggleSellPriorityFeePreset,
  onToggleSlippage,
  onUpdateBuyPreset,
  draftBuyPresets,
  quickBuyAdvancedEnabled,
  quickBuyPresetOverrides,
  onToggleQuickBuyAdvanced,
  onToggleQuickBuyPresetGas,
  onToggleQuickBuyPresetPriorityFee,
  onUpdateSellPreset,
  draftSellPresets,
  locale,
  showBuyHotkeys,
  showSellHotkeys,
  gmgnBuyEnabled,
  gmgnSellEnabled,
  onToggleGmgnBuy,
  onToggleGmgnSell,
  advancedAutoSell,
  onUpdateAdvancedAutoSell,
  formattedTokenBalance,
  tokenBalanceAmount,
  tokenPriceUsd,
  sellPreviewQuotedUsd,
  sellPreviewQuotedBaseAmounts,
  tokenSymbol,
  buyPreviewRoute,
  sellPreviewRoute,
  approveStatus,
  approveStatusTitle,
  onSell,
  onApprove,
  siteInfo,
  onUnlock,
  walletAccounts,
  activeWalletAddress,
  selectedTradeWallets,
  onToggleTradeWallet,
  multiWalletBuyMode,
  childWalletBuyPresetAmountsNative,
  childPresetActiveWalletCounts,
  childPresetTooltipTexts,
  onChangeMultiWalletBuyMode,
  onUpdateChildWalletBuyPresetAmount,
  walletNativeBalancesWei,
  walletTokenBalancesWei,
  tokenDecimals,
  nativeSymbol,
  nativeDecimals = 18,
  holdingStats,
  onOpenWalletSelector,
}: QuickTradePanelProps) {
  const [walletSelectorOpen, setWalletSelectorOpen] = useState(false);

  const walletSelectorVisible = isUnlocked && walletAccounts.length > 0;
  const sellSectionProps: SellSectionProps = {
    formattedTokenBalance,
    tokenBalanceAmount,
    tokenSymbol,
    baseSymbol: tradeBaseSymbol,
    baseTokenPriceUsd: tradeBasePriceUsd,
    quotedUsdValues: sellPreviewQuotedUsd,
    quotedBaseAmounts: sellPreviewQuotedBaseAmounts,
    tokenPriceUsd,
    previewRouteLabel: sellPreviewRoute,
    isAltfunLayout: siteInfo.platform === 'altfun',
    approveStatus,
    approveStatusTitle,
    busy,
    isUnlocked,
    onSell,
    settings,
    dynamicGasBasePriceWei,
    onToggleMode,
    onToggleGas: onToggleSellGas,
    onTogglePriorityFeePreset: onToggleSellPriorityFeePreset,
    onToggleSlippage,
    onApprove,
    isEditing,
    onUpdatePreset: onUpdateSellPreset,
    draftPresets: draftSellPresets,
    locale,
    showHotkeys: showSellHotkeys,
    hotkeyLabels: ['A', 'S', 'D', 'F'],
    gmgnVisible: false,
    gmgnEnabled: gmgnSellEnabled,
    onToggleGmgn: onToggleGmgnSell,
    showApproveAction: settings?.chainId !== 501,
  };
  const handleToggleWalletSelector = () => {
    setWalletSelectorOpen((prev) => {
      const next = !prev;
      if (next) onOpenWalletSelector?.();
      return next;
    });
  };

  if (minimized) {
    return (
      <div
        className="fixed z-[2147483647] flex cursor-pointer items-center justify-center rounded-full bg-zinc-900 p-3 shadow-xl border border-zinc-700 hover:border-zinc-500 transition-colors"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={onMinimizedDragStart}
        onClick={onMinimizedClick}
      >
        <Logo />
      </div>
    );
  }

  return (
    <div
      className={`fixed z-[2147483647] ${siteInfo.platform === 'altfun' ? 'w-[400px]' : 'w-[360px]'} select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/50 font-sans flex flex-col`}
      style={{ left: pos.x, top: pos.y }}
    >
      <Header
        siteInfo={siteInfo}
        onDragStart={onDragStart}
        onMinimize={onMinimize}
        isEditing={isEditing}
        onEditToggle={onEditToggle}
        onToggleXTrade={onToggleXTrade}
        xTradeActive={xTradeActive}
        onToggleLimitTrade={onToggleLimitTrade}
        autotradeActive={autotradeActive}
        onToggleRpc={onToggleRpc}
        rpcActive={rpcActive}
        onToggleDailyAnalysis={onToggleDailyAnalysis}
        dailyAnalysisActive={dailyAnalysisActive}
        onToggleReview={onToggleReview}
        reviewActive={reviewActive}
        onToggleCooking={onToggleCooking}
        cookingActive={cookingActive}
        keyboardShortcutsEnabled={keyboardShortcutsEnabled}
        onToggleKeyboardShortcuts={onToggleKeyboardShortcuts}
        walletSelectorVisible={walletSelectorVisible}
        walletSelectorOpen={walletSelectorOpen}
        walletSelectedCount={selectedTradeWallets.length}
        walletTotalCount={walletAccounts.length}
        onToggleWalletSelector={handleToggleWalletSelector}
      />
      {!siteInfo.showBar && (
        <div className="relative flex flex-col">
          {walletSelectorVisible && (
            <WalletSelectorDropdown
              open={walletSelectorOpen}
              selectedTradeWallets={selectedTradeWallets}
              walletAccounts={walletAccounts}
              activeWalletAddress={activeWalletAddress}
              onToggleTradeWallet={onToggleTradeWallet}
              multiWalletBuyMode={multiWalletBuyMode}
              childWalletBuyPresetAmountsNative={childWalletBuyPresetAmountsNative}
              onChangeMultiWalletBuyMode={onChangeMultiWalletBuyMode}
              onUpdateChildWalletBuyPresetAmount={onUpdateChildWalletBuyPresetAmount}
              walletNativeBalancesWei={walletNativeBalancesWei}
              walletTokenBalancesWei={walletTokenBalancesWei}
              tokenDecimals={tokenDecimals}
              nativeSymbol={nativeSymbol}
              nativeDecimals={nativeDecimals}
              onRequestClose={() => setWalletSelectorOpen(false)}
            />
          )}
          <BuySection
            formattedNativeBalance={formattedNativeBalance}
            baseSymbol={tradeBaseSymbol}
            baseTokenPriceUsd={tradeBasePriceUsd}
            quotedUsdValues={buyPreviewQuotedUsd}
            quotedTokenAmounts={buyPreviewQuotedTokenAmounts}
            tokenPriceUsd={tokenPriceUsd}
            tokenSymbol={tokenSymbol}
            previewRouteLabel={buyPreviewRoute}
            isAltfunLayout={siteInfo.platform === 'altfun'}
            busy={busy}
            isUnlocked={isUnlocked}
            onBuy={onBuy}
            settings={settings}
            dynamicGasBasePriceWei={dynamicGasBasePriceWei}
            onToggleMode={onToggleMode}
            onToggleGas={onToggleBuyGas}
            onTogglePriorityFeePreset={onToggleBuyPriorityFeePreset}
            onToggleSlippage={onToggleSlippage}
            isEditing={isEditing}
            onUpdatePreset={onUpdateBuyPreset}
            draftPresets={draftBuyPresets}
            quickBuyAdvancedEnabled={quickBuyAdvancedEnabled}
            quickBuyPresetOverrides={quickBuyPresetOverrides}
            onToggleQuickBuyAdvanced={onToggleQuickBuyAdvanced}
            onToggleQuickBuyPresetGas={onToggleQuickBuyPresetGas}
            onToggleQuickBuyPresetPriorityFee={onToggleQuickBuyPresetPriorityFee}
            locale={locale}
            showHotkeys={showBuyHotkeys}
            hotkeyLabels={['Q', 'W', 'E', 'R'] as [string, string, string, string]}
            childPresetActiveWalletCounts={childPresetActiveWalletCounts}
            childPresetTooltipTexts={childPresetTooltipTexts}
            gmgnVisible={false}
            gmgnEnabled={gmgnBuyEnabled}
            onToggleGmgn={onToggleGmgnBuy}
            advancedAutoSell={advancedAutoSell}
            onUpdateAdvancedAutoSell={onUpdateAdvancedAutoSell}
            channelActiveKey={channelActiveKey}
            channelOptions={channelOptions}
            channelRouteTagLabel={buyPreviewRoute}
            onSelectChannel={onSelectChannel}
            prewarmIndicatorState={prewarmIndicatorState}
            prewarmIndicatorTitle={prewarmIndicatorTitle}
          />

          <div className="mx-3 h-px bg-zinc-800/80" />

          <div className="pt-0.5">
            <SellSection {...sellSectionProps} />
          </div>

          {(siteInfo.platform === 'gmgn' || settings?.chainId === 501) && (
            <div className="border-t border-zinc-800/80 bg-zinc-950/10">
              <FooterStats
                holdingStats={holdingStats}
              />
            </div>
          )}

          <Overlays
            siteInfo={siteInfo}
            isUnlocked={isUnlocked}
            onUnlock={onUnlock}
            locale={locale}
          />
        </div>
      )}
    </div>
  );
}
