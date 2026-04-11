import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Settings } from '@/types/extention';
import type { SiteInfo } from '@/utils/sites';
import type { Locale } from '@/utils/i18n';
import { Header } from './Header';
import { BuySection } from './BuySection';
import { SellSection } from './SellSection';
import { Overlays } from './Overlays';
import { Logo } from '@/components/Logo';

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
  keyboardShortcutsEnabled: boolean;
  onToggleKeyboardShortcuts: () => void;
  formattedNativeBalance: string;
  busy: boolean;
  isUnlocked: boolean;
  onBuy: (amountStr: string) => void;
  settings: Settings | null;
  onToggleMode: () => void;
  onToggleBuyGas: () => void;
  onToggleSellGas: () => void;
  onToggleSlippage: () => void;
  onUpdateBuyPreset: (idx: number, value: string) => void;
  draftBuyPresets: string[];
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
  tokenSymbol: string | null;
  onSell: (pct: number) => void;
  onApprove: () => void;
  siteInfo: SiteInfo;
  onUnlock: () => void;
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
  keyboardShortcutsEnabled,
  onToggleKeyboardShortcuts,
  formattedNativeBalance,
  busy,
  isUnlocked,
  onBuy,
  settings,
  onToggleMode,
  onToggleBuyGas,
  onToggleSellGas,
  onToggleSlippage,
  onUpdateBuyPreset,
  draftBuyPresets,
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
  tokenSymbol,
  onSell,
  onApprove,
  siteInfo,
  onUnlock,
}: QuickTradePanelProps) {
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
      className="fixed z-[2147483647] w-[320px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/50 font-sans flex flex-col"
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
        keyboardShortcutsEnabled={keyboardShortcutsEnabled}
        onToggleKeyboardShortcuts={onToggleKeyboardShortcuts}
      />
      {!siteInfo.showBar && (
        <div className="relative flex flex-col">
          <BuySection
            formattedNativeBalance={formattedNativeBalance}
            busy={busy}
            isUnlocked={isUnlocked}
            onBuy={onBuy}
            settings={settings}
            onToggleMode={onToggleMode}
            onToggleGas={onToggleBuyGas}
            onToggleSlippage={onToggleSlippage}
            isEditing={isEditing}
            onUpdatePreset={onUpdateBuyPreset}
            draftPresets={draftBuyPresets}
            locale={locale}
            showHotkeys={showBuyHotkeys}
            hotkeyLabels={['Q', 'W', 'E', 'R'] as [string, string, string, string]}
            gmgnVisible={false}
            gmgnEnabled={gmgnBuyEnabled}
            onToggleGmgn={onToggleGmgnBuy}
            advancedAutoSell={advancedAutoSell}
            onUpdateAdvancedAutoSell={onUpdateAdvancedAutoSell}
          />

          <div className="h-px bg-zinc-800 mx-3"></div>

          <SellSection
            formattedTokenBalance={formattedTokenBalance}
            tokenSymbol={tokenSymbol}
            busy={busy}
            isUnlocked={isUnlocked}
            onSell={onSell}
            settings={settings}
            onToggleMode={onToggleMode}
            onToggleGas={onToggleSellGas}
            onToggleSlippage={onToggleSlippage}
            onApprove={onApprove}
            isEditing={isEditing}
            onUpdatePreset={onUpdateSellPreset}
            draftPresets={draftSellPresets}
            locale={locale}
            showHotkeys={showSellHotkeys}
            hotkeyLabels={['A', 'S', 'D', 'F'] as [string, string, string, string]}
            gmgnVisible={false}
            gmgnEnabled={gmgnSellEnabled}
            onToggleGmgn={onToggleGmgnSell}
          />

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
