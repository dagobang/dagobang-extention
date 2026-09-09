import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import toast from 'react-hot-toast';
import { getAddress, isAddress } from 'viem';
import { browser } from 'wxt/browser';
import type { ChainAddress } from '@/types/chain/address';
import { ChainId } from '@/constants/chains/chainId';
import {
  FLAP_CUSTOM_QUOTE_ID,
  FlapQuoteTokensByChain,
  getFlapStocksPresetTokens,
  toFlapPresetFromCustom,
  type FlapCustomQuoteToken,
  type FlapPresetQuoteToken,
} from '@/constants/flap';
import { OPENFOUR_4STOCK_MODE, OPENFOUR_4STOCK_TEMPLATE, type OpenFourLaunchMode } from '@/constants/openfour';
import GmgnAPI from '@/hooks/GmgnAPI';
import { TokenAPI } from '@/hooks/TokenAPI';
import { call } from '@/utils/messaging';
import { navigateToUrl, parsePlatformTokenLink } from '@/utils/sites';
import { normalizeAddressKey } from '@/services/xSniper/engine/metrics';
import {
  clearCookingLastLaunch,
  readCookingLastLaunch,
  type CookingLastLaunch,
} from '@/utils/cookingLaunchWallets';
import {
  COOKING_CONFIG_STORAGE_KEY,
  COOKING_PANEL_DEFAULT_HEIGHT,
  COOKING_PANEL_WIDTH,
  MAX_AUTO_SELL_RULES,
} from './constants';
import { FlapPresetSection } from './FlapPresetSection';
import { LaunchFooter } from './LaunchFooter';
import { LogoSearchSection } from './LogoSearchSection';
import { OpenFourPresetSection } from './OpenFourPresetSection';
import { PlatformSelector } from './PlatformSelector';
import { TokenMetaForm } from './TokenMetaForm';
import { WalletSellSection } from './WalletSellSection';
import {
  clampCookingPanelHeight,
  clampCookingPanelPos,
  getCookingLaunchFallbackLink,
  isCookingLaunchPlatform,
  pickFirstNonEmpty,
  rememberLaunchToken,
  resolveLogoUrlToDataUrl,
} from './helpers';
import type {
  AutoSellRule,
  CookingLaunchPlatform,
  CookingPanelProps,
  LogoSearchImage,
  LogoSearchTab,
  OpenFourTaxAlloc,
} from './types';
import { OPENFOUR_DEFAULT_TAX_ALLOC, sumOpenFourTaxAlloc } from './types';

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
          const platform = isCookingLaunchPlatform(message?.platform) ? message.platform : 'flap';
          const link = (siteInfo ? parsePlatformTokenLink(siteInfo, addr) : '')
            || getCookingLaunchFallbackLink(platform, addr);
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
  const [tokenDescInput, setTokenDescInput] = useState('');
  const [twitterInput, setTwitterInput] = useState('');
  const [websiteInput, setWebsiteInput] = useState('');
  const [telegramInput, setTelegramInput] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState<CookingLaunchPlatform>('fourmeme');
  const [openFourMode, setOpenFourMode] = useState<OpenFourLaunchMode>(OPENFOUR_4STOCK_MODE);
  const [openFourAntiSniperEnabled, setOpenFourAntiSniperEnabled] = useState(true);
  const [openFourTaxEnabled, setOpenFourTaxEnabled] = useState(true);
  const [openFourBuyTaxBps, setOpenFourBuyTaxBps] = useState(100);
  const [openFourSellTaxBps, setOpenFourSellTaxBps] = useState(100);
  const [openFourTaxAlloc, setOpenFourTaxAlloc] = useState<OpenFourTaxAlloc>(OPENFOUR_DEFAULT_TAX_ALLOC);
  const [flapQuoteTokenId, setFlapQuoteTokenId] = useState<FlapPresetQuoteToken['id']>('bnb');
  const [flapCustomQuoteAddress, setFlapCustomQuoteAddress] = useState('');
  const [flapCustomQuoteToken, setFlapCustomQuoteToken] = useState<FlapCustomQuoteToken | null>(null);
  const [flapCustomQuoteChecking, setFlapCustomQuoteChecking] = useState(false);
  const [flapCustomQuoteError, setFlapCustomQuoteError] = useState<string | null>(null);
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
  const selectedFlapQuoteToken = useMemo(() => {
    if (flapQuoteTokenId === FLAP_CUSTOM_QUOTE_ID) {
      return flapCustomQuoteToken ? toFlapPresetFromCustom(flapCustomQuoteToken) : null;
    }
    return flapQuoteTokens.find((item) => item.id === flapQuoteTokenId) ?? flapQuoteTokens[0] ?? null;
  }, [flapQuoteTokenId, flapQuoteTokens, flapCustomQuoteToken]);
  const filteredFlapStockOptions = useMemo(() => {
    const keyword = flapStockSearch.trim().toLowerCase();
    if (!keyword) return [...flapStocksPresetTokens];
    return flapStocksPresetTokens.filter((token) => token.symbol.toLowerCase().includes(keyword));
  }, [flapStockSearch, flapStocksPresetTokens]);
  const isFlapPlatform = selectedPlatform === 'flap' || selectedPlatform === 'flap_stocks';
  const isFlapStocksTemplate = selectedPlatform === 'flap_stocks';
  const isOpenFourPlatform = selectedPlatform === 'openfour';
  const isFlapNativeQuote = selectedFlapQuoteToken?.isNative === true;
  const openFourTemplate = OPENFOUR_4STOCK_TEMPLATE;

  const persistCookingConfig = (patch?: {
    selectedPlatform?: CookingLaunchPlatform;
    openFourMode?: OpenFourLaunchMode;
    openFourAntiSniperEnabled?: boolean;
    openFourTaxEnabled?: boolean;
    openFourBuyTaxBps?: number;
    openFourSellTaxBps?: number;
    openFourTaxAlloc?: OpenFourTaxAlloc;
    flapQuoteTokenId?: FlapPresetQuoteToken['id'];
    flapCustomQuoteAddress?: string;
    flapCustomQuoteToken?: FlapCustomQuoteToken | null;
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
        openFourMode: patch?.openFourMode ?? openFourMode,
        openFourAntiSniperEnabled: patch?.openFourAntiSniperEnabled ?? openFourAntiSniperEnabled,
        openFourTaxEnabled: patch?.openFourTaxEnabled ?? openFourTaxEnabled,
        openFourBuyTaxBps: patch?.openFourBuyTaxBps ?? openFourBuyTaxBps,
        openFourSellTaxBps: patch?.openFourSellTaxBps ?? openFourSellTaxBps,
        openFourTaxAlloc: patch?.openFourTaxAlloc ?? openFourTaxAlloc,
        flapQuoteTokenId: patch?.flapQuoteTokenId ?? flapQuoteTokenId,
        flapCustomQuoteAddress: patch?.flapCustomQuoteAddress ?? flapCustomQuoteAddress,
        flapCustomQuoteToken: patch?.flapCustomQuoteToken === undefined
          ? flapCustomQuoteToken
          : patch.flapCustomQuoteToken,
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
      window.localStorage.setItem(COOKING_CONFIG_STORAGE_KEY, JSON.stringify(payload));
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
    const nextDesc = pickFirstNonEmpty(currentTokenInfo?.description);

    if (isNewToken) {
      setLogoUrl(nextLogo);
      setTokenNameInput(nextName);
      setTokenSymbolInput(nextSymbol);
      setTokenDescInput(nextDesc);
      setTwitterInput(nextTwitter);
      setWebsiteInput(nextWebsite);
      setTelegramInput(nextTelegram);
      autoFillTokenKeyRef.current = tokenKey;
      return;
    }

    if (!logoUrl.trim() && nextLogo) setLogoUrl(nextLogo);
    if (!tokenNameInput.trim() && nextName) setTokenNameInput(nextName);
    if (!tokenSymbolInput.trim() && nextSymbol) setTokenSymbolInput(nextSymbol);
    if (!tokenDescInput.trim() && nextDesc) setTokenDescInput(nextDesc);
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
    currentTokenInfo?.description,
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
      const stored = window.localStorage.getItem(COOKING_CONFIG_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        selectedPlatform?: CookingLaunchPlatform;
        openFourMode?: OpenFourLaunchMode;
        openFourAntiSniperEnabled?: boolean;
        openFourTaxEnabled?: boolean;
        openFourBuyTaxBps?: number;
        openFourSellTaxBps?: number;
        openFourTaxAlloc?: OpenFourTaxAlloc;
        flapQuoteTokenId?: FlapPresetQuoteToken['id'];
        flapCustomQuoteAddress?: string;
        flapCustomQuoteToken?: FlapCustomQuoteToken | null;
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
      if (isCookingLaunchPlatform(parsed.selectedPlatform)) {
        setSelectedPlatform(parsed.selectedPlatform);
      }
      if (parsed.openFourMode === OPENFOUR_4STOCK_MODE) {
        setOpenFourMode(parsed.openFourMode);
      }
      if (typeof parsed.openFourAntiSniperEnabled === 'boolean') setOpenFourAntiSniperEnabled(parsed.openFourAntiSniperEnabled);
      if (typeof parsed.openFourTaxEnabled === 'boolean') setOpenFourTaxEnabled(parsed.openFourTaxEnabled);
      if (Number.isFinite(parsed.openFourBuyTaxBps)) setOpenFourBuyTaxBps(Number(parsed.openFourBuyTaxBps));
      if (Number.isFinite(parsed.openFourSellTaxBps)) setOpenFourSellTaxBps(Number(parsed.openFourSellTaxBps));
      if (parsed.openFourTaxAlloc && typeof parsed.openFourTaxAlloc === 'object') {
        setOpenFourTaxAlloc({
          founder: Number(parsed.openFourTaxAlloc.founder) || 0,
          burn: Number(parsed.openFourTaxAlloc.burn) || 0,
          holder: Number(parsed.openFourTaxAlloc.holder) || 0,
          liquidity: Number(parsed.openFourTaxAlloc.liquidity) || 0,
        });
      }
      if (typeof parsed.flapCustomQuoteAddress === 'string') {
        setFlapCustomQuoteAddress(parsed.flapCustomQuoteAddress);
      }
      if (
        parsed.flapCustomQuoteToken
        && isAddress(parsed.flapCustomQuoteToken.address)
        && Number(parsed.flapCustomQuoteToken.decimals) > 0
      ) {
        setFlapCustomQuoteToken({
          address: getAddress(parsed.flapCustomQuoteToken.address),
          symbol: String(parsed.flapCustomQuoteToken.symbol || ''),
          name: String(parsed.flapCustomQuoteToken.name || parsed.flapCustomQuoteToken.symbol || ''),
          decimals: Number(parsed.flapCustomQuoteToken.decimals),
          iconSrc: parsed.flapCustomQuoteToken.iconSrc || undefined,
        });
      }
      if (parsed.flapQuoteTokenId === FLAP_CUSTOM_QUOTE_ID) {
        setFlapQuoteTokenId(FLAP_CUSTOM_QUOTE_ID);
      } else if (parsed.flapQuoteTokenId && flapQuoteTokens.some((item) => item.id === parsed.flapQuoteTokenId)) {
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
    openFourMode,
    openFourAntiSniperEnabled,
    openFourTaxEnabled,
    openFourBuyTaxBps,
    openFourSellTaxBps,
    openFourTaxAlloc,
    flapQuoteTokenId,
    flapCustomQuoteAddress,
    flapCustomQuoteToken,
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
    setTokenDescInput('');
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

  const handleCheckCustomQuote = async () => {
    const raw = flapCustomQuoteAddress.trim();
    if (!isAddress(raw)) {
      setFlapCustomQuoteError('请输入有效的 ERC20 合约地址');
      setFlapCustomQuoteToken(null);
      return;
    }
    setFlapCustomQuoteChecking(true);
    setFlapCustomQuoteError(null);
    try {
      const result = await GmgnAPI.checkFlapQuoteSupport('bsc', raw);
      if (!result.supported || !result.symbol || result.decimals <= 0) {
        setFlapCustomQuoteToken(null);
        setFlapCustomQuoteError('该代币暂不支持作为 Flap 底池');
        return;
      }
      let iconSrc: string | undefined;
      try {
        const info = await GmgnAPI.getTokenInfo('bsc', raw);
        iconSrc = info?.logo || undefined;
      } catch {
      }
      setFlapCustomQuoteToken({
        address: getAddress(raw),
        symbol: result.symbol,
        name: result.name || result.symbol,
        decimals: result.decimals,
        iconSrc,
      });
      setFlapQuoteTokenId(FLAP_CUSTOM_QUOTE_ID);
    } catch (error: any) {
      setFlapCustomQuoteToken(null);
      setFlapCustomQuoteError(String(error?.message || '校验失败'));
    } finally {
      setFlapCustomQuoteChecking(false);
    }
  };

  const handleClearCustomQuote = () => {
    setFlapCustomQuoteToken(null);
    setFlapCustomQuoteAddress('');
    setFlapCustomQuoteError(null);
    setFlapQuoteTokenId(FLAP_CUSTOM_QUOTE_ID);
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
    if (isOpenFourPlatform && !tokenDescInput.trim()) {
      toast.error('OpenFour 需要填写代币描述');
      return;
    }
    if (isOpenFourPlatform && openFourTaxEnabled) {
      if (openFourSellTaxBps < 100) {
        toast.error('OpenFour 开启税收后，卖出税率至少 1%');
        return;
      }
      if (sumOpenFourTaxAlloc(openFourTaxAlloc) !== 100) {
        toast.error('税费分配总和必须为 100%');
        return;
      }
    }
    if (selectedPlatform === 'flap_stocks' && flapSelectedStocks.length <= 0) {
      toast.error('币股模板至少选择 1 个币股');
      return;
    }
    if (isFlapPlatform && flapQuoteTokenId === FLAP_CUSTOM_QUOTE_ID && !flapCustomQuoteToken) {
      toast.error('请先校验自定义底池代币');
      return;
    }
    if (selectedPlatform === 'flap' && flapTaxMode === 'custom' && !flapCustomDividendTokenAddress.trim()) {
      toast.error('请填写自定义分红代币地址');
      return;
    }
    try {
      const flowId = `cooking:${selectedPlatform}:${Date.now().toString(36)}:${Math.random().toString(16).slice(2, 8)}`;
      const toastId = toast.loading(
        selectedPlatform === 'fourmeme'
          ? '正在创建 Fourmeme Token...'
          : selectedPlatform === 'openfour'
            ? '正在准备 OpenFour 发射...'
            : '正在准备 Flap 发射...',
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
      if (isOpenFourPlatform && tokenDescInput.trim()) descParts.push(tokenDescInput.trim());
      if (twitterInput.trim()) descParts.push(`Twitter: ${twitterInput.trim()}`);
      if (websiteInput.trim()) descParts.push(`Website: ${websiteInput.trim()}`);
      if (telegramInput.trim()) descParts.push(`Telegram: ${telegramInput.trim()}`);
      if (defaultBuyBnb.trim()) descParts.push(`DefaultBuyBNB: ${defaultBuyBnb.trim()}`);
      if (latestAutoSellEnabled) descParts.push('AutoSellMode: marketCapTargets');
      if (selectedFlapQuoteToken) descParts.push(`FlapQuote: ${selectedFlapQuoteToken.label}`);
      if (isFlapPlatform) descParts.push(`FlapTaxMode: ${isFlapStocksTemplate ? 'stocks' : flapTaxMode}`);
      if (isFlapStocksTemplate && flapSelectedStocks.length > 0) descParts.push(`FlapStocks: ${flapSelectedStocks.join(',')}`);
      if (isOpenFourPlatform) {
        descParts.push(`OpenFourMode: ${openFourMode}`);
        descParts.push(`AntiSniper: ${openFourAntiSniperEnabled ? 'on' : 'off'}`);
        descParts.push(openFourTaxEnabled
          ? `OpenFourTax: ${openFourBuyTaxBps / 100}/${openFourSellTaxBps / 100} founder${openFourTaxAlloc.founder}/burn${openFourTaxAlloc.burn}/holder${openFourTaxAlloc.holder}/lp${openFourTaxAlloc.liquidity}`
          : 'OpenFourTax: off');
      }
      const desc = descParts.join(' | ');
      const autoSellPayload = {
        enabled: latestAutoSellEnabled,
        rules: latestAutoSellRules,
        quoteToken: isOpenFourPlatform
          ? (openFourTemplate?.quoteSymbol || 'BNC4')
          : (selectedFlapQuoteToken?.label || 'BNB'),
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
      } else if (selectedPlatform === 'openfour') {
        const res = await call({
          type: 'token:createOpenFour',
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
            mode: openFourMode,
            quoteAmount: defaultBuyBnb.trim() || '0',
            antiSniperEnabled: openFourAntiSniperEnabled,
            taxEnabled: openFourTaxEnabled,
            buyTaxBps: openFourBuyTaxBps,
            sellTaxBps: openFourSellTaxBps,
            taxAlloc: openFourTaxAlloc,
            autoSell: autoSellPayload,
          },
        } as const);
        const data = (res as any)?.data;
        if (data?.txHash) {
          const addr = data.tokenAddress as string | undefined;
          const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';
          toast.success(
            addr ? `OpenFour 发射交易已发送，地址：${short}` : 'OpenFour 发射交易已发送',
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
              || getCookingLaunchFallbackLink('openfour', addr);
            if (link) {
              setTimeout(() => {
                navigateToUrl(link);
              }, 10);
            }
          }
        } else {
          toast.success('OpenFour 发射参数已生成', { id: toastId, icon: '✅' });
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
            customQuoteToken: flapQuoteTokenId === FLAP_CUSTOM_QUOTE_ID && flapCustomQuoteToken
              ? flapCustomQuoteToken
              : undefined,
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
          : selectedPlatform === 'openfour'
            ? '创建 OpenFour Token 失败'
            : '创建 Flap Token 失败';
      if (msg.includes('Request timed out') && selectedPlatform !== 'fourmeme') {
        toast.loading('发射流程仍在后台继续，请按钱包弹窗完成后等待结果', {
          id: launchToastIdRef.current,
          icon: '⏳',
        });
        return;
      }
      if (!launchFlowIdRef.current) {
        setLaunching(false);
        return;
      }
      const toastId = launchToastIdRef.current;
      setLaunching(false);
      launchFlowIdRef.current = null;
      launchToastIdRef.current = undefined;
      toast.error(msg, { id: toastId, icon: '❌' });
    }
  };

  const buyAmountLabel = isOpenFourPlatform
    ? '初始注入预算（BNB）'
    : isFlapPlatform
      ? (isFlapNativeQuote ? '初始注入金额' : '初始注入预算（BNB）')
      : '默认买入（发币钱包，BNB）';
  const buyAmountHint = isOpenFourPlatform
    ? `非 BNB 募集会先用这里的 BNB 预算兑换 ${openFourTemplate?.quoteSymbol || 'BNC4'}，再授权 OpenFour Core 并提交 createToken。`
    : isFlapPlatform
      ? (isFlapNativeQuote
        ? 'BNB 底池已按官方 Portal 路径接入，这里会写入 quoteAmt 和交易 value。'
        : `非 BNB 底池会先用这里的 BNB 预算兑换 ${selectedFlapQuoteToken?.symbol || '底池币种'}，再自动授权并提交发射。`)
      : undefined;

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

          <LogoSearchSection
            googleQuery={googleQuery}
            onGoogleQueryChange={setGoogleQuery}
            logoSearchActive={logoSearchActive}
            onLogoSearchFocus={() => setLogoSearchActive(true)}
            logoSearchTab={logoSearchTab}
            onLogoSearchTabChange={setLogoSearchTab}
            currentSearchImages={currentSearchImages}
            currentSearchLoading={currentSearchLoading}
            googleSearching={googleSearching}
            googleImagesLength={googleImages.length}
            googlePage={googlePage}
            onSearchByActiveTab={handleSearchByActiveTab}
            onSearchGoogleMore={(page) => void handleSearchGoogleImages(page)}
            onPickLocalLogo={handlePickLocalLogo}
            localImageInputRef={localImageInputRef}
            onLocalLogoChange={handleLocalLogoChange}
            logoUrl={logoUrl}
            onLogoUrlChange={setLogoUrl}
            logoResolving={logoResolving}
            logoResolveError={logoResolveError}
            resolvedLogoDataUrl={resolvedLogoDataUrl}
            onSelectImage={setLogoUrl}
          />

          <TokenMetaForm
            isOpenFour={isOpenFourPlatform}
            tokenSymbolInput={tokenSymbolInput}
            onTokenSymbolChange={setTokenSymbolInput}
            tokenNameInput={tokenNameInput}
            onTokenNameChange={setTokenNameInput}
            tokenDescInput={tokenDescInput}
            onTokenDescChange={setTokenDescInput}
            twitterInput={twitterInput}
            onTwitterChange={setTwitterInput}
            websiteInput={websiteInput}
            onWebsiteChange={setWebsiteInput}
            telegramInput={telegramInput}
            onTelegramChange={setTelegramInput}
          />

          <PlatformSelector
            selectedPlatform={selectedPlatform}
            onSelectPlatform={setSelectedPlatform}
          />

          {isOpenFourPlatform && (
            <OpenFourPresetSection
              mode={openFourMode}
              onModeChange={setOpenFourMode}
              template={openFourTemplate}
              antiSniperEnabled={openFourAntiSniperEnabled}
              onAntiSniperEnabledChange={setOpenFourAntiSniperEnabled}
              taxEnabled={openFourTaxEnabled}
              onTaxEnabledChange={(enabled) => {
                setOpenFourTaxEnabled(enabled);
                if (enabled && openFourBuyTaxBps <= 0 && openFourSellTaxBps <= 0) {
                  setOpenFourBuyTaxBps(100);
                  setOpenFourSellTaxBps(100);
                }
                if (enabled && sumOpenFourTaxAlloc(openFourTaxAlloc) !== 100) {
                  setOpenFourTaxAlloc(OPENFOUR_DEFAULT_TAX_ALLOC);
                }
              }}
              buyTaxBps={openFourBuyTaxBps}
              sellTaxBps={openFourSellTaxBps}
              onBuyTaxBpsChange={(bps) => setOpenFourBuyTaxBps((prev) => (prev === bps ? 0 : bps))}
              onSellTaxBpsChange={(bps) => setOpenFourSellTaxBps((prev) => (prev === bps ? 0 : bps))}
              taxAlloc={openFourTaxAlloc}
              onTaxAllocChange={(patch) => setOpenFourTaxAlloc((prev) => ({ ...prev, ...patch }))}
            />
          )}

          {isFlapPlatform && (
            <FlapPresetSection
              isFlapStocksTemplate={isFlapStocksTemplate}
              flapQuoteTokens={flapQuoteTokens}
              flapQuoteTokenId={flapQuoteTokenId}
              onFlapQuoteTokenIdChange={setFlapQuoteTokenId}
              selectedFlapQuoteToken={selectedFlapQuoteToken}
              flapCustomQuoteAddress={flapCustomQuoteAddress}
              onFlapCustomQuoteAddressChange={(value) => {
                setFlapCustomQuoteAddress(value);
                setFlapCustomQuoteError(null);
              }}
              flapCustomQuoteToken={flapCustomQuoteToken}
              flapCustomQuoteChecking={flapCustomQuoteChecking}
              flapCustomQuoteError={flapCustomQuoteError}
              onCheckCustomQuote={() => { void handleCheckCustomQuote(); }}
              onClearCustomQuote={handleClearCustomQuote}
              flapTaxMode={flapTaxMode}
              onFlapTaxModeChange={setFlapTaxMode}
              flapCustomDividendTokenAddress={flapCustomDividendTokenAddress}
              onFlapCustomDividendTokenAddressChange={setFlapCustomDividendTokenAddress}
              flapStockSearch={flapStockSearch}
              onFlapStockSearchChange={setFlapStockSearch}
              filteredFlapStockOptions={filteredFlapStockOptions}
              flapSelectedStocks={flapSelectedStocks}
              flapStocksPresetTokens={flapStocksPresetTokens}
              onToggleFlapStockSymbol={toggleFlapStockSymbol}
              flapBuyTaxBps={flapBuyTaxBps}
              onFlapBuyTaxBpsChange={(bps) => setFlapBuyTaxBps((prev) => (prev === bps ? 0 : bps))}
              flapSellTaxBps={flapSellTaxBps}
              onFlapSellTaxBpsChange={(bps) => setFlapSellTaxBps((prev) => (prev === bps ? 0 : bps))}
            />
          )}

          <WalletSellSection
            walletAccounts={walletAccounts}
            deployWallet={deployWallet}
            onDeployWalletChange={(next) => {
              setDeployWallet(next);
              setDeployWalletSelectorOpen(false);
            }}
            deployWalletSelectorOpen={deployWalletSelectorOpen}
            onToggleDeployWalletSelector={() => setDeployWalletSelectorOpen((v) => !v)}
            selectedDeployWallet={selectedDeployWallet}
            activeWalletAddress={activeWalletAddress}
            defaultBuyBnb={defaultBuyBnb}
            onDefaultBuyBnbChange={setDefaultBuyBnb}
            buyAmountLabel={buyAmountLabel}
            buyAmountHint={buyAmountHint}
            autoSellEnabled={autoSellEnabled}
            onAutoSellEnabledChange={(checked) => {
              autoSellEnabledRef.current = checked;
              setAutoSellEnabled(checked);
            }}
            autoSellRules={autoSellRules}
            onAddAutoSellRule={addAutoSellRule}
            onRemoveAutoSellRule={removeAutoSellRule}
            onUpdateAutoSellRule={updateAutoSellRule}
          />
        </div>
        <LaunchFooter
          launching={launching}
          selectedPlatform={selectedPlatform}
          onSubmit={() => void handleSubmitMemeForm()}
          lastLaunch={lastLaunch}
          lastLaunchWallet={lastLaunchWallet}
          launchBalanceWei={launchBalanceWei}
          launchSelling={launchSelling}
          onSellPercent={(pct) => void handleLaunchTokenSell(pct)}
          onClearLastLaunch={() => {
            clearCookingLastLaunch();
            setLastLaunch(null);
            setLaunchBalanceWei('0');
          }}
        />
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
