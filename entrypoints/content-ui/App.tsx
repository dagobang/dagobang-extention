import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { SatelliteDish } from 'lucide-react';
import { formatUnits, parseUnits, zeroAddress } from 'viem';
import type { Account, BgGetStateResponse, QuickBuyPresetOverride, Settings, SolanaSwqosProviderType, SubmitChannel, TradeSuccessSoundPreset, TradeTurboPrewarmInput } from '@/types/extention';
import type { TokenInfo, TokenStat } from '@/types/token';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { formatBroadcastProvider, formatPriceValue } from '@/utils/format';
import { parseCurrentUrl, parseCurrentUrlFull, type SiteInfo } from '@/utils/sites';
import { call } from '@/utils/messaging';
import { TokenAPI } from '@/hooks/TokenAPI';
import GmgnAPI, { type GmgnTokenHolding } from '@/hooks/GmgnAPI';
import { getChainIdByName, getNativeSymbol } from '@/constants/chains';
import { ChainId } from '@/constants/chains/chainId';
import { getChainRuntimeBase, isSolanaChain } from '@/constants/chains/runtime';
import { getEvmChainRuntime } from '@/constants/chains/evmRuntime';
import { USDC, USDT } from '@/constants/tokens/chains/common';
import { bscTokens } from '@/constants/tokens/chains/bsc';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import {
  DEFAULT_SOLANA_TIP_PRESET_VALUES,
  getRandomSolanaTipRecipient,
  getSolanaTipMinimumNative,
} from '@/utils/solanaTip';
import type { ChainAddress } from '@/types/chain/address';
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
import type { ChannelSwitcherItem } from './components/QuickTradePanel/ChannelSwitcher';
import { resolveSolanaTradeSource, SOLANA_ROUTE_LABELS } from '../../packages/solana-dex-core/src/constants';
import { SOLANA_WARM_CACHE_TTL_MS } from '../../packages/solana-dex-core/src/prewarm';

type NewPoolMonitorDisplayMode = 'floating' | 'tab';
type XTradeTab = 'xmonitor' | 'xsniper' | 'xtokensniper' | 'xnewcoinsniper' | 'xnewpoolmonitor';
type GmgnHoldingStats = {
  balanceUsd: number | null;
  currentBuyUsd: number | null;
  currentSellUsd: number | null;
  currentProfitUsd: number | null;
  currentProfitPnl: number | null;
  totalBuyUsd: number | null;
  totalSellUsd: number | null;
  totalProfitUsd: number | null;
  totalProfitPnl: number | null;
  walletsCount: number;
  updatedAt: number;
};

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
const DEFAULT_QUICK_BUY_PRESET_OVERRIDES: QuickBuyPresetOverride[] = [{}, {}, {}, {}];
const SOLANA_WRAPPED_NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYDutLCRa14Q6gttxyPjdvV';
function normalizeAddr(addr: string): `0x${string}` | null {
  const trimmed = typeof addr === 'string' ? addr.trim() : '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
}

function isLikelySolanaAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

function normalizeWalletAddress(chainId: number, addr: string): ChainAddress | null {
  const trimmed = typeof addr === 'string' ? addr.trim() : '';
  if (!trimmed) return null;
  if (isSolanaChain(chainId)) {
    return isLikelySolanaAddress(trimmed) ? trimmed : null;
  }
  return normalizeAddr(trimmed);
}

function normalizeSiteTokenAddress(chainId: number, addr: string): ChainAddress | null {
  const trimmed = typeof addr === 'string' ? addr.trim() : '';
  if (!trimmed) return null;
  if (isSolanaChain(chainId)) {
    return isLikelySolanaAddress(trimmed) ? trimmed : null;
  }
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed : null;
}

function normalizeQuickBuyPresetOverrides(raw: QuickBuyPresetOverride[] | null | undefined): QuickBuyPresetOverride[] {
  return Array.from({ length: 4 }, (_, index) => {
    const item = raw?.[index];
    const gasPreset = item?.gasPreset;
    const priorityFeePreset = item?.priorityFeePreset;
    return {
      gasPreset: gasPreset === 'slow' || gasPreset === 'standard' || gasPreset === 'fast' || gasPreset === 'turbo' ? gasPreset : undefined,
      priorityFeePreset: priorityFeePreset === 'none' || priorityFeePreset === 'slow' || priorityFeePreset === 'standard' || priorityFeePreset === 'fast'
        ? priorityFeePreset
        : undefined,
    };
  });
}

function getTokenInfoWarmFingerprint(tokenInfo: TokenInfo | null | undefined): string {
  if (!tokenInfo) return '';
  return [
    String(tokenInfo.launchpad_platform || '').toLowerCase(),
    String(tokenInfo.launchpad_status ?? ''),
    String(tokenInfo.quote_token_address || '').toLowerCase(),
  ].join('|');
}

function getSolPrewarmCacheKey(input: {
  chainId: number;
  sitePlatform?: string | null;
  tokenAddress: string;
  address?: string | null;
  tokenInfo?: TokenInfo | null;
}) {
  const platform = String(input.sitePlatform || '');
  const tokenAddress = input.tokenAddress.toLowerCase();
  const fingerprint = getTokenInfoWarmFingerprint(input.tokenInfo);
  if (input.address) {
    return `${input.chainId}:sol-owner:${input.address.toLowerCase()}:${platform}:${tokenAddress}:${fingerprint}`;
  }
  return `${input.chainId}:sol-base:${platform}:${tokenAddress}:${fingerprint}`;
}

function parseGmgnUsdValue(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) ? num : 0;
}

function parseGmgnNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveHoldingBalanceUsd(detail: GmgnTokenHolding): number {
  const direct = parseGmgnNullableNumber(detail.usd_value);
  if (direct != null) return direct;
  const balance = parseGmgnNullableNumber(detail.balance) ?? 0;
  const price = parseGmgnNullableNumber(detail.price) ?? 0;
  return balance * price;
}

function resolveHoldingUnitPriceUsd(detail: GmgnTokenHolding): number | null {
  const directUsdValue = parseGmgnNullableNumber(detail.usd_value);
  const balance = parseGmgnNullableNumber(detail.balance);
  if (directUsdValue != null && balance != null && balance > 0) {
    const unitPrice = directUsdValue / balance;
    return Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : null;
  }
  const directPrice = parseGmgnNullableNumber(detail.price)
    ?? parseGmgnNullableNumber(detail.token?.price)
    ?? parseGmgnNullableNumber((detail as any)?.token_basic_stats?.price);
  if (directPrice != null && directPrice > 0) return directPrice;
  return null;
}

function resolveHoldingTokenSymbol(detail: GmgnTokenHolding | null | undefined): string | null {
  const symbol = String(
    detail?.symbol
    || detail?.token_symbol
    || detail?.token?.symbol
    || detail?.token_basic_stats?.symbol
    || ''
  ).trim();
  return symbol || null;
}

function resolveHoldingTokenDecimals(detail: GmgnTokenHolding | null | undefined): number | null {
  const decimals = Number(
    detail?.token?.decimals
    ?? detail?.token_basic_stats?.decimals
    ?? NaN
  );
  return Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null;
}

function resolveHoldingBalanceWei(detail: GmgnTokenHolding | null | undefined): string | null {
  const balanceText = String(detail?.balance ?? '').trim();
  if (!balanceText) return null;
  const decimals = resolveHoldingTokenDecimals(detail);
  if (decimals == null) return null;
  try {
    return parseUnits(balanceText, decimals).toString();
  } catch {
    return null;
  }
}

function mapHoldingDetailToHolding(
  walletAddress: string,
  tokenAddress: string,
  detail: Awaited<ReturnType<typeof GmgnAPI.getTokenHoldingDetail>>
): GmgnTokenHolding | null {
  if (!detail) return null;
  return {
    chain_wallet: '',
    token_address: String(detail.token?.token_address || tokenAddress || '').toLowerCase(),
    wallet_address: String(walletAddress || '').trim().toLowerCase(),
    symbol: String(detail.token?.symbol || ''),
    token_symbol: String(detail.token?.symbol || ''),
    balance: String(detail.balance ?? '0'),
    price: String(detail.token?.price ?? ''),
    usd_value: String(detail.usd_value ?? ''),
    total_profit: String(detail.total_profit ?? ''),
    unrealized_profit: String(detail.unrealized_profit ?? ''),
    realized_profit: String(detail.realized_profit ?? ''),
    total_profit_pnl: detail.total_profit_pnl ?? null,
    unrealized_profit_pnl: detail.unrealized_profit_pnl ?? null,
    accu_amount: String(detail.accu_amount ?? ''),
    accu_cost: String(detail.accu_cost ?? ''),
    sold_income: String(detail.history_sold_income ?? ''),
    history_bought_cost: String(detail.history_bought_cost ?? ''),
    history_sold_income: String(detail.history_sold_income ?? ''),
    history_realized_profit: String(detail.realized_profit ?? ''),
    token: detail.token,
    token_basic_stats: {
      symbol: detail.token?.symbol,
      decimals: detail.token?.decimals,
      launchpad: detail.token?.launchpad,
      launchpad_platform: detail.token?.launchpad_platform,
    },
  } as GmgnTokenHolding;
}

function aggregateGmgnHoldings(details: Array<GmgnTokenHolding | null | undefined>): GmgnHoldingStats | null {
  const available = details.filter((item): item is GmgnTokenHolding => !!item);
  if (available.length <= 0) return null;

  const sums = available.reduce((acc, detail) => {
    const balanceUsd = resolveHoldingBalanceUsd(detail);
    const currentBuyUsd = parseGmgnUsdValue(detail.accu_cost);
    const currentSellUsd = parseGmgnUsdValue(detail.sold_income);
    const realizedProfit = parseGmgnNullableNumber(detail.realized_profit);
    const currentProfitUsd = parseGmgnNullableNumber(detail.unrealized_profit)
      ?? ((realizedProfit ?? 0) + balanceUsd - currentBuyUsd);
    const totalBuyUsd = parseGmgnUsdValue(detail.history_bought_cost);
    const totalSellUsd = parseGmgnUsdValue(detail.history_sold_income);
    const totalProfitUsd = parseGmgnNullableNumber(detail.total_profit)
      ?? ((parseGmgnNullableNumber(detail.history_realized_profit) ?? 0) + balanceUsd - currentBuyUsd);

    acc.balanceUsd += balanceUsd;
    acc.currentBuyUsd += currentBuyUsd;
    acc.currentSellUsd += currentSellUsd;
    acc.currentProfitUsd += currentProfitUsd;
    acc.totalBuyUsd += totalBuyUsd;
    acc.totalSellUsd += totalSellUsd;
    acc.totalProfitUsd += totalProfitUsd;
    return acc;
  }, {
    balanceUsd: 0,
    currentBuyUsd: 0,
    currentSellUsd: 0,
    currentProfitUsd: 0,
    totalBuyUsd: 0,
    totalSellUsd: 0,
    totalProfitUsd: 0,
  });

  return {
    ...sums,
    currentProfitPnl: sums.currentBuyUsd > 0 ? sums.currentProfitUsd / sums.currentBuyUsd : null,
    totalProfitPnl: sums.totalBuyUsd > 0 ? sums.totalProfitUsd / sums.totalBuyUsd : null,
    walletsCount: available.length,
    updatedAt: Date.now(),
  };
}

type WalletApproveState = {
  approved?: boolean;
  pendingSince?: number;
};

const APPROVE_PENDING_TIMEOUT_MS = 90_000;

function isBlockrazorProtectedUrl(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase().includes('blockrazor');
  } catch {
    return raw.toLowerCase().includes('blockrazor');
  }
}

function collectSubmitChannelUrls(settings: Settings | null | undefined, chainId: number) {
  const chain = settings?.chains?.[chainId];
  const allProtected = [
    ...(chain?.protectedRpcUrls ?? []),
    ...(((chain as any)?.protectedRpcUrlsBuy ?? []) as string[]),
    ...(((chain as any)?.protectedRpcUrlsSell ?? []) as string[]),
  ]
    .map((url) => String(url || '').trim())
    .filter(Boolean);
  const blockrazorUrls = Array.from(new Set(allProtected.filter((url) => isBlockrazorProtectedUrl(url))));
  const protectUrls = Array.from(new Set(allProtected));
  return { blockrazorUrls, protectUrls };
}

function formatSolanaSwqosProviders(settings: Settings['chains'][number]['solanaSwqos'] | null | undefined) {
  const providers = Array.isArray(settings?.providers)
    ? settings.providers.filter((item) => item?.enabled)
    : [];
  return providers.map((item) => {
    const type = String(item.type || '').trim().toLowerCase();
    if (type === 'jito') return 'Jito';
    if (type === 'nextblock') return 'NextBlock';
    if (type === 'temporal') return 'Temporal';
    if (type === 'blox') return 'Blox';
    return type || 'Provider';
  });
}

function resolveEnabledSolanaSwqosProviderTypes(settings: Settings['chains'][number]['solanaSwqos'] | null | undefined): SolanaSwqosProviderType[] {
  const providers = Array.isArray(settings?.providers)
    ? settings.providers.filter((item) => item?.enabled)
    : [];
  return providers
    .map((item) => {
      const type = String(item?.type || '').trim().toLowerCase();
      return type === 'jito'
        || type === 'nextblock'
        || type === 'blox'
        || type === 'temporal'
        || type === 'zeroslot'
        || type === 'node1'
        || type === 'flashblock'
        || type === 'blockrazor'
        || type === 'astralane'
        ? type
        : null;
    })
    .filter((item): item is SolanaSwqosProviderType => !!item);
}

function resolveTradeBaseTokenAddress(settings: Settings | null | undefined, chainIdOverride?: number): ChainAddress {
  const chainId = chainIdOverride ?? settings?.chainId ?? 56;
  if (isSolanaChain(chainId)) return zeroAddress;
  const runtime = getEvmChainRuntime(chainId);
  const baseToken = String(settings?.chains?.[chainId]?.tradeBaseToken ?? settings?.tradeBaseToken ?? 'BNB').toUpperCase();
  if (baseToken === 'WBNB') return runtime.wrappedNativeAddress;
  if (baseToken === 'USDC') return (USDC[chainId as keyof typeof USDC]?.address ?? zeroAddress) as `0x${string}`;
  if (baseToken === 'USDT') return (USDT[chainId as keyof typeof USDT]?.address ?? zeroAddress) as `0x${string}`;
  if (baseToken === 'USD1' && chainId === 56) return bscTokens.usd1.address as `0x${string}`;
  return zeroAddress;
}

function resolveTradeBaseTokenMeta(chainId: number, tradeBaseTokenAddress: ChainAddress) {
  const runtime = getChainRuntimeBase(chainId);
  const target = tradeBaseTokenAddress.toLowerCase();
  if (target === zeroAddress.toLowerCase()) {
    return { symbol: runtime.nativeSymbol, decimals: runtime.kind === 'evm' ? getEvmChainRuntime(chainId).viemChain.nativeCurrency.decimals : 9 };
  }

  if (runtime.kind === 'evm' && target === getEvmChainRuntime(chainId).wrappedNativeAddress.toLowerCase()) {
    return { symbol: `W${runtime.nativeSymbol}`, decimals: getEvmChainRuntime(chainId).viemChain.nativeCurrency.decimals };
  }

  if (isSolanaChain(chainId)) {
    if (target === SOLANA_WRAPPED_NATIVE_MINT.toLowerCase()) {
      return { symbol: 'WSOL', decimals: 9 };
    }
    if (target === SOLANA_USDC_MINT.toLowerCase()) {
      return { symbol: 'USDC', decimals: 6 };
    }
    if (target === SOLANA_USDT_MINT.toLowerCase()) {
      return { symbol: 'USDT', decimals: 6 };
    }
    return { symbol: 'TOKEN', decimals: 9 };
  }

  const usdc = USDC[chainId as keyof typeof USDC];
  if (usdc && target === usdc.address.toLowerCase()) {
    return { symbol: usdc.symbol, decimals: usdc.decimals };
  }

  const usdt = USDT[chainId as keyof typeof USDT];
  if (usdt && target === usdt.address.toLowerCase()) {
    return { symbol: usdt.symbol, decimals: usdt.decimals };
  }

  if (chainId === 56 && target === bscTokens.usd1.address.toLowerCase()) {
    return { symbol: bscTokens.usd1.symbol, decimals: bscTokens.usd1.decimals };
  }

  return { symbol: 'TOKEN', decimals: runtime.kind === 'evm' ? getEvmChainRuntime(chainId).viemChain.nativeCurrency.decimals : 9 };
}

function deriveUsdFromBaseAmount(
  amount: number,
  tradeBaseTokenAddress: ChainAddress,
  tradeBaseTokenMeta: { symbol: string },
  baseTokenPriceUsd: number | null,
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const symbol = tradeBaseTokenMeta.symbol.toUpperCase();
  if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'USD1') return amount;
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
  if (symbol === 'USDC' || symbol === 'USDT' || symbol === 'USD1') return usdAmount;
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
    if (formatted === '-') return '0';
    const [intPartRaw, fracPart] = formatted.split('.');
    const sign = intPartRaw.startsWith('-') ? '-' : '';
    const intPart = sign ? intPartRaw.slice(1) : intPartRaw;
    const withSeparators = `${sign}${intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
    return fracPart ? `${withSeparators}.${fracPart}` : withSeparators;
  } catch {
    return '0';
  }
}

function resolveSelectedTradeWallets(
  wallet: BgGetStateResponse['wallet'] | null | undefined,
  settings: Settings | null | undefined,
  chainId: number
): ChainAddress[] {
  if (!wallet?.isUnlocked) return [];
  const allAccounts = Array.isArray(wallet.accounts) ? wallet.accounts : [];
  const byLower = new Map<string, ChainAddress>();
  for (const acc of allAccounts) {
    const normalized = normalizeWalletAddress(chainId, String(acc.address || ''));
    if (!normalized) continue;
    byLower.set(normalized.toLowerCase(), normalized);
  }
  const selectedRaw = Array.isArray(settings?.selectedTradeWallets) ? settings!.selectedTradeWallets : [];
  const picked = selectedRaw
    .map((x) => byLower.get(String(x).toLowerCase()))
    .filter(Boolean) as ChainAddress[];
  const deduped = Array.from(new Set(picked.map((x) => x.toLowerCase()))).map((x) => byLower.get(x)!).filter(Boolean);
  if (deduped.length > 0) return deduped;
  const fallback = normalizeWalletAddress(chainId, String(wallet.address || ''));
  return fallback ? [fallback] : [];
}

const SOL_PENDING_TOKEN_DELTA_TTL_MS = 15_000;
const TOKEN_CONTEXT_STICKY_MS = 10_000;

type PendingSolTokenDeltaEntry = {
  id: string;
  deltaWei: string;
  expiresAt: number;
};

type PendingAutoSellOrderContext = {
  chainId: number;
  tokenAddress: string;
  walletAddress: ChainAddress;
  siteInfo: SiteInfo;
  tokenInfo: TokenInfo;
  tokenSymbol: string | null;
};

function getPendingTokenDeltaKey(tokenAddress: string, walletAddress: string) {
  return `${String(tokenAddress || '').trim().toLowerCase()}:${String(walletAddress || '').trim().toLowerCase()}`;
}

function getPendingTradeBaseDeltaKey(baseTokenAddress: string, walletAddress: string) {
  return `${String(baseTokenAddress || '').trim().toLowerCase()}:${String(walletAddress || '').trim().toLowerCase()}`;
}

function normalizeChainScopedAddressKey(chainId: number, value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return isSolanaChain(chainId) ? trimmed : trimmed.toLowerCase();
}

function getPendingAutoSellOrderKey(chainId: number, tokenAddress: string, walletAddress: string) {
  return `${chainId}:${normalizeChainScopedAddressKey(chainId, tokenAddress)}:${normalizeChainScopedAddressKey(chainId, walletAddress)}`;
}

export default function App() {
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(() => parseCurrentUrl(window.location.href));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<BgGetStateResponse | null>(null);
  const stateRef = useRef<BgGetStateResponse | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
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
  const [pendingBuyQuotedOutWei, setPendingBuyQuotedOutWei] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftBuyPresets, setDraftBuyPresets] = useState<string[]>([]);
  const [draftSellPresets, setDraftSellPresets] = useState<string[]>([]);
  const [draftQuickBuyAdvancedEnabled, setDraftQuickBuyAdvancedEnabled] = useState(false);
  const [draftQuickBuyPresetOverrides, setDraftQuickBuyPresetOverrides] = useState<QuickBuyPresetOverride[]>(DEFAULT_QUICK_BUY_PRESET_OVERRIDES);
  const [tokenStat, setTokenStat] = useState<TokenStat | null>(null);
  const [tokenPriceUsd, setTokenPriceUsd] = useState<number | null>(null);
  const [tradeBasePriceUsd, setTradeBasePriceUsd] = useState<number | null>(null);
  const [buyPreviewQuotedUsd, setBuyPreviewQuotedUsd] = useState<Array<number | null>>([null, null, null, null]);
  const [buyPreviewQuotedTokenAmounts, setBuyPreviewQuotedTokenAmounts] = useState<Array<number | null>>([null, null, null, null]);
  const [sellPreviewQuotedUsd, setSellPreviewQuotedUsd] = useState<Array<number | null>>([null, null, null, null]);
  const [sellPreviewQuotedBaseAmounts, setSellPreviewQuotedBaseAmounts] = useState<Array<number | null>>([null, null, null, null]);
  const [marketCapDisplay, setMarketCapDisplay] = useState<string | null>(null);
  const [liquidityDisplay, setLiquidityDisplay] = useState<string | null>(null);
  const [gmgnHoldingStats, setGmgnHoldingStats] = useState<GmgnHoldingStats | null>(null);
  const [gmgnHoldingTokenPriceUsd, setGmgnHoldingTokenPriceUsd] = useState<number | null>(null);
  const [gmgnHoldingTokenBalanceWei, setGmgnHoldingTokenBalanceWei] = useState<string | null>(null);
  const [gmgnHoldingTokenDecimals, setGmgnHoldingTokenDecimals] = useState<number | null>(null);
  const [gmgnHoldingTokenSymbol, setGmgnHoldingTokenSymbol] = useState<string | null>(null);
  const [walletApproveStates, setWalletApproveStates] = useState<Record<string, WalletApproveState>>({});
  const [gmgnHoldingPollingEnabled, setGmgnHoldingPollingEnabled] = useState(false);
  const [pendingQuickBuy, setPendingQuickBuy] = useState<{ tokenAddress: string; amount: string } | null>(null);
  const [cookingSiteInfoOverride, setCookingSiteInfoOverride] = useState<SiteInfo | null>(null);
  const [cookingTokenInfoOverride, setCookingTokenInfoOverride] = useState<TokenInfo | null>(null);
  const [cookingTokenInfoLoading, setCookingTokenInfoLoading] = useState(false);
  const [gmgnBuyEnabled, setGmgnBuyEnabled] = useState(false);
  const [gmgnSellEnabled, setGmgnSellEnabled] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const siteInfoRef = useRef<SiteInfo | null>(siteInfo);
  const pendingQuickBuyRef = useRef<{ tokenAddress: string; amount: string } | null>(pendingQuickBuy);
  const actualWalletTokenBalancesRef = useRef<Record<string, string>>({});
  const effectiveWalletTokenBalancesRef = useRef<Record<string, string>>({});
  const pendingSolTokenDeltasRef = useRef<Record<string, PendingSolTokenDeltaEntry[]>>({});
  const actualWalletTradeBaseBalancesRef = useRef<Record<string, string>>({});
  const effectiveWalletTradeBaseBalancesRef = useRef<Record<string, string>>({});
  const pendingSolTradeBaseDeltasRef = useRef<Record<string, PendingSolTokenDeltaEntry[]>>({});
  const settingsRef = useRef<Settings | null>(null);
  const effectiveChainIdRef = useRef<number>(56);
  const minimizedRef = useRef(false);
  const isEditingRef = useRef(false);
  const keyboardEnabledRef = useRef(false);
  const spaceHeldRef = useRef(false);
  const solTradeOutcomeRef = useRef(new Map<string, 'submitted' | 'success' | 'failed'>());
  const handleBuyRef = useRef<(amountStr: string, presetIndex: number) => void>(() => { });
  const handleSellRef = useRef<(pct: number) => void>(() => { });
  const prewarmedTurboRef = useRef<Map<string, number>>(new Map());
  const prewarmedRpcRef = useRef<Set<string>>(new Set());
  const prewarmTurboInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const solSubmitKickoffQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const fastPollingRef = useRef<any>(null);
  const approveStatusRefreshSeqRef = useRef(0);
  const tokenRefreshSeqRef = useRef(0);
  const gmgnHoldingRefreshSeqRef = useRef(0);
  const solBaseBalanceRefreshSeqRef = useRef(0);
  const solTokenBalanceRefreshSeqRef = useRef(0);
  const gmgnHoldingPollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bgStateChangedSeqRef = useRef(0);
  const bgStateChangedHandledAtRef = useRef(0);
  const bgStateChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cookingTokenInfoReqSeqRef = useRef(0);
  const deleteSoundPlayedAtRef = useRef<Record<string, number>>({});
  const autoTradeOrderSoundPlayedAtRef = useRef<Record<string, number>>({});
  const stickyTokenSiteInfoRef = useRef<{ siteInfo: SiteInfo | null; updatedAt: number }>({ siteInfo: null, updatedAt: 0 });
  const tokenPriceCacheRef = useRef(new Map<string, number>());
  const pendingAutoSellOrdersRef = useRef(new Map<string, PendingAutoSellOrderContext>());

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
  const isSolana = isSolanaChain(chainId);
  const effectiveChainSettings = settings?.chains?.[chainId] ?? null;
  const effectiveScopedSettings = useMemo(
    () => (settings ? { ...settings, chainId } : null),
    [settings, chainId]
  );
  const [bloxProbeState, setBloxProbeState] = useState<{
    checked: boolean;
    loading: boolean;
    reachable: boolean;
    message?: string;
  }>({ checked: false, loading: false, reachable: false });
  const [rpcPrewarmState, setRpcPrewarmState] = useState<'idle' | 'warming' | 'done'>('idle');
  const [turboPrewarmState, setTurboPrewarmState] = useState<'idle' | 'warming' | 'done'>('idle');
  const SOL_PREWARM_KEEPWARM_INTERVAL_MS = 2_000;
  const SOL_PREWARM_REFRESH_TTL_MS = Math.max(
    SOL_PREWARM_KEEPWARM_INTERVAL_MS,
    SOLANA_WARM_CACHE_TTL_MS.dynamicQuote,
  );
  const submitChannel = (effectiveChainSettings?.submitChannel ?? 'protectRpcs') as SubmitChannel;
  const isSolPrewarmFresh = useCallback((key: string) => {
    const warmedAt = prewarmedTurboRef.current.get(key);
    return typeof warmedAt === 'number' && (Date.now() - warmedAt) < SOL_PREWARM_REFRESH_TTL_MS;
  }, [SOL_PREWARM_REFRESH_TTL_MS]);
  const hasSolPrewarmSnapshot = useCallback((key: string) => {
    return prewarmedTurboRef.current.has(key);
  }, []);
  const channelOptions = useMemo<ChannelSwitcherItem[]>(() => {
    if (isSolana) {
      const swqos = effectiveChainSettings?.solanaSwqos;
      const enabledProviders = formatSolanaSwqosProviders(swqos);
      const swqosConfigured = enabledProviders.length > 0;
      const strategyLabel = (swqos?.strategy ?? 'concurrent') === 'single' ? '单路' : '并发';
      return [
        {
          key: 'rpc',
          label: 'RPC',
          configured: true,
          available: true,
          reason: '标准 RPC 广播',
        },
        {
          key: 'swqos',
          label: 'SWQoS',
          configured: swqosConfigured,
          available: swqosConfigured,
          reason: swqosConfigured
            ? `${strategyLabel} · ${enabledProviders.join('+')}`
            : '未配置 Provider',
        },
      ];
    }
    const authHeader = String(settings?.bloxrouteAuthHeader ?? '').trim();
    const { blockrazorUrls, protectUrls } = collectSubmitChannelUrls(settings, chainId);
    const bloxReady = !!authHeader && bloxProbeState.reachable;
    const bloxStatus: ChannelSwitcherItem = {
      key: 'blox',
      label: 'Blox',
      configured: !!authHeader,
      available: bloxReady,
      reason: !authHeader
        ? '未配置'
        : (bloxProbeState.loading
          ? '检测中'
          : (bloxProbeState.reachable
            ? '已就绪'
            : (bloxProbeState.checked ? (bloxProbeState.message || '连接异常') : '待检测'))),
    };
    const blockrazorReady = blockrazorUrls.length > 0;
    const protectReady = protectUrls.length > 0;
    const blockrazorStatus: ChannelSwitcherItem = {
      key: 'blockrazor',
      label: 'Razor',
      configured: blockrazorReady,
      available: blockrazorReady,
      reason: blockrazorReady ? '已就绪' : '未配置',
    };
    const protectStatus: ChannelSwitcherItem = {
      key: 'protectRpcs',
      label: 'Protect',
      configured: protectReady,
      available: protectReady,
      reason: protectReady ? '已就绪' : '未配置',
    };
    const mixedStatus: ChannelSwitcherItem = {
      key: 'mixed',
      label: '混合',
      configured: bloxStatus.configured && protectReady,
      available: bloxReady && protectReady,
      reason: !bloxStatus.configured
        ? '缺少 Blox'
        : !protectReady
          ? '缺少 Protect'
          : (bloxReady ? '已就绪' : '待检测'),
    };
    return [bloxStatus, blockrazorStatus, protectStatus, mixedStatus];
  }, [settings, chainId, bloxProbeState, effectiveChainSettings?.solanaSwqos, isSolana]);
  const channelActiveKey = useMemo(
    () => (isSolana ? (effectiveChainSettings?.solanaSwqos?.enabled ? 'swqos' : 'rpc') : submitChannel),
    [effectiveChainSettings?.solanaSwqos?.enabled, isSolana, submitChannel]
  );
  const selectedTradeWallets = useMemo(
    () => resolveSelectedTradeWallets(state?.wallet, settings, chainId),
    [state?.wallet, settings, chainId]
  );
  const selectedTradeWalletsKey = useMemo(
    () => selectedTradeWallets.map((item) => item.toLowerCase()).sort().join(','),
    [selectedTradeWallets]
  );
  const gmgnHoldingWallets = useMemo(() => {
    if (selectedTradeWallets.length > 0) return selectedTradeWallets;
    const fallback = normalizeWalletAddress(chainId, String(address || ''));
    return fallback ? [fallback] : [];
  }, [selectedTradeWallets, address, chainId]);
  const gmgnHoldingWalletsKey = useMemo(
    () => gmgnHoldingWallets.map((item) => item.toLowerCase()).sort().join(','),
    [gmgnHoldingWallets]
  );

  useEffect(() => {
    const authHeader = String(settings?.bloxrouteAuthHeader ?? '').trim();
    if (!authHeader) {
      setBloxProbeState({ checked: true, loading: false, reachable: false, message: '未配置' });
      return;
    }
    let cancelled = false;
    setBloxProbeState((prev) => ({ checked: prev.checked, loading: true, reachable: prev.reachable, message: prev.message }));
    void call({ type: 'bloxroute:probe', authHeader } as const)
      .then((res) => {
        if (cancelled) return;
        setBloxProbeState({
          checked: true,
          loading: false,
          reachable: res.ok && res.status === 'reachable',
          message: res.ok && res.status === 'reachable' ? undefined : (res.message || '连接异常'),
        });
      })
      .catch((error: any) => {
        if (cancelled) return;
        setBloxProbeState({
          checked: true,
          loading: false,
          reachable: false,
          message: String(error?.message || error || '连接异常'),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.bloxrouteAuthHeader]);
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
  useEffect(() => {
    if (!siteInfo?.tokenAddress) return;
    stickyTokenSiteInfoRef.current = { siteInfo, updatedAt: Date.now() };
  }, [siteInfo]);
  const tokenContextSiteInfo = useMemo(() => {
    if (siteInfo?.tokenAddress) return siteInfo;
    const sticky = stickyTokenSiteInfoRef.current.siteInfo;
    const stickyUpdatedAt = stickyTokenSiteInfoRef.current.updatedAt;
    if (!sticky?.tokenAddress) return siteInfo;
    if (Date.now() - stickyUpdatedAt > TOKEN_CONTEXT_STICKY_MS) return siteInfo;
    const rawPlatform = String(siteInfo?.platform || '').trim().toLowerCase();
    const rawChain = String(siteInfo?.chain || '').trim().toLowerCase();
    const stickyPlatform = String(sticky.platform || '').trim().toLowerCase();
    const stickyChain = String(sticky.chain || '').trim().toLowerCase();
    if (rawPlatform && rawPlatform !== stickyPlatform) return siteInfo;
    if (rawChain && rawChain !== stickyChain) return siteInfo;
    return sticky;
  }, [siteInfo]);
  const tokenAddressNormalized = useMemo(() => {
    if (!tokenContextSiteInfo?.tokenAddress) return null;
    return normalizeSiteTokenAddress(chainId, tokenContextSiteInfo.tokenAddress);
  }, [chainId, tokenContextSiteInfo]);
  const gmgnHoldingChain = isSolana ? 'sol' : String(siteInfo?.chain || '').trim().toLowerCase();
  const shouldEnableHoldingStats = !!tokenAddressNormalized && gmgnHoldingWallets.length > 0;
  useEffect(() => {
    approveStatusRefreshSeqRef.current += 1;
    setWalletApproveStates({});
  }, [chainId, tokenAddressNormalized, selectedTradeWalletsKey]);
  const consoleLogsEnabled = settings?.ui?.consoleLogsEnabled === true;
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
    if (!isSolana) {
      effectiveWalletTokenBalancesRef.current = walletTokenBalancesWei;
    }
  }, [isSolana, walletTokenBalancesWei]);

  useEffect(() => {
    effectiveWalletTradeBaseBalancesRef.current = walletTradeBaseBalancesWei;
  }, [walletTradeBaseBalancesWei]);

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
      setDraftQuickBuyAdvancedEnabled(!!settings.chains[quickBuyChainId]?.quickBuyAdvancedEnabled);
      setDraftQuickBuyPresetOverrides(normalizeQuickBuyPresetOverrides(settings.chains[quickBuyChainId]?.quickBuyPresetOverrides));
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
  const normalizedSitePlatform = useMemo(
    () => String(siteInfo?.platform || '').trim().toLowerCase(),
    [siteInfo?.platform]
  );
  const shouldKeepSolPrewarmWarm = !!tokenAddressNormalized && (!minimized || limitTradePanelVisible || showCookingPanel);
  const waitForSolTurboPrewarmReady = useCallback(async (walletAddress?: string | null) => {
    if (!isSolana) return;
    if (!tokenAddressNormalized) return;
    if ((effectiveChainSettings?.executionMode ?? 'default') !== 'turbo') return;
    const baseKey = getSolPrewarmCacheKey({
      chainId,
      sitePlatform: normalizedSitePlatform,
      tokenAddress: tokenAddressNormalized,
      tokenInfo: tokenInfo as TokenInfo | null | undefined,
    });
    const ownerKey = walletAddress
      ? getSolPrewarmCacheKey({
        chainId,
        sitePlatform: normalizedSitePlatform,
        tokenAddress: tokenAddressNormalized,
        address: walletAddress,
        tokenInfo: tokenInfo as TokenInfo | null | undefined,
      })
      : null;
    const pending = [
      prewarmTurboInFlightRef.current.get(baseKey),
      ownerKey ? prewarmTurboInFlightRef.current.get(ownerKey) : null,
    ].filter((item): item is Promise<void> => !!item);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    if (!isSolPrewarmFresh(baseKey) && !hasSolPrewarmSnapshot(baseKey)) {
      throw new Error('交易预热中，请稍后再试');
    }
  }, [
    isSolana,
    tokenAddressNormalized,
    effectiveChainSettings?.executionMode,
    chainId,
    normalizedSitePlatform,
    tokenInfo,
    isSolPrewarmFresh,
    hasSolPrewarmSnapshot,
  ]);

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

  const tokenContextKey = `${tokenContextSiteInfo?.platform ?? ''}:${tokenContextSiteInfo?.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
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
    actualWalletTokenBalancesRef.current = {};
    effectiveWalletTokenBalancesRef.current = {};
    setTokenBalanceWei('0');
    setWalletTokenBalancesWei({});
    setTokenStat(null);
    setTokenPriceUsd(null);
    setMarketCapDisplay(null);
    setLiquidityDisplay(null);
    setTxHash(null);
    setPendingBuyQuotedOutWei(null);
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
    if (isSolana) {
      setRpcPrewarmState('done');
      return;
    }
    const chain = settings.chains[chainId];
    if (!chain) {
      setRpcPrewarmState('idle');
      return;
    }
    const key = [
      chainId,
      ...(chain.rpcUrls ?? []),
      ...(chain.protectedRpcUrls ?? []),
      ...(((chain as any).protectedRpcUrlsBuy ?? []) as string[]),
      ...(((chain as any).protectedRpcUrlsSell ?? []) as string[]),
    ].join('|');
    if (prewarmedRpcRef.current.has(key)) {
      setRpcPrewarmState('done');
      return;
    }
    let cancelled = false;
    setRpcPrewarmState('warming');
    prewarmedRpcRef.current.add(key);
    void call({
      type: 'rpc:prewarm',
      input: { timeoutMs: 1500 },
    } as const)
      .catch(() => { })
      .finally(() => {
        if (!cancelled) setRpcPrewarmState('done');
      });
    return () => {
      cancelled = true;
    };
  }, [settings, chainId, isSolana]);

  const startSolTurboPrewarm = useCallback((input: {
    key: string;
    fromAddress?: string;
    debugStartLocation?: string;
    debugDoneLocation?: string;
    debugMsgPrefix?: string;
    onDone?: () => void;
  }) => {
    if (!tokenAddressNormalized) return Promise.resolve();
    const existing = prewarmTurboInFlightRef.current.get(input.key);
    if (existing) return existing;
    if (input.debugStartLocation && input.debugMsgPrefix) {
    }
    const prewarmInput: TradeTurboPrewarmInput = {
      chainId,
      tokenAddress: tokenAddressNormalized,
      tokenInfo: tokenInfo ?? undefined,
      fromAddress: input.fromAddress,
      submitChannel,
      platform: normalizedSitePlatform || undefined,
    };
    const inflight = call({
      type: 'trade:prewarmTurbo',
      input: prewarmInput,
    } as const)
      .then(() => {
        prewarmedTurboRef.current.set(input.key, Date.now());
      })
      .catch(() => {
        prewarmedTurboRef.current.delete(input.key);
      })
      .finally(() => {
        prewarmTurboInFlightRef.current.delete(input.key);
        if (input.debugDoneLocation && input.debugMsgPrefix) {
        }
        input.onDone?.();
      });
    prewarmTurboInFlightRef.current.set(input.key, inflight);
    return inflight;
  }, [chainId, normalizedSitePlatform, submitChannel, tokenAddressNormalized, tokenInfo]);

  useEffect(() => {
    if (!tokenAddressNormalized) {
      setTurboPrewarmState('idle');
      return;
    }
    if (isSolana) {
      const key = getSolPrewarmCacheKey({
        chainId,
        sitePlatform: normalizedSitePlatform,
        tokenAddress: tokenAddressNormalized,
        tokenInfo: tokenInfo as TokenInfo | null | undefined,
      });
      if (isSolPrewarmFresh(key)) {
        setTurboPrewarmState('done');
        return;
      }
      let cancelled = false;
      setTurboPrewarmState('warming');
      void startSolTurboPrewarm({
        key,
        debugStartLocation: 'App.tsx:solBasePrewarmStart',
        debugDoneLocation: 'App.tsx:solBasePrewarmDone',
        debugMsgPrefix: 'ui sol base prewarm',
        onDone: () => {
          if (!cancelled) setTurboPrewarmState('done');
        },
      });
      return () => {
        cancelled = true;
      };
    }
    if (!isUnlocked || !address || !tokenInfo) {
      setTurboPrewarmState('warming');
      return;
    }
    const key = getSolPrewarmCacheKey({
      chainId,
      sitePlatform: normalizedSitePlatform,
      tokenAddress: tokenAddressNormalized,
      address,
      tokenInfo: tokenInfo as TokenInfo | null | undefined,
    });
    if (isSolPrewarmFresh(key)) {
      setTurboPrewarmState('done');
      return;
    }
    let cancelled = false;
    setTurboPrewarmState('warming');
    void startSolTurboPrewarm({
      key,
      fromAddress: address,
      onDone: () => {
        if (!cancelled) setTurboPrewarmState('done');
      },
    });
    return () => {
      cancelled = true;
    };
  }, [isUnlocked, address, tokenAddressNormalized, tokenInfo, chainId, submitChannel, isSolana, normalizedSitePlatform, startSolTurboPrewarm]);

  useEffect(() => {
    if (!isSolana || !tokenAddressNormalized || selectedTradeWallets.length <= 0) return;
    let cancelled = false;
    const ownerKeys = selectedTradeWallets.map((walletAddress) => ({
      walletAddress,
      key: getSolPrewarmCacheKey({
        chainId,
        sitePlatform: normalizedSitePlatform,
        tokenAddress: tokenAddressNormalized,
        address: walletAddress,
        tokenInfo: tokenInfo as TokenInfo | null | undefined,
      }),
    }));
    if (ownerKeys.every((item) => isSolPrewarmFresh(item.key))) {
      setTurboPrewarmState('done');
      return;
    }
    setTurboPrewarmState('warming');
    void Promise.allSettled(ownerKeys.map((item) => {
      if (isSolPrewarmFresh(item.key)) return Promise.resolve();
      return startSolTurboPrewarm({
        key: item.key,
        fromAddress: item.walletAddress,
        debugStartLocation: 'App.tsx:solOwnerPrewarmStart',
        debugDoneLocation: 'App.tsx:solOwnerPrewarmDone',
        debugMsgPrefix: 'ui sol owner prewarm',
      });
    })).then(() => {
      if (!cancelled) setTurboPrewarmState('done');
    });
    return () => {
      cancelled = true;
    };
  }, [isSolana, tokenAddressNormalized, selectedTradeWalletsKey, selectedTradeWallets, chainId, normalizedSitePlatform, startSolTurboPrewarm, tokenInfo, isSolPrewarmFresh]);

  useEffect(() => {
    if (!isSolana || !tokenAddressNormalized || !shouldKeepSolPrewarmWarm) return;
    let disposed = false;
    const tick = () => {
      if (disposed || document.hidden) return;
      const baseKey = getSolPrewarmCacheKey({
        chainId,
        sitePlatform: normalizedSitePlatform,
        tokenAddress: tokenAddressNormalized,
        tokenInfo: tokenInfo as TokenInfo | null | undefined,
      });
      if (!isSolPrewarmFresh(baseKey) && !prewarmTurboInFlightRef.current.has(baseKey)) {
        void startSolTurboPrewarm({
          key: baseKey,
          debugStartLocation: 'App.tsx:solKeepWarmBaseStart',
          debugDoneLocation: 'App.tsx:solKeepWarmBaseDone',
          debugMsgPrefix: 'ui sol keepwarm base',
        });
      }
      for (const walletAddress of selectedTradeWallets) {
        const ownerKey = getSolPrewarmCacheKey({
          chainId,
          sitePlatform: normalizedSitePlatform,
          tokenAddress: tokenAddressNormalized,
          address: walletAddress,
          tokenInfo: tokenInfo as TokenInfo | null | undefined,
        });
        if (!isSolPrewarmFresh(ownerKey) && !prewarmTurboInFlightRef.current.has(ownerKey)) {
          void startSolTurboPrewarm({
            key: ownerKey,
            fromAddress: walletAddress,
            debugStartLocation: 'App.tsx:solKeepWarmOwnerStart',
            debugDoneLocation: 'App.tsx:solKeepWarmOwnerDone',
            debugMsgPrefix: 'ui sol keepwarm owner',
          });
        }
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) tick();
    };
    const timer = window.setInterval(tick, SOL_PREWARM_KEEPWARM_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    isSolana,
    tokenAddressNormalized,
    shouldKeepSolPrewarmWarm,
    chainId,
    selectedTradeWallets,
    selectedTradeWalletsKey,
    normalizedSitePlatform,
    tokenInfo,
    startSolTurboPrewarm,
    isSolPrewarmFresh,
    SOL_PREWARM_KEEPWARM_INTERVAL_MS,
  ]);

  const shouldShowPrewarmIndicator = !!tokenAddressNormalized;
  const prewarmIndicatorState = useMemo<'hidden' | 'warming' | 'done'>(() => {
    if (!shouldShowPrewarmIndicator) return 'hidden';
    const turboExpected = isSolana ? selectedTradeWallets.length > 0 : (!!isUnlocked && !!address);
    if (rpcPrewarmState === 'warming') return 'warming';
    if (turboExpected && turboPrewarmState !== 'done') return 'warming';
    return 'done';
  }, [shouldShowPrewarmIndicator, isSolana, selectedTradeWallets.length, isUnlocked, address, rpcPrewarmState, turboPrewarmState]);
  const prewarmIndicatorTitle = useMemo(() => {
    if (!shouldShowPrewarmIndicator) return undefined;
    if (prewarmIndicatorState === 'warming') {
      const parts: string[] = [];
      if (rpcPrewarmState === 'warming') parts.push('RPC');
      const turboExpected = isSolana ? selectedTradeWallets.length > 0 : (!!isUnlocked && !!address);
      if (turboExpected && turboPrewarmState !== 'done') {
        parts.push(isSolana ? '交易预取' : (tokenInfo ? '交易路由' : '代币信息'));
      }
      return parts.length
        ? `预热中：正在查询${parts.join('和')}`
        : '预热中：正在初始化交易预热';
    }
    return isSolana
      ? '预热完成：当前代币详情页已完成 SOL 交易预取'
      : '预热完成：当前代币详情页已完成预热';
  }, [shouldShowPrewarmIndicator, prewarmIndicatorState, rpcPrewarmState, turboPrewarmState, isUnlocked, address, selectedTradeWallets.length, tokenInfo, isSolana]);

  const formattedNativeBalance = useMemo(
    () => formatTokenAmountForDisplay(tradeBaseBalanceWei, tradeBaseTokenMeta.decimals),
    [tradeBaseBalanceWei, tradeBaseTokenMeta.decimals]
  );
  const resolvedTokenDecimals = useMemo(() => {
    if (Number.isFinite(tokenDecimals as number) && (tokenDecimals as number) >= 0) {
      return Number(tokenDecimals);
    }
    if (Number.isFinite(gmgnHoldingTokenDecimals as number) && (gmgnHoldingTokenDecimals as number) >= 0) {
      return Number(gmgnHoldingTokenDecimals);
    }
    return isSolana ? 9 : 18;
  }, [tokenDecimals, gmgnHoldingTokenDecimals, isSolana]);

  const quoteSymbol = useMemo(() => {
    if (!tokenInfo) return null;
    return tokenInfo.quote_token || 'BNB';
  }, [tokenInfo]);

  const cachedTokenPriceUsd = useMemo(() => {
    if (!tokenAddressNormalized) return null;
    return tokenPriceCacheRef.current.get(`${chainId}:${tokenAddressNormalized}`) ?? null;
  }, [chainId, tokenAddressNormalized]);

  const tokenPrice = useMemo(() => {
    if (tokenPriceUsd && Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0) {
      return tokenPriceUsd;
    }
    if (chainId === ChainId.SOL && gmgnHoldingTokenPriceUsd && Number.isFinite(gmgnHoldingTokenPriceUsd) && gmgnHoldingTokenPriceUsd > 0) {
      return gmgnHoldingTokenPriceUsd;
    }
    if (cachedTokenPriceUsd && Number.isFinite(cachedTokenPriceUsd) && cachedTokenPriceUsd > 0) {
      return cachedTokenPriceUsd;
    }
    return null;
  }, [cachedTokenPriceUsd, chainId, gmgnHoldingTokenPriceUsd, tokenPriceUsd]);

  useEffect(() => {
    if (!tokenAddressNormalized) return;
    const nextPrice =
      (tokenPriceUsd && Number.isFinite(tokenPriceUsd) && tokenPriceUsd > 0)
        ? tokenPriceUsd
        : (chainId === ChainId.SOL && gmgnHoldingTokenPriceUsd && Number.isFinite(gmgnHoldingTokenPriceUsd) && gmgnHoldingTokenPriceUsd > 0)
          ? gmgnHoldingTokenPriceUsd
          : null;
    if (nextPrice == null) return;
    tokenPriceCacheRef.current.set(`${chainId}:${tokenAddressNormalized}`, nextPrice);
  }, [chainId, gmgnHoldingTokenPriceUsd, tokenAddressNormalized, tokenPriceUsd]);

  const getPendingSolTokenDeltaEntries = useCallback((tokenAddress: string, walletAddress: string) => {
    const key = getPendingTokenDeltaKey(tokenAddress, walletAddress);
    const entries = pendingSolTokenDeltasRef.current[key];
    if (!Array.isArray(entries) || entries.length <= 0) {
      delete pendingSolTokenDeltasRef.current[key];
      return [] as PendingSolTokenDeltaEntry[];
    }
    const now = Date.now();
    const activeEntries = entries.filter((entry) => !(entry.expiresAt > 0 && entry.expiresAt <= now));
    if (activeEntries.length > 0) {
      pendingSolTokenDeltasRef.current[key] = activeEntries;
    } else {
      delete pendingSolTokenDeltasRef.current[key];
    }
    return activeEntries;
  }, []);

  const getPendingSolTradeBaseDeltaEntries = useCallback((baseTokenAddress: string, walletAddress: string) => {
    const key = getPendingTradeBaseDeltaKey(baseTokenAddress, walletAddress);
    const entries = pendingSolTradeBaseDeltasRef.current[key];
    if (!Array.isArray(entries) || entries.length <= 0) {
      delete pendingSolTradeBaseDeltasRef.current[key];
      return [] as PendingSolTokenDeltaEntry[];
    }
    const now = Date.now();
    const activeEntries = entries.filter((entry) => !(entry.expiresAt > 0 && entry.expiresAt <= now));
    if (activeEntries.length > 0) {
      pendingSolTradeBaseDeltasRef.current[key] = activeEntries;
    } else {
      delete pendingSolTradeBaseDeltasRef.current[key];
    }
    return activeEntries;
  }, []);

  const getPendingSolTokenDeltaWei = useCallback((tokenAddress: string, walletAddress: string) => {
    let total = 0n;
    for (const entry of getPendingSolTokenDeltaEntries(tokenAddress, walletAddress)) {
      try {
        total += BigInt(entry.deltaWei || '0');
      } catch {
      }
    }
    return total;
  }, [getPendingSolTokenDeltaEntries]);

  const getPendingSolTokenNegativeDeltaWei = useCallback((tokenAddress: string, walletAddress: string) => {
    let total = 0n;
    for (const entry of getPendingSolTokenDeltaEntries(tokenAddress, walletAddress)) {
      try {
        const delta = BigInt(entry.deltaWei || '0');
        if (delta < 0n) total += delta;
      } catch {
      }
    }
    return total;
  }, [getPendingSolTokenDeltaEntries]);

  const getPendingSolTradeBaseDeltaWei = useCallback((baseTokenAddress: string, walletAddress: string) => {
    let total = 0n;
    for (const entry of getPendingSolTradeBaseDeltaEntries(baseTokenAddress, walletAddress)) {
      try {
        total += BigInt(entry.deltaWei || '0');
      } catch {
      }
    }
    return total;
  }, [getPendingSolTradeBaseDeltaEntries]);

  const getPendingSolTokenDeltaSummary = useCallback((tokenAddress: string, walletAddress: string) => {
    const entries = getPendingSolTokenDeltaEntries(tokenAddress, walletAddress);
    let positiveTotal = 0n;
    let negativeTotal = 0n;
    const items = entries.map((entry) => {
      let deltaWei = 0n;
      try {
        deltaWei = BigInt(entry.deltaWei || '0');
      } catch {
        deltaWei = 0n;
      }
      if (deltaWei > 0n) positiveTotal += deltaWei;
      if (deltaWei < 0n) negativeTotal += deltaWei;
      return {
        id: entry.id,
        deltaWei: deltaWei.toString(),
        expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
      };
    });
    return {
      count: items.length,
      positiveTotalWei: positiveTotal.toString(),
      negativeTotalWei: negativeTotal.toString(),
      netTotalWei: (positiveTotal + negativeTotal).toString(),
      items,
    };
  }, [getPendingSolTokenDeltaEntries]);

  const addPendingSolTokenDeltaWei = useCallback((tokenAddress: string, walletAddress: string, deltaWeiLike: string) => {
    let deltaWei = 0n;
    try {
      deltaWei = BigInt(String(deltaWeiLike || '0'));
    } catch {
      deltaWei = 0n;
    }
    if (deltaWei === 0n) return null;
    const key = getPendingTokenDeltaKey(tokenAddress, walletAddress);
    const entry: PendingSolTokenDeltaEntry = {
      id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
      deltaWei: deltaWei.toString(),
      expiresAt: Date.now() + SOL_PENDING_TOKEN_DELTA_TTL_MS,
    };
    const current = getPendingSolTokenDeltaEntries(tokenAddress, walletAddress);
    pendingSolTokenDeltasRef.current[key] = [...current, entry];
    return entry.id;
  }, [getPendingSolTokenDeltaEntries]);

  const addPendingSolTradeBaseDeltaWei = useCallback((baseTokenAddress: string, walletAddress: string, deltaWeiLike: string) => {
    let deltaWei = 0n;
    try {
      deltaWei = BigInt(String(deltaWeiLike || '0'));
    } catch {
      deltaWei = 0n;
    }
    if (deltaWei === 0n) return null;
    const key = getPendingTradeBaseDeltaKey(baseTokenAddress, walletAddress);
    const entry: PendingSolTokenDeltaEntry = {
      id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
      deltaWei: deltaWei.toString(),
      expiresAt: Date.now() + SOL_PENDING_TOKEN_DELTA_TTL_MS,
    };
    const current = getPendingSolTradeBaseDeltaEntries(baseTokenAddress, walletAddress);
    pendingSolTradeBaseDeltasRef.current[key] = [...current, entry];
    return entry.id;
  }, [getPendingSolTradeBaseDeltaEntries]);

  const removePendingSolTokenDeltaWei = useCallback((tokenAddress: string, walletAddress: string, entryId: string | null | undefined) => {
    const id = String(entryId || '').trim();
    if (!id) return;
    const key = getPendingTokenDeltaKey(tokenAddress, walletAddress);
    const current = getPendingSolTokenDeltaEntries(tokenAddress, walletAddress);
    const next = current.filter((entry) => entry.id !== id);
    if (next.length > 0) {
      pendingSolTokenDeltasRef.current[key] = next;
    } else {
      delete pendingSolTokenDeltasRef.current[key];
    }
  }, [getPendingSolTokenDeltaEntries]);

  const removePendingSolTradeBaseDeltaWei = useCallback((baseTokenAddress: string, walletAddress: string, entryId: string | null | undefined) => {
    const id = String(entryId || '').trim();
    if (!id) return;
    const key = getPendingTradeBaseDeltaKey(baseTokenAddress, walletAddress);
    const current = getPendingSolTradeBaseDeltaEntries(baseTokenAddress, walletAddress);
    const next = current.filter((entry) => entry.id !== id);
    if (next.length > 0) {
      pendingSolTradeBaseDeltasRef.current[key] = next;
    } else {
      delete pendingSolTradeBaseDeltasRef.current[key];
    }
  }, [getPendingSolTradeBaseDeltaEntries]);

  const consumePendingSolTokenDeltaWei = useCallback((tokenAddress: string, walletAddress: string, observedChangeWei: bigint) => {
    if (observedChangeWei === 0n) return;
    const key = getPendingTokenDeltaKey(tokenAddress, walletAddress);
    const current = getPendingSolTokenDeltaEntries(tokenAddress, walletAddress);
    if (current.length <= 0) return;
    let remainingObserved = observedChangeWei > 0n ? observedChangeWei : -observedChangeWei;
    const consumePositive = observedChangeWei > 0n;
    const next: PendingSolTokenDeltaEntry[] = [];
    for (const entry of current) {
      let entryDelta = 0n;
      try {
        entryDelta = BigInt(entry.deltaWei || '0');
      } catch {
        entryDelta = 0n;
      }
      const matchesDirection = consumePositive ? entryDelta > 0n : entryDelta < 0n;
      if (!matchesDirection || remainingObserved <= 0n) {
        next.push(entry);
        continue;
      }
      const entryAbs = entryDelta > 0n ? entryDelta : -entryDelta;
      if (entryAbs <= remainingObserved) {
        remainingObserved -= entryAbs;
        continue;
      }
      const leftoverAbs = entryAbs - remainingObserved;
      remainingObserved = 0n;
      next.push({
        ...entry,
        deltaWei: consumePositive ? leftoverAbs.toString() : `-${leftoverAbs.toString()}`,
      });
    }
    if (next.length > 0) {
      pendingSolTokenDeltasRef.current[key] = next;
    } else {
      delete pendingSolTokenDeltasRef.current[key];
    }
  }, [getPendingSolTokenDeltaEntries]);

  const consumePendingSolTradeBaseDeltaWei = useCallback((baseTokenAddress: string, walletAddress: string, observedChangeWei: bigint) => {
    if (observedChangeWei >= 0n) return;
    const key = getPendingTradeBaseDeltaKey(baseTokenAddress, walletAddress);
    const current = getPendingSolTradeBaseDeltaEntries(baseTokenAddress, walletAddress);
    if (current.length <= 0) return;
    let remainingObserved = -observedChangeWei;
    const next: PendingSolTokenDeltaEntry[] = [];
    for (const entry of current) {
      let entryDelta = 0n;
      try {
        entryDelta = BigInt(entry.deltaWei || '0');
      } catch {
        entryDelta = 0n;
      }
      if (!(entryDelta < 0n) || remainingObserved <= 0n) {
        next.push(entry);
        continue;
      }
      const entryAbs = -entryDelta;
      if (entryAbs <= remainingObserved) {
        remainingObserved -= entryAbs;
        continue;
      }
      const leftoverAbs = entryAbs - remainingObserved;
      remainingObserved = 0n;
      next.push({
        ...entry,
        deltaWei: `-${leftoverAbs.toString()}`,
      });
    }
    if (next.length > 0) {
      pendingSolTradeBaseDeltasRef.current[key] = next;
    } else {
      delete pendingSolTradeBaseDeltasRef.current[key];
    }
  }, [getPendingSolTradeBaseDeltaEntries]);

  const applyPendingSolTokenDeltaWei = useCallback((tokenAddress: string, walletAddress: string, actualWei: string) => {
    let actual = 0n;
    try {
      actual = BigInt(String(actualWei || '0'));
    } catch {
      actual = 0n;
    }
    const pending = getPendingSolTokenDeltaWei(tokenAddress, walletAddress);
    const effective = actual + pending;
    return effective > 0n ? effective.toString() : '0';
  }, [getPendingSolTokenDeltaWei]);

  const applyPendingSolTradeBaseDeltaWei = useCallback((baseTokenAddress: string, walletAddress: string, actualWei: string) => {
    let actual = 0n;
    try {
      actual = BigInt(String(actualWei || '0'));
    } catch {
      actual = 0n;
    }
    const pending = getPendingSolTradeBaseDeltaWei(baseTokenAddress, walletAddress);
    const effective = actual + pending;
    return effective > 0n ? effective.toString() : '0';
  }, [getPendingSolTradeBaseDeltaWei]);

  const getTrackedSolWalletTokenBalanceWei = useCallback((walletAddress: string) => {
    const walletKey = String(walletAddress || '').trim().toLowerCase();
    if (!walletKey) return null;
    if (!Object.prototype.hasOwnProperty.call(effectiveWalletTokenBalancesRef.current, walletKey)) return null;
    try {
      return BigInt(effectiveWalletTokenBalancesRef.current[walletKey] || '0');
    } catch {
      return 0n;
    }
  }, []);

  const getTrackedSolWalletSellableTokenBalanceWei = useCallback((tokenAddress: string, walletAddress: string) => {
    const walletKey = String(walletAddress || '').trim().toLowerCase();
    if (!walletKey) return null;
    if (!Object.prototype.hasOwnProperty.call(actualWalletTokenBalancesRef.current, walletKey)) return null;
    let actual = 0n;
    try {
      actual = BigInt(actualWalletTokenBalancesRef.current[walletKey] || '0');
    } catch {
      actual = 0n;
    }
    const pendingDelta = getPendingSolTokenDeltaWei(tokenAddress, walletAddress);
    const sellable = actual + pendingDelta;
    return sellable > 0n ? sellable : 0n;
  }, [getPendingSolTokenDeltaWei]);

  const getSolWalletTokenSellableBalanceWei = useCallback((tokenAddress: string, walletAddress: string, actualWeiLike: string) => {
    let actual = 0n;
    try {
      actual = BigInt(String(actualWeiLike || '0'));
    } catch {
      actual = 0n;
    }
    const pendingDelta = getPendingSolTokenDeltaWei(tokenAddress, walletAddress);
    const sellable = actual + pendingDelta;
    return sellable > 0n ? sellable.toString() : '0';
  }, [getPendingSolTokenDeltaWei]);

  const solDisplayBalanceCacheRef = useRef(new Map<string, { value: string; updatedAt: number }>());
  const solWalletDisplayBalanceCacheRef = useRef(new Map<string, { value: string; updatedAt: number }>());

  const getSolWalletDisplayBalanceCacheKey = useCallback((tokenAddress: string, walletAddress: string) => {
    return `${chainId}:${String(tokenAddress || '').toLowerCase()}:${String(walletAddress || '').toLowerCase()}`;
  }, [chainId]);

  const getCachedSolWalletDisplayBalanceWei = useCallback((tokenAddress: string, walletAddress: string) => {
    return solWalletDisplayBalanceCacheRef.current.get(getSolWalletDisplayBalanceCacheKey(tokenAddress, walletAddress))?.value ?? null;
  }, [getSolWalletDisplayBalanceCacheKey]);

  const getSelectedCachedSolDisplayBalanceWei = useCallback(() => {
    if (chainId !== ChainId.SOL || !tokenAddressNormalized || selectedTradeWallets.length <= 0) return null;
    let total = 0n;
    for (const walletAddress of selectedTradeWallets) {
      const cached = getCachedSolWalletDisplayBalanceWei(tokenAddressNormalized, walletAddress);
      if (cached == null) return null;
      try {
        total += BigInt(cached || '0');
      } catch {
        return null;
      }
    }
    return total.toString();
  }, [chainId, getCachedSolWalletDisplayBalanceWei, selectedTradeWallets, tokenAddressNormalized]);

  const trackedSelectedSolTokenBalanceWei = useMemo(() => {
    if (chainId !== ChainId.SOL || !tokenAddressNormalized || selectedTradeWallets.length <= 0) return null;
    let total = 0n;
    let resolved = false;
    for (const walletAddress of selectedTradeWallets) {
      const tracked = getTrackedSolWalletSellableTokenBalanceWei(tokenAddressNormalized, walletAddress);
      if (tracked != null) {
        total += tracked;
        resolved = true;
        continue;
      }
      const fallback = walletTokenBalancesWei[String(walletAddress || '').toLowerCase()];
      if (typeof fallback === 'string') {
        try {
          total += BigInt(fallback || '0');
          resolved = true;
        } catch {
        }
      }
    }
    return resolved ? total.toString() : null;
  }, [chainId, getTrackedSolWalletSellableTokenBalanceWei, selectedTradeWallets, tokenAddressNormalized, walletTokenBalancesWei]);

  const cachedSolDisplayBalanceWei = useMemo(() => {
    if (chainId !== ChainId.SOL || !tokenAddressNormalized) return null;
    return solDisplayBalanceCacheRef.current.get(`${chainId}:${tokenAddressNormalized}`)?.value ?? null;
  }, [chainId, tokenAddressNormalized]);

  const getSelectedSingleWalletDisplayBalanceWei = useCallback((walletAddress: string) => {
    if (chainId !== ChainId.SOL) return null;
    const walletKey = String(walletAddress || '').toLowerCase();
    const direct = walletTokenBalancesWei[walletKey];
    if (typeof direct === 'string' && direct) return direct;
    const cachedPerWallet = tokenAddressNormalized
      ? getCachedSolWalletDisplayBalanceWei(tokenAddressNormalized, walletAddress)
      : null;
    if (cachedPerWallet != null) return cachedPerWallet;
    if (selectedTradeWallets.length !== 1) return null;
    const selectedWallet = String(selectedTradeWallets[0] || '').toLowerCase();
    if (!selectedWallet || selectedWallet !== walletKey) return null;
    if (trackedSelectedSolTokenBalanceWei && trackedSelectedSolTokenBalanceWei !== '0') return trackedSelectedSolTokenBalanceWei;
    const selectedCachedTotal = getSelectedCachedSolDisplayBalanceWei();
    if (selectedCachedTotal && selectedCachedTotal !== '0') return selectedCachedTotal;
    if (String(tokenBalanceWei || '0') !== '0') return tokenBalanceWei;
    return null;
  }, [chainId, getCachedSolWalletDisplayBalanceWei, getSelectedCachedSolDisplayBalanceWei, selectedTradeWallets, tokenAddressNormalized, tokenBalanceWei, trackedSelectedSolTokenBalanceWei, walletTokenBalancesWei]);

  const solSellBalanceReady = useMemo(() => {
    if (chainId !== ChainId.SOL) return true;
    if (!tokenAddressNormalized || selectedTradeWallets.length <= 0) return false;
    return selectedTradeWallets.every((walletAddress) => {
      const walletKey = String(walletAddress || '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(walletTokenBalancesWei, walletKey)) return true;
      if (getCachedSolWalletDisplayBalanceWei(tokenAddressNormalized, walletAddress) != null) return true;
      if (selectedTradeWallets.length !== 1) return false;
      if (trackedSelectedSolTokenBalanceWei && trackedSelectedSolTokenBalanceWei !== '0') return true;
      if (getSelectedCachedSolDisplayBalanceWei() && getSelectedCachedSolDisplayBalanceWei() !== '0') return true;
      if (String(tokenBalanceWei || '0') !== '0') return true;
      return false;
    });
  }, [
    chainId,
    getCachedSolWalletDisplayBalanceWei,
    getSelectedCachedSolDisplayBalanceWei,
    selectedTradeWallets,
    tokenAddressNormalized,
    tokenBalanceWei,
    trackedSelectedSolTokenBalanceWei,
    walletTokenBalancesWei,
  ]);
  const sellActionReady = chainId !== ChainId.SOL || solSellBalanceReady;
  const sellActionDisabledReason = !sellActionReady
    ? '余额加载中，请稍后再试'
    : undefined;

  const displayTokenBalanceWei = useMemo(() => {
    if (chainId === ChainId.SOL) {
      if (trackedSelectedSolTokenBalanceWei && trackedSelectedSolTokenBalanceWei !== '0') {
        return trackedSelectedSolTokenBalanceWei;
      }
      if (String(tokenBalanceWei || '0') !== '0') {
        return tokenBalanceWei;
      }
      const selectedCachedTotal = getSelectedCachedSolDisplayBalanceWei();
      if (selectedCachedTotal && selectedCachedTotal !== '0') {
        return selectedCachedTotal;
      }
    }
    return tokenBalanceWei;
  }, [chainId, getSelectedCachedSolDisplayBalanceWei, tokenBalanceWei, trackedSelectedSolTokenBalanceWei]);

  useEffect(() => {
    if (chainId !== ChainId.SOL || !tokenAddressNormalized) return;
    if (!displayTokenBalanceWei || displayTokenBalanceWei === '0') return;
    solDisplayBalanceCacheRef.current.set(`${chainId}:${tokenAddressNormalized}`, {
      value: displayTokenBalanceWei,
      updatedAt: Date.now(),
    });
  }, [chainId, displayTokenBalanceWei, tokenAddressNormalized]);

  const formattedTokenBalance = useMemo(() => {
    return formatTokenAmountForDisplay(displayTokenBalanceWei, resolvedTokenDecimals);
  }, [displayTokenBalanceWei, resolvedTokenDecimals]);

  const numericTokenBalance = useMemo(() => {
    if (!displayTokenBalanceWei) return null;
    try {
      const normalized = Number(formatUnits(BigInt(displayTokenBalanceWei), resolvedTokenDecimals));
      return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
    } catch {
      return null;
    }
  }, [displayTokenBalanceWei, resolvedTokenDecimals]);

  const getTrackedSolWalletTradeBaseBalanceWei = useCallback((walletAddress: string) => {
    const walletKey = String(walletAddress || '').trim().toLowerCase();
    if (!walletKey) return null;
    if (!Object.prototype.hasOwnProperty.call(effectiveWalletTradeBaseBalancesRef.current, walletKey)) return null;
    try {
      return BigInt(effectiveWalletTradeBaseBalancesRef.current[walletKey] || '0');
    } catch {
      return 0n;
    }
  }, []);

  const applyOptimisticSolWalletTokenDeltaWei = useCallback((walletAddress: string, deltaWei: bigint) => {
    if (!isSolana || deltaWei === 0n) return;
    const walletKey = String(walletAddress || '').trim().toLowerCase();
    if (!walletKey) return;
    const currentRaw = effectiveWalletTokenBalancesRef.current[walletKey];
    if (typeof currentRaw !== 'string') return;
    let current = 0n;
    try {
      current = BigInt(currentRaw || '0');
    } catch {
      current = 0n;
    }
    const next = current + deltaWei;
    const nextByWallet = {
      ...effectiveWalletTokenBalancesRef.current,
      [walletKey]: next > 0n ? next.toString() : '0',
    };
    effectiveWalletTokenBalancesRef.current = nextByWallet;
    const actualRaw = actualWalletTokenBalancesRef.current[walletKey] || '0';
    const nextDisplayWei = tokenAddressNormalized
      ? getSolWalletTokenSellableBalanceWei(tokenAddressNormalized, walletAddress, actualRaw)
      : '0';
    if (tokenAddressNormalized) {
      solWalletDisplayBalanceCacheRef.current.set(getSolWalletDisplayBalanceCacheKey(tokenAddressNormalized, walletAddress), {
        value: nextDisplayWei,
        updatedAt: Date.now(),
      });
    }
    setWalletTokenBalancesWei((prev) => ({
      ...prev,
      [walletKey]: nextDisplayWei,
    }));
    if (selectedTradeWallets.some((wallet) => wallet.toLowerCase() === walletKey)) {
      let total = 0n;
      for (const selectedWalletAddress of selectedTradeWallets) {
        const addrLower = selectedWalletAddress.toLowerCase();
        const actualSelectedRaw = actualWalletTokenBalancesRef.current[addrLower] || '0';
        const displayWei = tokenAddressNormalized
          ? getSolWalletTokenSellableBalanceWei(tokenAddressNormalized, selectedWalletAddress, actualSelectedRaw)
          : '0';
        try {
          total += BigInt(displayWei || '0');
        } catch {
        }
      }
      setTokenBalanceWei(total.toString());
    }
  }, [getSolWalletTokenSellableBalanceWei, isSolana, selectedTradeWallets, tokenAddressNormalized]);

  const applyOptimisticSolWalletTradeBaseDeltaWei = useCallback((walletAddress: string, deltaWei: bigint) => {
    if (!isSolana || deltaWei === 0n) return;
    const walletKey = String(walletAddress || '').trim().toLowerCase();
    if (!walletKey) return;
    const currentRaw = effectiveWalletTradeBaseBalancesRef.current[walletKey];
    if (typeof currentRaw !== 'string') return;
    let current = 0n;
    try {
      current = BigInt(currentRaw || '0');
    } catch {
      current = 0n;
    }
    const next = current + deltaWei;
    const nextByWallet = {
      ...effectiveWalletTradeBaseBalancesRef.current,
      [walletKey]: next > 0n ? next.toString() : '0',
    };
    effectiveWalletTradeBaseBalancesRef.current = nextByWallet;
    setWalletTradeBaseBalancesWei(nextByWallet);
    if (selectedTradeWallets.some((wallet) => wallet.toLowerCase() === walletKey)) {
      setTradeBaseBalanceWei((prev) => {
        let currentTotal = 0n;
        try {
          currentTotal = BigInt(String(prev || '0'));
        } catch {
          currentTotal = 0n;
        }
        const nextTotal = currentTotal + deltaWei;
        return nextTotal > 0n ? nextTotal.toString() : '0';
      });
    }
  }, [isSolana, selectedTradeWallets]);

  const reconcilePendingSolTokenDeltaWei = useCallback((
    tokenAddress: string,
    walletAddress: string,
    prevActualWei: string,
    nextActualWei: string,
  ) => {
    let prevActual = 0n;
    let nextActual = 0n;
    try {
      prevActual = BigInt(String(prevActualWei || '0'));
      nextActual = BigInt(String(nextActualWei || '0'));
    } catch {
      return;
    }
    const observedChange = nextActual - prevActual;
    if (observedChange === 0n) return;
    consumePendingSolTokenDeltaWei(tokenAddress, walletAddress, observedChange);
  }, [consumePendingSolTokenDeltaWei]);

  const resolvedTokenSymbol = useMemo(() => {
    const candidates = [
      tokenSymbol,
      gmgnHoldingTokenSymbol,
      tokenInfo?.symbol,
      tokenInfo?.name,
    ];
    for (const candidate of candidates) {
      const text = typeof candidate === 'string' ? candidate.trim() : '';
      if (text) return text;
    }
    if (tokenAddressNormalized) {
      return `${tokenAddressNormalized.slice(0, 6)}...${tokenAddressNormalized.slice(-4)}`;
    }
    return null;
  }, [gmgnHoldingTokenSymbol, tokenAddressNormalized, tokenInfo?.name, tokenInfo?.symbol, tokenSymbol]);

  useEffect(() => {
    let canceled = false;
    if (!settings || !siteInfo) return;

    const runtime = getChainRuntimeBase(chainId);
    const priceTokenAddress = tradeBaseTokenAddress.toLowerCase() === zeroAddress.toLowerCase()
      ? (runtime.kind === 'evm' ? getEvmChainRuntime(chainId).wrappedNativeAddress : SOLANA_WRAPPED_NATIVE_MINT)
      : tradeBaseTokenAddress;
    const priceTokenMeta = priceTokenAddress.toLowerCase() === (runtime.kind === 'evm' ? getEvmChainRuntime(chainId).wrappedNativeAddress.toLowerCase() : SOLANA_WRAPPED_NATIVE_MINT.toLowerCase())
      ? {
          address: priceTokenAddress,
          symbol: runtime.kind === 'evm' ? `W${runtime.nativeSymbol}` : 'WSOL',
          decimals: runtime.kind === 'evm' ? getEvmChainRuntime(chainId).viemChain.nativeCurrency.decimals : 9,
        } as TokenInfo
      : null;
    const stableSymbol = tradeBaseTokenMeta.symbol.toUpperCase();
    if (stableSymbol === 'USDC' || stableSymbol === 'USDT' || stableSymbol === 'USD1') {
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
      const token = resolvedTokenSymbol || 'TOKEN';
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
    if (chainId === ChainId.SOL) {
      const directSource = resolveSolanaTradeSource({
        tokenInfo: tokenInfo as any,
        tokenAddress: tokenAddressNormalized,
        platform: siteInfo?.platform,
        fallbackPlatforms: [(tokenInfo as any)?.tpool_exchange],
      }).directSource;
      const routeLabel = directSource
        ? (SOLANA_ROUTE_LABELS[directSource] ?? directSource)
        : 'Jup';
      return {
        buy: routeLabel,
        sell: routeLabel,
      };
    }
    return { buy: null, sell: null };
  }, [siteInfo?.platform, chainId, resolvedTokenSymbol, tradeBaseTokenMeta.symbol, tokenInfo, tokenAddressNormalized]);

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
      nextBuyTokens[idx] = usdAmount != null && tokenPrice && tokenPrice > 0
        ? usdAmount / tokenPrice
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
    tokenPrice,
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
      const usdAmount = tokenPrice && tokenPrice > 0 ? tokenAmount * tokenPrice : null;
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
    gmgnHoldingTokenPriceUsd,
    tokenPrice,
    tokenPriceUsd,
  ]);

  const lastTokenPriceRefresh = useRef(0);
  const tokenPriceReqSeq = useRef(0);
  useEffect(() => {
    tokenPriceReqSeq.current += 1;
    setTokenPriceUsd(null);
  }, [tokenAddressNormalized, chainId, tokenContextSiteInfo?.platform]);
  async function refreshTokenPrice(force = false, tokenInfoOverride?: TokenInfo | null, stateOverride?: BgGetStateResponse | null) {
    if (document.hidden && !force) return;
    const refreshState = getRefreshStateSnapshot(stateOverride);
    const refreshSettings = refreshState?.settings ?? null;
    if (!refreshSettings || !tokenContextSiteInfo || !tokenAddressNormalized) {
      setTokenPriceUsd(null);
      return;
    }
    const reqCtxKey = `${tokenContextSiteInfo.platform ?? ''}:${tokenContextSiteInfo.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
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
    const shouldBypassTokenInfoPriceShortcut = tokenContextSiteInfo.platform === 'gmgn' && chainId === ChainId.SOL;
    const seq = tokenPriceReqSeq.current + 1;
    tokenPriceReqSeq.current = seq;
    if (!force && !shouldBypassTokenInfoPriceShortcut && Number.isFinite(tokenInfoPrice) && tokenInfoPrice > 0) {
      if (reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenPriceUsd(tokenInfoPrice);
      return;
    }
    try {
      const v = await TokenAPI.getTokenPriceUsd(tokenContextSiteInfo.platform, chainId, tokenAddr, safeTokenInfo);
      if (seq !== tokenPriceReqSeq.current) return;
      if (reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenPriceUsd(v && Number.isFinite(v) && v > 0 ? v : null);
    } catch (error: any) {
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
    const res = await call({ type: 'bg:getState', chainId });
    stateRef.current = res;
    setState(res);
    setError(null);
    return res;
  }

  function getRefreshStateSnapshot(stateOverride?: BgGetStateResponse | null) {
    return stateOverride ?? stateRef.current ?? state;
  }

  async function refreshBaseBalances(
    res: BgGetStateResponse,
    queryAllWallets = false,
  ) {
    if (!siteInfo || !res.wallet.isUnlocked) return null;
    const solRefreshSeq = isSolana ? ++solBaseBalanceRefreshSeqRef.current : 0;
    const resolvedChainId = siteInfo?.chain ? (getChainIdByName(siteInfo.chain) || (res.settings?.chainId ?? 56)) : (res.settings?.chainId ?? 56);
    const tradeBaseAddress = resolveTradeBaseTokenAddress(res.settings, resolvedChainId);
    const allWallets = ((res.wallet.accounts ?? []) as Account[])
      .map((acc) => normalizeWalletAddress(resolvedChainId, String(acc.address || '')))
      .filter(Boolean) as ChainAddress[];
    const selectedWallets = resolveSelectedTradeWallets(res.wallet, res.settings, resolvedChainId);
    const targetWallets = selectedWallets.length > 0 ? selectedWallets : allWallets.slice(0, 1);
    const queryWallets = queryAllWallets ? allWallets : targetWallets;
    const allBalances = await Promise.all(
      queryWallets.map((addr) => TokenAPI.getBalance(siteInfo.platform, siteInfo.chain, addr, zeroAddress, { cacheTtlMs: 2000 }))
    );
    if (isSolana && solRefreshSeq !== solBaseBalanceRefreshSeqRef.current) return null;
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
      if (isSolana && solRefreshSeq !== solBaseBalanceRefreshSeqRef.current) return null;
      const mapped: Record<string, string> = {};
      allWallets.forEach((addr) => {
        mapped[addr.toLowerCase()] = '0';
      });
      queryWallets.forEach((addr, i) => {
        mapped[addr.toLowerCase()] = typeof tradeBaseBalances[i] === 'string' ? (tradeBaseBalances[i] as string) : '0';
      });
      byTradeBaseWallet = mapped;
    }
    if (isSolana && solRefreshSeq !== solBaseBalanceRefreshSeqRef.current) return null;
    const prevActualTradeBaseByWallet = actualWalletTradeBaseBalancesRef.current;
    if (isSolana) {
      queryWallets.forEach((addr) => {
        const addrLower = addr.toLowerCase();
        const prevActualWei = prevActualTradeBaseByWallet[addrLower] || '0';
        const nextActualWei = byTradeBaseWallet[addrLower] || '0';
        let prevActual = 0n;
        let nextActual = 0n;
        try {
          prevActual = BigInt(prevActualWei);
          nextActual = BigInt(nextActualWei);
        } catch {
          prevActual = 0n;
          nextActual = 0n;
        }
        const observedChange = nextActual - prevActual;
        if (observedChange !== 0n) {
          consumePendingSolTradeBaseDeltaWei(tradeBaseAddress, addr, observedChange);
        }
      });
    }
    actualWalletTradeBaseBalancesRef.current = { ...byTradeBaseWallet };
    const effectiveTradeBaseByWallet: Record<string, string> = {};
    allWallets.forEach((addr) => {
      const addrLower = addr.toLowerCase();
      effectiveTradeBaseByWallet[addrLower] = isSolana
        ? applyPendingSolTradeBaseDeltaWei(tradeBaseAddress, addr, byTradeBaseWallet[addrLower] || '0')
        : (byTradeBaseWallet[addrLower] || '0');
    });
    effectiveWalletTradeBaseBalancesRef.current = { ...effectiveTradeBaseByWallet };
    setWalletTradeBaseBalancesWei(effectiveTradeBaseByWallet);

    const total = targetWallets.reduce((sum, addr) => sum + BigInt(effectiveTradeBaseByWallet[addr.toLowerCase()] || '0'), 0n);
    setTradeBaseBalanceWei(total.toString());
    return {
      selectedWalletCount: selectedWallets.length,
      queryWalletCount: queryWallets.length,
      tradeBaseAddress,
    };
  }

  async function refreshAll(queryAllWallets = false, source = 'unknown', stateOverride?: BgGetStateResponse | null) {
    if (document.hidden) return;
    if (!siteInfo) return;
    const startedAt = Date.now();
    const includeBalances = queryAllWallets || shouldKeepBaseBalancesWarm;
    logHyperReadDebug('refreshAll.start', { source, queryAllWallets, includeBalances });
    const res = stateOverride ?? await loadState();
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
  async function refreshToken(force = false, queryAllWallets = false, source = 'unknown', stateOverride?: BgGetStateResponse | null) {
    const seq = tokenRefreshSeqRef.current;
    const solRefreshSeq = isSolana ? ++solTokenBalanceRefreshSeqRef.current : 0;
    if (document.hidden && !force) return;
    const refreshState = getRefreshStateSnapshot(stateOverride);
    const refreshSettings = refreshState?.settings ?? null;
    const refreshWallet = refreshState?.wallet ?? null;
    const refreshIsUnlocked = !!refreshWallet?.isUnlocked;
    if (!tokenAddressNormalized || !tokenContextSiteInfo) {
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
    if (!refreshIsUnlocked) {
      logHyperReadDebug('refreshToken.done', {
        source,
        force,
        queryAllWallets,
        elapsedMs: Date.now() - startedAt,
        unlocked: false,
        preservedExistingBalance: true,
      });
      return;
    }

    const reqCtxKey = `${tokenContextSiteInfo.platform ?? ''}:${tokenContextSiteInfo.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
    try {
      const metaStartedAt = Date.now();
      const meta = await TokenAPI.getTokenInfo(tokenContextSiteInfo.platform, tokenContextSiteInfo.chain, tokenAddressNormalized, {
        cacheTtlMs: tokenInfoCacheTtlMs,
      });
      if (isSolana && solRefreshSeq !== solTokenBalanceRefreshSeqRef.current) return;
      const metaElapsedMs = Date.now() - metaStartedAt;
      if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
      if (meta) {
        let normalizedDecimals =
          Number.isFinite(meta.decimals)
            && Number(meta.decimals) > 0
            && Number(meta.decimals) <= 36
            ? Number(meta.decimals)
            : (isSolana ? 9 : 18);
        let normalizedSymbol = meta.symbol;
        if (isSolana && (!Number.isFinite(meta.decimals) || Number(meta.decimals) <= 0 || Number(meta.decimals) > 36)) {
          try {
            const chainMeta = await call({
              type: 'token:getMeta',
              tokenAddress: tokenAddressNormalized,
              chainId,
            } as const);
            if (Number.isFinite(chainMeta.decimals) && Number(chainMeta.decimals) >= 0 && Number(chainMeta.decimals) <= 36) {
              normalizedDecimals = Number(chainMeta.decimals);
            }
            if (typeof chainMeta.symbol === 'string' && chainMeta.symbol.trim()) {
              normalizedSymbol = chainMeta.symbol.trim();
            }
          } catch {
          }
        }
        setTokenInfo(meta);
        setTokenSymbol(normalizedSymbol);
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

      const selectedWalletsForToken = resolveSelectedTradeWallets(refreshWallet, refreshSettings, chainId);
      const allWalletsForToken = ((refreshWallet?.accounts ?? []) as Account[])
        .map((acc) => normalizeWalletAddress(chainId, String(acc.address || '')))
        .filter(Boolean) as ChainAddress[];
      const targetWalletsForToken = selectedWalletsForToken.length > 0 ? selectedWalletsForToken : allWalletsForToken.slice(0, 1);
      const queryWalletsForToken = queryAllWallets ? allWalletsForToken : targetWalletsForToken;
      let holdingsElapsedMs = 0;
      if (refreshIsUnlocked && queryWalletsForToken.length > 0) {
        const holdingsStartedAt = Date.now();
        const holdingResults = await Promise.allSettled(
          queryWalletsForToken.map((walletAddr) =>
            TokenAPI.getTokenHolding(tokenContextSiteInfo.platform, tokenContextSiteInfo.chain, walletAddr, tokenAddressNormalized, {
              cacheTtlMs: force ? 0 : tokenBalanceRefreshThrottleMs,
            })
          )
        );
        if (isSolana && solRefreshSeq !== solTokenBalanceRefreshSeqRef.current) return;
        holdingsElapsedMs = Date.now() - holdingsStartedAt;
        if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
        const byWallet: Record<string, string> = {};
        allWalletsForToken.forEach((addr) => {
          byWallet[addr.toLowerCase()] = '0';
        });
        const prevActualByWallet = actualWalletTokenBalancesRef.current;
        let resolvedHoldingCount = 0;
        queryWalletsForToken.forEach((addr, i) => {
          const addrLower = addr.toLowerCase();
          const result = holdingResults[i];
          let nextHoldingRaw = prevActualByWallet[addrLower] || '0';
          if (result?.status === 'fulfilled') {
            nextHoldingRaw = result.value ?? '0';
            resolvedHoldingCount += 1;
          }
          if (isSolana) {
            let prevActual = 0n;
            let nextActual = 0n;
            const prevActualRaw = prevActualByWallet[addrLower] || '0';
            try {
              prevActual = BigInt(String(prevActualRaw || '0'));
              nextActual = BigInt(String(nextHoldingRaw || '0'));
            } catch {
              prevActual = 0n;
              nextActual = 0n;
            }
            const pendingDelta = getPendingSolTokenDeltaWei(tokenAddressNormalized, addr);
            const expectedRemaining = prevActual + pendingDelta;
            const isTransientZeroAfterPartialSell =
              nextActual === 0n
              && prevActual > 0n
              && pendingDelta < 0n
              && expectedRemaining > 0n;
            if (isTransientZeroAfterPartialSell) {
              nextHoldingRaw = prevActual.toString();
            }
          }
          byWallet[addrLower] = nextHoldingRaw;
        });
        if (resolvedHoldingCount <= 0 && Object.keys(prevActualByWallet).length > 0) {
          logHyperReadDebug('refreshToken.holdingsPreserved', {
            source,
            force,
            queryAllWallets,
            elapsedMs: Date.now() - startedAt,
            selectedWalletCount: targetWalletsForToken.length,
            queriedWalletCount: queryWalletsForToken.length,
          });
        }
        queryWalletsForToken.forEach((addr) => {
          const addrLower = addr.toLowerCase();
          reconcilePendingSolTokenDeltaWei(
            tokenAddressNormalized,
            addr,
            prevActualByWallet[addrLower] || '0',
            byWallet[addrLower] || '0',
          );
        });
        actualWalletTokenBalancesRef.current = { ...byWallet };
        const effectiveByWallet: Record<string, string> = {};
        const displayByWallet: Record<string, string> = {};
        allWalletsForToken.forEach((addr) => {
          const addrLower = addr.toLowerCase();
          effectiveByWallet[addrLower] = isSolana
            ? applyPendingSolTokenDeltaWei(tokenAddressNormalized, addr, byWallet[addrLower] || '0')
            : (byWallet[addrLower] || '0');
          displayByWallet[addrLower] = isSolana
            ? getSolWalletTokenSellableBalanceWei(tokenAddressNormalized, addr, byWallet[addrLower] || '0')
            : effectiveByWallet[addrLower];
          if (isSolana) {
            solWalletDisplayBalanceCacheRef.current.set(getSolWalletDisplayBalanceCacheKey(tokenAddressNormalized, addr), {
              value: displayByWallet[addrLower],
              updatedAt: Date.now(),
            });
          }
        });
        effectiveWalletTokenBalancesRef.current = { ...effectiveByWallet };
        setWalletTokenBalancesWei(displayByWallet);
        const total = targetWalletsForToken.reduce((sum, addr) => sum + BigInt(displayByWallet[addr.toLowerCase()] || '0'), 0n);
        setTokenBalanceWei(total.toString());
      } else {
        logHyperReadDebug('refreshToken.done', {
          source,
          force,
          queryAllWallets,
          elapsedMs: Date.now() - startedAt,
          hasMeta: !!meta,
          metaElapsedMs,
          holdingsElapsedMs,
          selectedWalletCount: targetWalletsForToken.length,
          queriedWalletCount: queryWalletsForToken.length,
          preservedExistingBalance: true,
        });
        return;
      }

      const priceStartedAt = Date.now();
      await refreshTokenPrice(force, meta ?? null, refreshState);
      if (isSolana && solRefreshSeq !== solTokenBalanceRefreshSeqRef.current) return;
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
      if (isSolana && solRefreshSeq !== solTokenBalanceRefreshSeqRef.current) return;
      if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
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

  async function refreshGmgnHoldingStats(force = false, source = 'unknown') {
    const seq = ++gmgnHoldingRefreshSeqRef.current;
    if (document.hidden && !force) return;
    if (!shouldEnableHoldingStats || !gmgnHoldingChain) {
      setGmgnHoldingStats(null);
      setGmgnHoldingTokenPriceUsd(null);
      setGmgnHoldingTokenBalanceWei(null);
      setGmgnHoldingTokenDecimals(null);
      setGmgnHoldingTokenSymbol(null);
      setGmgnHoldingPollingEnabled(false);
      return;
    }

    try {
      const detailHoldings = (await Promise.all(
        gmgnHoldingWallets.map(async (walletAddress) => {
          try {
            const detail = await GmgnAPI.getTokenHoldingDetail(gmgnHoldingChain, walletAddress, tokenAddressNormalized);
            return mapHoldingDetailToHolding(walletAddress, tokenAddressNormalized, detail);
          } catch {
            return null;
          }
        })
      )).filter((item): item is GmgnTokenHolding => !!item);
      const holdings = detailHoldings.length > 0
        ? detailHoldings
        : await GmgnAPI.getWalletsHolding(gmgnHoldingChain, tokenAddressNormalized, gmgnHoldingWallets) as GmgnTokenHolding[];
      if (seq !== gmgnHoldingRefreshSeqRef.current) return;
      const nextStats = aggregateGmgnHoldings(holdings);
      const derivedPrices = holdings
        .map((item) => resolveHoldingUnitPriceUsd(item))
        .filter((item): item is number => item != null && Number.isFinite(item) && item > 0)
        .sort((a, b) => a - b);
      const derivedPrice = derivedPrices.length > 0
        ? derivedPrices[Math.floor(derivedPrices.length / 2)]
        : null;
      const derivedSymbol = holdings
        .map((item) => resolveHoldingTokenSymbol(item))
        .find((item): item is string => !!item) ?? null;
      const derivedDecimals = holdings
        .map((item) => resolveHoldingTokenDecimals(item))
        .find((item): item is number => item != null && Number.isFinite(item) && item >= 0) ?? null;
      const derivedBalanceWei = holdings.reduce((sum, item) => {
        const raw = resolveHoldingBalanceWei(item);
        if (!raw) return sum;
        try {
          return sum + BigInt(raw);
        } catch {
          return sum;
        }
      }, 0n).toString();
      setGmgnHoldingStats(nextStats);
      setGmgnHoldingTokenPriceUsd(derivedPrice);
      setGmgnHoldingTokenBalanceWei(derivedBalanceWei);
      setGmgnHoldingTokenDecimals(derivedDecimals);
      setGmgnHoldingTokenSymbol(derivedSymbol);
      setGmgnHoldingPollingEnabled(holdings.some((item) => (parseGmgnNullableNumber(item.balance) ?? 0) > 0));
    } catch (e: any) {
      if (seq !== gmgnHoldingRefreshSeqRef.current) return;
      console.warn('[quickTrade.gmgnHolding.refresh.failed]', {
        source,
        error: String(e?.message || e || ''),
      });
      setGmgnHoldingStats(null);
      setGmgnHoldingTokenPriceUsd(null);
      setGmgnHoldingTokenBalanceWei(null);
      setGmgnHoldingTokenDecimals(null);
      setGmgnHoldingTokenSymbol(null);
      setGmgnHoldingPollingEnabled(false);
    }
  }

  const clearGmgnHoldingPollingTimer = () => {
    if (gmgnHoldingPollingTimerRef.current) {
      clearTimeout(gmgnHoldingPollingTimerRef.current);
      gmgnHoldingPollingTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!siteInfo || !shouldKeepTokenWarm) return;
    void refreshToken(true, false, 'tokenConsumers:visible');
  }, [siteInfo, shouldKeepTokenWarm]);

  useEffect(() => {
    if (!shouldEnableHoldingStats || !gmgnHoldingChain) {
      clearGmgnHoldingPollingTimer();
      setGmgnHoldingStats(null);
      setGmgnHoldingTokenBalanceWei(null);
      setGmgnHoldingTokenDecimals(null);
      setGmgnHoldingPollingEnabled(false);
      return;
    }
    void refreshGmgnHoldingStats(true, 'gmgnHolding:init');
  }, [shouldEnableHoldingStats, gmgnHoldingChain, tokenAddressNormalized, gmgnHoldingWalletsKey]);

  useEffect(() => {
    clearGmgnHoldingPollingTimer();
    if (!gmgnHoldingPollingEnabled) return;
    if (!shouldEnableHoldingStats || !gmgnHoldingChain) return;
    let cancelled = false;
    const scheduleNext = () => {
      if (cancelled) return;
      clearGmgnHoldingPollingTimer();
      gmgnHoldingPollingTimerRef.current = setTimeout(async () => {
        gmgnHoldingPollingTimerRef.current = null;
        if (cancelled) return;
        await refreshGmgnHoldingStats(false, 'interval:gmgnHolding');
        if (!cancelled && gmgnHoldingPollingEnabled) scheduleNext();
      }, 1000);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      clearGmgnHoldingPollingTimer();
    };
  }, [gmgnHoldingPollingEnabled, shouldEnableHoldingStats, gmgnHoldingChain, tokenAddressNormalized, gmgnHoldingWalletsKey]);

  useEffect(() => {
    if (!txHash) return;
    if (!shouldEnableHoldingStats || !gmgnHoldingChain) return;
    void refreshGmgnHoldingStats(true, 'txHash');
  }, [txHash, shouldEnableHoldingStats, gmgnHoldingChain, tokenAddressNormalized, gmgnHoldingWalletsKey]);

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
        const seq = bgStateChangedSeqRef.current + 1;
        bgStateChangedSeqRef.current = seq;
        const sentAtMs = Number(message?.ts ?? 0) || null;
        const now = Date.now();
        const minIntervalMs = 1200;
        const runRefresh = () => {
          bgStateChangedHandledAtRef.current = Date.now();
          void (async () => {
            const refreshState = await loadState().catch(() => getRefreshStateSnapshot());
            await refreshAll(false, 'bg:stateChanged', refreshState);
            if (shouldKeepTokenWarm) await refreshToken(false, false, 'bg:stateChanged', refreshState);
          })();
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
        if (message?.chainId === ChainId.SOL && rawAddr) {
          solTradeOutcomeRef.current.set(getSolTradeOutcomeKey(side, rawAddr), 'success');
        }
        const symbol = resolvedTokenSymbol ?? (rawAddr ? `${rawAddr.slice(0, 6)}...${rawAddr.slice(-4)}` : '');
        const providerRaw = formatBroadcastProvider(message?.broadcastVia, message?.broadcastUrl, message?.isBundle);
        const provider = providerRaw === '-' ? 'RPC' : providerRaw;
        const submitNode = null;
        const confirmNode = null;
        const timing = formatTradeTiming({
          submitElapsedMs: Number(message?.submitElapsedMs ?? 0),
          receiptElapsedMs: Number(message?.receiptElapsedMs ?? 0),
        });
        if (
          message?.chainId === ChainId.SOL
          && rawAddr
          && rawAddr.toLowerCase() === String(tokenAddressNormalized || '').toLowerCase()
        ) {
          void refreshGmgnHoldingStats(true, 'tradeSuccess');
          startFastPolling();
        }
        if (side === 'buy') {
          const fromAddress = typeof message?.fromAddress === 'string' ? message.fromAddress : '';
          const pendingKey = fromAddress ? getPendingAutoSellOrderKey(Number(message?.chainId || 0), rawAddr, fromAddress) : '';
          const pendingAutoSell = pendingKey ? pendingAutoSellOrdersRef.current.get(pendingKey) : null;
          if (pendingAutoSell) {
            pendingAutoSellOrdersRef.current.delete(pendingKey);
            void createAutoSellOrdersForWallet(pendingAutoSell)
              .then((createdCount) => {
                if (createdCount > 0) {
                  toast.success(`已创建自动卖出挂单 ${createdCount} 个`, { icon: '✅' });
                }
              })
              .catch((error) => {
                console.error('auto sell create orders on trade success failed', error);
              });
          }
        }
        const eventToastId = getTradeEventToastId(side, rawAddr, String(message?.txHash || ''));
        toast.dismiss(eventToastId);
        toast.dismiss(getTradeToastId(side, rawAddr));
        toast.success(renderTradeSuccessToast({ side, symbol, provider, timing, submitNode, confirmNode, stage: 'confirmed' }), {
          id: `${eventToastId}:confirmed`,
          icon: '✅',
          duration: 5000,
        });
        return;
      }
      if (message.type === 'bg:tradeFailed') {
        const side = message?.side === 'sell' ? 'sell' : 'buy';
        const rawAddr = typeof message?.tokenAddress === 'string' ? message.tokenAddress : '';
        if (side === 'buy') {
          const fromAddress = typeof message?.fromAddress === 'string' ? message.fromAddress : '';
          const pendingKey = fromAddress ? getPendingAutoSellOrderKey(Number(message?.chainId || 0), rawAddr, fromAddress) : '';
          if (pendingKey) pendingAutoSellOrdersRef.current.delete(pendingKey);
        }
        if (message?.chainId === ChainId.SOL && rawAddr) {
          solTradeOutcomeRef.current.set(getSolTradeOutcomeKey(side, rawAddr), 'failed');
        }
        const symbol = resolvedTokenSymbol ?? (rawAddr ? `${rawAddr.slice(0, 6)}...${rawAddr.slice(-4)}` : '');
        const errorMessage = String(message?.errorMessage || '');
        const stage = message?.stage === 'receipt'
          ? (locale === 'en' ? 'On-chain failed' : '上链失败')
          : (locale === 'en' ? 'Submit failed' : '提交失败');
        const title = locale === 'en'
          ? `[${symbol}] ${side === 'buy' ? 'Buy' : 'Sell'} failed (${stage})`
          : `[${symbol}] ${side === 'buy' ? '买入失败' : '卖出失败'}（${stage}）`;
        const eventToastId = getTradeEventToastId(side, rawAddr, String(message?.txHash || ''));
        toast.dismiss(eventToastId);
        toast.error(
          <div className="space-y-1">
            <div className="font-medium">{title}</div>
            {errorMessage ? <div className="text-[12px] opacity-90">{errorMessage}</div> : null}
          </div>,
          {
            id: `${eventToastId}:failed`,
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
        if (message?.chainId === ChainId.SOL && rawAddr) {
          solTradeOutcomeRef.current.set(getSolTradeOutcomeKey(side, rawAddr), 'submitted');
        }
        const symbol = resolvedTokenSymbol ?? (rawAddr ? `${rawAddr.slice(0, 6)}...${rawAddr.slice(-4)}` : '');
        const providerRaw = formatBroadcastProvider(message?.broadcastVia, message?.broadcastUrl, message?.isBundle);
        const provider = providerRaw === '-' ? (locale === 'en' ? 'Submitted' : '已提交') : providerRaw;
        const submitNode = null;
        const timing = formatTradeTiming({ submitElapsedMs: Number(message?.submitElapsedMs ?? 0) }, true);
        if (
          message?.chainId === ChainId.SOL
          && rawAddr
          && rawAddr.toLowerCase() === String(tokenAddressNormalized || '').toLowerCase()
        ) {
          void refreshGmgnHoldingStats(true, 'tradeSubmitted');
          startFastPolling();
        }
        const eventToastId = getTradeEventToastId(side, rawAddr, String(message?.txHash || ''));
        // Replace the initial "交易执行中..." flow toast as soon as tx hash is submitted.
        toast.dismiss(getTradeToastId(side, rawAddr));
        toast.success(renderTradeSuccessToast({ side, symbol, provider, timing, submitNode, stage: 'submitted' }), {
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
    resolvedTokenSymbol,
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

  async function withBusy(fn: () => Promise<void>, options?: { trackBusy?: boolean; label?: string }) {
    const trackBusy = options?.trackBusy ?? true;
    const label = options?.label ?? 'unknown';
    if (trackBusy) setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      const side = label === 'sell' ? 'sell' : (label === 'buy' ? 'buy' : null);
      if (side && shouldIgnoreSolUiTransportError(side, tokenAddressNormalized, e)) return;
      const rawMessage = e?.message ? String(e.message) : '';
      const message = (() => {
        const raw = rawMessage || t('popup.error.unknown', locale);
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
    } finally {
      if (trackBusy) setBusy(false);
    }
  }

  async function enqueueSolSubmitKickoff(scopeKey: string, kickoff: () => Promise<void>) {
    const queues = solSubmitKickoffQueuesRef.current;
    const previous = queues.get(scopeKey) ?? Promise.resolve();
    const next = previous.catch(() => { }).then(kickoff);
    queues.set(scopeKey, next);
    try {
      await next;
    } finally {
      if (queues.get(scopeKey) === next) queues.delete(scopeKey);
    }
  }

  const startFastPolling = () => {
    if (fastPollingRef.current) clearInterval(fastPollingRef.current);

    // Poll briefly to catch balance updates after tx
    let count = 0;
    fastPollingRef.current = setInterval(() => {
      count++;
      void (async () => {
        const refreshState = await loadState().catch(() => getRefreshStateSnapshot());
        await Promise.all([
          refreshAll(false, 'fastPolling', refreshState),
          refreshToken(true, false, 'fastPolling', refreshState),
        ]);
      })();
      void refreshGmgnHoldingStats(true, 'fastPolling');
      void refreshApproveStatuses('fastPolling');
      if (count >= 15) {
        if (fastPollingRef.current) clearInterval(fastPollingRef.current);
        fastPollingRef.current = null;
      }
    }, 500);
  };

  const triggerPostTradeRefresh = useCallback((side: 'buy' | 'sell') => {
    startFastPolling();
    void (async () => {
      const refreshState = await loadState();
      await Promise.all([
        refreshToken(true, false, `postTrade:${side}`, refreshState),
        refreshAll(false, `postTrade:${side}`, refreshState),
      ]);
    })().catch((e: any) => {
      warnUiDebug('[ui.trade.postRefresh.failed]', {
        side,
        chainId,
        token: tokenAddressNormalized,
        error: String(e?.message || e || ''),
        ts: Date.now(),
      });
    });
  }, [chainId, tokenAddressNormalized]);

  const refreshApproveStatuses = useCallback(async (_source = 'unknown') => {
    if (!tokenAddressNormalized || !tokenInfo || selectedTradeWallets.length <= 0) {
      return;
    }
    if (isSolana) {
      setWalletApproveStates((prev) => {
        const next = { ...prev };
        for (const walletAddress of selectedTradeWallets) {
          next[walletAddress.toLowerCase()] = { approved: true };
        }
        return next;
      });
      return;
    }
    const evmTokenAddress = normalizeAddr(tokenAddressNormalized);
    if (!evmTokenAddress) return;
    const seq = ++approveStatusRefreshSeqRef.current;
    const wallets = selectedTradeWallets
      .map((walletAddress) => normalizeAddr(walletAddress))
      .filter(Boolean) as `0x${string}`[];
    const now = Date.now();
    const results = await Promise.allSettled(
      wallets.map(async (walletAddress) => {
        const res = await call({
          type: 'tx:checkSellAllowanceInsufficient',
          chainId,
          tokenAddress: evmTokenAddress,
          tokenInfo,
          fromAddress: walletAddress,
        } as const) as { insufficient?: boolean };
        return {
          walletAddress,
          approved: !res.insufficient,
        };
      })
    );
    if (seq !== approveStatusRefreshSeqRef.current) return;
    setWalletApproveStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const key = result.value.walletAddress.toLowerCase();
        const prevState = prev[key];
        const pendingActive = !!prevState?.pendingSince && (now - prevState.pendingSince < APPROVE_PENDING_TIMEOUT_MS);
        if (result.value.approved) {
          next[key] = { approved: true };
          continue;
        }
        if (pendingActive) {
          next[key] = { approved: false, pendingSince: prevState?.pendingSince };
          continue;
        }
        next[key] = { approved: false };
      }
      return next;
    });
  }, [chainId, isSolana, selectedTradeWallets, tokenAddressNormalized, tokenInfo]);

  const requestApproveForWallets = useCallback(async (
    wallets: ChainAddress[],
    opts?: { silent?: boolean },
  ) => {
    if (!tokenAddressNormalized) throw new Error('Invalid token');
    if (!tokenInfo) throw new Error('Token info required');
    if (wallets.length <= 0) return [];
    if (isSolana) {
      setWalletApproveStates((prev) => {
        const next = { ...prev };
        for (const walletAddress of wallets) {
          next[walletAddress.toLowerCase()] = { approved: true };
        }
        return next;
      });
      return [];
    }
    const evmTokenAddress = normalizeAddr(tokenAddressNormalized);
    if (!evmTokenAddress) throw new Error('Invalid token');
    const evmWallets = wallets
      .map((walletAddress) => normalizeAddr(walletAddress))
      .filter(Boolean) as `0x${string}`[];
    if (evmWallets.length <= 0) return [];
    const pendingSince = Date.now();
    setWalletApproveStates((prev) => {
      const next = { ...prev };
      for (const walletAddress of evmWallets) {
        const key = walletAddress.toLowerCase();
        next[key] = {
          approved: prev[key]?.approved,
          pendingSince,
        };
      }
      return next;
    });
    const results = await Promise.allSettled(
      evmWallets.map(async (walletAddress) => ({
        walletAddress,
        res: await call({
          type: 'tx:approveMaxForSellIfNeeded',
          chainId,
          tokenAddress: evmTokenAddress,
          tokenInfo,
          fromAddress: walletAddress,
        } as const),
      }))
    );
    setWalletApproveStates((prev) => {
      const next = { ...prev };
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const key = result.value.walletAddress.toLowerCase();
          const txHash = result.value.res?.txHash;
          next[key] = txHash
            ? { approved: false, pendingSince: pendingSince }
            : { approved: true };
          continue;
        }
        const failedWallet = evmWallets[results.indexOf(result)];
        if (!failedWallet) continue;
        const key = failedWallet.toLowerCase();
        next[key] = { approved: prev[key]?.approved ?? false };
      }
      return next;
    });
    const submitted = results
      .filter((item): item is PromiseFulfilledResult<{ walletAddress: `0x${string}`; res: any }> => item.status === 'fulfilled')
      .map((item) => item.value)
      .filter((item) => !!item.res?.txHash);
    const alreadyApprovedCount = results
      .filter((item): item is PromiseFulfilledResult<{ walletAddress: `0x${string}`; res: any }> => item.status === 'fulfilled')
      .filter((item) => !item.value.res?.txHash)
      .length;
    if (!opts?.silent) {
      if (submitted[0]?.res?.txHash) setTxHash(submitted[0].res.txHash);
      if (submitted.length > 0 || alreadyApprovedCount > 0) {
        const parts = [
          submitted.length > 0 ? `已提交 ${submitted.length}` : '',
          alreadyApprovedCount > 0 ? `已授权 ${alreadyApprovedCount}` : '',
        ].filter(Boolean);
        toast.success(`授权状态已更新 ${parts.join(' / ')}`, { icon: '✅' });
      }
    }
    await Promise.all([refreshToken(true), refreshAll()]);
    startFastPolling();
    void refreshApproveStatuses(opts?.silent ? 'autoApprove' : 'manualApprove');
    return results;
  }, [chainId, isSolana, refreshAll, refreshApproveStatuses, refreshToken, startFastPolling, tokenAddressNormalized, tokenInfo]);

  useEffect(() => {
    if (!tokenAddressNormalized || !tokenInfo || selectedTradeWallets.length <= 0) return;
    void refreshApproveStatuses('approve:init');
    const timer = setInterval(() => {
      void refreshApproveStatuses('approve:interval');
    }, 4000);
    return () => clearInterval(timer);
  }, [refreshApproveStatuses, selectedTradeWallets.length, tokenAddressNormalized, tokenInfo]);

  const selectedApproveStatus = useMemo<'ready' | 'approving' | 'approved'>(() => {
    if (isSolana) return 'approved';
    if (!tokenAddressNormalized || !tokenInfo || selectedTradeWallets.length <= 0) return 'ready';
    const now = Date.now();
    let allApproved = true;
    for (const walletAddress of selectedTradeWallets) {
      const state = walletApproveStates[walletAddress.toLowerCase()];
      const pendingActive = !!state?.pendingSince && (now - state.pendingSince < APPROVE_PENDING_TIMEOUT_MS);
      if (pendingActive) return 'approving';
      if (state?.approved !== true) allApproved = false;
    }
    return allApproved ? 'approved' : 'ready';
  }, [isSolana, selectedTradeWallets, tokenAddressNormalized, tokenInfo, walletApproveStates]);
  const approveStatusTitle = isSolana
    ? (locale === 'en' ? 'Solana token sells do not require ERC-20 approval' : 'Solana 卖出不需要 ERC-20 授权')
    : selectedApproveStatus === 'approved'
    ? (locale === 'en' ? 'Selected wallets are approved' : '已选钱包已完成授权')
    : selectedApproveStatus === 'approving'
      ? (locale === 'en' ? 'Approval submitted and waiting on-chain' : '授权已提交，等待上链生效')
      : (locale === 'en' ? 'Approve selected wallets for sell' : '为已选钱包补充卖出授权');

  const resolvePriorityFee = (side: 'buy' | 'sell', overridePreset?: PriorityFeePreset) => {
    if (!settings) return undefined;
    const chainSettings = effectiveChainSettings;
    if (!chainSettings) return undefined;
    const submitChannel = (chainSettings.submitChannel ?? 'protectRpcs');
    if (chainId !== ChainId.SOL && (submitChannel === 'protectRpcs' || submitChannel === 'mixed')) return '0';
    const selectedPreset = overridePreset ?? (side === 'buy'
      ? ((chainSettings.buyPriorityFeePreset ?? 'standard') as PriorityFeePreset)
      : ((chainSettings.sellPriorityFeePreset ?? 'standard') as PriorityFeePreset));
    const presetValues = side === 'buy'
      ? (chainSettings.buyPriorityFeePresets ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES)
      : (chainSettings.sellPriorityFeePresets ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES);
    const value = presetValues[selectedPreset] ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES[selectedPreset];
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || '0';
  };

  const resolveSingleEnabledSolanaTipProvider = useCallback((): SolanaSwqosProviderType | null => {
    if (chainId !== ChainId.SOL) return null;
    const enabledProviderTypes = resolveEnabledSolanaSwqosProviderTypes(effectiveChainSettings?.solanaSwqos);
    return enabledProviderTypes.length === 1 ? enabledProviderTypes[0] : null;
  }, [chainId, effectiveChainSettings?.solanaSwqos]);

  const resolveSolanaTip = useCallback((side: 'buy' | 'sell') => {
    if (chainId !== ChainId.SOL) return { providerType: null, tipNative: '0', tipRecipient: '' };
    const chainSettings = effectiveChainSettings;
    if (!chainSettings?.solanaSwqos?.enabled) return { providerType: null, tipNative: '0', tipRecipient: '' };
    const providerType = resolveSingleEnabledSolanaTipProvider();
    if (!providerType) return { providerType: null, tipNative: '0', tipRecipient: '' };
    const selectedPreset = (side === 'buy'
      ? chainSettings.buyTipPreset
      : chainSettings.sellTipPreset) as PriorityFeePreset | undefined;
    const presetValues = side === 'buy'
      ? (chainSettings.buyTipPresets ?? DEFAULT_SOLANA_TIP_PRESET_VALUES)
      : (chainSettings.sellTipPresets ?? DEFAULT_SOLANA_TIP_PRESET_VALUES);
    const rawValue = presetValues[selectedPreset ?? 'none'] ?? DEFAULT_SOLANA_TIP_PRESET_VALUES[selectedPreset ?? 'none'];
    const tipNative = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!tipNative || tipNative === '0') {
      return { providerType, tipNative: '0', tipRecipient: '' };
    }
    const minimumTipNative = getSolanaTipMinimumNative(providerType);
    const normalizedTipNative = (() => {
      try {
        return parseUnits(tipNative, 9) >= parseUnits(minimumTipNative, 9) ? tipNative : minimumTipNative;
      } catch {
        return minimumTipNative;
      }
    })();
    return {
      providerType,
      tipNative: normalizedTipNative,
      tipRecipient: getRandomSolanaTipRecipient(providerType),
    };
  }, [chainId, effectiveChainSettings, resolveSingleEnabledSolanaTipProvider]);

  const resolveQuickBuyOverride = (presetIndex: number) => {
    const chainSettings = effectiveChainSettings;
    if (!chainSettings) return {};
    if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex > 3) return {};
    if (!chainSettings.quickBuyAdvancedEnabled) return {};
    return chainSettings.quickBuyPresetOverrides?.[presetIndex] ?? {};
  };

  const resolveBuyGasPresetForPreset = (presetIndex: number) => {
    const chainSettings = effectiveChainSettings;
    const override = resolveQuickBuyOverride(presetIndex);
    return override.gasPreset ?? chainSettings?.buyGasPreset ?? chainSettings?.gasPreset ?? 'standard';
  };

  const resolveBuyPriorityFeePresetForPreset = (presetIndex: number) => {
    const chainSettings = effectiveChainSettings;
    const override = resolveQuickBuyOverride(presetIndex);
    return override.priorityFeePreset ?? ((chainSettings?.buyPriorityFeePreset ?? 'standard') as PriorityFeePreset);
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

  const createAutoSellOrdersForWallet = useCallback(async (ctx: PendingAutoSellOrderContext) => {
    const config = settingsRef.current?.advancedAutoSell;
    if (!config?.enabled) return 0;
    if (!ctx.siteInfo?.platform) return 0;
    const tokenAddress = String(ctx.tokenAddress || '').trim();
    if (!tokenAddress) return 0;
    const latestTokenInfo = ctx.tokenInfo;
    const fetchedPriceUsd = await TokenAPI.getTokenPriceUsd(ctx.siteInfo.platform, ctx.chainId, tokenAddress, latestTokenInfo);
    const fallbackPriceUsd = Number(latestTokenInfo?.tokenPrice?.price ?? 0);
    const basePriceUsd = fetchedPriceUsd != null && fetchedPriceUsd > 0
      ? fetchedPriceUsd
      : (Number.isFinite(fallbackPriceUsd) && fallbackPriceUsd > 0 ? fallbackPriceUsd : null);
    if (basePriceUsd == null || !(basePriceUsd > 0)) return 0;

    const inputs = buildStrategySellOrderInputs({
      config,
      chainId: ctx.chainId,
      tokenAddress,
      tokenSymbol: ctx.tokenSymbol ?? null,
      tokenInfo: latestTokenInfo,
      basePriceUsd,
      entryPriceUsd: basePriceUsd,
    });

    const mode = (config as any)?.trailingStop?.activationMode ?? 'after_first_take_profit';
    if (mode === 'immediate' && (config as any)?.trailingStop?.enabled) {
      if (getAdvancedAutoSellMode(config) === 'rolling_take_profit') {
        const rolling = buildStrategyRollingTakeProfitOrderInputs({
          config,
          chainId: ctx.chainId,
          tokenAddress,
          tokenSymbol: ctx.tokenSymbol ?? null,
          tokenInfo: latestTokenInfo,
          basePriceUsd,
          entryPriceUsd: basePriceUsd,
        });
        if (rolling) inputs.push(rolling);
      } else {
        const trailing = buildStrategyTrailingSellOrderInputs({
          config,
          chainId: ctx.chainId,
          tokenAddress,
          tokenSymbol: ctx.tokenSymbol ?? null,
          tokenInfo: latestTokenInfo,
          basePriceUsd,
        });
        if (trailing) inputs.push(trailing);
      }
    }

    if (!inputs.length) return 0;
    for (const input of inputs) {
      await call({
        type: 'limitOrder:create',
        input: {
          ...input,
          fromAddress: ctx.walletAddress,
        },
      } as const);
    }
    return inputs.length;
  }, []);

  const renderTradeSuccessToast = (input: {
    side: 'buy' | 'sell';
    symbol: string;
    provider: string;
    timing: { submitLabel: string; submitValue: string; receiptLabel: string; receiptValue: string };
    submitNode?: string | null;
    confirmNode?: string | null;
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
        {(input.submitNode || input.confirmNode) ? (
          <div className="space-y-0.5 text-[11px] opacity-80">
            {input.submitNode ? <div>{locale === 'en' ? 'Submit RPC' : '提交节点'}: <span className="font-medium">{input.submitNode}</span></div> : null}
            {input.confirmNode ? <div>{locale === 'en' ? 'Confirm RPC' : '确认节点'}: <span className="font-medium">{input.confirmNode}</span></div> : null}
          </div>
        ) : null}
      </div>
    );
  };

  const getTradeToastId = (side: 'buy' | 'sell', tokenAddress?: string | null) =>
    `trade-flow:${side}:${String(tokenAddress || '').toLowerCase()}`;
  const getTradeEventToastId = (side: 'buy' | 'sell', tokenAddress?: string | null, txHash?: string | null) =>
    txHash
      ? `trade-event:${side}:${String(txHash).toLowerCase()}`
      : `trade-event:${side}:${String(tokenAddress || '').toLowerCase()}`;
  const getSolTradeOutcomeKey = (side: 'buy' | 'sell', tokenAddress?: string | null) =>
    `${side}:${String(tokenAddress || '').toLowerCase()}`;
  const getSolTradeOutcomeStatus = (side: 'buy' | 'sell', tokenAddress?: string | null) =>
    solTradeOutcomeRef.current.get(getSolTradeOutcomeKey(side, tokenAddress)) || '';
  const shouldIgnoreSolUiTransportError = (
    side: 'buy' | 'sell',
    tokenAddress: string | null | undefined,
    error: unknown,
  ) => {
    if (chainId !== ChainId.SOL) return false;
    const rawMessage = String((error as any)?.message || error || '').trim().toLowerCase();
    if (!rawMessage) return false;
    const isTransportError =
      rawMessage.includes('request timed out')
      || rawMessage.includes('failed to fetch')
      || rawMessage.includes('all promises were rejected');
    if (!isTransportError) return false;
    return ['submitted', 'success'].includes(getSolTradeOutcomeStatus(side, tokenAddress));
  };

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
      const parseAmountWei = (rawAmount: string, walletAddress: ChainAddress) => {
        const normalized = String(rawAmount || '').trim();
        if (!normalized) throw new Error(`钱包 ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} 金额为空`);
        const wei = parseUnits(normalized, tradeBaseTokenMeta.decimals);
        if (wei <= 0n) throw new Error(`钱包 ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} 金额必须大于 0`);
        return wei;
      };
      const hasValidPresetIndex = Number.isInteger(presetIndex) && presetIndex >= 0 && presetIndex < 4;
      const buyPlan: Array<{ walletAddress: ChainAddress; amountWei: bigint }> = [];
      const skippedByPreset: ChainAddress[] = [];
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
      const executablePlan: Array<{ walletAddress: ChainAddress; amountWei: bigint }> = [];
      const insufficientWallets: ChainAddress[] = [];
      for (const item of buyPlan) {
        const walletBal = isSolana
          ? (getTrackedSolWalletTradeBaseBalanceWei(item.walletAddress) ?? BigInt(walletTradeBaseBalancesWei[item.walletAddress.toLowerCase()] || '0'))
          : BigInt(walletTradeBaseBalancesWei[item.walletAddress.toLowerCase()] || '0');
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
      const sym = resolvedTokenSymbol ?? '';
      const flowToastId = getTradeToastId('buy', tokenAddressNormalized);
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: tradingLoadingIcon, id: flowToastId });
      let buyLoadingClosed = false;
      const buyGasPreset = hasValidPresetIndex ? resolveBuyGasPresetForPreset(presetIndex) : (effectiveChainSettings?.buyGasPreset ?? effectiveChainSettings?.gasPreset ?? 'standard');
      const buyExecutionMode = effectiveChainSettings?.executionMode === 'turbo' ? 'turbo' : 'default';
      const buyPriorityFeePreset = hasValidPresetIndex ? resolveBuyPriorityFeePresetForPreset(presetIndex) : ((effectiveChainSettings?.buyPriorityFeePreset ?? 'standard') as PriorityFeePreset);

      const mainTrade = (async () => {
        const tradeOutcomeKey = getSolTradeOutcomeKey('buy', tokenAddressNormalized);
        if (chainId === ChainId.SOL) {
          solTradeOutcomeRef.current.delete(tradeOutcomeKey);
        }
        const tradePromises: Array<Promise<{ walletAddress: ChainAddress; res: any }>> = [];
        const launchPromises = executablePlan.map(async ({ walletAddress, amountWei }) => {
          const launchTrade = async () => {
            let pendingTradeBaseDeltaId: string | null = null;
            const tradePromise = (async () => {
              if (chainId === ChainId.SOL && buyExecutionMode === 'turbo') {
                await waitForSolTurboPrewarmReady(walletAddress);
              }
              const uiRequestStartedAt = Date.now();
              if (chainId === ChainId.SOL) {
                pendingTradeBaseDeltaId = addPendingSolTradeBaseDeltaWei(tradeBaseTokenAddress, walletAddress, `-${amountWei.toString()}`);
                applyOptimisticSolWalletTradeBaseDeltaWei(walletAddress, -amountWei);
              }
              const resolvedBuyPriorityFeeNative = resolvePriorityFee('buy', buyPriorityFeePreset);
              const resolvedBuyTip = resolveSolanaTip('buy');
              const hasBuyPriorityFee = !!resolvedBuyPriorityFeeNative && resolvedBuyPriorityFeeNative !== '0';
              const hasBuyTip = !!resolvedBuyTip.tipNative && resolvedBuyTip.tipNative !== '0' && !!resolvedBuyTip.tipRecipient;
              const buyInput = {
                chainId,
                tokenAddress: tokenAddressNormalized,
                nativeAmountWei: amountWei.toString(),
                baseTokenAddress: tradeBaseTokenAddress,
                fromAddress: walletAddress,
                submitChannel,
                executionModeOverride: buyExecutionMode,
                priorityFeeNative: resolvedBuyPriorityFeeNative,
                solanaFeeMode: chainId === ChainId.SOL
                  ? (hasBuyTip ? (hasBuyPriorityFee ? 'pf_and_tip' : 'tip') : 'pf')
                  : undefined,
                solanaTipNative: chainId === ChainId.SOL && hasBuyTip ? resolvedBuyTip.tipNative : undefined,
                solanaTipProviderType: chainId === ChainId.SOL && hasBuyTip ? resolvedBuyTip.providerType ?? undefined : undefined,
                solanaTipRecipient: chainId === ChainId.SOL && hasBuyTip ? resolvedBuyTip.tipRecipient : undefined,
                gasPreset: buyGasPreset,
                tokenInfo: tokenInfo ?? undefined,
              } as const;
              let res;
              try {
                res = await call({
                  type: 'tx:buyWithReceiptAuto',
                  input: buyInput,
                } as const);
              } catch (e) {
                if (shouldIgnoreSolUiTransportError('buy', tokenAddressNormalized, e)) {
                  return { walletAddress, res: { ok: true, txHash: null, backgroundPending: true } };
                }
                throw e;
              }
              const buyMetrics = res as any;
              if (!res.ok) {
                const detail = res.revertReason || res.error?.shortMessage || res.error?.message;
                throw new Error(detail || 'Transaction failed');
              }
              return { walletAddress, res };
            })().catch((error: any) => {
              if (chainId === ChainId.SOL) {
                removePendingSolTradeBaseDeltaWei(tradeBaseTokenAddress, walletAddress, pendingTradeBaseDeltaId);
                try {
                  applyOptimisticSolWalletTradeBaseDeltaWei(walletAddress, amountWei);
                } catch {
                }
              }
              throw error;
            });
            tradePromises.push(tradePromise);
          };
          if (chainId === ChainId.SOL) {
            await enqueueSolSubmitKickoff(
              `sol:buy:${walletAddress.toLowerCase()}:${String(tradeBaseTokenAddress || '').toLowerCase()}`,
              launchTrade,
            );
            return;
          }
          await launchTrade();
        });
        await Promise.all(launchPromises);
        const results = await Promise.allSettled(
          tradePromises
        );
        const successes = results
          .filter((item): item is PromiseFulfilledResult<{ walletAddress: ChainAddress; res: any }> => item.status === 'fulfilled')
          .map((item) => item.value);
        const failures = results
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => String(item.reason?.message || item.reason || 'Transaction failed'));
        const pendingCount = successes.filter((item) => (item.res as any)?.backgroundPending).length;
        const confirmedSuccesses = successes.filter((item) => !(item.res as any)?.backgroundPending);
        if (successes.length <= 0) {
          throw new Error(failures[0] || 'Transaction failed');
        }
        const first = successes[0].res;
        const quotedOutWei = chainId === ChainId.SOL
          ? null
          : (first.quotedOutWei ?? first.protectionMinOutWei ?? null);
        if (first?.txHash) setTxHash(first.txHash);
        setPendingBuyQuotedOutWei(quotedOutWei);
        if (confirmedSuccesses.length > 0) {
          toast.success(`买入成功 ${confirmedSuccesses.length}/${executablePlan.length} 个钱包`, { icon: '✅', duration: 2500 });
        }
        if (pendingCount > 0) {
          toast(`后台继续处理中 ${pendingCount}/${executablePlan.length} 个钱包`, { icon: '⏳', duration: 2500 });
        }
        if (failures.length > 0) {
          toast.error(`买入失败 ${failures.length} 个钱包`, { icon: '⚠️' });
        }
        if (confirmedSuccesses.length > 0) {
          buyLoadingClosed = true;
        }

        if (tokenInfo && confirmedSuccesses.length > 0) {
          void requestApproveForWallets(
            confirmedSuccesses.map(({ walletAddress }) => walletAddress),
            { silent: true }
          ).catch(() => { });
        }

        if (confirmedSuccesses.length > 0) {
          triggerPostTradeRefresh('buy');
          setPendingBuyQuotedOutWei(null);
        }

        try {
          const config = settings.advancedAutoSell;
          if (!config?.enabled) return;
          if (!siteInfo) return;
          if (!tokenInfo) return;
          const autoSellContexts = successes.map(({ walletAddress, res }) => ({
            walletAddress,
            res,
            ctx: {
              chainId,
              tokenAddress: tokenAddressNormalized,
              walletAddress,
              siteInfo,
              tokenInfo,
              tokenSymbol: resolvedTokenSymbol ?? null,
            } satisfies PendingAutoSellOrderContext,
          }));
          let createdOrderCount = 0;
          for (const item of autoSellContexts) {
            if ((item.res as any)?.backgroundPending) continue;
            createdOrderCount += await createAutoSellOrdersForWallet(item.ctx);
          }
          for (const item of autoSellContexts) {
            if (!(item.res as any)?.backgroundPending) continue;
            const pendingKey = getPendingAutoSellOrderKey(chainId, tokenAddressNormalized, item.walletAddress);
            pendingAutoSellOrdersRef.current.set(pendingKey, item.ctx);
          }
          if (createdOrderCount > 0) {
            toast.success(`已创建自动卖出挂单 ${createdOrderCount} 个`, { icon: '✅' });
          }
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
    }, { trackBusy: !isSolana, label: 'buy' });
  };

  const handleSell = (pct: number) => {
    setSellPercent(pct);
    withBusy(async () => {
      if (!settings) throw new Error('Settings not ready');
      if (!tokenAddressNormalized) throw new Error('Invalid token');
      if (submitChannel === 'blox' && selectedApproveStatus === 'approving') {
        toast.error(locale === 'en' ? 'Wait for approval to finish before selling on Blox.' : 'Blox 通道授权中，请等待授权完成后再卖出');
        return;
      }
      const wallets = selectedTradeWallets;
      if (wallets.length <= 0) throw new Error('No wallet selected');

      const isTurbo = settings.chains[chainId]?.executionMode === 'turbo';
      const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = !!tokenInfo?.launchpad && (platform.includes('four')) && tokenInfo.launchpad_status !== 1;

      ensureTradeSuccessAudioReady();
      const sym = resolvedTokenSymbol ?? '';
      const flowToastId = getTradeToastId('sell', tokenAddressNormalized);
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: tradingLoadingIcon, id: flowToastId });
      let sellLoadingClosed = false;
      const sellGasPreset = effectiveChainSettings?.sellGasPreset ?? effectiveChainSettings?.gasPreset ?? 'standard';

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
        const tradeOutcomeKey = getSolTradeOutcomeKey('sell', tokenAddressNormalized);
        if (chainId === ChainId.SOL) {
          solTradeOutcomeRef.current.delete(tradeOutcomeKey);
        }
        const tradePromises: Array<Promise<{ walletAddress: ChainAddress; res: any }>> = [];
        const launchPromises = wallets.map(async (walletAddress) => {
          const launchTrade = async () => {
            let tokenAmountWei = '0';
            let expectedTokenInWeiHint: string | undefined;
            let pendingSellDeltaId: string | null = null;
            if (chainId === ChainId.SOL && isTurbo) {
              await waitForSolTurboPrewarmReady(walletAddress);
            }
            const shouldResolveSellAmountBeforeSubmit = !isTurbo || chainId === ChainId.SOL;
            const sellPrepStartedAt = Date.now();
            if (shouldResolveSellAmountBeforeSubmit) {
              const trackedSolSellableBalanceWei = chainId === ChainId.SOL
                ? getTrackedSolWalletSellableTokenBalanceWei(tokenAddressNormalized, walletAddress)
                : null;
              const usingTrackedSolBalance = chainId === ChainId.SOL && trackedSolSellableBalanceWei != null;
              const walletAddrLower = String(walletAddress || '').toLowerCase();
              const displayedSolSellableBalanceWei = chainId === ChainId.SOL
                ? (walletTokenBalancesWei[walletAddrLower] ?? getSelectedSingleWalletDisplayBalanceWei(walletAddress))
                : null;
              let usingDisplayedSolBalanceFallback = false;
              const holding = usingTrackedSolBalance
                ? null
                : await (async () => {
                  if (chainId === ChainId.SOL) {
                    if (displayedSolSellableBalanceWei != null) {
                      usingDisplayedSolBalanceFallback = true;
                      return displayedSolSellableBalanceWei;
                    }
                    throw new Error('Solana sellable balance not ready');
                  }
                  return await TokenAPI.getTokenHolding(siteInfo?.platform || 'gmgn', siteInfo?.chain || String(chainId), walletAddress, tokenAddressNormalized, {
                    cacheTtlMs: 0,
                  });
                })();
              const bal = usingTrackedSolBalance ? (trackedSolSellableBalanceWei ?? 0n) : BigInt(holding || '0');
              const pendingDeltaWei = chainId === ChainId.SOL && !usingTrackedSolBalance && !usingDisplayedSolBalanceFallback
                ? getPendingSolTokenNegativeDeltaWei(tokenAddressNormalized, walletAddress)
                : 0n;
              const effectiveBal = usingTrackedSolBalance ? bal : (chainId === ChainId.SOL ? (bal + pendingDeltaWei) : bal);
              const availableBal = effectiveBal > 0n ? effectiveBal : 0n;
              if (chainId === ChainId.SOL) expectedTokenInWeiHint = availableBal.toString();
              if (availableBal <= 0n) throw new Error('No balance');
              let amountWei = (availableBal * BigInt(pct)) / 100n;
              if (pct >= 100) amountWei = availableBal;
              if (isInnerFourMeme && amountWei > 0n) amountWei = (amountWei / 1000000000n) * 1000000000n;
              if (amountWei <= 0n) throw new Error('Invalid amount');
              tokenAmountWei = amountWei.toString();
              if (chainId === ChainId.SOL) {
                pendingSellDeltaId = addPendingSolTokenDeltaWei(tokenAddressNormalized, walletAddress, `-${tokenAmountWei}`);
                applyOptimisticSolWalletTokenDeltaWei(walletAddress, -amountWei);
              }
              const pendingDeltaSummary = chainId === ChainId.SOL
                ? getPendingSolTokenDeltaSummary(tokenAddressNormalized, walletAddress)
                : null;
              logUiDebug('[ui.sell.auto][amount.resolved]', {
                chainId,
                token: tokenAddressNormalized,
                walletAddress,
                balanceWei: bal.toString(),
                pendingDeltaWei: pendingDeltaWei.toString(),
                pendingDeltaSummary,
                effectiveBalanceWei: effectiveBal.toString(),
                availableBalanceWei: availableBal.toString(),
                balanceSource: usingTrackedSolBalance ? 'tracked' : (usingDisplayedSolBalanceFallback ? 'displayed' : 'holding'),
                tokenAmountWei,
                percentBps,
                ts: Date.now(),
              });
            }
            const tradePromise = (async () => {
              const uiRequestStartedAt = Date.now();
              const resolvedSellPriorityFeeNative = resolvePriorityFee('sell');
              const resolvedSellTip = resolveSolanaTip('sell');
              const hasSellPriorityFee = !!resolvedSellPriorityFeeNative && resolvedSellPriorityFeeNative !== '0';
              const hasSellTip = !!resolvedSellTip.tipNative && resolvedSellTip.tipNative !== '0' && !!resolvedSellTip.tipRecipient;
              const sellInput = {
                chainId,
                tokenAddress: tokenAddressNormalized,
                tokenAmountWei: chainId === ChainId.SOL ? '0' : tokenAmountWei,
                baseTokenAddress: tradeBaseTokenAddress,
                sellPercentBps: chainId === ChainId.SOL ? percentBps : (isTurbo && chainId !== ChainId.SOL ? percentBps : undefined),
                expectedTokenInWei: chainId === ChainId.SOL ? expectedTokenInWeiHint : (isTurbo && chainId !== ChainId.SOL ? (pendingBuyQuotedOutWei ?? undefined) : undefined),
                fromAddress: walletAddress,
                submitChannel,
                executionModeOverride: isTurbo ? 'turbo' : 'default',
                priorityFeeNative: resolvedSellPriorityFeeNative,
                solanaFeeMode: chainId === ChainId.SOL
                  ? (hasSellTip ? (hasSellPriorityFee ? 'pf_and_tip' : 'tip') : 'pf')
                  : undefined,
                solanaTipNative: chainId === ChainId.SOL && hasSellTip ? resolvedSellTip.tipNative : undefined,
                solanaTipProviderType: chainId === ChainId.SOL && hasSellTip ? resolvedSellTip.providerType ?? undefined : undefined,
                solanaTipRecipient: chainId === ChainId.SOL && hasSellTip ? resolvedSellTip.tipRecipient : undefined,
                gasPreset: sellGasPreset,
                tokenInfo: tokenInfo ?? undefined
              } as const;
              try {
                const res = await call({
                  type: 'tx:sellWithReceiptAuto',
                  input: sellInput,
                } as const);
                const sellMetrics = res as any;
                if (!res.ok) {
                  const detail = res.revertReason || res.error?.shortMessage || res.error?.message || 'Transaction failed';
                  throw new Error(detail);
                }
                return { walletAddress, res };
              } catch (e) {
                if (shouldIgnoreSolUiTransportError('sell', tokenAddressNormalized, e)) {
                  return { walletAddress, res: { ok: true, txHash: null, backgroundPending: true } };
                }
                if (chainId === ChainId.SOL && tokenAmountWei && tokenAmountWei !== '0') {
                  removePendingSolTokenDeltaWei(tokenAddressNormalized, walletAddress, pendingSellDeltaId);
                  try {
                    applyOptimisticSolWalletTokenDeltaWei(walletAddress, BigInt(tokenAmountWei));
                  } catch {
                  }
                }
                throw e;
              }
            })();
            tradePromises.push(tradePromise);
          };
          if (chainId === ChainId.SOL) {
            await enqueueSolSubmitKickoff(
              `sol:sell:${walletAddress.toLowerCase()}:${tokenAddressNormalized.toLowerCase()}`,
              launchTrade,
            );
            return;
          }
          await launchTrade();
        });
        await Promise.all(launchPromises);
        const results = await Promise.allSettled(
          tradePromises
        );
        const successes = results
          .filter((item): item is PromiseFulfilledResult<{ walletAddress: `0x${string}`; res: any }> => item.status === 'fulfilled')
          .map((item) => item.value);
        const failures = results
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => String(item.reason?.message || item.reason || 'Transaction failed'));
        const pendingCount = successes.filter((item) => (item.res as any)?.backgroundPending).length;
        const confirmedSuccesses = successes.filter((item) => !(item.res as any)?.backgroundPending);
        logUiDebug('[ui.sell.auto][request.response]', {
          chainId,
          token: tokenAddressNormalized,
          ok: successes.length > 0,
          successCount: successes.length,
          pendingCount,
          totalWallets: wallets.length,
          elapsedMs: Date.now() - sellReqStartedAt,
          ts: Date.now(),
        });
        if (successes.length <= 0) {
          throw new Error(failures[0] || 'Transaction failed');
        }
        const firstConfirmedSuccess = confirmedSuccesses[0];
        if (firstConfirmedSuccess?.res?.txHash) setTxHash(firstConfirmedSuccess.res.txHash);
        if (confirmedSuccesses.length > 0) {
          toast.success(`卖出成功 ${confirmedSuccesses.length}/${wallets.length} 个钱包`, { icon: '✅', duration: 2500 });
        }
        if (pendingCount > 0) {
          toast(`后台继续处理中 ${pendingCount}/${wallets.length} 个钱包`, { icon: '⏳', duration: 2500 });
        }
        if (failures.length > 0) {
          toast.error(`卖出失败 ${failures.length} 个钱包`, { icon: '⚠️' });
        }
        if (confirmedSuccesses.length > 0) {
          sellLoadingClosed = true;
          triggerPostTradeRefresh('sell');
          setPendingBuyQuotedOutWei(null);
        }

        // Cancel limit order if exists
        if (percentBps === 10000 && confirmedSuccesses.length > 0) {
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
    }, { trackBusy: !isSolana, label: 'sell' });
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
      if (isSolana) return;
      const wallets = selectedTradeWallets;
      if (wallets.length <= 0) throw new Error('No wallet selected');
      await requestApproveForWallets(wallets);
    }, { label: 'approve' });
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
    const submitChannel = (currentChainSettings.submitChannel ?? 'protectRpcs');
    if (chainId !== ChainId.SOL && (submitChannel === 'protectRpcs' || submitChannel === 'mixed')) return;
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
    const submitChannel = (currentChainSettings.submitChannel ?? 'protectRpcs');
    if (chainId !== ChainId.SOL && (submitChannel === 'protectRpcs' || submitChannel === 'mixed')) return;
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

  const handleToggleBuyTipPreset = () => {
    if (!settings || chainId !== ChainId.SOL) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const current = PRIORITY_FEE_PRESETS.includes((currentChainSettings as any).buyTipPreset)
      ? (currentChainSettings as any).buyTipPreset as PriorityFeePreset
      : 'none';
    const next = PRIORITY_FEE_PRESETS[(PRIORITY_FEE_PRESETS.indexOf(current) + 1) % PRIORITY_FEE_PRESETS.length];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            buyTipPreset: next,
          },
        },
      },
    }).then(() => refreshAll());
  };

  const handleToggleSellTipPreset = () => {
    if (!settings || chainId !== ChainId.SOL) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const current = PRIORITY_FEE_PRESETS.includes((currentChainSettings as any).sellTipPreset)
      ? (currentChainSettings as any).sellTipPreset as PriorityFeePreset
      : 'none';
    const next = PRIORITY_FEE_PRESETS[(PRIORITY_FEE_PRESETS.indexOf(current) + 1) % PRIORITY_FEE_PRESETS.length];
    call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            sellTipPreset: next,
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

  const handleSelectChannel = (next: string) => {
    if (!settings) return;
    const currentChainSettings = effectiveChainSettings;
    if (!currentChainSettings) return;
    const target = channelOptions.find((item) => item.key === next);
    if (!target?.available) return;
    if (isSolana) {
      const nextSwqosEnabled = next === 'swqos';
      if (!!currentChainSettings.solanaSwqos?.enabled === nextSwqosEnabled) return;
      void call({
        type: 'settings:set',
        settings: {
          ...settings,
          chains: {
            ...settings.chains,
            [chainId]: {
              ...currentChainSettings,
              solanaSwqos: {
                ...(currentChainSettings.solanaSwqos ?? {}),
                enabled: nextSwqosEnabled,
              },
            },
          },
        },
      } as const).then(() => refreshAll());
      return;
    }
    if (!['blox', 'blockrazor', 'protectRpcs', 'mixed'].includes(next)) return;
    const submitChannelNext = next as SubmitChannel;
    if ((currentChainSettings.submitChannel ?? 'protectRpcs') === submitChannelNext) return;
    const buyPriorityPresets = currentChainSettings.buyPriorityFeePresets ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES;
    const sellPriorityPresets = currentChainSettings.sellPriorityFeePresets ?? DEFAULT_PRIORITY_FEE_PRESET_VALUES;
    const buyPriorityPreset = (['none', 'slow', 'standard', 'fast'] as const).includes((currentChainSettings as any)?.buyPriorityFeePreset)
      ? (currentChainSettings as any).buyPriorityFeePreset as PriorityFeePreset
      : 'standard';
    const sellPriorityPreset = (['none', 'slow', 'standard', 'fast'] as const).includes((currentChainSettings as any)?.sellPriorityFeePreset)
      ? (currentChainSettings as any).sellPriorityFeePreset as PriorityFeePreset
      : 'standard';
    const buyPriorityEnabled = Number(buyPriorityPresets[buyPriorityPreset] ?? '0') > 0;
    const sellPriorityEnabled = Number(sellPriorityPresets[sellPriorityPreset] ?? '0') > 0;
    const nextExecutionMode = (currentChainSettings.executionMode ?? 'turbo') === 'turbo' ? 'turbo' : 'default';
    const channelToast = submitChannelNext === 'protectRpcs' && nextExecutionMode === 'turbo'
      ? (locale === 'en'
          ? 'Protect + Turbo may expose large buys. Use Default mode + slippage protection; for stronger MEV protection, use Blox/Razor + PF.'
          : 'Protect + 极速模式下，大额买入仍可能被夹；建议使用默认模式 + 滑点保护，若更重视防夹可切到 Blox/Razor + PF。')
      : submitChannelNext === 'mixed'
        ? (locale === 'en'
            ? 'Mixed mode races Blox private and Protect raw routes. PF is hidden and disabled in this mode.'
            : '混合模式会让 Blox private 与 Protect 路由并发竞速；此模式下 PF 会被隐藏并禁用。')
      : (!buyPriorityEnabled || !sellPriorityEnabled)
        ? (locale === 'en'
            ? 'Blox/Razor without PF may confirm slowly. Consider enabling PF.'
            : 'Blox/Razor 未开启 PF 时确认可能较慢，建议开启 PF。')
        : null;
    void call({
      type: 'settings:set',
      settings: {
        ...settings,
        chains: {
          ...settings.chains,
          [chainId]: {
            ...currentChainSettings,
            submitChannel: submitChannelNext,
          },
        },
      },
    } as const).then(() => {
      refreshAll();
      if (channelToast) {
        toast(channelToast, {
          icon: submitChannelNext === 'protectRpcs' || submitChannelNext === 'mixed' ? '⚠️' : 'ℹ️',
          duration: 2800,
        });
      }
    });
  };

  const handleEditToggle = () => {
    if (!isEditing) {
      // Start editing: initialize drafts
      if (settings) {
        setDraftBuyPresets(settings.chains[chainId]?.buyPresets || ['0.01', '0.2', '0.5', '1.0']);
        setDraftSellPresets(settings.chains[chainId]?.sellPresets || ['10', '25', '50', '100']);
        setDraftQuickBuyAdvancedEnabled(!!settings.chains[chainId]?.quickBuyAdvancedEnabled);
        setDraftQuickBuyPresetOverrides(normalizeQuickBuyPresetOverrides(settings.chains[chainId]?.quickBuyPresetOverrides));
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
                quickBuyAdvancedEnabled: draftQuickBuyAdvancedEnabled,
                quickBuyPresetOverrides: normalizeQuickBuyPresetOverrides(draftQuickBuyPresetOverrides),
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

  const handleToggleQuickBuyAdvanced = () => {
    setDraftQuickBuyAdvancedEnabled((prev) => !prev);
  };

  const handleToggleQuickBuyPresetGas = (presetIndex: number) => {
    if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex > 3) return;
    const presets: Array<QuickBuyPresetOverride['gasPreset']> = [undefined, 'slow', 'standard', 'fast', 'turbo'];
    setDraftQuickBuyPresetOverrides((prev) => {
      const next = normalizeQuickBuyPresetOverrides(prev);
      const current = next[presetIndex]?.gasPreset;
      const currentIndex = presets.findIndex((item) => item === current);
      next[presetIndex] = {
        ...next[presetIndex],
        gasPreset: presets[(currentIndex + 1 + presets.length) % presets.length],
      };
      return next;
    });
  };

  const handleToggleQuickBuyPresetPriorityFee = (presetIndex: number) => {
    if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex > 3) return;
    const presets: Array<QuickBuyPresetOverride['priorityFeePreset']> = [undefined, 'none', 'slow', 'standard', 'fast'];
    setDraftQuickBuyPresetOverrides((prev) => {
      const next = normalizeQuickBuyPresetOverrides(prev);
      const current = next[presetIndex]?.priorityFeePreset;
      const currentIndex = presets.findIndex((item) => item === current);
      next[presetIndex] = {
        ...next[presetIndex],
        priorityFeePreset: presets[(currentIndex + 1 + presets.length) % presets.length],
      };
      return next;
    });
  };

  const handleUpdateAdvancedAutoSell = (next: Settings['advancedAutoSell']) => {
    if (!settings) return;
    void call({ type: 'settings:set', settings: { ...settings, advancedAutoSell: next } } as const).then(() => refreshAll());
  };

  const handleToggleTradeWallet = (walletAddress: ChainAddress) => {
    if (!settings || !state?.wallet) return;
    const allAccounts = (state.wallet.accounts ?? []) as Account[];
    const lowerToCanonical = new Map<string, ChainAddress>();
    for (const acc of allAccounts) {
      const normalized = normalizeWalletAddress(chainId, String(acc.address || ''));
      if (!normalized) continue;
      lowerToCanonical.set(normalized.toLowerCase(), normalized);
    }
    const targetLower = walletAddress.toLowerCase();
    if (!lowerToCanonical.has(targetLower)) return;
    const current = new Set(selectedTradeWallets.map((x) => x.toLowerCase()));
    if (current.has(targetLower)) current.delete(targetLower);
    else current.add(targetLower);
    if (current.size === 0) {
      const fallback = normalizeWalletAddress(chainId, String(state.wallet.address || ''));
      if (fallback) current.add(fallback.toLowerCase());
    }
    const nextSelected = Array.from(current)
      .map((x) => lowerToCanonical.get(x))
      .filter(Boolean) as ChainAddress[];
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

  const handleUpdateChildWalletBuyPresetAmount = (walletAddress: ChainAddress, presetIndex: number, amountNative: string) => {
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
              activeWalletAddress={address}
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
              tokenDecimals={resolvedTokenDecimals}
              nativeSymbol={nativeSymbol}
              nativeDecimals={tradeBaseTokenMeta.decimals}
              holdingStats={gmgnHoldingStats}
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
              channelActiveKey={channelActiveKey}
              channelOptions={channelOptions}
              onSelectChannel={handleSelectChannel}
              prewarmIndicatorState={prewarmIndicatorState}
              prewarmIndicatorTitle={prewarmIndicatorTitle}
              dynamicGasBasePriceWei={dynamicGasBasePriceWei}
              onToggleMode={handleToggleMode}
              onToggleBuyGas={handleToggleBuyGas}
              onToggleSellGas={handleToggleSellGas}
              onToggleBuyPriorityFeePreset={handleToggleBuyPriorityFeePreset}
              onToggleSellPriorityFeePreset={handleToggleSellPriorityFeePreset}
              onToggleBuyTipPreset={handleToggleBuyTipPreset}
              onToggleSellTipPreset={handleToggleSellTipPreset}
              onToggleSlippage={handleToggleSlippage}
              onUpdateBuyPreset={handleUpdateBuyPreset}
              draftBuyPresets={draftBuyPresets}
              quickBuyAdvancedEnabled={isEditing ? draftQuickBuyAdvancedEnabled : !!effectiveChainSettings?.quickBuyAdvancedEnabled}
              quickBuyPresetOverrides={isEditing ? draftQuickBuyPresetOverrides : normalizeQuickBuyPresetOverrides(effectiveChainSettings?.quickBuyPresetOverrides)}
              onToggleQuickBuyAdvanced={handleToggleQuickBuyAdvanced}
              onToggleQuickBuyPresetGas={handleToggleQuickBuyPresetGas}
              onToggleQuickBuyPresetPriorityFee={handleToggleQuickBuyPresetPriorityFee}
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
              tokenSymbol={resolvedTokenSymbol}
              buyPreviewRoute={quickTradePreviewRoutes.buy}
              sellPreviewRoute={quickTradePreviewRoutes.sell}
              approveStatus={selectedApproveStatus}
              approveStatusTitle={approveStatusTitle}
              sellActionReady={sellActionReady}
              sellActionDisabledReason={sellActionDisabledReason}
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
            activeWalletAddress={address}
            selectedTradeWallets={selectedTradeWallets}
            onToggleTradeWallet={handleToggleTradeWallet}
            walletTradeBaseBalancesWei={walletTradeBaseBalancesWei}
            walletTokenBalancesWei={walletTokenBalancesWei}
            tokenDecimals={resolvedTokenDecimals}
            formattedTradeBaseBalance={formattedNativeBalance}
            tradeBaseTokenAddress={tradeBaseTokenAddress}
            tradeBaseTokenSymbol={tradeBaseTokenSymbol}
            tradeBaseTokenDecimals={tradeBaseTokenMeta.decimals}
            formattedTokenBalance={formattedTokenBalance}
            tokenSymbol={resolvedTokenSymbol}
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
            tokenSymbol={resolvedTokenSymbol}
          />

          <CookingPanel
            visible={showCookingPanel}
            onVisibleChange={setShowCookingPanel}
            address={effectiveCookingSiteInfo?.walletAddress ?? address}
            walletAccounts={walletAccounts}
            activeWalletAddress={address}
            siteInfo={effectiveCookingSiteInfo}
            currentTokenName={effectiveCookingTokenInfo?.name ?? (cookingSiteInfoOverride ? null : tokenInfo?.name ?? null)}
            currentTokenSymbol={effectiveCookingTokenInfo?.symbol ?? (cookingSiteInfoOverride ? null : resolvedTokenSymbol ?? tokenInfo?.symbol ?? null)}
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
