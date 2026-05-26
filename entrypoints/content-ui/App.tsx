import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { SatelliteDish } from 'lucide-react';
import { formatUnits, parseUnits, zeroAddress } from 'viem';
import type { Account, BgGetStateResponse, Settings, TradeSuccessSoundPreset } from '@/types/extention';
import type { TokenInfo, TokenStat } from '@/types/token';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { formatBroadcastProvider, formatPriceValue } from '@/utils/format';
import { parseCurrentUrl, parseCurrentUrlFull, type SiteInfo } from '@/utils/sites';
import { call } from '@/utils/messaging';
import { TokenAPI } from '@/hooks/TokenAPI';
import GmgnAPI from '@/hooks/GmgnAPI';
import { getChainIdByName, getNativeSymbol } from '@/constants/chains';
import { getChainRuntime } from '@/constants/chains/runtime';
import { USDC, USDT } from '@/constants/tokens/chains/common';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import {
  buildStrategyRollingTakeProfitOrderInputs,
  buildStrategySellOrderInputs,
  buildStrategyTrailingSellOrderInputs,
  getAdvancedAutoSellMode,
} from '@/services/limitOrders/advancedAutoSell';

import { CustomToaster } from './components/CustomToaster';
import { LimitTradePanel } from './components/LimitTradePanel';
import { XTradePanel } from './components/XTradePanel';
import { NewPoolMonitorPanel } from './components/XTradePanel/NewPoolMonitor';
import { RpcPanel } from './components/RpcPanel';
import { DailyAnalysisPanel } from './components/DailyAnalysisPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { QuickTradePanel } from './components/QuickTradePanel';
import { FloatingToolbar } from './components/FloatingToolbar';
import { CookingPanel } from './components/CookingPanel';
import { useDynamicGasPreview } from './components/QuickTradePanel/useDynamicGasPreview';

type NewPoolMonitorDisplayMode = 'floating' | 'tab';
type XTradeTab = 'xmonitor' | 'xsniper' | 'xtokensniper' | 'xnewcoinsniper' | 'xnewpoolmonitor';

const XTRADE_ACTIVE_TAB_STORAGE_KEY = 'dagobang_xtrade_active_tab';

function readPersistedXTradeTab(): XTradeTab {
  try {
    const raw = String(window.localStorage.getItem(XTRADE_ACTIVE_TAB_STORAGE_KEY) || '').trim();
    if (
      raw === 'xmonitor'
      || raw === 'xsniper'
      || raw === 'xtokensniper'
      || raw === 'xnewcoinsniper'
      || raw === 'xnewpoolmonitor'
    ) {
      return raw;
    }
  } catch {
  }
  return 'xmonitor';
}

const PRIORITY_FEE_PRESETS = ['none', 'slow', 'standard', 'fast'] as const;
type PriorityFeePreset = (typeof PRIORITY_FEE_PRESETS)[number];
const DEFAULT_PRIORITY_FEE_PRESET_VALUES = {
  none: '0',
  slow: '0.000025',
  standard: '0.00004',
  fast: '0.0001',
} as const;
const STATE_CHANGE_PROBE_ENABLED_KEY = 'dagobang_state_change_probe_enabled_v1';
const STATE_CHANGE_PROBE_LOG_INTERVAL_MS = 30_000;

function normalizeAddr(addr: string): `0x${string}` | null {
  const trimmed = typeof addr === 'string' ? addr.trim() : '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
}

function getTokenInfoWarmFingerprint(tokenInfo: TokenInfo | null | undefined): string {
  if (!tokenInfo) return '';
  return [
    String(tokenInfo.launchpad_platform || '').toLowerCase(),
    String(tokenInfo.launchpad_status ?? ''),
    String(tokenInfo.pool_pair || '').toLowerCase(),
    String(tokenInfo.dex_type || '').toLowerCase(),
    String(tokenInfo.quote_token_address || '').toLowerCase(),
  ].join('|');
}

function resolveTradeBaseTokenAddress(settings: Settings | null | undefined, chainIdOverride?: number): `0x${string}` {
  const chainId = chainIdOverride ?? settings?.chainId ?? 56;
  const runtime = getChainRuntime(chainId);
  const baseToken = String(settings?.chains?.[chainId]?.tradeBaseToken ?? settings?.tradeBaseToken ?? 'BNB').toUpperCase();
  if (baseToken === 'WBNB') return runtime.wrappedNativeAddress;
  if (baseToken === 'USDC') return (USDC[chainId as keyof typeof USDC]?.address ?? zeroAddress) as `0x${string}`;
  if (baseToken === 'USDT') return (USDT[chainId as keyof typeof USDT]?.address ?? zeroAddress) as `0x${string}`;
  return zeroAddress;
}

function resolveTradeBaseTokenMeta(chainId: number, tradeBaseTokenAddress: `0x${string}`) {
  const runtime = getChainRuntime(chainId);
  const target = tradeBaseTokenAddress.toLowerCase();
  if (target === zeroAddress.toLowerCase()) {
    return { symbol: runtime.nativeSymbol, decimals: runtime.viemChain.nativeCurrency.decimals };
  }

  if (target === runtime.wrappedNativeAddress.toLowerCase()) {
    return { symbol: `W${runtime.nativeSymbol}`, decimals: runtime.viemChain.nativeCurrency.decimals };
  }

  const usdc = USDC[chainId as keyof typeof USDC];
  if (usdc && target === usdc.address.toLowerCase()) {
    return { symbol: usdc.symbol, decimals: usdc.decimals };
  }

  const usdt = USDT[chainId as keyof typeof USDT];
  if (usdt && target === usdt.address.toLowerCase()) {
    return { symbol: usdt.symbol, decimals: usdt.decimals };
  }

  return { symbol: 'TOKEN', decimals: runtime.viemChain.nativeCurrency.decimals };
}

function deriveUsdFromBaseAmount(
  amount: number,
  tradeBaseTokenAddress: `0x${string}`,
  tradeBaseTokenMeta: { symbol: string },
  baseTokenPriceUsd: number | null,
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const symbol = tradeBaseTokenMeta.symbol.toUpperCase();
  if (symbol === 'USDC' || symbol === 'USDT') return amount;
  if (tradeBaseTokenAddress.toLowerCase() === zeroAddress.toLowerCase()) {
    return baseTokenPriceUsd && baseTokenPriceUsd > 0 ? amount * baseTokenPriceUsd : null;
  }
  return baseTokenPriceUsd && baseTokenPriceUsd > 0 ? amount * baseTokenPriceUsd : null;
}

function deriveBaseAmountFromUsd(
  usdAmount: number,
  tradeBaseTokenMeta: { symbol: string },
  baseTokenPriceUsd: number | null,
): number | null {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return null;
  const symbol = tradeBaseTokenMeta.symbol.toUpperCase();
  if (symbol === 'USDC' || symbol === 'USDT') return usdAmount;
  return baseTokenPriceUsd && baseTokenPriceUsd > 0 ? usdAmount / baseTokenPriceUsd : null;
}

function formatTokenAmountForDisplay(rawAmountWei: string | null | undefined, decimals: number): string {
  if (!rawAmountWei) return '0';
  try {
    const normalized = formatUnits(BigInt(rawAmountWei), decimals);
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) return normalized;
    if (numeric === 0) return '0';
    const formatted = formatPriceValue(numeric, 4, 6);
    return formatted === '-' ? '0' : formatted;
  } catch {
    return '0';
  }
}

function resolveSelectedTradeWallets(
  wallet: BgGetStateResponse['wallet'] | null | undefined,
  settings: Settings | null | undefined
): `0x${string}`[] {
  if (!wallet?.isUnlocked) return [];
  const allAccounts = Array.isArray(wallet.accounts) ? wallet.accounts : [];
  const byLower = new Map<string, `0x${string}`>();
  for (const acc of allAccounts) {
    const normalized = normalizeAddr(String(acc.address || ''));
    if (!normalized) continue;
    byLower.set(normalized.toLowerCase(), normalized);
  }
  const selectedRaw = Array.isArray(settings?.selectedTradeWallets) ? settings!.selectedTradeWallets : [];
  const picked = selectedRaw
    .map((x) => byLower.get(String(x).toLowerCase()))
    .filter(Boolean) as `0x${string}`[];
  const deduped = Array.from(new Set(picked.map((x) => x.toLowerCase()))).map((x) => byLower.get(x)!).filter(Boolean);
  if (deduped.length > 0) return deduped;
  const fallback = normalizeAddr(String(wallet.address || ''));
  return fallback ? [fallback] : [];
}

export default function App() {
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(() => parseCurrentUrl(window.location.href));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<BgGetStateResponse | null>(null);
  const [sellPercent, setSellPercent] = useState(25);
  const [tokenInfo, setTokenInfo] = useState<any | null>(null);
  const [tokenDecimals, setTokenDecimals] = useState<number | null>(null);
  const [tokenSymbol, setTokenSymbol] = useState<string | null>(null);
  const [tokenBalanceWei, setTokenBalanceWei] = useState<string>('0');
  const [tradeBaseBalanceWei, setTradeBaseBalanceWei] = useState<string>('0');
  const [walletNativeBalancesWei, setWalletNativeBalancesWei] = useState<Record<string, string>>({});
  const [walletTradeBaseBalancesWei, setWalletTradeBaseBalancesWei] = useState<Record<string, string>>({});
  const [walletTokenBalancesWei, setWalletTokenBalancesWei] = useState<Record<string, string>>({});
  const [txHash, setTxHash] = useState<string | null>(null);
  const [pendingBuyTokenMinOutWei, setPendingBuyTokenMinOutWei] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftBuyPresets, setDraftBuyPresets] = useState<string[]>([]);
  const [draftSellPresets, setDraftSellPresets] = useState<string[]>([]);
  const [tokenStat, setTokenStat] = useState<TokenStat | null>(null);
  const [tokenPriceUsd, setTokenPriceUsd] = useState<number | null>(null);
  const [tradeBasePriceUsd, setTradeBasePriceUsd] = useState<number | null>(null);
  const [buyPreviewQuotedUsd, setBuyPreviewQuotedUsd] = useState<Array<number | null>>([null, null, null, null]);
  const [buyPreviewQuotedTokenAmounts, setBuyPreviewQuotedTokenAmounts] = useState<Array<number | null>>([null, null, null, null]);
  const [sellPreviewQuotedUsd, setSellPreviewQuotedUsd] = useState<Array<number | null>>([null, null, null, null]);
  const [sellPreviewQuotedBaseAmounts, setSellPreviewQuotedBaseAmounts] = useState<Array<number | null>>([null, null, null, null]);
  const [marketCapDisplay, setMarketCapDisplay] = useState<string | null>(null);
  const [liquidityDisplay, setLiquidityDisplay] = useState<string | null>(null);
  const [pendingQuickBuy, setPendingQuickBuy] = useState<{ tokenAddress: string; amount: string } | null>(null);
  const [cookingSiteInfoOverride, setCookingSiteInfoOverride] = useState<SiteInfo | null>(null);
  const [cookingTokenInfoOverride, setCookingTokenInfoOverride] = useState<TokenInfo | null>(null);
  const [cookingTokenInfoLoading, setCookingTokenInfoLoading] = useState(false);
  const [gmgnBuyEnabled, setGmgnBuyEnabled] = useState(false);
  const [gmgnSellEnabled, setGmgnSellEnabled] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const siteInfoRef = useRef<SiteInfo | null>(siteInfo);
  const pendingQuickBuyRef = useRef<{ tokenAddress: string; amount: string } | null>(pendingQuickBuy);
  const settingsRef = useRef<Settings | null>(null);
  const effectiveChainIdRef = useRef<number>(56);
  const minimizedRef = useRef(false);
  const isEditingRef = useRef(false);
  const keyboardEnabledRef = useRef(false);
  const spaceHeldRef = useRef(false);
  const handleBuyRef = useRef<(amountStr: string, presetIndex: number) => void>(() => { });
  const handleSellRef = useRef<(pct: number) => void>(() => { });
  const prewarmedTurboRef = useRef<Set<string>>(new Set());
  const prewarmedRpcRef = useRef<Set<string>>(new Set());
  const fastPollingRef = useRef<any>(null);
  const tokenRefreshSeqRef = useRef(0);
  const bgStateChangedSeqRef = useRef(0);
  const bgStateChangedHandledAtRef = useRef(0);
  const bgStateChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateChangeProbeRef = useRef({
    startedAtMs: Date.now(),
    bgStateChangedReceived: 0,
    refreshAllCalls: 0,
    refreshAllBySource: {} as Record<string, number>,
    refreshTokenCalls: 0,
    refreshTokenBySource: {} as Record<string, number>,
    loadStateCalls: 0,
  });
  const cookingTokenInfoReqSeqRef = useRef(0);
  const deleteSoundPlayedAtRef = useRef<Record<string, number>>({});
  const autoTradeOrderSoundPlayedAtRef = useRef<Record<string, number>>({});

  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
    const defaultY = 100;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const [showCookingPanel, setShowCookingPanel] = useState(false);
  const [showLimitTradePanel, setShowLimitTradePanel] = useState(false);
  const [showXTradePanel, setShowXTradePanel] = useState(false);
  const [showNewPoolMonitorPanel, setShowNewPoolMonitorPanel] = useState(false);
  const [newPoolMonitorDisplayMode, setNewPoolMonitorDisplayMode] = useState<NewPoolMonitorDisplayMode>(() => {
    try {
      return window.localStorage.getItem('dagobang_newpool_monitor_display_mode') === 'tab' ? 'tab' : 'floating';
    } catch {
      return 'floating';
    }
  });
  const [xTradeActiveTab, setXTradeActiveTab] = useState<XTradeTab>(() => readPersistedXTradeTab());
  const [showRpcPanel, setShowRpcPanel] = useState(false);
  const [showDailyAnalysisPanel, setShowDailyAnalysisPanel] = useState(false);
  const [showReviewPanel, setShowReviewPanel] = useState(false);
  const dragging = useRef<null | { target: 'main'; startX: number; startY: number; baseX: number; baseY: number }>(null);

  const isUnlocked = !!state?.wallet.isUnlocked;
  const settings: Settings | null = state?.settings ?? null;
  const address = state?.wallet.address ?? null;
  const walletAccounts = (state?.wallet.accounts ?? []) as Account[];
  const siteChainId = useMemo(() => {
    if (!siteInfo?.chain) return null;
    const resolved = getChainIdByName(siteInfo.chain);
    return Number.isFinite(resolved) && resolved > 0 ? resolved : null;
  }, [siteInfo?.chain]);
  const chainId = siteChainId ?? settings?.chainId ?? 56;
  const effectiveChainSettings = settings?.chains?.[chainId] ?? null;
  const effectiveScopedSettings = useMemo(
    () => (settings ? { ...settings, chainId } : null),
    [settings, chainId]
  );
  const selectedTradeWallets = useMemo(
    () => resolveSelectedTradeWallets(state?.wallet, settings),
    [state?.wallet, settings]
  );
  const multiWalletBuyMode: 'uniform' | 'child_custom' = settings?.multiWalletBuyMode === 'child_custom' ? 'child_custom' : 'uniform';
  const childWalletBuyPresetAmountsNative: Record<string, string[]> = settings?.childWalletBuyPresetAmountsNative ?? {};
  const childPresetActiveWalletCounts = useMemo<[number, number, number, number]>(() => {
    if (multiWalletBuyMode !== 'child_custom') return [0, 0, 0, 0];
    if (selectedTradeWallets.length <= 0) return [0, 0, 0, 0];
    const mainWalletLower = (() => {
      const activeLower = String(address || '').toLowerCase();
      if (activeLower && selectedTradeWallets.some((w) => w.toLowerCase() === activeLower)) return activeLower;
      return selectedTradeWallets[0].toLowerCase();
    })();
    const counts: [number, number, number, number] = [0, 0, 0, 0];
    for (const walletAddress of selectedTradeWallets) {
      const lower = walletAddress.toLowerCase();
      if (lower === mainWalletLower) continue;
      const presets = childWalletBuyPresetAmountsNative[lower];
      for (const idx of [0, 1, 2, 3] as const) {
        const raw = String(presets?.[idx] || '').trim();
        const num = Number(raw);
        if (raw && Number.isFinite(num) && num > 0) counts[idx] += 1;
      }
    }
    return counts;
  }, [multiWalletBuyMode, selectedTradeWallets, address, childWalletBuyPresetAmountsNative]);
  const nativeSymbol = useMemo(() => {
    return getNativeSymbol(chainId);
  }, [chainId]);
  const tradeBaseTokenAddress = useMemo(() => resolveTradeBaseTokenAddress(settings, chainId), [settings, chainId]);
  const tradeBaseTokenMeta = useMemo(() => {
    return resolveTradeBaseTokenMeta(chainId, tradeBaseTokenAddress);
  }, [tradeBaseTokenAddress, chainId]);
  const tradeBaseTokenSymbol = tradeBaseTokenMeta.symbol;
  const tokenAddressNormalized = useMemo(() => {
    if (!siteInfo?.tokenAddress) return null;
    const t = siteInfo.tokenAddress.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(t) ? (t as `0x${string}`) : null;
  }, [siteInfo]);
  const consoleLogsEnabled = settings?.ui?.consoleLogsEnabled === true;
  const isStateChangeProbeEnabled = () => {
    try {
      return window.localStorage.getItem(STATE_CHANGE_PROBE_ENABLED_KEY) === '1';
    } catch {
      return false;
    }
  };
  const noteStateChangeProbe = (event: 'bgStateChangedReceived' | 'refreshAll' | 'refreshToken' | 'loadState', source?: string) => {
    if (!isStateChangeProbeEnabled()) return;
    const probe = stateChangeProbeRef.current;
    if (event === 'bgStateChangedReceived') {
      probe.bgStateChangedReceived += 1;
      return;
    }
    if (event === 'loadState') {
      probe.loadStateCalls += 1;
      return;
    }
    if (event === 'refreshAll') {
      probe.refreshAllCalls += 1;
      if (source) probe.refreshAllBySource[source] = (probe.refreshAllBySource[source] ?? 0) + 1;
      return;
    }
    probe.refreshTokenCalls += 1;
    if (source) probe.refreshTokenBySource[source] = (probe.refreshTokenBySource[source] ?? 0) + 1;
  };
  const emitStateChangeProbe = () => {
    if (!isStateChangeProbeEnabled()) return;
    const snapshot = {
      source: 'content-ui',
      nowMs: Date.now(),
      ...stateChangeProbeRef.current,
    };
    (window as any).__DAGOBANG_STATE_CHANGE_PROBE__ = snapshot;
    console.info('[state-change-probe]', snapshot);
  };
  const shouldDebugHyperReads = consoleLogsEnabled && (chainId === 999 || siteInfo?.platform === 'altfun');
  const logUiDebug = (event: string, payload: Record<string, unknown>) => {
    if (!consoleLogsEnabled) return;
    console.log(event, payload);
  };
  const warnUiDebug = (event: string, payload: Record<string, unknown>) => {
    if (!consoleLogsEnabled) return;
    console.warn(event, payload);
  };
  const logHyperReadDebug = (event: string, payload: Record<string, unknown>) => {
    if (!shouldDebugHyperReads) return;
    console.log(`[content-ui.${event}]`, {
      platform: siteInfo?.platform ?? null,
      chain: siteInfo?.chain ?? null,
      chainId,
      tokenAddress: tokenAddressNormalized ?? null,
      ...payload,
    });
  };
  const childPresetTooltipTexts = useMemo<[string, string, string, string]>(() => {
    const totals: [number, number, number, number] = [0, 0, 0, 0];
    if (multiWalletBuyMode === 'child_custom' && selectedTradeWallets.length > 0) {
      const mainWalletLower = (() => {
        const activeLower = String(address || '').toLowerCase();
        if (activeLower && selectedTradeWallets.some((w) => w.toLowerCase() === activeLower)) return activeLower;
        return selectedTradeWallets[0].toLowerCase();
      })();
      for (const walletAddress of selectedTradeWallets) {
        const lower = walletAddress.toLowerCase();
        if (lower === mainWalletLower) continue;
        const presets = childWalletBuyPresetAmountsNative[lower];
        for (const idx of [0, 1, 2, 3] as const) {
          const raw = String(presets?.[idx] || '').trim();
          const num = Number(raw);
          if (raw && Number.isFinite(num) && num > 0) totals[idx] += num;
        }
      }
    }
    const formatAmount = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });
    return ([0, 1, 2, 3] as const).map((idx) => {
      const count = childPresetActiveWalletCounts[idx];
      if (count <= 0) return '';
      return `子钱包 ${count} 个，合计 ${formatAmount(totals[idx])} ${tradeBaseTokenSymbol}`;
    }) as [string, string, string, string];
  }, [multiWalletBuyMode, selectedTradeWallets, address, childWalletBuyPresetAmountsNative, childPresetActiveWalletCounts, tradeBaseTokenSymbol]);
  const locale: Locale = normalizeLocale(settings?.locale);
  const displayedBuyPresets = useMemo(
    () => (isEditing && draftBuyPresets.length > 0
      ? draftBuyPresets
      : (settings?.chains[chainId]?.buyPresets || ['0.01', '0.2', '0.5', '1.0'])),
    [isEditing, draftBuyPresets, settings, chainId]
  );
  const displayedSellPresets = useMemo(
    () => (isEditing && draftSellPresets.length > 0
      ? draftSellPresets
      : (settings?.chains[chainId]?.sellPresets || ['10', '25', '50', '100'])),
    [isEditing, draftSellPresets, settings, chainId]
  );
  const toastPosition = settings?.toastPosition ?? 'top-center';
  const keyboardShortcutsEnabled = !!settings?.keyboardShortcutsEnabled;
  const tokenBalancePollIntervalMs = settings?.tokenBalancePollIntervalMs ?? 2000;
  const tokenBalanceRefreshThrottleMs = Math.max(200, tokenBalancePollIntervalMs);
  const dynamicGasEnabled = effectiveChainSettings?.gasPriceMode === 'dynamic' && !!tokenAddressNormalized;
  const { baseGasPriceWei: dynamicGasBasePriceWei } = useDynamicGasPreview(effectiveScopedSettings, dynamicGasEnabled);
  const { ensureReady: ensureTradeSuccessAudioReady, playBuy: playTradeBuySound, playSell: playTradeSellSound } = useTradeSuccessSound({
    enabled: settings?.tradeSuccessSoundEnabled,
    volume: settings?.tradeSuccessSoundVolume,
    buyPreset: settings?.tradeSuccessSoundPresetBuy,
    sellPreset: settings?.tradeSuccessSoundPresetSell,
  });
  const autoTradeSoundEnabled = settings?.autoTrade?.triggerSound?.enabled ?? true;
  const autoTradeSoundPreset = (settings?.autoTrade?.triggerSound?.preset ?? 'Boom') as any;
  const { ensureReady: ensureAutoTradeAudioReady, playPreset: playAutoTradePreset } = useTradeSuccessSound({
    enabled: autoTradeSoundEnabled,
    volume: settings?.tradeSuccessSoundVolume,
    buyPreset: autoTradeSoundPreset,
    sellPreset: autoTradeSoundPreset,
  });
  const deleteTweetSoundPreset = (settings?.autoTrade?.twitterSnipe?.deleteTweetSoundPreset ?? 'Handgun') as TradeSuccessSoundPreset;
  const { ensureReady: ensureDeleteTweetAudioReady, playPreset: playDeleteTweetPreset } = useTradeSuccessSound({
    enabled: true,
    volume: settings?.tradeSuccessSoundVolume,
    buyPreset: deleteTweetSoundPreset,
    sellPreset: deleteTweetSoundPreset,
  });

  useEffect(() => {
    siteInfoRef.current = siteInfo;
    pendingQuickBuyRef.current = pendingQuickBuy;
    settingsRef.current = settings;
    effectiveChainIdRef.current = chainId;
    minimizedRef.current = minimized;
    isEditingRef.current = isEditing;
    posRef.current = pos;
  }, [siteInfo, pendingQuickBuy, settings, chainId, minimized, isEditing, pos]);

  useEffect(() => {
    if (settings) {
      (window as any).__DAGOBANG_SETTINGS__ = settings;
    }
  }, [settings]);

  useEffect(() => {
    keyboardEnabledRef.current = keyboardShortcutsEnabled;
    if (!keyboardShortcutsEnabled && spaceHeldRef.current) {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    }
  }, [keyboardShortcutsEnabled]);

  useEffect(() => {
    try {
      const posKey = 'dagobang_content_ui_pos';
      const posStored = window.localStorage.getItem(posKey);
      if (posStored) {
        const parsed = JSON.parse(posStored);
        if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const width = window.innerWidth || 0;
          const height = window.innerHeight || 0;
          const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 340));
          const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
          setPos({ x: clampedX, y: clampedY });
        }
      }
    } catch {
    }

    try {
      const key = 'dagobang_limit_trade_panel_visible';
      const stored = window.localStorage.getItem(key);
      if (stored) setShowLimitTradePanel(stored === '1');
    } catch {
    }

    try {
      const xTradePanelStored = window.localStorage.getItem('dagobang_xtrade_panel_visible');
      const host = String(window.location.hostname || '').toLowerCase();
      if (host.includes('gmgn')) {
        setShowXTradePanel(xTradePanelStored === '1');
      }
    } catch {
    }

    try {
      const stored = window.localStorage.getItem('dagobang_review_panel_visible');
      if (stored) setShowReviewPanel(stored === '1');
    } catch {
    }

    try {
      const stored = window.localStorage.getItem('dagobang_cooking_panel_visible');
      if (stored) setShowCookingPanel(stored === '1');
    } catch {
    }

    try {
      const stored = window.localStorage.getItem('dagobang_newpool_monitor_visible');
      if (stored === '1') {
        if (newPoolMonitorDisplayMode === 'tab') {
          setXTradeActiveTab('xnewpoolmonitor');
          setShowXTradePanel(true);
        } else {
          setShowNewPoolMonitorPanel(true);
        }
      }
    } catch {
    }

  }, []);

  useEffect(() => {
    const newPoolMonitorVisible = newPoolMonitorDisplayMode === 'tab'
      ? showXTradePanel && xTradeActiveTab === 'xnewpoolmonitor'
      : showNewPoolMonitorPanel;
    try {
      window.localStorage.setItem('dagobang_limit_trade_panel_visible', showLimitTradePanel ? '1' : '0');
    } catch {
    }
    try {
      window.localStorage.setItem(
        'dagobang_xtrade_panel_visible',
        showXTradePanel ? '1' : '0'
      );
    } catch {
    }
    try {
      window.localStorage.setItem(XTRADE_ACTIVE_TAB_STORAGE_KEY, xTradeActiveTab);
    } catch {
    }
    try {
      window.localStorage.setItem('dagobang_review_panel_visible', showReviewPanel ? '1' : '0');
    } catch {
    }
    try {
      window.localStorage.setItem('dagobang_cooking_panel_visible', showCookingPanel ? '1' : '0');
    } catch {
    }
    try {
      window.localStorage.setItem('dagobang_newpool_monitor_visible', newPoolMonitorVisible ? '1' : '0');
    } catch {
    }
    try {
      window.localStorage.setItem('dagobang_newpool_monitor_display_mode', newPoolMonitorDisplayMode);
    } catch {
    }
  }, [showLimitTradePanel, showXTradePanel, showReviewPanel, showCookingPanel, showNewPoolMonitorPanel, newPoolMonitorDisplayMode, xTradeActiveTab]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const toEditable = (node: Element | null) => {
        if (!node) return false;
        const tag = (node.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if ((node as HTMLElement).isContentEditable) return true;
        if (node.closest('input,textarea,select,[contenteditable="true"]')) return true;
        return false;
      };
      const targetEl = target instanceof Element ? target : null;
      const activeEl = document.activeElement;
      if (toEditable(targetEl)) return true;
      if (activeEl instanceof Element && toEditable(activeEl)) return true;
      return false;
    };

    const clearSpaceHeld = () => {
      if (!spaceHeldRef.current) return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!keyboardEnabledRef.current) return;
      if (minimizedRef.current) return;
      if (isEditingRef.current) return;
      if (isEditableTarget(e.target)) return;

      if (e.code === 'Space') {
        if (!spaceHeldRef.current) {
          spaceHeldRef.current = true;
          setSpaceHeld(true);
        }
        return;
      }

      if (!spaceHeldRef.current) return;

      const key = String(e.key || '').toLowerCase();
      const buyMap = 'qwer';
      const sellMap = 'asdf';

      if (buyMap.includes(key)) {
        const s = settingsRef.current;
        if (!s) return;
        const idx = buyMap.indexOf(key);
        const activeChainId = effectiveChainIdRef.current;
        const presets = s.chains[activeChainId]?.buyPresets ?? ['0.01', '0.2', '0.5', '1.0'];
        const amt = presets[idx];
        if (!amt) return;
        handleBuyRef.current(amt, idx);
        return;
      }

      if (sellMap.includes(key)) {
        const s = settingsRef.current;
        if (!s) return;
        const idx = sellMap.indexOf(key);
        const activeChainId = effectiveChainIdRef.current;
        const presets = s.chains[activeChainId]?.sellPresets ?? ['10', '25', '50', '100'];
        const pctStr = presets[idx];
        const pct = Number(pctStr);
        if (!Number.isFinite(pct)) return;
        handleSellRef.current(pct);
        return;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') clearSpaceHeld();
    };

    const onBlur = () => clearSpaceHeld();

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur, true);
    document.addEventListener('visibilitychange', onBlur, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur, true);
      document.removeEventListener('visibilitychange', onBlur, true);
    };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      if (!((settingsRef.current?.ui?.quickCookingEnabled) ?? false)) return;
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      const addr = detail.tokenAddress as string | undefined;
      const amount = detail.amountBnb as string | undefined;
      if (!addr || !amount) return;
      if (!settings) return;
      const site: SiteInfo = {
        chain: 'bsc',
        tokenAddress: addr,
        platform: 'gmgn',
      };
      siteInfoRef.current = site;
      setSiteInfo(site);
      setIsEditing(false);
      const quickBuyChainId = getChainIdByName(site.chain) || 56;
      setDraftBuyPresets(settings.chains[quickBuyChainId]?.buyPresets || ['0.01', '0.2', '0.5', '1.0']);
      setDraftSellPresets(settings.chains[quickBuyChainId]?.sellPresets || ['10', '25', '50', '100']);
      setPendingQuickBuy({ tokenAddress: addr.toLowerCase(), amount });
    };
    window.addEventListener('dagobang-quickbuy' as any, handler as any);
    return () => {
      window.removeEventListener('dagobang-quickbuy' as any, handler as any);
    };
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      const addr = typeof detail.tokenAddress === 'string' ? detail.tokenAddress.trim() : '';
      if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return;
      const chain = typeof detail.chain === 'string' && detail.chain.trim()
        ? detail.chain.trim().toLowerCase()
        : 'bsc';
      const platform = detail.platform === 'gmgn' ? 'gmgn' : 'gmgn';
      const nextSiteInfo: SiteInfo = {
        chain,
        tokenAddress: addr,
        platform,
        showBar: true,
      };
      const reqSeq = cookingTokenInfoReqSeqRef.current + 1;
      cookingTokenInfoReqSeqRef.current = reqSeq;
      setCookingSiteInfoOverride(nextSiteInfo);
      setCookingTokenInfoOverride(null);
      setCookingTokenInfoLoading(true);
      setShowCookingPanel(true);
      void TokenAPI.getTokenInfo(platform, chain, addr)
        .then((meta) => {
          if (disposed) return;
          if (cookingTokenInfoReqSeqRef.current !== reqSeq) return;
          setCookingTokenInfoOverride(meta);
        })
        .catch((error) => {
          if (disposed) return;
          if (cookingTokenInfoReqSeqRef.current !== reqSeq) return;
          console.error('Failed to load quick cooking token info', error);
        })
        .finally(() => {
          if (disposed) return;
          if (cookingTokenInfoReqSeqRef.current !== reqSeq) return;
          setCookingTokenInfoLoading(false);
        });
    };
    window.addEventListener('dagobang-quickcooking' as any, handler as any);
    return () => {
      disposed = true;
      window.removeEventListener('dagobang-quickcooking' as any, handler as any);
    };
  }, []);

  // Monitor URL changes
  useEffect(() => {
    let disposed = false;
    let seq = 0;
    let scheduled = false;
    const lastHrefRef = { current: window.location.href };

    const apply = (next: SiteInfo | null) => {
      if (JSON.stringify(next) === JSON.stringify(siteInfoRef.current)) return;
      siteInfoRef.current = next;
      setSiteInfo(next);
    };

    const check = async (hrefOverride?: string) => {
      if (disposed) return;
      if (document.hidden) return;
      if (pendingQuickBuyRef.current) return;

      const href = hrefOverride ?? window.location.href;
      lastHrefRef.current = href;
      apply(parseCurrentUrl(href));

      const requestSeq = (seq += 1);
      const info = await parseCurrentUrlFull(href);
      if (disposed) return;
      if (requestSeq !== seq) return;
      apply(info);
    };

    const scheduleHrefDetect = () => {
      if (scheduled) return;
      scheduled = true;

      let tries = 0;
      const tick = () => {
        scheduled = false;
        if (disposed) return;
        if (document.hidden) return;

        const href = window.location.href;
        if (href !== lastHrefRef.current) {
          void check(href);
          return;
        }

        tries += 1;
        if (tries >= 12) return;
        scheduled = true;
        window.setTimeout(tick, 50);
      };

      window.setTimeout(tick, 0);
    };

    void check();

    const onVis = () => {
      if (!document.hidden) {
        void check();
        scheduleHrefDetect();
      }
    };

    const onUrl = () => {
      if (!document.hidden) {
        void check();
        scheduleHrefDetect();
      }
    };

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window) return;
      const data = e.data as any;
      if (!data || data.type !== 'DAGOBANG_URL_CHANGE') return;
      if (typeof data.href !== 'string') return;
      if (!document.hidden) void check(data.href);
    };

    const onClickCapture = () => {
      if (!document.hidden) scheduleHrefDetect();
    };

    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (document.hidden) return;
      if (e.key === 'Enter') scheduleHrefDetect();
    };

    const onSubmitCapture = () => {
      if (!document.hidden) scheduleHrefDetect();
    };

    const timer = window.setInterval(() => {
      void check();
    }, 2000);

    window.addEventListener('popstate', onUrl);
    window.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('click', onClickCapture, true);
    window.addEventListener('keydown', onKeyDownCapture, true);
    window.addEventListener('submit', onSubmitCapture, true);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('popstate', onUrl);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('keydown', onKeyDownCapture, true);
      window.removeEventListener('submit', onSubmitCapture, true);
    };
  }, []);

  const effectiveCookingSiteInfo = cookingSiteInfoOverride ?? siteInfo;
  const effectiveCookingTokenInfo = useMemo(() => {
    if (!cookingSiteInfoOverride) {
      return (tokenInfo as TokenInfo | null) ?? null;
    }
    if (cookingTokenInfoOverride) return cookingTokenInfoOverride;
    const overrideAddress = cookingSiteInfoOverride.tokenAddress.toLowerCase();
    if (tokenInfo && tokenAddressNormalized && overrideAddress === tokenAddressNormalized.toLowerCase()) {
      return tokenInfo as TokenInfo;
    }
    return null;
  }, [cookingSiteInfoOverride, cookingTokenInfoOverride, tokenInfo, tokenAddressNormalized]);
  const limitTradePanelOnlyOnTokenPage = settings?.ui?.limitTradePanelOnlyOnTokenPage ?? false;
  const quickCookingEnabled = settings?.ui?.quickCookingEnabled ?? false;
  const newPoolMonitorEnabled = settings?.ui?.newPoolMonitorEnabled ?? false;
  const newCoinSniperEnabled = settings?.ui?.newCoinSniperEnabled ?? false;
  const settingsReady = settings != null;
  const limitTradePanelVisible = showLimitTradePanel && (!limitTradePanelOnlyOnTokenPage || !!tokenAddressNormalized);
  const shouldKeepBaseBalancesWarm = !siteInfo?.showBar || limitTradePanelVisible;
  const shouldKeepTokenWarm = !!tokenAddressNormalized && (
    (!siteInfo?.showBar && !minimized)
    || limitTradePanelVisible
    || showCookingPanel
  );

  useEffect(() => {
    if (!settingsReady) return;
    if (!newPoolMonitorEnabled) {
      setShowNewPoolMonitorPanel(false);
      if (xTradeActiveTab === 'xnewpoolmonitor') {
        setXTradeActiveTab('xmonitor');
      }
    }
  }, [newPoolMonitorEnabled, settingsReady, xTradeActiveTab]);

  useEffect(() => {
    if (!settingsReady) return;
    if (!newCoinSniperEnabled && xTradeActiveTab === 'xnewcoinsniper') {
      setXTradeActiveTab('xmonitor');
    }
  }, [newCoinSniperEnabled, settingsReady, xTradeActiveTab]);

  const tokenContextKey = `${siteInfo?.platform ?? ''}:${siteInfo?.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
  const tokenContextKeyRef = useRef(tokenContextKey);
  useLayoutEffect(() => {
    if (tokenContextKeyRef.current === tokenContextKey) return;
    tokenContextKeyRef.current = tokenContextKey;
    tokenRefreshSeqRef.current += 1;
    if (fastPollingRef.current) {
      clearInterval(fastPollingRef.current);
      fastPollingRef.current = null;
    }
    setTokenInfo(null);
    setTokenSymbol(null);
    setTokenDecimals(null);
    setTokenBalanceWei('0');
    setTokenStat(null);
    setTokenPriceUsd(null);
    setMarketCapDisplay(null);
    setLiquidityDisplay(null);
    setTxHash(null);
    setPendingBuyTokenMinOutWei(null);
  }, [tokenContextKey]);

  useEffect(() => {
    if (!pendingQuickBuy) return;
    if (!settings) return;
    if (!tokenAddressNormalized) return;
    if (!tokenInfo) return;
    if (tokenAddressNormalized.toLowerCase() !== pendingQuickBuy.tokenAddress) return;
    handleBuy(pendingQuickBuy.amount, -1);
    setPendingQuickBuy(null);
  }, [pendingQuickBuy, tokenAddressNormalized, tokenInfo, settings]);

  useEffect(() => {
    if (!settings) return;
    const chain = settings.chains[chainId];
    if (!chain) return;
    const key = [
      chainId,
      ...(chain.rpcUrls ?? []),
      ...(chain.protectedRpcUrls ?? []),
      ...(((chain as any).protectedRpcUrlsBuy ?? []) as string[]),
      ...(((chain as any).protectedRpcUrlsSell ?? []) as string[]),
    ].join('|');
    if (prewarmedRpcRef.current.has(key)) return;
    prewarmedRpcRef.current.add(key);
    void call({
      type: 'rpc:prewarm',
      input: { timeoutMs: 1500 },
    } as const).catch(() => { });
  }, [settings, chainId]);

  useEffect(() => {
    if (!isUnlocked) return;
    if (!address) return;
    if (!settings) return;
    if (!tokenAddressNormalized) return;
    if (!tokenInfo) return;
    const key = `${chainId}:${address.toLowerCase()}:${tokenAddressNormalized.toLowerCase()}:${getTokenInfoWarmFingerprint(tokenInfo)}`;
    if (prewarmedTurboRef.current.has(key)) return;
    prewarmedTurboRef.current.add(key);
    void call({
      type: 'trade:prewarmTurbo',
      input: { chainId, tokenAddress: tokenAddressNormalized, tokenInfo: tokenInfo ?? undefined },
    } as const).catch(() => { });
  }, [isUnlocked, address, settings, tokenAddressNormalized, tokenInfo, chainId]);

  const formattedNativeBalance = useMemo(
    () => formatTokenAmountForDisplay(tradeBaseBalanceWei, tradeBaseTokenMeta.decimals),
    [tradeBaseBalanceWei, tradeBaseTokenMeta.decimals]
  );

  const formattedTokenBalance = useMemo(() => {
    if (!tokenBalanceWei) return '0';
    const val = BigInt(tokenBalanceWei);
    const decimals = Number.isFinite(tokenDecimals as number) && (tokenDecimals as number) >= 0
      ? Number(tokenDecimals)
      : 18;
    // Simple formatting for display
    if (val === 0n) return '0';
    return val > 1000n ? (val / (10n ** BigInt(decimals))).toString() : '>0';
  }, [tokenBalanceWei, tokenDecimals]);

  const numericTokenBalance = useMemo(() => {
    if (!tokenBalanceWei) return null;
    try {
      const decimals = Number.isFinite(tokenDecimals as number) && (tokenDecimals as number) >= 0
        ? Number(tokenDecimals)
        : 18;
      const normalized = Number(formatUnits(BigInt(tokenBalanceWei), decimals));
      return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
    } catch {
      return null;
    }
  }, [tokenBalanceWei, tokenDecimals]);

  const quoteSymbol = useMemo(() => {
    if (!tokenInfo) return null;
    return tokenInfo.quote_token || 'BNB';
  }, [tokenInfo]);

  const tokenPrice = useMemo(() => {
    if (tokenPriceUsd && Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0) {
      return tokenPriceUsd;
    }
    return null;
  }, [tokenPriceUsd]);

  useEffect(() => {
    let canceled = false;
    if (!settings || !siteInfo) return;

    const runtime = getChainRuntime(chainId);
    const priceTokenAddress = tradeBaseTokenAddress.toLowerCase() === zeroAddress.toLowerCase()
      ? runtime.wrappedNativeAddress
      : tradeBaseTokenAddress;
    const priceTokenMeta = priceTokenAddress.toLowerCase() === runtime.wrappedNativeAddress.toLowerCase()
      ? {
          address: priceTokenAddress,
          symbol: `W${runtime.nativeSymbol}`,
          decimals: runtime.viemChain.nativeCurrency.decimals,
        } as TokenInfo
      : null;
    const stableSymbol = tradeBaseTokenMeta.symbol.toUpperCase();
    if (stableSymbol === 'USDC' || stableSymbol === 'USDT') {
      setTradeBasePriceUsd(1);
      return;
    }

    void TokenAPI.getTokenPriceUsd(siteInfo.platform, chainId, priceTokenAddress, priceTokenMeta)
      .then((price) => {
        if (canceled) return;
        if (price && Number.isFinite(price) && price > 0) {
          setTradeBasePriceUsd(price);
        }
      })
      .catch(() => {
        if (canceled) return;
      });

    return () => {
      canceled = true;
    };
  }, [settings, siteInfo, tradeBaseTokenAddress, tradeBaseTokenMeta.symbol, chainId]);

  const quickTradePreviewRoutes = useMemo(() => {
    if (siteInfo?.platform === 'altfun' && chainId === 999) {
      const token = tokenSymbol || 'TOKEN';
      const base = tradeBaseTokenMeta.symbol;
      if (base.toUpperCase() === 'USDC') {
        return {
          buy: `USDC -> ${token}`,
          sell: `${token} -> USDC`,
        };
      }
      return {
        buy: `${base} -> USDC -> ${token}`,
        sell: `${token} -> USDC -> ${base}`,
      };
    }
    return { buy: null, sell: null };
  }, [siteInfo?.platform, chainId, tokenSymbol, tradeBaseTokenMeta.symbol]);

  useEffect(() => {
    if (!tokenAddressNormalized || !settings || !siteInfo || chainId !== 999 || siteInfo.platform !== 'altfun') {
      setBuyPreviewQuotedUsd([null, null, null, null]);
      setBuyPreviewQuotedTokenAmounts([null, null, null, null]);
      return;
    }

    const nextBuyUsd: Array<number | null> = [null, null, null, null];
    const nextBuyTokens: Array<number | null> = [null, null, null, null];

    displayedBuyPresets.slice(0, 4).forEach((raw, idx) => {
      const normalized = String(raw || '').replace(/,/g, '').trim();
      const amount = Number(normalized);
      if (!normalized || !Number.isFinite(amount) || amount <= 0) {
        return;
      }
      const usdAmount = deriveUsdFromBaseAmount(amount, tradeBaseTokenAddress, tradeBaseTokenMeta, tradeBasePriceUsd);
      nextBuyUsd[idx] = usdAmount;
      nextBuyTokens[idx] = usdAmount != null && tokenPriceUsd && tokenPriceUsd > 0
        ? usdAmount / tokenPriceUsd
        : null;
    });

    setBuyPreviewQuotedUsd(nextBuyUsd);
    setBuyPreviewQuotedTokenAmounts(nextBuyTokens);
  }, [
    tokenAddressNormalized,
    settings,
    siteInfo,
    chainId,
    displayedBuyPresets,
    tradeBaseTokenAddress,
    tradeBaseTokenMeta,
    tradeBasePriceUsd,
    tokenPriceUsd,
  ]);

  useEffect(() => {
    if (!tokenAddressNormalized || !settings || !siteInfo || chainId !== 999 || siteInfo.platform !== 'altfun') {
      setSellPreviewQuotedUsd([null, null, null, null]);
      setSellPreviewQuotedBaseAmounts([null, null, null, null]);
      return;
    }

    const nextSellUsd: Array<number | null> = [null, null, null, null];
    const nextSellBase: Array<number | null> = [null, null, null, null];
    const balanceAmount = numericTokenBalance ?? null;

    displayedSellPresets.slice(0, 4).forEach((raw, idx) => {
      const pct = Number(String(raw || '').replace(/,/g, '').trim());
      if (!Number.isFinite(pct) || pct <= 0 || balanceAmount == null || balanceAmount <= 0) {
        return;
      }
      const tokenAmount = (balanceAmount * pct) / 100;
      const usdAmount = tokenPriceUsd && tokenPriceUsd > 0 ? tokenAmount * tokenPriceUsd : null;
      const baseAmount = usdAmount != null ? deriveBaseAmountFromUsd(usdAmount, tradeBaseTokenMeta, tradeBasePriceUsd) : null;
      nextSellUsd[idx] = usdAmount;
      nextSellBase[idx] = baseAmount;
    });

    setSellPreviewQuotedUsd(nextSellUsd);
    setSellPreviewQuotedBaseAmounts(nextSellBase);
  }, [
    tokenAddressNormalized,
    settings,
    siteInfo,
    chainId,
    displayedSellPresets,
    numericTokenBalance,
    tradeBaseTokenMeta,
    tradeBasePriceUsd,
    tokenPriceUsd,
  ]);

  const lastTokenPriceRefresh = useRef(0);
  const tokenPriceReqSeq = useRef(0);
  useEffect(() => {
    tokenPriceReqSeq.current += 1;
    setTokenPriceUsd(null);
  }, [tokenAddressNormalized, chainId, siteInfo?.platform]);
  async function refreshTokenPrice(force = false, tokenInfoOverride?: TokenInfo | null) {
    if (document.hidden && !force) return;
    if (!settings || !siteInfo || !tokenAddressNormalized) {
      setTokenPriceUsd(null);
      return;
    }
    const reqCtxKey = `${siteInfo.platform ?? ''}:${siteInfo.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
    const now = Date.now();
    if (!force && now - lastTokenPriceRefresh.current < 5000) return;
    lastTokenPriceRefresh.current = now;

    const tokenAddr = tokenAddressNormalized;
    const addrLower = tokenAddr.toLowerCase();
    const baseTokenInfo = tokenInfoOverride !== undefined ? tokenInfoOverride : tokenInfo;
    const safeTokenInfo = baseTokenInfo && (baseTokenInfo as any).address?.toLowerCase?.() === addrLower ? baseTokenInfo : null;
    const tokenInfoPrice = safeTokenInfo && typeof safeTokenInfo.tokenPrice?.price === 'string'
      ? Number(safeTokenInfo.tokenPrice.price)
      : 0;
    const seq = tokenPriceReqSeq.current + 1;
    tokenPriceReqSeq.current = seq;
    if (!force && Number.isFinite(tokenInfoPrice) && tokenInfoPrice > 0) {
      if (reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenPriceUsd(tokenInfoPrice);
      return;
    }
    try {
      const v = await TokenAPI.getTokenPriceUsd(siteInfo.platform, chainId, tokenAddr, safeTokenInfo);
      if (seq !== tokenPriceReqSeq.current) return;
      if (reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenPriceUsd(v && Number.isFinite(v) && v > 0 ? v : null);
    } catch {
      if (seq !== tokenPriceReqSeq.current) return;
      if (reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenPriceUsd(null);
    }
  }

  const handleToggleGmgnBuy = () => {
    setGmgnBuyEnabled((v) => !v);
  };

  const handleToggleGmgnSell = () => {
    setGmgnSellEnabled((v) => !v);
  };

  async function loadState() {
    noteStateChangeProbe('loadState');
    const res = await call({ type: 'bg:getState' });
    setState(res);
    setError(null);
    if (!res.wallet.isUnlocked) {
      setTradeBaseBalanceWei('0');
      setWalletNativeBalancesWei({});
      setWalletTradeBaseBalancesWei({});
      setWalletTokenBalancesWei({});
    }
    return res;
  }

  async function refreshBaseBalances(
    res: BgGetStateResponse,
    queryAllWallets = false,
  ) {
    if (!siteInfo || !res.wallet.isUnlocked) return null;
    const resolvedChainId = siteInfo?.chain ? (getChainIdByName(siteInfo.chain) || (res.settings?.chainId ?? 56)) : (res.settings?.chainId ?? 56);
    const tradeBaseAddress = resolveTradeBaseTokenAddress(res.settings, resolvedChainId);
    const allWallets = ((res.wallet.accounts ?? []) as Account[])
      .map((acc) => normalizeAddr(String(acc.address || '')))
      .filter(Boolean) as `0x${string}`[];
    const selectedWallets = resolveSelectedTradeWallets(res.wallet, res.settings);
    const targetWallets = selectedWallets.length > 0 ? selectedWallets : allWallets.slice(0, 1);
    const queryWallets = queryAllWallets ? allWallets : targetWallets;
    const allBalances = await Promise.all(
      queryWallets.map((addr) => TokenAPI.getBalance(siteInfo.platform, siteInfo.chain, addr, zeroAddress, { cacheTtlMs: 2000 }))
    );
    const byWallet: Record<string, string> = {};
    allWallets.forEach((addr) => {
      byWallet[addr.toLowerCase()] = '0';
    });
    queryWallets.forEach((addr, i) => {
      byWallet[addr.toLowerCase()] = typeof allBalances[i] === 'string' ? (allBalances[i] as string) : '0';
    });
    setWalletNativeBalancesWei(byWallet);

    let byTradeBaseWallet: Record<string, string> = byWallet;
    if (tradeBaseAddress.toLowerCase() !== zeroAddress.toLowerCase()) {
      const tradeBaseBalances = await Promise.all(
        queryWallets.map((addr) =>
          TokenAPI.getBalance(siteInfo.platform, siteInfo.chain, addr, tradeBaseAddress, { cacheTtlMs: 2000 })
        )
      );
      const mapped: Record<string, string> = {};
      allWallets.forEach((addr) => {
        mapped[addr.toLowerCase()] = '0';
      });
      queryWallets.forEach((addr, i) => {
        mapped[addr.toLowerCase()] = typeof tradeBaseBalances[i] === 'string' ? (tradeBaseBalances[i] as string) : '0';
      });
      byTradeBaseWallet = mapped;
    }
    setWalletTradeBaseBalancesWei(byTradeBaseWallet);

    const total = targetWallets.reduce((sum, addr) => sum + BigInt(byTradeBaseWallet[addr.toLowerCase()] || '0'), 0n);
    setTradeBaseBalanceWei(total.toString());
    return {
      selectedWalletCount: selectedWallets.length,
      queryWalletCount: queryWallets.length,
      tradeBaseAddress,
    };
  }

  async function refreshAll(queryAllWallets = false, source = 'unknown') {
    noteStateChangeProbe('refreshAll', source);
    if (document.hidden) return;
    if (!siteInfo) return;
    const startedAt = Date.now();
    const includeBalances = queryAllWallets || shouldKeepBaseBalancesWarm;
    logHyperReadDebug('refreshAll.start', { source, queryAllWallets, includeBalances });
    const res = await loadState();
    if (!res) return;
    if (!res.wallet.isUnlocked) {
      logHyperReadDebug('refreshAll.done', {
        source,
        queryAllWallets,
        includeBalances,
        elapsedMs: Date.now() - startedAt,
        unlocked: false,
      });
      return;
    }
    if (!includeBalances) {
      logHyperReadDebug('refreshAll.done', {
        source,
        queryAllWallets,
        includeBalances,
        elapsedMs: Date.now() - startedAt,
        stateOnly: true,
      });
      return;
    }
    const balanceMeta = await refreshBaseBalances(res, queryAllWallets);
    logHyperReadDebug('refreshAll.done', {
      source,
      queryAllWallets,
      includeBalances,
      elapsedMs: Date.now() - startedAt,
      ...(balanceMeta ?? {}),
    });
  }

  const lastTokenRefresh = useRef(0);
  async function refreshToken(force = false, queryAllWallets = false, source = 'unknown') {
    noteStateChangeProbe('refreshToken', source);
    const seq = tokenRefreshSeqRef.current;
    if (document.hidden && !force) return;
    if (!tokenAddressNormalized || !siteInfo) {
      setTokenInfo(null);
      setTokenSymbol(null);
      setTokenDecimals(null);
      setTokenBalanceWei('0');
      setWalletTokenBalancesWei({});
      setTokenStat(null);
      setTokenPriceUsd(null);
      setMarketCapDisplay(null);
      setLiquidityDisplay(null);
      return;
    }

    // Throttle: don't refresh if less than configured interval passed, unless forced
    const now = Date.now();
    if (!force && now - lastTokenRefresh.current < tokenBalanceRefreshThrottleMs) return;
    lastTokenRefresh.current = now;
    const startedAt = Date.now();
    const tokenInfoCacheTtlMs = source === 'interval:token' ? 5000 : 0;
    logHyperReadDebug('refreshToken.start', {
      source,
      force,
      queryAllWallets,
      throttleMs: tokenBalanceRefreshThrottleMs,
      tokenInfoCacheTtlMs,
    });

    const reqCtxKey = `${siteInfo.platform ?? ''}:${siteInfo.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
    try {
      const metaStartedAt = Date.now();
      const meta = await TokenAPI.getTokenInfo(siteInfo.platform, siteInfo.chain, tokenAddressNormalized, {
        cacheTtlMs: tokenInfoCacheTtlMs,
      });
      const metaElapsedMs = Date.now() - metaStartedAt;
      if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
      if (meta) {
        const normalizedDecimals =
          Number.isFinite(meta.decimals)
            && Number(meta.decimals) > 0
            && Number(meta.decimals) <= 36
            ? Number(meta.decimals)
            : 18;
        setTokenInfo(meta);
        setTokenSymbol(meta.symbol);
        setTokenDecimals(normalizedDecimals);

        if ((meta as any).tokenPrice) {
          const p = (meta as any).tokenPrice as { marketCap?: string; liquidity?: string };
          setMarketCapDisplay(p.marketCap ?? null);
          setLiquidityDisplay(p.liquidity ?? null);
        } else {
          setMarketCapDisplay(null);
          setLiquidityDisplay(null);
        }
      }

      const selectedWalletsForToken = resolveSelectedTradeWallets(state?.wallet, settings);
      const allWalletsForToken = ((state?.wallet.accounts ?? []) as Account[])
        .map((acc) => normalizeAddr(String(acc.address || '')))
        .filter(Boolean) as `0x${string}`[];
      const targetWalletsForToken = selectedWalletsForToken.length > 0 ? selectedWalletsForToken : allWalletsForToken.slice(0, 1);
      const queryWalletsForToken = queryAllWallets ? allWalletsForToken : targetWalletsForToken;
      let holdingsElapsedMs = 0;
      if (isUnlocked && queryWalletsForToken.length > 0) {
        const holdingsStartedAt = Date.now();
        const holdings = await Promise.all(
          queryWalletsForToken.map((walletAddr) =>
            TokenAPI.getTokenHolding(siteInfo.platform, siteInfo.chain, walletAddr, tokenAddressNormalized, {
              cacheTtlMs: tokenBalanceRefreshThrottleMs,
            })
          )
        );
        holdingsElapsedMs = Date.now() - holdingsStartedAt;
        if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
        const byWallet: Record<string, string> = {};
        allWalletsForToken.forEach((addr) => {
          byWallet[addr.toLowerCase()] = '0';
        });
        queryWalletsForToken.forEach((addr, i) => {
          byWallet[addr.toLowerCase()] = holdings[i] ?? '0';
        });
        setWalletTokenBalancesWei(byWallet);
        const total = targetWalletsForToken.reduce((sum, addr) => sum + BigInt(byWallet[addr.toLowerCase()] || '0'), 0n);
        setTokenBalanceWei(total.toString());
      } else {
        setTokenBalanceWei('0');
        setWalletTokenBalancesWei({});
      }

      const priceStartedAt = Date.now();
      await refreshTokenPrice(force, meta ?? null);
      const priceElapsedMs = Date.now() - priceStartedAt;
      logHyperReadDebug('refreshToken.done', {
        source,
        force,
        queryAllWallets,
        elapsedMs: Date.now() - startedAt,
        hasMeta: !!meta,
        metaElapsedMs,
        holdingsElapsedMs,
        priceElapsedMs,
        selectedWalletCount: targetWalletsForToken.length,
        queriedWalletCount: queryWalletsForToken.length,
      });
    } catch (e: any) {
      if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenSymbol(null);
      setTokenDecimals(null);
      setTokenBalanceWei('0');
      setWalletTokenBalancesWei({});
      setTokenStat(null);
      setTokenPriceUsd(null);
      setMarketCapDisplay(null);
      setLiquidityDisplay(null);
      logHyperReadDebug('refreshToken.failed', {
        source,
        force,
        queryAllWallets,
        elapsedMs: Date.now() - startedAt,
        error: String(e?.message || e || ''),
      });
      // Don't show error for token fetch to avoid noise
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      emitStateChangeProbe();
    }, STATE_CHANGE_PROBE_LOG_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!siteInfo || !shouldKeepTokenWarm) return;
    void refreshToken(true, false, 'tokenConsumers:visible');
  }, [siteInfo, shouldKeepTokenWarm]);

  useEffect(() => {
    if (!siteInfo) return;
    refreshAll(false, 'siteInfo:init');
    const timer = setInterval(() => refreshAll(false, 'interval:10s'), 10000);
    return () => clearInterval(timer);
  }, [siteInfo, shouldKeepBaseBalancesWarm]);

  useEffect(() => {
    if (!siteInfo) return;
    if (!shouldKeepBaseBalancesWarm) return;
    void refreshAll(false, 'balanceConsumers:visible');
  }, [siteInfo, shouldKeepBaseBalancesWarm]);

  // Listen for background state changes (immediate update)
  useEffect(() => {
    if (!siteInfo) return;
    const shouldPlayOrderSound = (input: { source: 'xsniper' | 'newCoin'; record: any; ttlMs: number }) => {
      const now = Date.now();
      const token = String(input.record?.tokenAddress || '').trim().toLowerCase();
      const side = String(input.record?.side || '').trim().toLowerCase();
      const reason = String(input.record?.reason || '').trim().toLowerCase();
      const txHash = String(input.record?.txHash || '').trim().toLowerCase();
      const signalKey = String(
        input.record?.signalEventId
        || input.record?.signalTweetId
        || input.record?.signalId
        || input.record?.id
        || '',
      ).trim().toLowerCase();
      const key = `${input.source}:${side}:${token}:${reason}:${txHash || signalKey}`;
      if (!token || !side || !key) return true;
      const map = autoTradeOrderSoundPlayedAtRef.current;
      const prev = map[key];
      if (typeof prev === 'number' && Number.isFinite(prev) && now - prev < input.ttlMs) return false;
      map[key] = now;
      const entries = Object.entries(map);
      if (entries.length > 1200) {
        const next: Record<string, number> = {};
        for (const [k, ts] of entries) {
          if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
          if (now - ts > 10 * 60_000) continue;
          next[k] = ts;
        }
        autoTradeOrderSoundPlayedAtRef.current = next;
      }
      return true;
    };
    const listener = (message: any) => {
      if (message.type === 'bg:gmgn:getTokenHoldings') {
        return (async () => {
          if (siteInfo?.platform !== 'gmgn') return { ok: false, error: 'not_gmgn_page' };
          try {
            const chain = typeof message?.chain === 'string' ? message.chain : 'bsc';
            const walletAddress = typeof message?.walletAddress === 'string' ? message.walletAddress : '';
            if (!walletAddress) return { ok: false, error: 'invalid_wallet_address' };
            const holdings = await GmgnAPI.getTokenHoldings(chain, walletAddress);
            return { ok: true, holdings };
          } catch (e: any) {
            return { ok: false, error: String(e?.message || e || 'gmgn_holdings_query_failed') };
          }
        })();
      }
      if (message.type === 'bg:gmgn:getTokenHoldingDetail') {
        return (async () => {
          if (siteInfo?.platform !== 'gmgn') return { ok: false, error: 'not_gmgn_page' };
          try {
            const chain = typeof message?.chain === 'string' ? message.chain : 'bsc';
            const walletAddress = typeof message?.walletAddress === 'string' ? message.walletAddress : '';
            const tokenAddress = typeof message?.tokenAddress === 'string' ? message.tokenAddress : '';
            if (!walletAddress || !tokenAddress) return { ok: false, error: 'invalid_params' };
            const detail = await GmgnAPI.getTokenHoldingDetail(chain, walletAddress, tokenAddress);
            return { ok: true, detail };
          } catch (e: any) {
            return { ok: false, error: String(e?.message || e || 'gmgn_holding_detail_query_failed') };
          }
        })();
      }
      if (message.type === 'bg:tokenSniper:gmgnWalletAddress') {
        return (async () => {
          if (siteInfo?.platform !== 'gmgn') return { ok: false, error: 'not_gmgn_page' };
          try {
            const address = String(await GmgnAPI.getWalletAddress() || '').trim().toLowerCase();
            if (!address) return { ok: false, error: 'gmgn_wallet_not_found' };
            return { ok: true, address };
          } catch (e: any) {
            return { ok: false, error: String(e?.message || e || 'gmgn_wallet_query_failed') };
          }
        })();
      }
      if (message.type === 'bg:tokenSniper:gmgnBuy') {
        return (async () => {
          if (siteInfo?.platform !== 'gmgn') return { ok: false, error: 'not_gmgn_page' };
          try {
            const tokenAddress = typeof message?.tokenAddress === 'string' ? message.tokenAddress : '';
            const amountWei = typeof message?.amountWei === 'string' ? message.amountWei : '';
            const gasGwei = typeof message?.gasGwei === 'string' ? message.gasGwei.trim() : '';
            if (!tokenAddress || !amountWei) return { ok: false, error: 'invalid_params' };
            await GmgnAPI.buyToken({
              tokenAddress,
              amount: amountWei,
              gasGwei: gasGwei || undefined,
            });
            return { ok: true };
          } catch (e: any) {
            return { ok: false, error: String(e?.message || e || 'gmgn_buy_failed') };
          }
        })();
      }
      if (message.type === 'bg:stateChanged') {
        noteStateChangeProbe('bgStateChangedReceived');
        const seq = bgStateChangedSeqRef.current + 1;
        bgStateChangedSeqRef.current = seq;
        const sentAtMs = Number(message?.ts ?? 0) || null;
        const now = Date.now();
        const minIntervalMs = 1200;
        const runRefresh = () => {
          bgStateChangedHandledAtRef.current = Date.now();
          refreshAll(false, 'bg:stateChanged');
          if (shouldKeepTokenWarm) refreshToken(false, false, 'bg:stateChanged');
        };
        logHyperReadDebug('bg.stateChanged', {
          seq,
          broadcastSeq: typeof message?.seq === 'number' ? message.seq : null,
          sentAtMs,
          receivedLagMs: sentAtMs ? Math.max(0, Date.now() - sentAtMs) : null,
          hidden: document.hidden,
        });
        const elapsed = now - bgStateChangedHandledAtRef.current;
        if (elapsed >= minIntervalMs) {
          if (bgStateChangedTimerRef.current) {
            clearTimeout(bgStateChangedTimerRef.current);
            bgStateChangedTimerRef.current = null;
          }
          runRefresh();
          return;
        }
        if (bgStateChangedTimerRef.current) clearTimeout(bgStateChangedTimerRef.current);
        bgStateChangedTimerRef.current = setTimeout(() => {
          bgStateChangedTimerRef.current = null;
          runRefresh();
        }, Math.max(80, minIntervalMs - elapsed));
        return;
      }
      if (message.type === 'bg:xsniper:buy') {
        const record = message?.record as any;
        const isDeleteTweetSell = record?.side === 'sell' && record?.tweetType === 'delete_post';
        if (isDeleteTweetSell) return;
        if (record?.side !== 'buy' || record?.reason) return;
        if (!shouldPlayOrderSound({ source: 'xsniper', record, ttlMs: 30_000 })) return;
        ensureAutoTradeAudioReady();
        playAutoTradePreset(autoTradeSoundPreset);
        return;
      }
      if (message.type === 'bg:tokenSniper:matched') {
        const tokenSnipe = settingsRef.current?.autoTrade?.tokenSnipe;
        if (tokenSnipe?.playSound === false) return;
        const preset = (message?.preset ?? tokenSnipe?.soundPreset ?? autoTradeSoundPreset) as TradeSuccessSoundPreset;
        ensureAutoTradeAudioReady();
        playAutoTradePreset(preset);
        return;
      }
      if (message.type === 'bg:newCoinSniper:order') {
        const record = message?.record as any;
        const newCoinSnipe = (settingsRef.current?.autoTrade as any)?.newCoinSnipe;
        if (newCoinSnipe?.playSound === false) return;
        // Only play once when a real buy order record is created.
        if (record?.side !== 'buy' || record?.reason) return;
        if (!shouldPlayOrderSound({ source: 'newCoin', record, ttlMs: 120_000 })) return;
        const preset = (newCoinSnipe?.soundPreset ?? autoTradeSoundPreset) as TradeSuccessSoundPreset;
        ensureAutoTradeAudioReady();
        playAutoTradePreset(preset);
        return;
      }
      if (message.type === 'bg:tradeSuccess') {
        const source = String(message?.source || '');
        const isSupportedSource =
          source === 'limitOrder'
          || source === 'xsniper'
          || source === 'tokenSniper'
          || source === 'tx:buy'
          || source === 'tx:sell';
        if (!isSupportedSource) return;
        const side = message?.side === 'sell' ? 'sell' : 'buy';
        const rawAddr = typeof message?.tokenAddress === 'string' ? message.tokenAddress : '';
        const symbol = tokenSymbol ?? (rawAddr ? `${rawAddr.slice(0, 6)}...${rawAddr.slice(-4)}` : '');
        const providerRaw = formatBroadcastProvider(message?.broadcastVia, message?.broadcastUrl, message?.isBundle);
        const provider = providerRaw === '-' ? 'RPC' : providerRaw;
        const timing = formatTradeTiming({
          submitElapsedMs: Number(message?.submitElapsedMs ?? 0),
          receiptElapsedMs: Number(message?.receiptElapsedMs ?? 0),
        });
        const eventToastId = getTradeEventToastId(side, rawAddr, String(message?.txHash || ''));
        toast.success(renderTradeSuccessToast({ side, symbol, provider, timing, stage: 'confirmed' }), {
          id: eventToastId,
          icon: '✅',
          duration: 3000,
        });
        return;
      }
      if (message.type === 'bg:tradeFailed') {
        const side = message?.side === 'sell' ? 'sell' : 'buy';
        const rawAddr = typeof message?.tokenAddress === 'string' ? message.tokenAddress : '';
        const symbol = tokenSymbol ?? (rawAddr ? `${rawAddr.slice(0, 6)}...${rawAddr.slice(-4)}` : '');
        const errorMessage = String(message?.errorMessage || '');
        const stage = message?.stage === 'receipt'
          ? (locale === 'en' ? 'On-chain failed' : '上链失败')
          : (locale === 'en' ? 'Submit failed' : '提交失败');
        const title = locale === 'en'
          ? `[${symbol}] ${side === 'buy' ? 'Buy' : 'Sell'} failed (${stage})`
          : `[${symbol}] ${side === 'buy' ? '买入失败' : '卖出失败'}（${stage}）`;
        const eventToastId = getTradeEventToastId(side, rawAddr, String(message?.txHash || ''));
        toast.error(
          <div className="space-y-1">
            <div className="font-medium">{title}</div>
            {errorMessage ? <div className="text-[12px] opacity-90">{errorMessage}</div> : null}
          </div>,
          {
            id: eventToastId,
            icon: '❌',
            duration: 5000,
          }
        );
        // Also dismiss the early "交易执行中..." fallback toast if it still exists.
        toast.dismiss(getTradeToastId(side, rawAddr));
        return;
      }
      if (message.type === 'bg:tradeSubmitted') {
        ensureTradeSuccessAudioReady();
        if (message?.side === 'buy') playTradeBuySound();
        else playTradeSellSound();
        const side = message?.side === 'sell' ? 'sell' : 'buy';
        const rawAddr = typeof message?.tokenAddress === 'string' ? message.tokenAddress : '';
        const symbol = tokenSymbol ?? (rawAddr ? `${rawAddr.slice(0, 6)}...${rawAddr.slice(-4)}` : '');
        const provider = locale === 'en' ? 'Submitted' : '已提交';
        const timing = formatTradeTiming({ submitElapsedMs: Number(message?.submitElapsedMs ?? 0) }, true);
        const eventToastId = getTradeEventToastId(side, rawAddr, String(message?.txHash || ''));
        // Replace the initial "交易执行中..." flow toast as soon as tx hash is submitted.
        toast.dismiss(getTradeToastId(side, rawAddr));
        toast.success(renderTradeSuccessToast({ side, symbol, provider, timing, stage: 'submitted' }), {
          id: eventToastId,
          icon: <SatelliteDish size={14} className="text-cyan-300" />,
          // Keep this visible until replaced by confirmed/failed event.
          duration: Infinity,
        });
        return;
      }
      if (message.type === 'bg:tradeRetrying') {
        logUiDebug('[ui.trade.retrying]', {
          side: message?.side,
          chainId: message?.chainId,
          token: message?.tokenAddress,
          attempt: message?.attempt,
          reason: message?.reason,
          ts: Date.now(),
        });
        const side = message?.side === 'sell' ? '卖出' : '买入';
        const attempt = Number(message?.attempt || 1);
        const reasonRaw = String(message?.reason || '');
        const text = reasonRaw === 'allowance'
          ? `${side}检测到授权不足，正在自动补授权并重试（第${attempt}次）...`
          : reasonRaw === 'nonce'
            ? `${side}检测到 Nonce 冲突，正在自动修复并重试（第${attempt}次）...`
            : `${side}失败，正在自动重试（第${attempt}次）...`;
        toast(text, {
          id: `trade-retrying:${side}:${String(message?.tokenAddress || '').toLowerCase()}`,
          icon: '🔁',
          duration: 3000,
        });
        return;
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      if (bgStateChangedTimerRef.current) {
        clearTimeout(bgStateChangedTimerRef.current);
        bgStateChangedTimerRef.current = null;
      }
      browser.runtime.onMessage.removeListener(listener);
    };
  }, [
    siteInfo,
    address,
    ensureAutoTradeAudioReady,
    playAutoTradePreset,
    autoTradeSoundPreset,
    ensureTradeSuccessAudioReady,
    playTradeBuySound,
    playTradeSellSound,
    tokenBalanceRefreshThrottleMs,
    locale,
    tokenSymbol,
    shouldKeepBaseBalancesWarm,
    shouldKeepTokenWarm,
  ]);

  useEffect(() => {
    const dedupeStorageKey = 'dagobang_delete_tweet_sound_dedupe_v2';
    const dedupeMaxCount = 2000;
    const dedupePersistDebounceMs = 1500;
    const normalizeAddr = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    let pendingPersistMap: Record<string, number> | null = null;
    let persistTimer: number | null = null;
    const loadPlayedMap = () => {
      try {
        const raw = window.localStorage.getItem(dedupeStorageKey);
        if (!raw) return {} as Record<string, number>;
        const parsed = JSON.parse(raw) as Record<string, number>;
        if (!parsed || typeof parsed !== 'object') return {} as Record<string, number>;
        return parsed;
      } catch {
        return {} as Record<string, number>;
      }
    };
    const flushPersistPlayedMap = () => {
      const map = pendingPersistMap;
      if (!map) return;
      pendingPersistMap = null;
      try {
        window.localStorage.setItem(dedupeStorageKey, JSON.stringify(map));
      } catch {
      }
    };
    const persistPlayedMap = (map: Record<string, number>) => {
      pendingPersistMap = map;
      if (persistTimer != null) return;
      persistTimer = window.setTimeout(() => {
        persistTimer = null;
        flushPersistPlayedMap();
      }, dedupePersistDebounceMs);
    };
    const clampPlayedMap = (map: Record<string, number>) => {
      const entries = Object.entries(map).filter(([, ts]) => typeof ts === 'number' && Number.isFinite(ts));
      if (entries.length <= dedupeMaxCount) return map;
      entries.sort((a, b) => a[1] - b[1]);
      const next: Record<string, number> = {};
      for (const [k, ts] of entries.slice(entries.length - dedupeMaxCount)) {
        next[k] = ts;
      }
      return next;
    };
    deleteSoundPlayedAtRef.current = clampPlayedMap(loadPlayedMap());

    const onTwitterSignal = (e: Event) => {
      const signal = (e as CustomEvent<any>).detail as any;
      if (!signal || signal.tweetType !== 'delete_post' && signal.tweetType !== 'unfollow') return;
      const tokens = Array.isArray(signal.tokens) ? signal.tokens : [];
      if (!tokens.length) return;
      const tokenAddrKey = Array.from(
        new Set(
          tokens
            .map((x: any) => normalizeAddr(x?.tokenAddress))
            .filter(Boolean),
        ),
      )
        .sort()
        .join(',');
      if (!tokenAddrKey) return;
      const tweetType = normalizeText(signal.tweetType);
      const tweetId = normalizeText(signal.tweetId);
      const sourceTweetId = normalizeText(signal.sourceTweetId);
      const eventId = normalizeText(signal.eventId);
      const userScreen = normalizeText(signal.userScreen);
      const ts = Number(signal.ts ?? signal.receivedAtMs);
      const fallbackStableId = `${userScreen}:${Number.isFinite(ts) ? Math.floor(ts / 1000) : ''}`;
      const stableId = tweetId || sourceTweetId || eventId || fallbackStableId;
      const key = `${tweetType}:${stableId}`;
      if (!key) return;
      const now = Date.now();
      const map = deleteSoundPlayedAtRef.current;
      const lastPlayedAt = map[key];
      if (typeof lastPlayedAt === 'number' && Number.isFinite(lastPlayedAt)) {
        return;
      }
      const deleteTweetPlaySound = settingsRef.current?.autoTrade?.twitterSnipe?.deleteTweetPlaySound !== false;
      if (!deleteTweetPlaySound) return;
      const preset = (settingsRef.current?.autoTrade?.twitterSnipe?.deleteTweetSoundPreset ?? 'Handgun') as TradeSuccessSoundPreset;
      ensureDeleteTweetAudioReady();
      playDeleteTweetPreset(preset);
      const next = clampPlayedMap({ ...map, [key]: now });
      deleteSoundPlayedAtRef.current = next;
      persistPlayedMap(next);
    };
    window.addEventListener('dagobang-twitter-signal' as any, onTwitterSignal as any);
    const onPageHide = () => {
      if (persistTimer != null) {
        window.clearTimeout(persistTimer);
        persistTimer = null;
      }
      flushPersistPlayedMap();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('dagobang-twitter-signal' as any, onTwitterSignal as any);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      onPageHide();
    };
  }, [ensureDeleteTweetAudioReady, playDeleteTweetPreset]);

  useEffect(() => {
    if (!shouldKeepTokenWarm) return;
    refreshToken(true, false, 'token:init');
    const timer = setInterval(() => refreshToken(false, false, 'interval:token'), tokenBalancePollIntervalMs);
    return () => clearInterval(timer);
  }, [tokenAddressNormalized, address, siteInfo, tokenBalancePollIntervalMs, shouldKeepTokenWarm]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const nextX = dragging.current.baseX + dx;
      const nextY = dragging.current.baseY + dy;
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const keyMain = 'dagobang_content_ui_pos';
        window.localStorage.setItem(keyMain, JSON.stringify(posRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  async function withBusy(fn: () => Promise<void>) {

    setError(null);
    try {
      await fn();
    } catch (e: any) {
      const message = (() => {
        const raw = e?.message ? String(e.message) : t('popup.error.unknown', locale);
        if (raw === 'Settings not ready') return t('contentUi.error.settingsNotReady', locale);
        if (raw === 'Invalid token') return t('contentUi.error.invalidToken', locale);
        if (raw === 'Invalid amount') return t('contentUi.error.invalidAmount', locale);
        if (raw === 'No balance') return t('contentUi.error.noBalance', locale);
        if (raw === 'Token info required') return t('contentUi.error.tokenInfoRequired', locale);
        if (raw === 'Insufficient balance') return t('contentUi.error.insufficientBalance', locale);
        if (raw === 'Transaction failed') return t('contentUi.error.transactionFailed', locale);
        if (raw === 'ERC20_INPUT' || raw === 'ERC20: Invalid input') return t('contentUi.error.erc20Input', locale);
        return raw;
      })();
      setError(message);
      toast.error(message, { icon: '❌' });
    }
  }

  const startFastPolling = () => {
    if (fastPollingRef.current) clearInterval(fastPollingRef.current);

    // Poll briefly to catch balance updates after tx
    let count = 0;
    fastPollingRef.current = setInterval(() => {
      count++;
        refreshAll(false, 'fastPolling');
        refreshToken(true, false, 'fastPolling'); // force refresh
      if (count >= 15) {
        if (fastPollingRef.current) clearInterval(fastPollingRef.current);
        fastPollingRef.current = null;
      }
    }, 500);
  };

  const resolvePriorityFee = (side: 'buy' | 'sell') => {
    if (!settings) return undefined;
    const chainSettings = effectiveChainSettings;
    if (!chainSettings) return undefined;
    const selectedPreset = side === 'buy'
      ? ((chainSettings.buyPriorityFeePreset ?? 'standard') as PriorityFeePreset)
      : ((chainSettings.sellPriorityFeePreset ?? 'standard') as PriorityFeePreset);
    const presetValues = side === 'buy'
      ? (chainSettings.buyPriorityFeePresets ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES)
      : (chainSettings.sellPriorityFeePresets ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES);
    const value = presetValues[selectedPreset] ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES[selectedPreset];
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || '0';
  };

  const tradingLoadingIcon = (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-300 border-t-transparent" />
  );

  const formatTradeTiming = (res: { submitElapsedMs?: number; receiptElapsedMs?: number }, pendingReceipt = false) => {
    const submitMs = Number(res.submitElapsedMs ?? 0);
    const receiptMs = Number(res.receiptElapsedMs ?? 0);
    const formatSec = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
    const submitValue = submitMs > 0 ? formatSec(submitMs) : (locale === 'en' ? 'Submitted' : '已提交');
    const receiptValue = pendingReceipt
      ? (locale === 'en' ? 'Pending...' : '上链中...')
      : (receiptMs > 0 ? formatSec(receiptMs) : (locale === 'en' ? 'Pending...' : '上链中...'));
    if (locale === 'en') {
      return {
        submitLabel: 'RPC',
        submitValue,
        receiptLabel: 'On-chain',
        receiptValue,
      };
    }
    return {
      submitLabel: 'RPC',
      submitValue,
      receiptLabel: '上链',
      receiptValue,
    };
  };

  const renderTradeSuccessToast = (input: {
    side: 'buy' | 'sell';
    symbol: string;
    provider: string;
    timing: { submitLabel: string; submitValue: string; receiptLabel: string; receiptValue: string };
    stage?: 'submitted' | 'confirmed';
  }) => {
    const isSubmitted = input.stage === 'submitted';
    const title = locale === 'en'
      ? `[${input.symbol}] ${input.side === 'buy' ? 'Buy' : 'Sell'} ${isSubmitted ? 'submitted' : 'succeeded'} (${input.provider})`
      : `[${input.symbol}] ${input.side === 'buy' ? (isSubmitted ? '买入已提交' : '买入成功') : (isSubmitted ? '卖出已提交' : '卖出成功')}（${input.provider}）`;
    return (
      <div className="space-y-1">
        <div className="font-medium">{title}</div>
        <div className="flex items-center gap-2 text-[12px] opacity-90 whitespace-nowrap">
          <span className="inline-flex items-center gap-1">
            <SatelliteDish size={12} className="text-cyan-300" />
            <span>
              {input.timing.submitLabel} <span className="font-semibold text-cyan-300">{input.timing.submitValue}</span>
            </span>
          </span>
          <span className="opacity-50">|</span>
          <span>⛓️ {input.timing.receiptLabel} <span className="font-semibold text-emerald-300">{input.timing.receiptValue}</span></span>
        </div>
      </div>
    );
  };

  const getTradeToastId = (side: 'buy' | 'sell', tokenAddress?: string | null) =>
    `trade-flow:${side}:${String(tokenAddress || '').toLowerCase()}`;
  const getTradeEventToastId = (side: 'buy' | 'sell', tokenAddress?: string | null, txHash?: string | null) =>
    txHash
      ? `trade-event:${side}:${String(txHash).toLowerCase()}`
      : `trade-event:${side}:${String(tokenAddress || '').toLowerCase()}`;

  const handleBuy = (amountStr: string, presetIndex: number) => {
    withBusy(async () => {
      if (!settings) throw new Error('Settings not ready');
      if (!tokenAddressNormalized) throw new Error('Invalid token');
      const wallets = selectedTradeWallets;
      if (wallets.length <= 0) throw new Error('No wallet selected');
      const mainWalletLower = (() => {
        const activeLower = String(address || '').toLowerCase();
        if (activeLower && wallets.some((w) => w.toLowerCase() === activeLower)) return activeLower;
        return wallets[0].toLowerCase();
      })();
      const parseAmountWei = (rawAmount: string, walletAddress: `0x${string}`) => {
        const normalized = String(rawAmount || '').trim();
        if (!normalized) throw new Error(`钱包 ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} 金额为空`);
        const wei = parseUnits(normalized, tradeBaseTokenMeta.decimals);
        if (wei <= 0n) throw new Error(`钱包 ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} 金额必须大于 0`);
        return wei;
      };
      const hasValidPresetIndex = Number.isInteger(presetIndex) && presetIndex >= 0 && presetIndex < 4;
      const buyPlan: Array<{ walletAddress: `0x${string}`; amountWei: bigint }> = [];
      const skippedByPreset: `0x${string}`[] = [];
      for (const walletAddress of wallets) {
        const lower = walletAddress.toLowerCase();
        const isMainWallet = lower === mainWalletLower;
        if (multiWalletBuyMode === 'child_custom' && !isMainWallet && hasValidPresetIndex) {
          const customAmountRaw = childWalletBuyPresetAmountsNative[lower]?.[presetIndex];
          const trimmed = String(customAmountRaw || '').trim();
          const num = Number(trimmed);
          if (!trimmed || !Number.isFinite(num) || num <= 0) {
            skippedByPreset.push(walletAddress);
            continue;
          }
          try {
            const amountWei = parseAmountWei(trimmed, walletAddress);
            buyPlan.push({ walletAddress, amountWei });
          } catch {
            skippedByPreset.push(walletAddress);
          }
          continue;
        }
        const amountWei = parseAmountWei(amountStr, walletAddress);
        buyPlan.push({ walletAddress, amountWei });
      }
      if (skippedByPreset.length > 0) {
        toast(`子钱包金额为 0，已跳过 ${skippedByPreset.length} 个钱包`, { icon: 'ℹ️', duration: 1800 });
      }
      const executablePlan: Array<{ walletAddress: `0x${string}`; amountWei: bigint }> = [];
      const insufficientWallets: `0x${string}`[] = [];
      for (const item of buyPlan) {
        const walletBal = BigInt(walletTradeBaseBalancesWei[item.walletAddress.toLowerCase()] || '0');
        if (walletBal < item.amountWei) {
          insufficientWallets.push(item.walletAddress);
        } else {
          executablePlan.push(item);
        }
      }
      if (executablePlan.length <= 0) throw new Error('Insufficient balance');
      if (insufficientWallets.length > 0) {
        toast.error(`余额不足，已跳过 ${insufficientWallets.length} 个钱包`, { icon: '⚠️' });
      }
      ensureTradeSuccessAudioReady();
      const sym = tokenSymbol ?? '';
      const flowToastId = getTradeToastId('buy', tokenAddressNormalized);
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: tradingLoadingIcon, id: flowToastId });
      let buyLoadingClosed = false;

      const mainTrade = (async () => {
        const results = await Promise.allSettled(
          executablePlan.map(async ({ walletAddress, amountWei }) => {
            const buyInput = {
              chainId,
              tokenAddress: tokenAddressNormalized,
              nativeAmountWei: amountWei.toString(),
              baseTokenAddress: tradeBaseTokenAddress,
              fromAddress: walletAddress,
              priorityFeeNative: resolvePriorityFee('buy'),
              tokenInfo: tokenInfo ?? undefined,
            } as const;
            const res = await call({
              type: 'tx:buyWithReceiptAuto',
              input: buyInput,
            } as const);
            if (!res.ok) {
              const detail = res.revertReason || res.error?.shortMessage || res.error?.message;
              throw new Error(detail || 'Transaction failed');
            }
            return { walletAddress, res };
          })
        );
        const successes = results
          .filter((item): item is PromiseFulfilledResult<{ walletAddress: `0x${string}`; res: any }> => item.status === 'fulfilled')
          .map((item) => item.value);
        const failures = results
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => String(item.reason?.message || item.reason || 'Transaction failed'));
        if (successes.length <= 0) {
          throw new Error(failures[0] || 'Transaction failed');
        }
        const first = successes[0].res;
        const tokenMinOutWei = first.tokenMinOutWei ?? null;
        setTxHash(first.txHash);
        setPendingBuyTokenMinOutWei(tokenMinOutWei);
        toast.success(`买入成功 ${successes.length}/${executablePlan.length} 个钱包`, { icon: '✅', duration: 2500 });
        if (failures.length > 0) {
          toast.error(`买入失败 ${failures.length} 个钱包`, { icon: '⚠️' });
        }
        buyLoadingClosed = true;

        if (tokenInfo) {
          void Promise.allSettled(
            successes.map(({ walletAddress }) =>
              call({
                type: 'tx:approveMaxForSellIfNeeded',
                chainId,
                tokenAddress: tokenAddressNormalized,
                tokenInfo: tokenInfo,
                fromAddress: walletAddress,
              } as const)
            )
          ).catch(() => { });
        }

        await Promise.all([refreshToken(true), refreshAll()]);
        startFastPolling();
        setPendingBuyTokenMinOutWei(null);

        try {
          const config = settings.advancedAutoSell;
          if (!config?.enabled) return;
          if (!siteInfo) return;
          if (!tokenInfo) return;
          const fetchedPriceUsd = await TokenAPI.getTokenPriceUsd(siteInfo.platform, chainId, tokenAddressNormalized, tokenInfo);
          const basePriceUsd = fetchedPriceUsd != null && fetchedPriceUsd > 0
            ? fetchedPriceUsd
            : (tokenPrice != null && Number.isFinite(tokenPrice) && tokenPrice > 0 ? tokenPrice : null);
          if (basePriceUsd == null || !(basePriceUsd > 0)) return;

          const inputs = buildStrategySellOrderInputs({
            config,
            chainId,
            tokenAddress: tokenAddressNormalized,
            tokenSymbol: tokenSymbol ?? null,
            tokenInfo,
            basePriceUsd,
          });

          const mode = (config as any)?.trailingStop?.activationMode ?? 'after_first_take_profit';
          if (mode === 'immediate' && (config as any)?.trailingStop?.enabled) {
            if (getAdvancedAutoSellMode(config) === 'rolling_take_profit') {
              const rolling = buildStrategyRollingTakeProfitOrderInputs({
                config,
                chainId,
                tokenAddress: tokenAddressNormalized,
                tokenSymbol: tokenSymbol ?? null,
                tokenInfo,
                basePriceUsd,
                entryPriceUsd: basePriceUsd,
              });
              if (rolling) inputs.push(rolling);
            } else {
              const trailing = buildStrategyTrailingSellOrderInputs({
                config,
                chainId,
                tokenAddress: tokenAddressNormalized,
                tokenSymbol: tokenSymbol ?? null,
                tokenInfo,
                basePriceUsd,
              });
              if (trailing) inputs.push(trailing);
            }
          }

          if (!inputs.length) return;
          for (const { walletAddress } of successes) {
            for (const input of inputs) {
              await call({
                type: 'limitOrder:create',
                input: {
                  ...input,
                  fromAddress: walletAddress,
                },
              } as const);
            }
          }
          toast.success(`已创建自动卖出挂单 ${inputs.length * successes.length} 个`, { icon: '✅' });
        } catch (e) {
          console.error('auto sell xsniper create orders failed', e);
        }
      })().catch((e: any) => {
        if (!buyLoadingClosed) toast.dismiss(flowToastId);
        throw e;
      });

      let gmgnTrade: Promise<unknown> | null = null;
      if (gmgnBuyEnabled && siteInfo?.platform === 'gmgn') {
        gmgnTrade = (async () => {
          try {
            // await new Promise((resolve) => setTimeout(resolve, 300));
            await GmgnAPI.buyToken({
              tokenAddress: tokenAddressNormalized,
              amount: executablePlan[0].amountWei.toString(),
            });
          } catch (e) {
            console.error('GMGN buy failed', e);
          }
        })();
      }

      if (gmgnTrade) {
        await Promise.all([mainTrade, gmgnTrade]);
      } else {
        await mainTrade;
      }
    });
  };

  const handleSell = (pct: number) => {
    setSellPercent(pct);
    withBusy(async () => {
      if (!settings) throw new Error('Settings not ready');
      if (!tokenAddressNormalized) throw new Error('Invalid token');
      const wallets = selectedTradeWallets;
      if (wallets.length <= 0) throw new Error('No wallet selected');

      const isTurbo = settings.chains[chainId]?.executionMode === 'turbo';
      const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = !!tokenInfo?.launchpad && (platform.includes('four')) && tokenInfo.launchpad_status !== 1;

      ensureTradeSuccessAudioReady();
      const sym = tokenSymbol ?? '';
      const flowToastId = getTradeToastId('sell', tokenAddressNormalized);
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: tradingLoadingIcon, id: flowToastId });
      let sellLoadingClosed = false;

      const percentBps = Math.max(1, Math.min(10000, Math.floor(pct * 100)));
      const sellReqStartedAt = Date.now();
      logUiDebug('[ui.sell.auto][request.start]', {
        chainId,
        token: tokenAddressNormalized,
        percentBps,
        isTurbo,
        ts: sellReqStartedAt,
      });
      const mainTrade = (async () => {
        const results = await Promise.allSettled(
          wallets.map(async (walletAddress) => {
            let tokenAmountWei = '0';
            if (!isTurbo) {
              const holding = await TokenAPI.getTokenHolding(siteInfo?.platform || 'gmgn', siteInfo?.chain || String(chainId), walletAddress, tokenAddressNormalized, {
                cacheTtlMs: 0,
              });
              const bal = BigInt(holding || '0');
              if (bal <= 0n) throw new Error('No balance');
              let amountWei = (bal * BigInt(pct)) / 100n;
              if (isInnerFourMeme && amountWei > 0n) amountWei = (amountWei / 1000000000n) * 1000000000n;
              if (amountWei <= 0n) throw new Error('Invalid amount');
              tokenAmountWei = amountWei.toString();
            }
            const sellInput = {
              chainId,
              tokenAddress: tokenAddressNormalized,
              tokenAmountWei: isTurbo ? '0' : tokenAmountWei,
              baseTokenAddress: tradeBaseTokenAddress,
              sellPercentBps: isTurbo ? percentBps : undefined,
              expectedTokenInWei: isTurbo ? (pendingBuyTokenMinOutWei ?? undefined) : undefined,
              fromAddress: walletAddress,
              priorityFeeNative: resolvePriorityFee('sell'),
              tokenInfo: tokenInfo ?? undefined
            } as const;
            const res = await call({
              type: 'tx:sellWithReceiptAuto',
              input: sellInput,
            } as const);
            if (!res.ok) {
              const detail = res.revertReason || res.error?.shortMessage || res.error?.message || 'Transaction failed';
              throw new Error(detail);
            }
            return { walletAddress, res };
          })
        );
        const successes = results
          .filter((item): item is PromiseFulfilledResult<{ walletAddress: `0x${string}`; res: any }> => item.status === 'fulfilled')
          .map((item) => item.value);
        const failures = results
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => String(item.reason?.message || item.reason || 'Transaction failed'));
        logUiDebug('[ui.sell.auto][request.response]', {
          chainId,
          token: tokenAddressNormalized,
          ok: successes.length > 0,
          successCount: successes.length,
          totalWallets: wallets.length,
          elapsedMs: Date.now() - sellReqStartedAt,
          ts: Date.now(),
        });
        if (successes.length <= 0) {
          throw new Error(failures[0] || 'Transaction failed');
        }
        setTxHash(successes[0].res.txHash);
        toast.success(`卖出成功 ${successes.length}/${wallets.length} 个钱包`, { icon: '✅', duration: 2500 });
        if (failures.length > 0) {
          toast.error(`卖出失败 ${failures.length} 个钱包`, { icon: '⚠️' });
        }
        sellLoadingClosed = true;
        await Promise.all([refreshToken(true), refreshAll()]);
        startFastPolling();
        setPendingBuyTokenMinOutWei(null);

        // Cancel limit order if exists
        if (percentBps === 10000 && successes.length > 0) {
          await call({ type: 'limitOrder:cancelAll', chainId, tokenAddress: tokenAddressNormalized } as const);
        }
      })().catch((e: any) => {
        warnUiDebug('[ui.sell.auto][request.failed]', {
          chainId,
          token: tokenAddressNormalized,
          elapsedMs: Date.now() - sellReqStartedAt,
          error: String(e?.message || e || ''),
          ts: Date.now(),
        });
        if (!sellLoadingClosed) toast.dismiss(flowToastId);
        throw e;
      });

      let gmgnTrade: Promise<unknown> | null = null;
      const gmgnAmountWei = ((BigInt(tokenBalanceWei || '0') * BigInt(pct)) / 100n).toString();
      if (gmgnSellEnabled && siteInfo?.platform === 'gmgn' && BigInt(gmgnAmountWei) > 0n) {
        gmgnTrade = (async () => {
          try {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await GmgnAPI.sellToken({
              tokenAddress: tokenAddressNormalized,
              amount: gmgnAmountWei,
            });
          } catch (e) {
            console.error('GMGN sell failed', e);
          }
        })();
      }

      if (gmgnTrade) {
        await Promise.all([mainTrade, gmgnTrade]);
      } else {
        await mainTrade;
      }
    });
  };

  useEffect(() => {
    handleBuyRef.current = handleBuy;
  }, [handleBuy]);

  useEffect(() => {
    handleSellRef.current = handleSell;
  }, [handleSell]);

  const handleApprove = () => {
    withBusy(async () => {
      if (!settings) throw new Error('Settings not ready');
      if (!tokenAddressNormalized) throw new Error('Invalid token');
      if (!tokenInfo) throw new Error('Token info required');
      const wallets = selectedTradeWallets;
      if (wallets.length <= 0) throw new Error('No wallet selected');
      const results = await Promise.allSettled(
        wallets.map((walletAddress) =>
          call({
            type: 'tx:approveMaxForSellIfNeeded',
            chainId,
            tokenAddress: tokenAddressNormalized,
            tokenInfo,
            fromAddress: walletAddress,
          } as const)
        )
      );
      const successes = results
        .filter((item): item is PromiseFulfilledResult<any> => item.status === 'fulfilled')
        .map((item) => item.value)
        .filter((res) => !!res?.txHash);
      if (successes[0]?.txHash) {
        setTxHash(successes[0].txHash);
      }
      toast.success(`授权已提交 ${successes.length}/${wallets.length} 个钱包`, { icon: '✅' });

      // Trigger immediate refresh and start fast polling
      await Promise.all([refreshToken(true), refreshAll()]);
      startFastPolling();
    });
  };

  const handleToggleBuyGas = () => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const presets: ('slow' | 'standard' | 'fast' | 'turbo')[] = ['slow', 'standard', 'fast', 'turbo'];
    const current = (currentChainSettings as any).buyGasPreset ?? currentChainSettings.gasPreset ?? 'standard';
    const next = presets[(presets.indexOf(current) + 1) % 4];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            buyGasPreset: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleToggleSellGas = () => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const presets: ('slow' | 'standard' | 'fast' | 'turbo')[] = ['slow', 'standard', 'fast', 'turbo'];
    const current = (currentChainSettings as any).sellGasPreset ?? currentChainSettings.gasPreset ?? 'standard';
    const next = presets[(presets.indexOf(current) + 1) % 4];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            sellGasPreset: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleToggleSlippage = () => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const options = [3000, 4000, 5000, 9000];
    const current = currentChainSettings.slippageBps ?? 4000;
    const idx = options.indexOf(current);
    const next = options[(idx + 1 + options.length) % options.length];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            slippageBps: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleToggleBuyPriorityFeePreset = () => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const current = PRIORITY_FEE_PRESETS.includes((currentChainSettings as any).buyPriorityFeePreset)
      ? (currentChainSettings as any).buyPriorityFeePreset as PriorityFeePreset
      : 'standard';
    const next = PRIORITY_FEE_PRESETS[(PRIORITY_FEE_PRESETS.indexOf(current) + 1) % PRIORITY_FEE_PRESETS.length];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            buyPriorityFeePreset: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleToggleSellPriorityFeePreset = () => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const current = PRIORITY_FEE_PRESETS.includes((currentChainSettings as any).sellPriorityFeePreset)
      ? (currentChainSettings as any).sellPriorityFeePreset as PriorityFeePreset
      : 'standard';
    const next = PRIORITY_FEE_PRESETS[(PRIORITY_FEE_PRESETS.indexOf(current) + 1) % PRIORITY_FEE_PRESETS.length];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            sellPriorityFeePreset: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleToggleMode = () => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const next = currentChainSettings.executionMode === 'turbo' ? 'default' : 'turbo';
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            executionMode: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleEditToggle = () => {
    if (!isEditing) {
      // Start editing: initialize drafts
      if (settings) {
        setDraftBuyPresets(settings.chains[chainId]?.buyPresets || ['0.01', '0.2', '0.5', '1.0']);
        setDraftSellPresets(settings.chains[chainId]?.sellPresets || ['10', '25', '50', '100']);
      }
      setIsEditing(true);
    } else {
      // Stop editing: save drafts
      if (settings) {
        const currentChainSettings = effectiveChainSettings;
        if (!currentChainSettings) return;
        call({
          type: 'settings:set',
          settings: {
            ...settings,
            chains: {
              ...settings.chains,
              [chainId]: {
                ...currentChainSettings,
                buyPresets: draftBuyPresets,
                sellPresets: draftSellPresets,
              },
            },
          },
        }).then(() => refreshAll());
      }
      setIsEditing(false);
    }
  };

  const handleUpdateBuyPreset = (index: number, val: string) => {
    const newPresets = [...draftBuyPresets];
    newPresets[index] = val;
    setDraftBuyPresets(newPresets);
  };

  const handleUpdateSellPreset = (index: number, val: string) => {
    const newPresets = [...draftSellPresets];
    newPresets[index] = val;
    setDraftSellPresets(newPresets);
  };

  const handleUpdateAdvancedAutoSell = (next: Settings['advancedAutoSell']) => {
    if (!settings) return;
    void call({ type: 'settings:set', settings: { ...settings, advancedAutoSell: next } } as const).then(() => refreshAll());
  };

  const handleToggleTradeWallet = (walletAddress: `0x${string}`) => {
    if (!settings || !state?.wallet) return;
    const allAccounts = (state.wallet.accounts ?? []) as Account[];
    const lowerToCanonical = new Map<string, `0x${string}`>();
    for (const acc of allAccounts) {
      const normalized = normalizeAddr(String(acc.address || ''));
      if (!normalized) continue;
      lowerToCanonical.set(normalized.toLowerCase(), normalized);
    }
    const targetLower = walletAddress.toLowerCase();
    if (!lowerToCanonical.has(targetLower)) return;
    const current = new Set(selectedTradeWallets.map((x) => x.toLowerCase()));
    if (current.has(targetLower)) current.delete(targetLower);
    else current.add(targetLower);
    if (current.size === 0) {
      const fallback = normalizeAddr(String(state.wallet.address || ''));
      if (fallback) current.add(fallback.toLowerCase());
    }
    const nextSelected = Array.from(current)
      .map((x) => lowerToCanonical.get(x))
      .filter(Boolean) as `0x${string}`[];
    void call({
      type: 'settings:set',
      settings: {
        ...settings,
        selectedTradeWallets: nextSelected,
      },
    } as const).then(() => refreshAll());
  };

  const handleChangeMultiWalletBuyMode = (mode: 'uniform' | 'child_custom') => {
    if (!settings) return;
    void call({
      type: 'settings:set',
      settings: {
        ...settings,
        multiWalletBuyMode: mode,
      },
    } as const).then(() => refreshAll());
  };

  const handleUpdateChildWalletBuyPresetAmount = (walletAddress: `0x${string}`, presetIndex: number, amountNative: string) => {
    if (!settings) return;
    if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex > 3) return;
    const key = walletAddress.toLowerCase();
    const next = { ...(settings.childWalletBuyPresetAmountsNative ?? {}) } as Record<string, string[]>;
    const curr = Array.isArray(next[key]) ? next[key].slice(0, 4) : ['', '', '', ''];
    while (curr.length < 4) curr.push('');
    const normalized = String(amountNative || '').trim();
    curr[presetIndex] = normalized;
    if (curr.every((x) => !String(x || '').trim())) delete next[key];
    else next[key] = curr;
    void call({
      type: 'settings:set',
      settings: {
        ...settings,
        childWalletBuyPresetAmountsNative: next,
      },
    } as const).then(() => refreshAll());
  };

  const handleUnlock = () => {
    call({ type: 'bg:openPopup' });
  };

  const handleToggleLimitTradePanel = () => {
    setShowLimitTradePanel((v) => !v);
  };

  const handleToggleRpcPanel = () => {
    setShowRpcPanel((v) => !v);
  };

  const handleToggleDailyAnalysisPanel = () => {
    setShowDailyAnalysisPanel((v) => !v);
  };

  const handleToggleReviewPanel = () => {
    setShowReviewPanel((v) => !v);
  };

  const handleToggleCookingPanel = () => {
    const next = !showCookingPanel;
    if (next) {
      cookingTokenInfoReqSeqRef.current += 1;
      setCookingSiteInfoOverride(null);
      setCookingTokenInfoOverride(null);
      setCookingTokenInfoLoading(false);
    }
    setShowCookingPanel(next);
  };

  const handleToggleXTradePanelToTab = (tab: XTradeTab) => {
    if (tab === 'xnewpoolmonitor' && !newPoolMonitorEnabled) return;
    if (tab === 'xnewcoinsniper' && !newCoinSniperEnabled) return;
    if (!showXTradePanel) {
      setXTradeActiveTab(tab);
      setShowXTradePanel(true);
      return;
    }
    if (xTradeActiveTab !== tab) {
      setXTradeActiveTab(tab);
      return;
    }
    setShowXTradePanel(false);
  };

  const handleToggleXTradePanel = () => {
    handleToggleXTradePanelToTab('xmonitor');
  };

  const handleSetNewPoolMonitorDisplayMode = (mode: NewPoolMonitorDisplayMode) => {
    if (!newPoolMonitorEnabled) return;
    setNewPoolMonitorDisplayMode(mode);
    if (mode === 'tab') {
      setShowNewPoolMonitorPanel(false);
      setXTradeActiveTab('xnewpoolmonitor');
      setShowXTradePanel(true);
      return;
    }
    if (showXTradePanel && xTradeActiveTab === 'xnewpoolmonitor') {
      setShowXTradePanel(false);
    }
    setShowNewPoolMonitorPanel(true);
  };

  const handleToggleNewPoolMonitor = () => {
    if (!newPoolMonitorEnabled) return;
    if (newPoolMonitorDisplayMode === 'tab') {
      handleToggleXTradePanelToTab('xnewpoolmonitor');
      return;
    }
    setShowNewPoolMonitorPanel((v) => !v);
  };

  const handleToggleKeyboardShortcuts = () => {
    if (!settings) return;
    const next = !keyboardShortcutsEnabled;
    if (!next && spaceHeldRef.current) {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    }
    call({ type: 'settings:set', settings: { ...settings, keyboardShortcutsEnabled: next } } as const).then(() => refreshAll());
  };

  const handleWalletSelectorOpen = () => {
    void refreshAll(true, 'walletSelectorOpen');
    void refreshToken(true, true, 'walletSelectorOpen');
  };

  const newPoolMonitorActive = newPoolMonitorEnabled && (newPoolMonitorDisplayMode === 'tab'
    ? showXTradePanel && xTradeActiveTab === 'xnewpoolmonitor'
    : showNewPoolMonitorPanel);

  return (
    <>
      <CustomToaster position={toastPosition} />

      {siteInfo && (
        <>
          {siteInfo.showBar ? (
            <FloatingToolbar
              siteInfo={siteInfo}
              settings={effectiveScopedSettings}
              onToggleCooking={handleToggleCookingPanel}
              cookingActive={showCookingPanel}
              onToggleXTrade={handleToggleXTradePanel}
              xTradeActive={showXTradePanel}
              onToggleNewPoolMonitor={handleToggleNewPoolMonitor}
              newPoolMonitorActive={newPoolMonitorActive}
              newPoolMonitorEnabled={newPoolMonitorEnabled}
              onToggleLimitTrade={handleToggleLimitTradePanel}
              autotradeActive={limitTradePanelVisible}
              onToggleRpc={handleToggleRpcPanel}
              rpcActive={showRpcPanel}
              onToggleDailyAnalysis={handleToggleDailyAnalysisPanel}
              dailyAnalysisActive={showDailyAnalysisPanel}
              onToggleReview={handleToggleReviewPanel}
              reviewActive={showReviewPanel}
            />
          ) : (
            <QuickTradePanel
              minimized={minimized}
              pos={pos}
              onMinimizedDragStart={(e) => {
                dragging.current = {
                  target: 'main',
                  startX: e.clientX,
                  startY: e.clientY,
                  baseX: posRef.current.x,
                  baseY: posRef.current.y,
                };
              }}
              onMinimizedClick={() => {
                if (!dragging.current) setMinimized(false);
              }}
              onDragStart={(e) => {
                dragging.current = {
                  target: 'main',
                  startX: e.clientX,
                  startY: e.clientY,
                  baseX: posRef.current.x,
                  baseY: posRef.current.y,
                };
              }}
              onMinimize={() => setMinimized(true)}
              isEditing={isEditing}
              onEditToggle={handleEditToggle}
              onToggleXTrade={handleToggleXTradePanel}
              xTradeActive={showXTradePanel}
              onToggleLimitTrade={handleToggleLimitTradePanel}
              autotradeActive={limitTradePanelVisible}
              onToggleRpc={handleToggleRpcPanel}
              rpcActive={showRpcPanel}
              onToggleDailyAnalysis={handleToggleDailyAnalysisPanel}
              dailyAnalysisActive={showDailyAnalysisPanel}
              onToggleReview={handleToggleReviewPanel}
              reviewActive={showReviewPanel}
              onToggleCooking={handleToggleCookingPanel}
              cookingActive={showCookingPanel}
              keyboardShortcutsEnabled={keyboardShortcutsEnabled}
              onToggleKeyboardShortcuts={handleToggleKeyboardShortcuts}
              walletAccounts={walletAccounts}
              activeWalletAddress={address as `0x${string}` | null}
              selectedTradeWallets={selectedTradeWallets}
              onToggleTradeWallet={handleToggleTradeWallet}
              multiWalletBuyMode={multiWalletBuyMode}
              childWalletBuyPresetAmountsNative={childWalletBuyPresetAmountsNative}
              childPresetActiveWalletCounts={childPresetActiveWalletCounts}
              childPresetTooltipTexts={childPresetTooltipTexts}
              onChangeMultiWalletBuyMode={handleChangeMultiWalletBuyMode}
              onUpdateChildWalletBuyPresetAmount={handleUpdateChildWalletBuyPresetAmount}
              walletNativeBalancesWei={walletNativeBalancesWei}
              walletTokenBalancesWei={walletTokenBalancesWei}
              tokenDecimals={tokenDecimals}
              nativeSymbol={nativeSymbol}
              onOpenWalletSelector={handleWalletSelectorOpen}
              formattedNativeBalance={formattedNativeBalance}
              tradeBaseSymbol={tradeBaseTokenSymbol}
              tradeBasePriceUsd={tradeBasePriceUsd}
              buyPreviewQuotedUsd={buyPreviewQuotedUsd}
              buyPreviewQuotedTokenAmounts={buyPreviewQuotedTokenAmounts}
              busy={busy}
              isUnlocked={isUnlocked}
              onBuy={handleBuy}
              settings={effectiveScopedSettings}
              dynamicGasBasePriceWei={dynamicGasBasePriceWei}
              onToggleMode={handleToggleMode}
              onToggleBuyGas={handleToggleBuyGas}
              onToggleSellGas={handleToggleSellGas}
              onToggleBuyPriorityFeePreset={handleToggleBuyPriorityFeePreset}
              onToggleSellPriorityFeePreset={handleToggleSellPriorityFeePreset}
              onToggleSlippage={handleToggleSlippage}
              onUpdateBuyPreset={handleUpdateBuyPreset}
              draftBuyPresets={draftBuyPresets}
              onUpdateSellPreset={handleUpdateSellPreset}
              draftSellPresets={draftSellPresets}
              locale={locale}
              showBuyHotkeys={keyboardShortcutsEnabled && spaceHeld && !isEditing}
              showSellHotkeys={keyboardShortcutsEnabled && spaceHeld && !isEditing}
              gmgnBuyEnabled={gmgnBuyEnabled}
              gmgnSellEnabled={gmgnSellEnabled}
              onToggleGmgnBuy={handleToggleGmgnBuy}
              onToggleGmgnSell={handleToggleGmgnSell}
              advancedAutoSell={settings?.advancedAutoSell ?? null}
              onUpdateAdvancedAutoSell={handleUpdateAdvancedAutoSell}
              formattedTokenBalance={formattedTokenBalance}
              tokenBalanceAmount={numericTokenBalance}
              tokenPriceUsd={tokenPrice}
              sellPreviewQuotedUsd={sellPreviewQuotedUsd}
              sellPreviewQuotedBaseAmounts={sellPreviewQuotedBaseAmounts}
              tokenSymbol={tokenSymbol}
              buyPreviewRoute={quickTradePreviewRoutes.buy}
              sellPreviewRoute={quickTradePreviewRoutes.sell}
              onSell={handleSell}
              onApprove={handleApprove}
              siteInfo={siteInfo}
              onUnlock={handleUnlock}
            />
          )}

          <LimitTradePanel
            siteInfo={siteInfo}
            visible={limitTradePanelVisible}
            onVisibleChange={setShowLimitTradePanel}
            settings={effectiveScopedSettings}
            isUnlocked={isUnlocked}
            address={address}
            walletAccounts={walletAccounts}
            activeWalletAddress={address as `0x${string}` | null}
            selectedTradeWallets={selectedTradeWallets}
            onToggleTradeWallet={handleToggleTradeWallet}
            walletTradeBaseBalancesWei={walletTradeBaseBalancesWei}
            walletTokenBalancesWei={walletTokenBalancesWei}
            tokenDecimals={tokenDecimals}
            formattedTradeBaseBalance={formattedNativeBalance}
            tradeBaseTokenAddress={tradeBaseTokenAddress}
            tradeBaseTokenSymbol={tradeBaseTokenSymbol}
            tradeBaseTokenDecimals={tradeBaseTokenMeta.decimals}
            formattedTokenBalance={formattedTokenBalance}
            tokenSymbol={tokenSymbol}
            tokenPrice={tokenPrice}
            tokenAddress={tokenAddressNormalized}
            tokenInfo={tokenInfo}
          />

          <RpcPanel
            visible={showRpcPanel}
            onVisibleChange={setShowRpcPanel}
            settings={effectiveScopedSettings}
            locale={locale}
          />

          <DailyAnalysisPanel
            visible={showDailyAnalysisPanel}
            onVisibleChange={setShowDailyAnalysisPanel}
            settings={effectiveScopedSettings}
            address={siteInfo?.walletAddress ?? address}
          />

          <ReviewPanel
            visible={showReviewPanel}
            onVisibleChange={setShowReviewPanel}
            settings={effectiveScopedSettings}
            address={siteInfo?.walletAddress ?? address}
            tokenAddress={tokenAddressNormalized}
            tokenSymbol={tokenSymbol}
          />

          <CookingPanel
            visible={showCookingPanel}
            onVisibleChange={setShowCookingPanel}
            address={effectiveCookingSiteInfo?.walletAddress ?? address}
            walletAccounts={walletAccounts}
            activeWalletAddress={address as `0x${string}` | null}
            siteInfo={effectiveCookingSiteInfo}
            currentTokenName={effectiveCookingTokenInfo?.name ?? (cookingSiteInfoOverride ? null : tokenInfo?.name ?? null)}
            currentTokenSymbol={effectiveCookingTokenInfo?.symbol ?? (cookingSiteInfoOverride ? null : tokenSymbol ?? tokenInfo?.symbol ?? null)}
            currentTokenInfo={effectiveCookingTokenInfo}
            tokenInfoLoading={cookingTokenInfoLoading}
          />

          <XTradePanel
            siteInfo={siteInfo}
            visible={showXTradePanel}
            activeTab={xTradeActiveTab}
            onActiveTabChange={(tab) => {
              if (tab === 'xhistory') return;
              setXTradeActiveTab(tab);
            }}
            onVisibleChange={setShowXTradePanel}
            settings={effectiveScopedSettings}
            isUnlocked={isUnlocked}
            newPoolMonitorEnabled={newPoolMonitorEnabled}
            newCoinSniperEnabled={newCoinSniperEnabled}
            newPoolMonitorDisplayMode={newPoolMonitorDisplayMode}
            onNewPoolMonitorDisplayModeChange={handleSetNewPoolMonitorDisplayMode}
          />
          <NewPoolMonitorPanel
            siteInfo={siteInfo}
            visible={newPoolMonitorEnabled && newPoolMonitorDisplayMode === 'floating' && showNewPoolMonitorPanel}
            onVisibleChange={setShowNewPoolMonitorPanel}
            settings={effectiveScopedSettings}
            displayMode={newPoolMonitorDisplayMode}
            onDisplayModeChange={handleSetNewPoolMonitorDisplayMode}
          />
        </>
      )}
    </>
  );
}
