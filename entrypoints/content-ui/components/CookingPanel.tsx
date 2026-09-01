import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import toast from 'react-hot-toast';
import { browser } from 'wxt/browser';
import { formatUnits } from 'viem';
import type { Account } from '@/types/extention';
import type { ChainAddress } from '@/types/chain/address';
import type { TokenInfo } from '@/types/token';
import { ChainId } from '@/constants/chains/chainId';
import { FlapQuoteTokensByChain, getFlapStocksPresetTokens, type FlapPresetQuoteToken } from '@/constants/flap';
import GmgnAPI from '@/hooks/GmgnAPI';
import { TokenAPI } from '@/hooks/TokenAPI';
import { call } from '@/utils/messaging';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';
import { WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';
import { normalizeAddressKey } from '@/services/xSniper/engine/metrics';
import {
  clearCookingLastLaunch,
  readCookingLastLaunch,
  rememberCookingLastLaunch,
  type CookingLastLaunch,
} from '@/utils/cookingLaunchWallets';

type CookingPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  address: string | null;
  walletAccounts: Account[];
  activeWalletAddress: ChainAddress | null;
  siteInfo: SiteInfo | null;
  currentTokenName?: string | null;
  currentTokenSymbol?: string | null;
  currentTokenInfo?: TokenInfo | null;
  tokenInfoLoading?: boolean;
  onSellLaunchedToken?: (input: {
    pct: number;
    tokenAddress: ChainAddress;
    walletAddress: ChainAddress;
    tokenSymbol?: string | null;
    tokenInfo?: TokenInfo | null;
  }) => void | Promise<void>;
};

const COOKING_PANEL_WIDTH = 360;
const COOKING_PANEL_MIN_HEIGHT = 420;
const COOKING_PANEL_DEFAULT_HEIGHT = 700;
const FLAP_TAX_RATE_OPTIONS = [100, 300, 500, 1000] as const;

type CookingLaunchPlatform = 'fourmeme' | 'flap' | 'flap_stocks';
type FlapTaxMode = 'quote' | 'self' | 'custom' | 'stocks' | 'disabled';

function clampCookingPanelHeight(value: number, panelTop: number) {
  const viewportHeight = window.innerHeight || 0;
  const maxHeight = Math.max(COOKING_PANEL_MIN_HEIGHT, viewportHeight - Math.max(0, panelTop) - 12);
  return Math.min(Math.max(COOKING_PANEL_MIN_HEIGHT, value), maxHeight);
}

function clampCookingPanelPos(pos: { x: number; y: number }, panelHeight: number) {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, pos.x), Math.max(0, width - COOKING_PANEL_WIDTH));
  const clampedY = Math.min(Math.max(0, pos.y), Math.max(0, height - panelHeight));
  return { x: clampedX, y: clampedY };
}

function pickFirstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) return normalized;
  }
  return '';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result.startsWith('data:image/')) {
        reject(new Error('图片预处理失败'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error('图片预处理失败'));
    reader.readAsDataURL(blob);
  });
}

async function resolveLogoUrlToDataUrl(rawUrl: string): Promise<string> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('缺少图片地址');
  if (/^data:image\//i.test(trimmed)) return trimmed;
  const response = await fetch(trimmed);
  if (!response.ok) {
    throw new Error(`图片预加载失败：${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    throw new Error('图片预加载失败：返回内容不是图片');
  }
  return await blobToDataUrl(blob);
}

function getPlatformButtonClass(active: boolean) {
  return active
    ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(74,222,128,0.15)]'
    : 'border-zinc-800 bg-zinc-950/80 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100';
}

function getTaxChipClass(active: boolean) {
  return active
    ? 'border-emerald-400 bg-emerald-500/10 text-emerald-200'
    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200';
}

function renderFlapTokenAvatar(token: FlapPresetQuoteToken, sizeClass = 'h-4 w-4') {
  if (token.iconSrc) {
    return (
      <img
        src={token.iconSrc}
        alt={token.symbol}
        className={`${sizeClass} rounded-full object-cover`}
      />
    );
  }
  return (
    <span className={`${sizeClass} inline-flex items-center justify-center rounded-full bg-zinc-800 text-[9px] font-semibold text-zinc-200`}>
      {token.symbol.slice(0, 1)}
    </span>
  );
}

function getCookingLaunchFallbackLink(platform: CookingLaunchPlatform, tokenAddress: string) {
  if (platform === 'fourmeme') {
    return `https://four.meme/zh-TW/token/${tokenAddress}`;
  }
  if (platform === 'flap' || platform === 'flap_stocks') {
    return `https://gmgn.ai/bsc/token/${tokenAddress}`;
  }
  return '';
}

function notifyCookingAutoSellResult(autoSell?: { okCount: number; total: number; errors?: string[] } | null) {
  if (!autoSell) return;
  if (autoSell.total <= 0) {
    toast.error(autoSell.errors?.[0] || '自动卖出已开启，但没有有效的市值目标配置');
    return;
  }
  if (autoSell.okCount > 0) {
    toast.success(`自动卖出挂单已创建 ${autoSell.okCount}/${autoSell.total}`, { icon: '🧾' });
    return;
  }
  toast.error(autoSell.errors?.[0] || '自动卖出挂单创建失败');
}

function rememberLaunchToken(input: {
  tokenAddress?: string | null;
  walletAddress?: string | null;
  symbol?: string;
  name?: string;
}): CookingLastLaunch | null {
  const token = String(input.tokenAddress || '').trim();
  const wallet = String(input.walletAddress || '').trim();
  if (!token || !wallet) return null;
  return rememberCookingLastLaunch({
    tokenAddress: token,
    walletAddress: wallet,
    symbol: input.symbol,
    name: input.name,
  });
}

function formatLaunchTokenBalance(wei: string, decimals = 18) {
  try {
    const raw = formatUnits(BigInt(wei || '0'), decimals);
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return '0';
    if (num >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return num.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

export function CookingPanel({
  visible,
  onVisibleChange,
  address,
  walletAccounts,
  activeWalletAddress,
  siteInfo,
  currentTokenName,
  currentTokenSymbol,
  currentTokenInfo,
  tokenInfoLoading = false,
  onSellLaunchedToken,
}: CookingPanelProps) {
  type LogoSearchImage = { url: string; thumbnail?: string; title?: string; source?: string };
  type LogoSearchTab = 'token' | 'google';
  const cookingConfigStorageKey = 'dagobang_cooking_config_v2';
  const MAX_AUTO_SELL_RULES = 5;
  type AutoSellRule = { marketCapUsd: string; sellPercent: string };
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - COOKING_PANEL_WIDTH);
    const defaultY = 360;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const [panelHeight, setPanelHeight] = useState(() => clampCookingPanelHeight(COOKING_PANEL_DEFAULT_HEIGHT, 360));
  const panelHeightRef = useRef(panelHeight);
  const [launching, setLaunching] = useState(false);
  const launchFlowIdRef = useRef<string | null>(null);
  const launchToastIdRef = useRef<string | undefined>(undefined);
  const autoSellNotifiedFlowIdsRef = useRef(new Set<string>());
  const deployWalletRef = useRef<ChainAddress | null>(null);
  const pendingLaunchMetaRef = useRef<{ name: string; symbol: string } | null>(null);
  const [lastLaunch, setLastLaunch] = useState<CookingLastLaunch | null>(() => readCookingLastLaunch());
  const [launchBalanceWei, setLaunchBalanceWei] = useState('0');
  const [launchSelling, setLaunchSelling] = useState(false);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);
  const resizing = useRef<null | { startY: number; baseHeight: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    panelHeightRef.current = panelHeight;
  }, [panelHeight]);

  useEffect(() => {
    const listener = (message: any) => {
      if (message?.type !== 'bg:cookingLaunchEvent') return;
      const currentFlowId = launchFlowIdRef.current;
      if (!currentFlowId || message?.flowId !== currentFlowId) return;
      const toastId = launchToastIdRef.current;
      const display = String(message?.message || '发射处理中');
      if (message?.status === 'success') {
        toast.success(display, { id: toastId, icon: '✅' });
        setLaunching(false);
        launchFlowIdRef.current = null;
        launchToastIdRef.current = undefined;
        const addr = typeof message?.tokenAddress === 'string' ? message.tokenAddress.trim() : '';
        const fromAddress = typeof message?.fromAddress === 'string'
          ? message.fromAddress.trim()
          : String(deployWalletRef.current || '').trim();
        const nextLaunch = rememberLaunchToken({
          tokenAddress: addr,
          walletAddress: fromAddress,
          symbol: pendingLaunchMetaRef.current?.symbol,
          name: pendingLaunchMetaRef.current?.name,
        });
        if (nextLaunch) setLastLaunch(nextLaunch);
        if (!autoSellNotifiedFlowIdsRef.current.has(currentFlowId)) {
          autoSellNotifiedFlowIdsRef.current.add(currentFlowId);
          notifyCookingAutoSellResult(message?.autoSell ?? null);
        }
        if (addr) {
          const link = (siteInfo ? parsePlatformTokenLink(siteInfo, addr) : '')
            || getCookingLaunchFallbackLink(message?.platform === 'flap_stocks' ? 'flap_stocks' : 'flap', addr);
          if (link) {
            window.setTimeout(() => {
              navigateToUrl(link);
            }, 10);
          }
        }
        clearImageAndTokenInputs();
        return;
      }
      if (message?.status === 'error') {
        toast.error(display, { id: toastId, icon: '❌' });
        setLaunching(false);
        launchFlowIdRef.current = null;
        launchToastIdRef.current = undefined;
        return;
      }
      toast.loading(display, { id: toastId, icon: '🔄' });
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [siteInfo]);

  useEffect(() => {
    try {
      const key = 'dagobang_cooking_panel_pos';
      const stored = window.localStorage.getItem(key);
      const rawHeight = window.localStorage.getItem('dagobang_cooking_panel_height_v1');
      const storedHeight = rawHeight ? Number(rawHeight) : NaN;
      const parsed = stored ? JSON.parse(stored) : null;
      const nextPos = parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number'
        ? parsed
        : posRef.current;
      const nextHeight = Number.isFinite(storedHeight)
        ? clampCookingPanelHeight(storedHeight, nextPos.y)
        : clampCookingPanelHeight(panelHeightRef.current, nextPos.y);
      setPanelHeight(nextHeight);
      setPos(clampCookingPanelPos(nextPos, nextHeight));
    } catch {
    }
  }, []);

  useEffect(() => {
    const onResize = () => {
      const nextHeight = clampCookingPanelHeight(panelHeightRef.current, posRef.current.y);
      setPanelHeight(nextHeight);
      setPos((prev) => clampCookingPanelPos(prev, nextHeight));
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragging.current) {
        const dx = e.clientX - dragging.current.startX;
        const dy = e.clientY - dragging.current.startY;
        const nextX = dragging.current.baseX + dx;
        const nextY = dragging.current.baseY + dy;
        setPos(clampCookingPanelPos({ x: nextX, y: nextY }, panelHeightRef.current));
        return;
      }
      if (resizing.current) {
        const dy = e.clientY - resizing.current.startY;
        setPanelHeight(clampCookingPanelHeight(resizing.current.baseHeight + dy, posRef.current.y));
      }
    };
    const onUp = () => {
      const didDrag = !!dragging.current;
      const didResize = !!resizing.current;
      dragging.current = null;
      resizing.current = null;
      if (!didDrag && !didResize) return;
      try {
        const key = 'dagobang_cooking_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(clampCookingPanelPos(posRef.current, panelHeightRef.current)));
        window.localStorage.setItem('dagobang_cooking_panel_height_v1', String(panelHeightRef.current));
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

  const [logoUrl, setLogoUrl] = useState('');
  const [resolvedLogoDataUrl, setResolvedLogoDataUrl] = useState('');
  const [logoResolving, setLogoResolving] = useState(false);
  const [logoResolveError, setLogoResolveError] = useState<string | null>(null);
  const [tokenSymbolInput, setTokenSymbolInput] = useState('');
  const [tokenNameInput, setTokenNameInput] = useState('');
  const [twitterInput, setTwitterInput] = useState('');
  const [websiteInput, setWebsiteInput] = useState('');
  const [telegramInput, setTelegramInput] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<CookingLaunchPlatform>('fourmeme');
  const [flapQuoteTokenId, setFlapQuoteTokenId] = useState<FlapPresetQuoteToken['id']>('bnb');
  const [flapTaxMode, setFlapTaxMode] = useState<FlapTaxMode>('quote');
  const [flapBuyTaxBps, setFlapBuyTaxBps] = useState<number>(100);
  const [flapSellTaxBps, setFlapSellTaxBps] = useState<number>(100);
  const [flapCustomDividendTokenAddress, setFlapCustomDividendTokenAddress] = useState('');
  const [flapSelectedStocks, setFlapSelectedStocks] = useState<string[]>([]);
  const [flapStockSearch, setFlapStockSearch] = useState('');
  const [deployWallet, setDeployWallet] = useState<ChainAddress | null>(null);
  const [defaultBuyBnb, setDefaultBuyBnb] = useState('0.1');
  const [autoSellEnabled, setAutoSellEnabled] = useState(true);
  const [autoSellRules, setAutoSellRules] = useState<AutoSellRule[]>([{ marketCapUsd: '3700', sellPercent: '100' }]);
  const [deployWalletSelectorOpen, setDeployWalletSelectorOpen] = useState(false);
  const [googleQuery, setGoogleQuery] = useState('');
  const [logoSearchTab, setLogoSearchTab] = useState<LogoSearchTab>('token');
  const [logoSearchActive, setLogoSearchActive] = useState(false);
  const [tokenSearching, setTokenSearching] = useState(false);
  const [tokenImages, setTokenImages] = useState<LogoSearchImage[]>([]);
  const [googleSearching, setGoogleSearching] = useState(false);
  const [googleImages, setGoogleImages] = useState<LogoSearchImage[]>([]);
  const [googlePage, setGooglePage] = useState(0);
  const autoFillTokenKeyRef = useRef<string | null>(null);
  const localImageInputRef = useRef<HTMLInputElement | null>(null);
  const logoResolveSeqRef = useRef(0);
  const autoSellEnabledRef = useRef(autoSellEnabled);
  const autoSellRulesRef = useRef(autoSellRules);
  const flapQuoteTokens = useMemo(
    () => FlapQuoteTokensByChain[ChainId.BNB] ?? [],
    [],
  );
  const flapStocksPresetTokens = useMemo(
    () => getFlapStocksPresetTokens(ChainId.BNB),
    [],
  );
  const selectedFlapQuoteToken = useMemo(
    () => flapQuoteTokens.find((item) => item.id === flapQuoteTokenId) ?? flapQuoteTokens[0] ?? null,
    [flapQuoteTokenId, flapQuoteTokens],
  );
  const filteredFlapStockOptions = useMemo(() => {
    const keyword = flapStockSearch.trim().toLowerCase();
    if (!keyword) return [...flapStocksPresetTokens];
    return flapStocksPresetTokens.filter((token) => token.symbol.toLowerCase().includes(keyword));
  }, [flapStockSearch, flapStocksPresetTokens]);
  const isFlapPlatform = selectedPlatform === 'flap' || selectedPlatform === 'flap_stocks';
  const isFlapStocksTemplate = selectedPlatform === 'flap_stocks';
  const isFlapNativeQuote = selectedFlapQuoteToken?.isNative === true;

  const persistCookingConfig = (patch?: {
    selectedPlatform?: CookingLaunchPlatform;
    flapQuoteTokenId?: FlapPresetQuoteToken['id'];
    flapTaxMode?: FlapTaxMode;
    flapBuyTaxBps?: number;
    flapSellTaxBps?: number;
    flapCustomDividendTokenAddress?: string;
    flapSelectedStocks?: string[];
    deployWallet?: ChainAddress | null;
    defaultBuyBnb?: string;
    autoSellEnabled?: boolean;
    autoSellRules?: AutoSellRule[];
  }) => {
    try {
      const payload = {
        selectedPlatform: patch?.selectedPlatform ?? selectedPlatform,
        flapQuoteTokenId: patch?.flapQuoteTokenId ?? flapQuoteTokenId,
        flapTaxMode: patch?.flapTaxMode ?? flapTaxMode,
        flapBuyTaxBps: patch?.flapBuyTaxBps ?? flapBuyTaxBps,
        flapSellTaxBps: patch?.flapSellTaxBps ?? flapSellTaxBps,
        flapCustomDividendTokenAddress: patch?.flapCustomDividendTokenAddress ?? flapCustomDividendTokenAddress,
        flapSelectedStocks: patch?.flapSelectedStocks ?? flapSelectedStocks,
        deployWallet: (patch?.deployWallet ?? deployWallet) || undefined,
        defaultBuyBnb: patch?.defaultBuyBnb ?? defaultBuyBnb,
        autoSellEnabled: patch?.autoSellEnabled ?? autoSellEnabledRef.current,
        autoSellRules: patch?.autoSellRules ?? autoSellRulesRef.current,
      };
      window.localStorage.setItem(cookingConfigStorageKey, JSON.stringify(payload));
    } catch {
    }
  };

  useEffect(() => {
    if (!visible) {
      autoFillTokenKeyRef.current = null;
      return;
    }
    if (!siteInfo?.tokenAddress) return;
    const tokenKey = normalizeAddressKey(siteInfo.tokenAddress);
    const isNewToken = autoFillTokenKeyRef.current !== tokenKey;
    const nextLogo = pickFirstNonEmpty(currentTokenInfo?.logo);
    const nextName = pickFirstNonEmpty(currentTokenInfo?.name, currentTokenName);
    const nextSymbol = pickFirstNonEmpty(currentTokenInfo?.symbol, currentTokenSymbol);
    const nextTwitter = pickFirstNonEmpty(currentTokenInfo?.twitterUrl);
    const nextWebsite = pickFirstNonEmpty(currentTokenInfo?.website);
    const nextTelegram = pickFirstNonEmpty(currentTokenInfo?.telegramUrl);

    if (isNewToken) {
      setLogoUrl(nextLogo);
      setTokenNameInput(nextName);
      setTokenSymbolInput(nextSymbol);
      setTwitterInput(nextTwitter);
      setWebsiteInput(nextWebsite);
      setTelegramInput(nextTelegram);
      autoFillTokenKeyRef.current = tokenKey;
      return;
    }

    if (!logoUrl.trim() && nextLogo) setLogoUrl(nextLogo);
    if (!tokenNameInput.trim() && nextName) setTokenNameInput(nextName);
    if (!tokenSymbolInput.trim() && nextSymbol) setTokenSymbolInput(nextSymbol);
    if (!twitterInput.trim() && nextTwitter) setTwitterInput(nextTwitter);
    if (!websiteInput.trim() && nextWebsite) setWebsiteInput(nextWebsite);
    if (!telegramInput.trim() && nextTelegram) setTelegramInput(nextTelegram);
  }, [
    visible,
    siteInfo?.tokenAddress,
    currentTokenName,
    currentTokenSymbol,
    currentTokenInfo?.logo,
    currentTokenInfo?.name,
    currentTokenInfo?.symbol,
    currentTokenInfo?.twitterUrl,
    currentTokenInfo?.website,
    currentTokenInfo?.telegramUrl,
  ]);

  useEffect(() => {
    if (!deployWallet && activeWalletAddress) {
      setDeployWallet(activeWalletAddress);
      return;
    }
    if (!deployWallet && address) {
      setDeployWallet(address);
    }
  }, [address, activeWalletAddress, deployWallet]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(cookingConfigStorageKey);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        selectedPlatform?: CookingLaunchPlatform;
        flapQuoteTokenId?: FlapPresetQuoteToken['id'];
        flapTaxMode?: FlapTaxMode;
        flapBuyTaxBps?: number;
        flapSellTaxBps?: number;
        flapCustomDividendTokenAddress?: string;
        flapSelectedStocks?: string[];
        deployWallet?: string;
        defaultBuyBnb?: string;
        autoSellEnabled?: boolean;
        autoSellRules?: AutoSellRule[];
      };
      if (parsed.selectedPlatform === 'fourmeme' || parsed.selectedPlatform === 'flap' || parsed.selectedPlatform === 'flap_stocks') {
        setSelectedPlatform(parsed.selectedPlatform);
      }
      if (parsed.flapQuoteTokenId && flapQuoteTokens.some((item) => item.id === parsed.flapQuoteTokenId)) {
        setFlapQuoteTokenId(parsed.flapQuoteTokenId);
      }
      if (parsed.flapTaxMode === 'quote' || parsed.flapTaxMode === 'self' || parsed.flapTaxMode === 'custom' || parsed.flapTaxMode === 'stocks' || parsed.flapTaxMode === 'disabled') {
        setFlapTaxMode(parsed.flapTaxMode);
      }
      if (Number.isFinite(parsed.flapBuyTaxBps)) setFlapBuyTaxBps(Number(parsed.flapBuyTaxBps));
      if (Number.isFinite(parsed.flapSellTaxBps)) setFlapSellTaxBps(Number(parsed.flapSellTaxBps));
      if (typeof parsed.flapCustomDividendTokenAddress === 'string') setFlapCustomDividendTokenAddress(parsed.flapCustomDividendTokenAddress);
      if (Array.isArray(parsed.flapSelectedStocks)) {
        setFlapSelectedStocks(
          parsed.flapSelectedStocks
            .map((item) => String(item || '').trim().toUpperCase())
            .filter((item) => flapStocksPresetTokens.some((token) => token.symbol === item)),
        );
      }
      if (parsed.deployWallet) setDeployWallet(parsed.deployWallet as ChainAddress);
      if (typeof parsed.defaultBuyBnb === 'string') setDefaultBuyBnb(parsed.defaultBuyBnb);
      if (typeof parsed.autoSellEnabled === 'boolean') setAutoSellEnabled(parsed.autoSellEnabled);
      if (Array.isArray(parsed.autoSellRules) && parsed.autoSellRules.length > 0) {
        const nextRules = parsed.autoSellRules
          .map((x) => ({
            marketCapUsd: String(x?.marketCapUsd || '').trim(),
            sellPercent: String(x?.sellPercent || '').trim(),
          }))
          .filter((x) => x.marketCapUsd || x.sellPercent);
        if (nextRules.length > 0) setAutoSellRules(nextRules.slice(0, MAX_AUTO_SELL_RULES));
      }
    } catch {
    }
  }, [flapStocksPresetTokens]);

  useEffect(() => {
    if (selectedPlatform === 'flap_stocks') {
      if (flapTaxMode !== 'stocks') {
        setFlapTaxMode('stocks');
      }
      return;
    }
    if (flapTaxMode === 'stocks' || flapTaxMode === 'disabled') {
      setFlapTaxMode('quote');
    }
  }, [selectedPlatform, flapTaxMode]);

  useEffect(() => {
    autoSellEnabledRef.current = autoSellEnabled;
  }, [autoSellEnabled]);

  useEffect(() => {
    autoSellRulesRef.current = autoSellRules;
  }, [autoSellRules]);

  useEffect(() => {
    deployWalletRef.current = deployWallet;
  }, [deployWallet]);

  useEffect(() => {
    if (!visible || !isFlapPlatform) return;
    void call({ type: 'bg:prewarmFlapVanity' } as const).catch((error) => {
      console.warn('[cooking.flap.vanity_prewarm_failed]', error);
    });
  }, [visible, isFlapPlatform]);

  useEffect(() => {
    persistCookingConfig();
  }, [
    selectedPlatform,
    flapQuoteTokenId,
    flapTaxMode,
    flapBuyTaxBps,
    flapSellTaxBps,
    flapCustomDividendTokenAddress,
    flapSelectedStocks,
    deployWallet,
    defaultBuyBnb,
    autoSellEnabled,
    autoSellRules,
  ]);

  const selectedDeployWallet = useMemo(
    () => walletAccounts.find((acc) => acc.address.toLowerCase() === String(deployWallet || '').toLowerCase()) ?? null,
    [walletAccounts, deployWallet]
  );
  const lastLaunchWallet = useMemo(
    () => walletAccounts.find((acc) => acc.address.toLowerCase() === String(lastLaunch?.walletAddress || '').toLowerCase()) ?? null,
    [walletAccounts, lastLaunch?.walletAddress]
  );

  useEffect(() => {
    if (!visible || !lastLaunch?.tokenAddress || !lastLaunch?.walletAddress) {
      setLaunchBalanceWei('0');
      return;
    }
    let cancelled = false;
    const refreshBalance = async () => {
      try {
        const holding = await TokenAPI.getTokenHolding(
          siteInfo?.platform || 'gmgn',
          siteInfo?.chain || 'bsc',
          lastLaunch.walletAddress,
          lastLaunch.tokenAddress,
          { cacheTtlMs: 0 },
        );
        if (!cancelled) setLaunchBalanceWei(holding || '0');
      } catch {
        if (!cancelled) setLaunchBalanceWei('0');
      }
    };
    void refreshBalance();
    const timer = window.setInterval(() => {
      void refreshBalance();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [visible, lastLaunch?.tokenAddress, lastLaunch?.walletAddress, siteInfo?.platform, siteInfo?.chain]);

  const handleLaunchTokenSell = async (pct: number) => {
    if (!lastLaunch || launchSelling) return;
    if (!onSellLaunchedToken) {
      toast.error('卖出未接入');
      return;
    }
    const tokenAddress = lastLaunch.tokenAddress;
    const fromAddress = lastLaunch.walletAddress;
    const symbol = lastLaunch.symbol || '代币';
    const matchedTokenInfo = currentTokenInfo
      && currentTokenInfo.address.toLowerCase() === tokenAddress.toLowerCase()
      ? currentTokenInfo
      : null;
    setLaunchSelling(true);
    try {
      await onSellLaunchedToken({
        pct,
        tokenAddress,
        walletAddress: fromAddress,
        tokenSymbol: symbol,
        tokenInfo: matchedTokenInfo,
      });
    } finally {
      try {
        const nextHolding = await TokenAPI.getTokenHolding(
          siteInfo?.platform || 'gmgn',
          siteInfo?.chain || 'bsc',
          fromAddress,
          tokenAddress,
          { cacheTtlMs: 0 },
        );
        setLaunchBalanceWei(nextHolding || '0');
      } catch {
        // keep last displayed balance if refresh fails
      }
      setLaunchSelling(false);
    }
  };

  const clearImageAndTokenInputs = () => {
    setLogoUrl('');
    setResolvedLogoDataUrl('');
    setLogoResolving(false);
    setLogoResolveError(null);
    setGoogleQuery('');
    setGoogleImages([]);
    setGooglePage(0);
    setTokenSymbolInput('');
    setTokenNameInput('');
    setTwitterInput('');
    setWebsiteInput('');
    setTelegramInput('');
    if (localImageInputRef.current) {
      localImageInputRef.current.value = '';
    }
  };

  const handlePickLocalLogo = () => {
    localImageInputRef.current?.click();
  };

  const handleLocalLogoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件');
      e.currentTarget.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('图片不能超过 5MB');
      e.currentTarget.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        toast.error('读取本地图片失败');
        return;
      }
      setLogoUrl(dataUrl);
      setResolvedLogoDataUrl(dataUrl);
      setLogoResolving(false);
      setLogoResolveError(null);
      toast.success('本地图片已加载', { icon: '🖼️' });
    };
    reader.onerror = () => {
      toast.error('读取本地图片失败');
    };
    reader.readAsDataURL(file);
  };

  useEffect(() => {
    const raw = logoUrl.trim();
    const seq = logoResolveSeqRef.current + 1;
    logoResolveSeqRef.current = seq;
    if (!raw) {
      setResolvedLogoDataUrl('');
      setLogoResolving(false);
      setLogoResolveError(null);
      return;
    }
    if (/^data:image\//i.test(raw)) {
      setResolvedLogoDataUrl(raw);
      setLogoResolving(false);
      setLogoResolveError(null);
      return;
    }
    setLogoResolving(true);
    setLogoResolveError(null);
    const timer = window.setTimeout(() => {
      void resolveLogoUrlToDataUrl(raw)
        .then((dataUrl) => {
          if (logoResolveSeqRef.current !== seq) return;
          setResolvedLogoDataUrl(dataUrl);
          setLogoResolveError(null);
        })
        .catch((error: any) => {
          if (logoResolveSeqRef.current !== seq) return;
          setResolvedLogoDataUrl('');
          setLogoResolveError(String(error?.message || '图片预处理失败'));
        })
        .finally(() => {
          if (logoResolveSeqRef.current !== seq) return;
          setLogoResolving(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [logoUrl]);

  const updateAutoSellRule = (index: number, patch: Partial<AutoSellRule>) => {
    setAutoSellRules((list) => {
      const next = list.map((item, i) => (i === index ? { ...item, ...patch } : item));
      autoSellRulesRef.current = next;
      return next;
    });
  };

  const addAutoSellRule = () => {
    setAutoSellRules((list) => {
      if (list.length >= MAX_AUTO_SELL_RULES) return list;
      const next = [...list, { marketCapUsd: '', sellPercent: '' }];
      autoSellRulesRef.current = next;
      return next;
    });
  };

  const removeAutoSellRule = (index: number) => {
    setAutoSellRules((list) => {
      if (list.length <= 1) return list;
      const next = list.filter((_, i) => i !== index);
      autoSellRulesRef.current = next;
      return next;
    });
  };

  const handleSearchGoogleImages = async (nextPage = 0) => {
    const query = googleQuery.trim();
    if (!query) {
      toast.error('请输入搜索关键词');
      return;
    }
    try {
      setGoogleSearching(true);
      const res = await call({ type: 'google:imageSearch', query, page: nextPage } as const);
      setGooglePage(nextPage);
      setGoogleImages(Array.isArray(res.images) ? res.images : []);
      if (!res.images?.length) {
        toast('未找到图片，可换关键词重试', { icon: 'ℹ️' });
      }
    } catch (e: any) {
      toast.error(e?.message ? String(e.message) : 'Google 搜图失败');
    } finally {
      setGoogleSearching(false);
    }
  };

  const handleSearchTokenImages = async () => {
    const query = googleQuery.trim();
    if (!query) {
      toast.error('请输入搜索关键词');
      return;
    }
    try {
      setTokenSearching(true);
      const list = await GmgnAPI.searchTokens(query);
      const nextImages: LogoSearchImage[] = list
        .map((item) => {
          const tokenObj = (item as any)?.token || {};
          const logo = String(
            item?.logo ||
            tokenObj?.logo ||
            (item as any)?.image ||
            (item as any)?.icon ||
            (item as any)?.token_logo ||
            ''
          ).trim();
          if (!logo) return null;
          const symbol = String(item?.symbol || tokenObj?.symbol || '').trim();
          const name = String(item?.name || tokenObj?.name || '').trim();
          const address = String(item?.address || tokenObj?.address || tokenObj?.token_address || '').trim();
          const title = [symbol, name, address].filter(Boolean).join(' · ');
          return {
            url: logo,
            thumbnail: logo,
            title: title || logo,
            source: 'gmgn-token',
          } as LogoSearchImage;
        })
        .filter(Boolean) as LogoSearchImage[];
      setTokenImages(nextImages);
      if (!nextImages.length && list.length > 0) {
        toast('查到代币，但这些结果没有可用 logo', { icon: 'ℹ️' });
      } else if (!nextImages.length) {
        toast('未找到代币图片，可换关键词重试', { icon: 'ℹ️' });
      }
    } catch (e: any) {
      toast.error(e?.message ? String(e.message) : '代币图片搜索失败');
    } finally {
      setTokenSearching(false);
    }
  };

  const currentSearchImages = logoSearchTab === 'token' ? tokenImages : googleImages;
  const currentSearchLoading = logoSearchTab === 'token' ? tokenSearching : googleSearching;
  const handleSearchByActiveTab = () => {
    if (logoSearchTab === 'token') {
      void handleSearchTokenImages();
      return;
    }
    void handleSearchGoogleImages(0);
  };

  const toggleFlapStockSymbol = (symbol: string) => {
    setFlapSelectedStocks((list) => {
      if (list.includes(symbol)) {
        return list.filter((item) => item !== symbol);
      }
      if (list.length >= 10) {
        toast.error('最多选择 10 个币股模板');
        return list;
      }
      return [...list, symbol];
    });
  };

  const handleSubmitMemeForm = async () => {
    const symbol = tokenSymbolInput.trim();
    const name = tokenNameInput.trim();
    const img = resolvedLogoDataUrl.trim() || logoUrl.trim();
    if (!symbol || !name) {
      toast.error('请填写代币符号和名称');
      return;
    }
    if (!/^\S{1,20}$/u.test(symbol)) {
      toast.error('代币符号支持中文/英文/数字，长度 1-20，且不能包含空格');
      return;
    }
    if (!img) {
      toast.error('请先生成或填入 Logo 链接');
      return;
    }
    if (!deployWallet) {
      toast.error('请选择发币钱包');
      return;
    }
    if (selectedPlatform === 'flap_stocks' && flapSelectedStocks.length <= 0) {
      toast.error('币股模板至少选择 1 个币股');
      return;
    }
    if (selectedPlatform === 'flap' && flapTaxMode === 'custom' && !flapCustomDividendTokenAddress.trim()) {
      toast.error('请填写自定义分红代币地址');
      return;
    }
    try {
      const flowId = `cooking:${selectedPlatform}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 8)}`;
      const toastId = toast.loading(
        selectedPlatform === 'fourmeme' ? '正在创建 Fourmeme Token...' : '正在准备 Flap 发射...',
        { icon: '🔄' }
      );
      launchFlowIdRef.current = flowId;
      launchToastIdRef.current = String(toastId);
      setLaunching(true);
      pendingLaunchMetaRef.current = { name, symbol };
      const latestAutoSellEnabled = autoSellEnabledRef.current;
      const latestAutoSellRules = autoSellRulesRef.current;
      persistCookingConfig({
        autoSellEnabled: latestAutoSellEnabled,
        autoSellRules: latestAutoSellRules,
      });
      const descParts: string[] = [];
      if (twitterInput.trim()) descParts.push(`Twitter: ${twitterInput.trim()}`);
      if (websiteInput.trim()) descParts.push(`Website: ${websiteInput.trim()}`);
      if (telegramInput.trim()) descParts.push(`Telegram: ${telegramInput.trim()}`);
      if (defaultBuyBnb.trim()) descParts.push(`DefaultBuyBNB: ${defaultBuyBnb.trim()}`);
      if (latestAutoSellEnabled) descParts.push('AutoSellMode: marketCapTargets');
      if (selectedFlapQuoteToken) descParts.push(`FlapQuote: ${selectedFlapQuoteToken.label}`);
      if (isFlapPlatform) descParts.push(`FlapTaxMode: ${isFlapStocksTemplate ? 'stocks' : flapTaxMode}`);
      if (isFlapStocksTemplate && flapSelectedStocks.length > 0) descParts.push(`FlapStocks: ${flapSelectedStocks.join(',')}`);
      const desc = descParts.join(' | ');
      const autoSellPayload = {
        enabled: latestAutoSellEnabled,
        rules: latestAutoSellRules,
        quoteToken: selectedFlapQuoteToken?.label || 'BNB',
      };
      if (selectedPlatform === 'fourmeme') {
        const preSale = defaultBuyBnb.trim() || '0';
        const res = await call({
          type: 'token:createFourmeme',
          input: {
            name,
            shortName: symbol,
            desc,
            imgUrl: img,
            launchTime: Date.now(),
            label: 'Meme',
            lpTradingFee: 0.0025,
            webUrl: websiteInput.trim() || undefined,
            twitterUrl: twitterInput.trim() || undefined,
            telegramUrl: telegramInput.trim() || undefined,
            preSale,
            onlyMPC: false,
            feePlan: false,
            fromAddress: deployWallet,
            autoSell: autoSellPayload,
          },
        } as const);
        const data = (res as any)?.data;
        if (data && data.txHash) {
          const addr = data.tokenAddress as string | undefined;
          const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
          toast.success(
            addr ? `Meme Token 发币交易已发送，地址：${short}` : 'Meme Token 发币交易已发送',
            { id: toastId, icon: '✅' }
          );
          const nextLaunch = rememberLaunchToken({
            tokenAddress: addr,
            walletAddress: deployWallet,
            symbol,
            name,
          });
          if (nextLaunch) setLastLaunch(nextLaunch);
          if (addr) {
            const link = siteInfo
              ? parsePlatformTokenLink(siteInfo, addr)
              : `https://four.meme/zh-TW/token/${addr}`;
            if (link) {
              setTimeout(() => {
                navigateToUrl(link);
              }, 10);
            }
          }
        } else {
          toast.success('创建 Meme Token 参数已生成', { id: toastId, icon: '✅' });
        }
        autoSellNotifiedFlowIdsRef.current.add(flowId);
        if (latestAutoSellEnabled) {
          notifyCookingAutoSellResult((res as any)?.autoSell ?? null);
        }
        if (data) {
          console.log('Fourmeme create token response', data);
        }
      } else {
        const res = await call({
          type: 'token:createFlap',
          input: {
            name,
            symbol,
            desc,
            imgUrl: img,
            webUrl: websiteInput.trim() || undefined,
            twitterUrl: twitterInput.trim() || undefined,
            telegramUrl: telegramInput.trim() || undefined,
            launchFlowId: flowId,
            fromAddress: deployWallet,
            quoteTokenId: flapQuoteTokenId,
            quoteAmount: defaultBuyBnb.trim() || '0',
            taxMode: flapTaxMode,
            customDividendTokenAddress: flapTaxMode === 'custom'
              ? (flapCustomDividendTokenAddress.trim() as ChainAddress)
              : undefined,
            selectedStockSymbols: flapSelectedStocks,
            buyTaxRateBps: flapBuyTaxBps,
            sellTaxRateBps: flapSellTaxBps,
            autoSell: autoSellPayload,
          },
        } as const);
        const data = (res as any)?.data;
        if (data?.txHash) {
          const addr = data.tokenAddress as string | undefined;
          const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
          toast.success(
            addr ? `Flap 发射交易已发送，地址：${short}` : 'Flap 发射交易已发送',
            { id: toastId, icon: '✅' }
          );
          const nextLaunch = rememberLaunchToken({
            tokenAddress: addr,
            walletAddress: deployWallet,
            symbol,
            name,
          });
          if (nextLaunch) setLastLaunch(nextLaunch);
          if (!autoSellNotifiedFlowIdsRef.current.has(flowId)) {
            autoSellNotifiedFlowIdsRef.current.add(flowId);
            if (latestAutoSellEnabled) {
              notifyCookingAutoSellResult((res as any)?.autoSell ?? null);
            }
          }
          if (addr) {
            const link = (siteInfo ? parsePlatformTokenLink(siteInfo, addr) : '')
              || getCookingLaunchFallbackLink(selectedPlatform, addr);
            if (link) {
              setTimeout(() => {
                navigateToUrl(link);
              }, 10);
            }
          }
        } else {
          toast.success('Flap 发射参数已生成', { id: toastId, icon: '✅' });
        }
      }
      clearImageAndTokenInputs();
      setLaunching(false);
      launchFlowIdRef.current = null;
      launchToastIdRef.current = undefined;
    } catch (e: any) {
      const msg = e?.message
        ? String(e.message)
        : selectedPlatform === 'fourmeme'
          ? '创建 Meme Token 失败'
          : '创建 Flap Token 失败';
      if (msg.includes('Request timed out') && selectedPlatform !== 'fourmeme') {
        toast.loading('发射流程仍在后台继续，请按钱包弹窗完成后等待结果', {
          id: launchToastIdRef.current,
          icon: '⏳',
        });
        return;
      }
      const toastId = launchToastIdRef.current;
      setLaunching(false);
      launchFlowIdRef.current = null;
      launchToastIdRef.current = undefined;
      toast.error(msg, { id: toastId, icon: '❌' });
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <div
      className="fixed z-[2147483647]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="rounded-xl border border-zinc-800 bg-[#0F0F11] text-[12px] text-zinc-100 shadow-lg shadow-amber-500/40 flex flex-col"
        style={{ width: COOKING_PANEL_WIDTH, height: panelHeight }}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-grab"
          onPointerDown={(e) => {
            dragging.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: posRef.current.x,
              baseY: posRef.current.y,
            };
          }}
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
            <span>Cooking</span>
          </div>
          <button
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            关闭
          </button>
        </div>
        <div className="flex-1 p-3 space-y-3 overflow-y-auto dagobang-scrollbar">
          {tokenInfoLoading && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
              正在读取 tokenInfo...
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5">
            <div className="text-[12px] font-semibold text-sky-200">图片</div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">搜索图片</div>
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                  value={googleQuery}
                  onChange={(e) => setGoogleQuery(e.target.value)}
                  onFocus={() => setLogoSearchActive(true)}
                  onKeyDown={(e) => {
                    if ((e.key !== 'Enter' && e.code !== 'Enter') || (e.nativeEvent as any)?.isComposing) return;
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onKeyUp={(e) => {
                    if ((e.key !== 'Enter' && e.code !== 'Enter') || (e.nativeEvent as any)?.isComposing) return;
                    e.preventDefault();
                    e.stopPropagation();
                    handleSearchByActiveTab();
                  }}
                  placeholder="输入关键词搜索图片"
                />
                <button
                  type="button"
                  className="px-2 py-1 rounded-md border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500"
                  onClick={handleSearchByActiveTab}
                  disabled={currentSearchLoading}
                >
                  搜索
                </button>
                {logoSearchTab === 'google' && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded-md border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
                    onClick={() => handleSearchGoogleImages(googlePage + 1)}
                    disabled={googleSearching || !googleImages.length}
                  >
                    更多
                  </button>
                )}
              </div>
              {logoSearchActive && (
                <div className="flex items-center gap-2 text-[11px] text-zinc-300">
                  <button
                    type="button"
                    className={`rounded px-2 py-0.5 ${logoSearchTab === 'token' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                    onClick={() => setLogoSearchTab('token')}
                  >
                    代币
                  </button>
                  <button
                    type="button"
                    className={`rounded px-2 py-0.5 ${logoSearchTab === 'google' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                    onClick={() => setLogoSearchTab('google')}
                  >
                    Google
                  </button>
                </div>
              )}
              {currentSearchImages.length > 0 && (
                <div className="grid grid-cols-4 gap-2 max-h-40 overflow-auto pr-1">
                  {currentSearchImages.map((item, idx) => (
                    <button
                      key={`${item.url}-${idx}`}
                      type="button"
                      className="h-16 rounded-md overflow-hidden border border-zinc-800 hover:border-emerald-500"
                      onClick={() => {
                        setLogoUrl(item.url);
                      }}
                      title={item.title || item.url}
                    >
                      <img src={item.thumbnail || item.url} alt={item.title || 'img'} className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">Logo 链接</div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:border-zinc-500"
                  onClick={handlePickLocalLogo}
                >
                  上传本地图片
                </button>
                <input
                  ref={localImageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                  className="hidden"
                  onChange={handleLocalLogoChange}
                />
                <span className="text-[10px] text-zinc-500">支持 PNG/JPG/WEBP/GIF，≤5MB</span>
              </div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={logoUrl}
                onChange={(e) => setLogoUrl(e.target.value)}
                placeholder="可手动粘贴图片地址"
              />
              {(logoResolving || logoResolveError || resolvedLogoDataUrl) && (
                <div className={`text-[10px] ${logoResolveError ? 'text-amber-300' : 'text-zinc-500'}`}>
                  {logoResolving
                    ? '图片预处理中...'
                    : logoResolveError
                      ? `图片预处理失败，将在提交时回退原地址：${logoResolveError}`
                      : '图片已预处理，提交时可直接复用'}
                </div>
              )}
              {logoUrl && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="w-10 h-10 rounded-full border border-zinc-800 bg-zinc-950 overflow-hidden flex items-center justify-center">
                    <img src={logoUrl} alt="Logo" className="max-w-full max-h-full" />
                  </div>
                  <div className="text-[11px] text-zinc-500 break-all">
                    预览
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5">
            <div className="text-[12px] font-semibold text-violet-200">代币信息</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-[11px] text-zinc-400">代币符号</div>
                <input
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                  value={tokenSymbolInput}
                  onChange={(e) => setTokenSymbolInput(e.target.value)}
                  placeholder="如 DGB"
                />
              </div>
              <div className="space-y-1">
                <div className="text-[11px] text-zinc-400">代币名称</div>
                <input
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                  value={tokenNameInput}
                  onChange={(e) => setTokenNameInput(e.target.value)}
                  placeholder="如 Dagobang"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="text-[11px] text-zinc-400">推特</div>
                <input
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                  value={twitterInput}
                  onChange={(e) => setTwitterInput(e.target.value)}
                  placeholder="https://twitter.com/..."
                />
              </div>
              <div className="space-y-1">
                <div className="text-[11px] text-zinc-400">官网</div>
                <input
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                  value={websiteInput}
                  onChange={(e) => setWebsiteInput(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">电报</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={telegramInput}
                onChange={(e) => setTelegramInput(e.target.value)}
                placeholder="https://t.me/..."
              />
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 p-2.5">
            <div className="text-[12px] font-semibold text-fuchsia-200">平台</div>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'fourmeme', label: 'Four' },
                { value: 'flap', label: 'Flap' },
                { value: 'flap_stocks', label: 'Flap Stocks' },
              ] as const).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`rounded-md border px-2 py-2 text-[12px] font-medium transition ${getPlatformButtonClass(selectedPlatform === item.value)}`}
                  onClick={() => setSelectedPlatform(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {selectedPlatform === 'flap_stocks' && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
                币股模板先按官方 VaultPortal 路径做 fail-closed。当前版本支持预设与多选，不开放真正提交。
              </div>
            )}
          </div>

          {isFlapPlatform && (
            <div className="space-y-3 rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-2.5">
              <div className="text-[12px] font-semibold text-indigo-200">预设</div>

              <div className="space-y-1">
                <div className="text-[11px] text-zinc-400">底池币种</div>
                <div className="grid grid-cols-3 gap-2">
                  {flapQuoteTokens.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(flapQuoteTokenId === item.id)}`}
                      onClick={() => setFlapQuoteTokenId(item.id)}
                    >
                      <span className="flex items-center gap-1.5">
                        {renderFlapTokenAvatar(item)}
                        <span className="min-w-0 truncate">{item.label}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {!isFlapStocksTemplate ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-zinc-400">税收模式</div>
                    <div className="text-[10px] text-zinc-500">
                      当前默认按底池币种分红
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { value: 'quote', label: '按底池币种' },
                      { value: 'self', label: '本币' },
                      { value: 'custom', label: '自定义' },
                    ] as const).map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(flapTaxMode === item.value)}`}
                        onClick={() => setFlapTaxMode(item.value)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  {flapTaxMode === 'custom' && (
                    <input
                      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                      value={flapCustomDividendTokenAddress}
                      onChange={(e) => setFlapCustomDividendTokenAddress(e.target.value)}
                      placeholder="自定义分红代币地址"
                    />
                  )}
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-[11px] text-zinc-400">
                    <span className="flex items-center gap-1.5">
                      {flapTaxMode === 'quote' && selectedFlapQuoteToken
                        ? renderFlapTokenAvatar(selectedFlapQuoteToken)
                        : null}
                      <span>
                        当前分红代币：{flapTaxMode === 'quote'
                          ? selectedFlapQuoteToken?.label || '-'
                          : flapTaxMode === 'self'
                            ? '本币'
                            : flapCustomDividendTokenAddress.trim() || '待填写'}
                      </span>
                    </span>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] text-zinc-400">币股分红模板</div>
                    <div className="text-[10px] text-zinc-500">已选 {flapSelectedStocks.length}/10</div>
                  </div>
                  <input
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                    value={flapStockSearch}
                    onChange={(e) => setFlapStockSearch(e.target.value)}
                    placeholder="搜索币种符号"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    {filteredFlapStockOptions.map((token) => {
                      const active = flapSelectedStocks.includes(token.symbol);
                      return (
                        <button
                          key={token.address}
                          type="button"
                          className={`rounded-md border px-2 py-2 text-left text-[11px] transition ${getTaxChipClass(active)}`}
                          onClick={() => toggleFlapStockSymbol(token.symbol)}
                        >
                          <span className="flex items-center gap-2">
                            {renderFlapTokenAvatar(token, 'h-5 w-5')}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-zinc-100">{token.symbol}</span>
                              <span className="block text-[10px] text-zinc-500">
                                {(token.tags?.[0] || token.category).toUpperCase()}
                              </span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {flapSelectedStocks.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {flapSelectedStocks.map((symbol) => {
                        const token = flapStocksPresetTokens.find((item) => item.symbol === symbol);
                        return (
                          <button
                            key={symbol}
                            type="button"
                            className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200"
                            onClick={() => toggleFlapStockSymbol(symbol)}
                          >
                            <span className="flex items-center gap-1">
                              {token ? renderFlapTokenAvatar(token, 'h-3.5 w-3.5') : null}
                              <span>{symbol} ×</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                    <span>买入税率</span>
                    <span>{flapBuyTaxBps > 0 ? `${flapBuyTaxBps / 100}%` : '0%'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {FLAP_TAX_RATE_OPTIONS.map((bps) => (
                      <button
                        key={`buy-${bps}`}
                        type="button"
                        className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(flapBuyTaxBps === bps)}`}
                        onClick={() => setFlapBuyTaxBps((prev) => (prev === bps ? 0 : bps))}
                      >
                        {bps / 100}%
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-zinc-500">再次点击已选税率可取消，未选中即 0%</div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                    <span>卖出税率</span>
                    <span>{flapSellTaxBps > 0 ? `${flapSellTaxBps / 100}%` : '0%'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {FLAP_TAX_RATE_OPTIONS.map((bps) => (
                      <button
                        key={`sell-${bps}`}
                        type="button"
                        className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(flapSellTaxBps === bps)}`}
                        onClick={() => setFlapSellTaxBps((prev) => (prev === bps ? 0 : bps))}
                      >
                        {bps / 100}%
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-zinc-500">再次点击已选税率可取消，未选中即 0%</div>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5">
            <div className="text-[12px] font-semibold text-emerald-200">钱包 + 卖出设置</div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[12px] text-zinc-400">发币钱包（单选）</div>
                <WalletSelectorTrigger
                  walletSelectorOpen={deployWalletSelectorOpen}
                  walletSelectedCount={deployWallet ? 1 : 0}
                  walletTotalCount={walletAccounts.length}
                  onToggleWalletSelector={() => setDeployWalletSelectorOpen((v) => !v)}
                  title="选择发币钱包"
                />
              </div>
              <div className="text-[11px] text-zinc-500">
                {selectedDeployWallet
                  ? `已指定：${selectedDeployWallet.name || 'Wallet'} (${selectedDeployWallet.address.slice(0, 6)}...${selectedDeployWallet.address.slice(-4)})`
                  : `未指定，使用当前钱包${activeWalletAddress ? ` (${activeWalletAddress.slice(0, 6)}...${activeWalletAddress.slice(-4)})` : ''}`}
              </div>
              {deployWalletSelectorOpen ? (
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-1 dagobang-scrollbar">
                  {walletAccounts.map((acc) => {
                    const selected = String(deployWallet || '').toLowerCase() === acc.address.toLowerCase();
                    const isActive = !!activeWalletAddress && activeWalletAddress.toLowerCase() === acc.address.toLowerCase();
                    return (
                      <button
                        key={acc.address}
                        type="button"
                        className={`w-full rounded px-2 py-1 text-left text-[12px] ${selected ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-200 hover:bg-zinc-800'}`}
                        onClick={() => {
                          setDeployWallet(acc.address);
                          setDeployWalletSelectorOpen(false);
                        }}
                      >
                        {acc.name || 'Wallet'} {isActive ? '(当前)' : ''} ({acc.address.slice(0, 6)}...{acc.address.slice(-4)})
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">
                {isFlapPlatform ? (isFlapNativeQuote ? '初始注入金额' : '初始注入预算（BNB）') : '默认买入（发币钱包，BNB）'}
              </div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={defaultBuyBnb}
                onChange={(e) => setDefaultBuyBnb(e.target.value)}
                placeholder={isFlapPlatform ? '按 BNB 预算填写，例如 0.1' : undefined}
              />
              {isFlapPlatform && (
                <div className="text-[10px] text-zinc-500">
                  {isFlapNativeQuote
                    ? 'BNB 底池已按官方 Portal 路径接入，这里会写入 quoteAmt 和交易 value。'
                    : `非 BNB 底池会先用这里的 BNB 预算兑换 ${selectedFlapQuoteToken?.symbol || '底池币种'}，再自动授权并提交发射。`}
                </div>
              )}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-zinc-300">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSellEnabled}
                  onChange={(e) => {
                    autoSellEnabledRef.current = e.target.checked;
                    setAutoSellEnabled(e.target.checked);
                  }}
                />
                <span>自动卖出（按市值目标创建挂单）</span>
              </label>
            </div>

            {autoSellEnabled && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-[11px] text-zinc-400">市值目标配置（最多 5 条）</div>
                  <button
                    type="button"
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                    onClick={addAutoSellRule}
                    disabled={autoSellRules.length >= MAX_AUTO_SELL_RULES}
                  >
                    + 添加
                  </button>
                </div>
                <div className="space-y-1">
                  {autoSellRules.map((rule, idx) => (
                    <div key={idx} className="grid grid-cols-[44px_minmax(0,1fr)_minmax(0,88px)_24px] gap-2 items-center">
                      <div className="text-[11px] text-zinc-500">TP{idx + 1}</div>
                      <input
                        className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none"
                        value={rule.marketCapUsd}
                        onChange={(e) => updateAutoSellRule(idx, { marketCapUsd: e.target.value })}
                        placeholder="触发市值 USD"
                      />
                      <input
                        className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none"
                        value={rule.sellPercent}
                        onChange={(e) => updateAutoSellRule(idx, { sellPercent: e.target.value })}
                        placeholder="卖出%"
                      />
                      <button
                        type="button"
                        className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
                        onClick={() => removeAutoSellRule(idx)}
                        disabled={autoSellRules.length <= 1}
                        title="删除"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="border-t border-zinc-800 p-3">
          <button
            className="w-full rounded-md bg-emerald-500 text-[13px] font-semibold text-black py-2.5 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            type="button"
            onClick={handleSubmitMemeForm}
            disabled={launching}
          >
            {launching
              ? '发射处理中...'
              : selectedPlatform === 'fourmeme'
                ? '发布到 Four'
                : selectedPlatform === 'flap'
                  ? '发布到 Flap'
                  : '发布到 Flap Stocks'}
          </button>

          {lastLaunch ? (
            <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-rose-200">发币钱包快捷卖出</div>
                  <div className="truncate text-[11px] text-zinc-300">
                    {lastLaunch.symbol || lastLaunch.name || '新代币'}
                    <span className="ml-1 text-zinc-500">
                      {lastLaunch.tokenAddress.slice(0, 6)}...{lastLaunch.tokenAddress.slice(-4)}
                    </span>
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {lastLaunchWallet?.name || '发币钱包'}
                    {' '}
                    ({lastLaunch.walletAddress.slice(0, 6)}...{lastLaunch.walletAddress.slice(-4)})
                  </div>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-[10px] text-zinc-500 hover:text-zinc-300"
                  onClick={() => {
                    clearCookingLastLaunch();
                    setLastLaunch(null);
                    setLaunchBalanceWei('0');
                  }}
                >
                  关闭
                </button>
              </div>
              <div className="flex items-center justify-between text-[12px] text-zinc-200">
                <span>余额</span>
                <span>
                  {formatLaunchTokenBalance(launchBalanceWei)}
                  {' '}
                  <span className="text-amber-400">{lastLaunch.symbol || 'TOKEN'}</span>
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {[10, 20, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={launchSelling || launching || launchBalanceWei === '0'}
                    className="rounded border border-rose-500/30 bg-rose-500/10 py-1 text-center text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => {
                      void handleLaunchTokenSell(pct);
                    }}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-zinc-500">
                这里永远用发币钱包卖出，不会改快捷交易面板当前选中的钱包。
              </div>
            </div>
          ) : null}
        </div>
        <div
          className="flex shrink-0 cursor-ns-resize justify-center border-t border-zinc-800/60 px-4 py-1.5"
          onPointerDown={(e) => {
            e.stopPropagation();
            resizing.current = {
              startY: e.clientY,
              baseHeight: panelHeightRef.current,
            };
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const nextHeight = clampCookingPanelHeight(COOKING_PANEL_DEFAULT_HEIGHT, posRef.current.y);
            setPanelHeight(nextHeight);
            try {
              window.localStorage.setItem('dagobang_cooking_panel_height_v1', String(nextHeight));
            } catch {
            }
          }}
          title="拖动调整高度，双击恢复默认高度"
        >
          <div className="h-1 w-14 rounded-full bg-zinc-700/80" />
        </div>
      </div>
    </div>
  );
}
