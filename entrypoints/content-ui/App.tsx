import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { parseEther, zeroAddress } from 'viem';
import type { BgGetStateResponse, Settings, TradeSuccessSoundPreset } from '@/types/extention';
import type { TokenInfo, TokenStat } from '@/types/token';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { formatBroadcastProvider } from '@/utils/format';
import { parseCurrentUrl, parseCurrentUrlFull, type SiteInfo } from '@/utils/sites';
import { call } from '@/utils/messaging';
import { TokenAPI } from '@/hooks/TokenAPI';
import GmgnAPI from '@/hooks/GmgnAPI';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import { buildStrategySellOrderInputs, buildStrategyTrailingSellOrderInputs } from '@/services/limitOrders/advancedAutoSell';

import { CustomToaster } from './components/CustomToaster';
import { LimitTradePanel } from './components/LimitTradePanel';
import { XTradePanel } from './components/XTradePanel';
import { RpcPanel } from './components/RpcPanel';
import { DailyAnalysisPanel } from './components/DailyAnalysisPanel';
import { QuickTradePanel } from './components/QuickTradePanel';
import { FloatingToolbar } from './components/FloatingToolbar';

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
  const [nativeBalanceWei, setNativeBalanceWei] = useState<string>('0');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [pendingBuyTokenMinOutWei, setPendingBuyTokenMinOutWei] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draftBuyPresets, setDraftBuyPresets] = useState<string[]>([]);
  const [draftSellPresets, setDraftSellPresets] = useState<string[]>([]);
  const [tokenStat, setTokenStat] = useState<TokenStat | null>(null);
  const [tokenPriceUsd, setTokenPriceUsd] = useState<number | null>(null);
  const [marketCapDisplay, setMarketCapDisplay] = useState<string | null>(null);
  const [liquidityDisplay, setLiquidityDisplay] = useState<string | null>(null);
  const [pendingQuickBuy, setPendingQuickBuy] = useState<{ tokenAddress: string; amount: string } | null>(null);
  const [gmgnBuyEnabled, setGmgnBuyEnabled] = useState(false);
  const [gmgnSellEnabled, setGmgnSellEnabled] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const siteInfoRef = useRef<SiteInfo | null>(siteInfo);
  const pendingQuickBuyRef = useRef<{ tokenAddress: string; amount: string } | null>(pendingQuickBuy);
  const settingsRef = useRef<Settings | null>(null);
  const minimizedRef = useRef(false);
  const isEditingRef = useRef(false);
  const keyboardEnabledRef = useRef(false);
  const spaceHeldRef = useRef(false);
  const handleBuyRef = useRef<(amountStr: string) => void>(() => { });
  const handleSellRef = useRef<(pct: number) => void>(() => { });
  const prewarmedTurboRef = useRef<Set<string>>(new Set());
  const prewarmedRpcRef = useRef<Set<string>>(new Set());
  const fastPollingRef = useRef<any>(null);
  const tokenRefreshSeqRef = useRef(0);
  const deleteSoundPlayedAtRef = useRef<Record<string, number>>({});

  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
    const defaultY = 100;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const [showLimitTradePanel, setShowLimitTradePanel] = useState(false);
  const [showXTradePanel, setShowXTradePanel] = useState(false);
  const [showRpcPanel, setShowRpcPanel] = useState(false);
  const [showDailyAnalysisPanel, setShowDailyAnalysisPanel] = useState(false);
  const dragging = useRef<null | { target: 'main'; startX: number; startY: number; baseX: number; baseY: number }>(null);

  const isUnlocked = !!state?.wallet.isUnlocked;
  const settings: Settings | null = state?.settings ?? null;
  const address = state?.wallet.address ?? null;
  const locale: Locale = normalizeLocale(settings?.locale);
  const toastPosition = settings?.toastPosition ?? 'top-center';
  const keyboardShortcutsEnabled = !!settings?.keyboardShortcutsEnabled;
  const tokenBalancePollIntervalMs = settings?.tokenBalancePollIntervalMs ?? 2000;
  const tokenBalanceRefreshThrottleMs = Math.max(200, tokenBalancePollIntervalMs);
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
    minimizedRef.current = minimized;
    isEditingRef.current = isEditing;
    posRef.current = pos;
  }, [siteInfo, pendingQuickBuy, settings, minimized, isEditing, pos]);

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

  }, []);

  useEffect(() => {
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
  }, [showLimitTradePanel, showXTradePanel]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if ((el as any).isContentEditable) return true;
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
        const presets = s.chains[s.chainId]?.buyPresets ?? ['0.01', '0.2', '0.5', '1.0'];
        const amt = presets[idx];
        if (!amt) return;
        handleBuyRef.current(amt);
        return;
      }

      if (sellMap.includes(key)) {
        const s = settingsRef.current;
        if (!s) return;
        const idx = sellMap.indexOf(key);
        const presets = s.chains[s.chainId]?.sellPresets ?? ['10', '25', '50', '100'];
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
      setDraftBuyPresets(settings.chains[settings.chainId].buyPresets || ['0.01', '0.2', '0.5', '1.0']);
      setDraftSellPresets(settings.chains[settings.chainId].sellPresets || ['10', '25', '50', '100']);
      setPendingQuickBuy({ tokenAddress: addr.toLowerCase(), amount });
    };
    window.addEventListener('dagobang-quickbuy' as any, handler as any);
    return () => {
      window.removeEventListener('dagobang-quickbuy' as any, handler as any);
    };
  }, [settings]);

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

  const tokenAddressNormalized = useMemo(() => {
    if (!siteInfo?.tokenAddress) return null;
    const t = siteInfo.tokenAddress.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(t) ? (t as `0x${string}`) : null;
  }, [siteInfo]);
  const limitTradePanelOnlyOnTokenPage = settings?.ui?.limitTradePanelOnlyOnTokenPage ?? false;
  const limitTradePanelVisible = showLimitTradePanel && (!limitTradePanelOnlyOnTokenPage || !!tokenAddressNormalized);

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
    handleBuy(pendingQuickBuy.amount);
    setPendingQuickBuy(null);
  }, [pendingQuickBuy, tokenAddressNormalized, tokenInfo, settings]);

  useEffect(() => {
    if (!settings) return;
    const chainId = settings.chainId ?? 56;
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
  }, [settings]);

  useEffect(() => {
    if (!isUnlocked) return;
    if (!address) return;
    if (!settings) return;
    if (!tokenAddressNormalized) return;
    if (!tokenInfo) return;
    const chainId = settings.chainId ?? 56;
    const isTurbo = settings.chains[chainId]?.executionMode === 'turbo';
    if (!isTurbo) return;
    const key = `${chainId}:${address.toLowerCase()}:${tokenAddressNormalized.toLowerCase()}`;
    if (prewarmedTurboRef.current.has(key)) return;
    prewarmedTurboRef.current.add(key);
    void call({
      type: 'trade:prewarmTurbo',
      input: { chainId, tokenAddress: tokenAddressNormalized, tokenInfo: tokenInfo ?? undefined },
    } as const).catch(() => { });
  }, [isUnlocked, address, settings, tokenAddressNormalized, tokenInfo]);

  const formattedNativeBalance = useMemo(() => {
    if (!nativeBalanceWei) return '0.00';
    const val = BigInt(nativeBalanceWei);
    const whole = val / 10n ** 18n;
    const frac = (val % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
    return `${whole}.${frac}`;
  }, [nativeBalanceWei]);

  const formattedTokenBalance = useMemo(() => {
    if (!tokenBalanceWei || !tokenDecimals) return '0';
    const val = BigInt(tokenBalanceWei);
    // Simple formatting for display
    if (val === 0n) return '0';
    return val > 1000n ? (val / (10n ** BigInt(tokenDecimals))).toString() : '>0';
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

  const lastTokenPriceRefresh = useRef(0);
  const tokenPriceReqSeq = useRef(0);
  useEffect(() => {
    tokenPriceReqSeq.current += 1;
    setTokenPriceUsd(null);
  }, [tokenAddressNormalized, settings?.chainId, siteInfo?.platform]);
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

    const chainId = settings.chainId ?? 56;
    const tokenAddr = tokenAddressNormalized;
    const addrLower = tokenAddr.toLowerCase();
    const baseTokenInfo = tokenInfoOverride !== undefined ? tokenInfoOverride : tokenInfo;
    const safeTokenInfo = baseTokenInfo && (baseTokenInfo as any).address?.toLowerCase?.() === addrLower ? baseTokenInfo : null;
    const seq = tokenPriceReqSeq.current + 1;
    tokenPriceReqSeq.current = seq;
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

  async function refreshAll() {
    if (document.hidden) return;
    if (!siteInfo) return;
    const res = await call({ type: 'bg:getState' });
    setState(res);
    setError(null);
    if (res.wallet.isUnlocked && res.wallet.address) {
      const tokenBalanceWei = await TokenAPI.getBalance(siteInfo.platform, siteInfo.chain, res.wallet.address, zeroAddress, { cacheTtlMs: 2000 });
      setNativeBalanceWei(tokenBalanceWei ?? '0');
    } else {
      setNativeBalanceWei('0');
    }
  }

  const lastTokenRefresh = useRef(0);
  async function refreshToken(force = false) {
    const seq = tokenRefreshSeqRef.current;
    if (document.hidden && !force) return;
    if (!tokenAddressNormalized || !siteInfo) {
      setTokenInfo(null);
      setTokenSymbol(null);
      setTokenDecimals(null);
      setTokenBalanceWei('0');
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

    const reqCtxKey = `${siteInfo.platform ?? ''}:${siteInfo.chain ?? ''}:${tokenAddressNormalized ?? ''}`;
    try {
      const meta = await TokenAPI.getTokenInfo(siteInfo.platform, siteInfo.chain, tokenAddressNormalized);
      if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
      if (meta) {
        setTokenInfo(meta);
        setTokenSymbol(meta.symbol);
        setTokenDecimals(meta.decimals);

        if ((meta as any).tokenPrice) {
          const p = (meta as any).tokenPrice as { marketCap?: string; liquidity?: string };
          setMarketCapDisplay(p.marketCap ?? null);
          setLiquidityDisplay(p.liquidity ?? null);
        } else {
          setMarketCapDisplay(null);
          setLiquidityDisplay(null);
        }
      }

      if (isUnlocked && address) {
        const holding = await TokenAPI.getTokenHolding(siteInfo.platform, siteInfo.chain, address, tokenAddressNormalized, {
          cacheTtlMs: tokenBalanceRefreshThrottleMs,
        });
        if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
        setTokenBalanceWei(holding ?? '0');
      } else {
        setTokenBalanceWei('0');
      }

      await refreshTokenPrice(force, meta ?? null);
    } catch (e: any) {
      if (seq !== tokenRefreshSeqRef.current || reqCtxKey !== tokenContextKeyRef.current) return;
      setTokenSymbol(null);
      setTokenDecimals(null);
      setTokenBalanceWei('0');
      setTokenStat(null);
      setTokenPriceUsd(null);
      setMarketCapDisplay(null);
      setLiquidityDisplay(null);
      // Don't show error for token fetch to avoid noise
    }
  }

  useEffect(() => {
    if (!siteInfo) return;
    refreshAll();
    const timer = setInterval(refreshAll, 10000);
    return () => clearInterval(timer);
  }, [siteInfo]);

  // Listen for background state changes (immediate update)
  useEffect(() => {
    if (!siteInfo) return;
    const listener = (message: any) => {
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
        refreshAll();
        refreshToken();
        return;
      }
      if (message.type === 'bg:xsniper:buy') {
        const record = message?.record as any;
        const isDeleteTweetSell = record?.side === 'sell' && record?.tweetType === 'delete_post';
        if (isDeleteTweetSell) return;
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
      if (message.type === 'bg:tradeSuccess') {
        ensureTradeSuccessAudioReady();
        if (message?.side === 'buy') playTradeBuySound();
        else playTradeSellSound();
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
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
    refreshToken(true);
    const timer = setInterval(() => refreshToken(), tokenBalancePollIntervalMs);
    return () => clearInterval(timer);
  }, [tokenAddressNormalized, address, siteInfo, tokenBalancePollIntervalMs]);

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
      refreshAll();
      refreshToken(true); // force refresh
      if (count >= 15) {
        if (fastPollingRef.current) clearInterval(fastPollingRef.current);
        fastPollingRef.current = null;
      }
    }, 500);
  };

  const handleBuy = (amountStr: string) => {
    withBusy(async () => {
      if (!settings) throw new Error('Settings not ready');
      if (!tokenAddressNormalized) throw new Error('Invalid token');
      const amountIn = parseEther(amountStr);
      if (!amountIn) throw new Error('Invalid amount');
      if (BigInt(nativeBalanceWei || '0') < amountIn) throw new Error('Insufficient balance');
      ensureTradeSuccessAudioReady();
      const sym = tokenSymbol ?? '';
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: '🔄' });
      const startTime = Date.now();

      const mainTrade = (async () => {
        const res = await call({
          type: 'tx:buy',
          input: { chainId: settings.chainId, tokenAddress: tokenAddressNormalized, bnbAmountWei: amountIn.toString(), tokenInfo: tokenInfo ?? undefined },
        } as const);
        if (!res.ok) {
          const detail = res.revertReason || res.error?.shortMessage || res.error?.message;
          throw new Error(detail || 'Transaction failed');
        }
        const tokenMinOutWei = res.tokenMinOutWei ?? null;

        const elapsed = (Date.now() - startTime) / 1000;
        setTxHash(res.txHash);
        setPendingBuyTokenMinOutWei(tokenMinOutWei);
        const provider = formatBroadcastProvider(res.broadcastVia, res.broadcastUrl, res.isBundle);
        toast.success(t('contentUi.toast.buySuccessTime', locale, [sym, elapsed.toFixed(2), provider]), { id: toastId, icon: '✅' });

        if (tokenInfo) {
          void call({
            type: 'tx:approveMaxForSellIfNeeded',
            chainId: settings.chainId,
            tokenAddress: tokenAddressNormalized,
            tokenInfo: tokenInfo,
          } as const).catch(() => { });
        }

        await Promise.all([refreshToken(true), refreshAll()]);
        startFastPolling();

        const receipt = await call({
          type: 'tx:waitForReceipt',
          hash: res.txHash,
          chainId: settings.chainId
        });
        if (!receipt.ok) {
          const detail = receipt.revertReason || receipt.error?.shortMessage || receipt.error?.message;
          throw new Error(detail || 'Transaction failed');
        }
        toast.success(t('contentUi.toast.buyDone', locale, [sym, amountStr]), { icon: '✅' });
        setPendingBuyTokenMinOutWei(null);

        await Promise.all([refreshToken(true), refreshAll()]);

        try {
          const config = settings.advancedAutoSell;
          if (!config?.enabled) return;
          if (!siteInfo) return;
          if (!tokenInfo) return;
          const chainId = settings.chainId ?? 56;
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

          const mode = (config as any)?.trailingStop?.activationMode ?? 'after_last_take_profit';
          if (mode === 'immediate' && (config as any)?.trailingStop?.enabled) {
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

          if (!inputs.length) return;
          for (const input of inputs) {
            await call({
              type: 'limitOrder:create',
              input,
            } as const);
          }
          toast.success(`已创建自动卖出挂单 ${inputs.length} 个`, { icon: '✅' });
        } catch (e) {
          console.error('auto sell xsniper create orders failed', e);
        }
      })();

      let gmgnTrade: Promise<unknown> | null = null;
      if (gmgnBuyEnabled && siteInfo?.platform === 'gmgn') {
        gmgnTrade = (async () => {
          try {
            // await new Promise((resolve) => setTimeout(resolve, 300));
            await GmgnAPI.buyToken({
              tokenAddress: tokenAddressNormalized,
              amount: amountIn.toString(),
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

      if (!tokenDecimals) return;
      const chainId = settings.chainId;
      const isTurbo = settings.chains[chainId]?.executionMode === 'turbo';
      const bal = BigInt(tokenBalanceWei || '0');
      if (!isTurbo) {
        if (bal <= 0n) throw new Error('No balance');
      }
      let amountWei = bal > 0n ? (bal * BigInt(pct)) / 100n : 0n;
      const platform = tokenInfo?.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = !!tokenInfo?.launchpad && (platform.includes('fourmeme')) && tokenInfo.launchpad_status !== 1;
      if (!isTurbo && isInnerFourMeme && amountWei > 0n) {
        amountWei = (amountWei / 1000000000n) * 1000000000n;
      }
      if (!isTurbo && amountWei <= 0n) throw new Error('Invalid amount');

      if (tokenInfo) {
        const approveRes = await call({
          type: 'tx:approveMaxForSellIfNeeded',
          chainId: settings.chainId,
          tokenAddress: tokenAddressNormalized,
          tokenInfo,
        } as const);
        if (approveRes.txHash) {
          const receipt = await call({
            type: 'tx:waitForReceipt',
            hash: approveRes.txHash,
            chainId: settings.chainId
          } as const);
          if (!receipt.ok) {
            const detail = receipt.revertReason || receipt.error?.shortMessage || receipt.error?.message;
            throw new Error(detail || 'Transaction failed');
          }
        }
      }

      ensureTradeSuccessAudioReady();
      const sym = tokenSymbol ?? '';
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: '🔄' });
      const startTime = Date.now();

      const percentBps = Math.max(1, Math.min(10000, Math.floor(pct * 100)));
      const mainTrade = (async () => {
        const res = await call({
          type: 'tx:sell',
          input: {
            chainId,
            tokenAddress: tokenAddressNormalized,
            tokenAmountWei: isTurbo ? '0' : amountWei.toString(),
            sellPercentBps: isTurbo ? percentBps : undefined,
            expectedTokenInWei: isTurbo ? (pendingBuyTokenMinOutWei ?? undefined) : undefined,
            tokenInfo: tokenInfo ?? undefined
          },
        } as const);
        if (!res.ok) {
          const detail = res.revertReason || res.error?.shortMessage || res.error?.message;
          throw new Error(detail || 'Transaction failed');
        }

        const elapsed = (Date.now() - startTime) / 1000;
        setTxHash(res.txHash);
        const provider = formatBroadcastProvider(res.broadcastVia, res.broadcastUrl, res.isBundle);
        toast.success(t('contentUi.toast.sellSuccessTime', locale, [sym, elapsed.toFixed(2), provider]), { id: toastId, icon: '✅' });

        await Promise.all([refreshToken(true), refreshAll()]);
        startFastPolling();

        const receipt = await call({
          type: 'tx:waitForReceipt',
          hash: res.txHash,
          chainId: settings.chainId
        });
        if (!receipt.ok) {
          const detail = receipt.revertReason || receipt.error?.shortMessage || receipt.error?.message;
          throw new Error(detail || 'Transaction failed');
        }
        toast.success(t('contentUi.toast.sellDone', locale, [sym, pct]), { icon: '✅' });
        await Promise.all([refreshToken(true), refreshAll()]);
        setPendingBuyTokenMinOutWei(null);

        // Cancel limit order if exists
        if (percentBps === 10000) {
          await call({ type: 'limitOrder:cancelAll', chainId, tokenAddress: tokenAddressNormalized } as const);
        }
      })();

      let gmgnTrade: Promise<unknown> | null = null;
      if (gmgnSellEnabled && siteInfo?.platform === 'gmgn' && amountWei > 0n) {
        gmgnTrade = (async () => {
          try {
            await new Promise((resolve) => setTimeout(resolve, 200));
            await GmgnAPI.sellToken({
              tokenAddress: tokenAddressNormalized,
              amount: amountWei.toString(),
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
      const res = await call({
        type: 'tx:approveMaxForSellIfNeeded',
        chainId: settings.chainId,
        tokenAddress: tokenAddressNormalized,
        tokenInfo,
      } as const);
      if (res.txHash) {
        setTxHash(res.txHash);
      }
      toast.success(t('contentUi.toast.approveSubmitted', locale, [tokenSymbol ?? '']), { icon: '✅' });

      // Trigger immediate refresh and start fast polling
      await Promise.all([refreshToken(true), refreshAll()]);
      startFastPolling();
    });
  };

  const handleToggleBuyGas = () => {
    if (!settings) return;
    const chainId = settings.chainId;
    const currentChainSettings = settings.chains[chainId];
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
    }).then(refreshAll);
  };

  const handleToggleSellGas = () => {
    if (!settings) return;
    const chainId = settings.chainId;
    const currentChainSettings = settings.chains[chainId];
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
    }).then(refreshAll);
  };

  const handleToggleSlippage = () => {
    if (!settings) return;
    const chainId = settings.chainId;
    const currentChainSettings = settings.chains[chainId];
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
    }).then(refreshAll);
  };

  const handleToggleMode = () => {
    if (!settings) return;
    const chainId = settings.chainId;
    const currentChainSettings = settings.chains[chainId];
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
    }).then(refreshAll);
  };

  const handleEditToggle = () => {
    if (!isEditing) {
      // Start editing: initialize drafts
      if (settings) {
        const chainId = settings.chainId;
        setDraftBuyPresets(settings.chains[chainId].buyPresets || ['0.01', '0.2', '0.5', '1.0']);
        setDraftSellPresets(settings.chains[chainId].sellPresets || ['10', '25', '50', '100']);
      }
      setIsEditing(true);
    } else {
      // Stop editing: save drafts
      if (settings) {
        const chainId = settings.chainId;
        const currentChainSettings = settings.chains[chainId];
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
        }).then(refreshAll);
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

  const handleToggleXTradePanel = () => {
    if (!showXTradePanel) {
      setShowXTradePanel(true);
      return;
    }
    setShowXTradePanel(false);
  };

  const handleToggleKeyboardShortcuts = () => {
    if (!settings) return;
    const next = !keyboardShortcutsEnabled;
    if (!next && spaceHeldRef.current) {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    }
    call({ type: 'settings:set', settings: { ...settings, keyboardShortcutsEnabled: next } } as const).then(refreshAll);
  };

  return (
    <>
      <CustomToaster position={toastPosition} />

      {siteInfo && (
        <>
          {siteInfo.showBar ? (
            <FloatingToolbar
              siteInfo={siteInfo}
              settings={settings}
              onToggleXTrade={handleToggleXTradePanel}
              xTradeActive={showXTradePanel}
              onToggleLimitTrade={handleToggleLimitTradePanel}
              autotradeActive={limitTradePanelVisible}
              onToggleRpc={handleToggleRpcPanel}
              rpcActive={showRpcPanel}
              onToggleDailyAnalysis={handleToggleDailyAnalysisPanel}
              dailyAnalysisActive={showDailyAnalysisPanel}
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
              keyboardShortcutsEnabled={keyboardShortcutsEnabled}
              onToggleKeyboardShortcuts={handleToggleKeyboardShortcuts}
              formattedNativeBalance={formattedNativeBalance}
              busy={busy}
              isUnlocked={isUnlocked}
              onBuy={handleBuy}
              settings={settings}
              onToggleMode={handleToggleMode}
              onToggleBuyGas={handleToggleBuyGas}
              onToggleSellGas={handleToggleSellGas}
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
              tokenSymbol={tokenSymbol}
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
            settings={settings}
            isUnlocked={isUnlocked}
            address={address}
            formattedNativeBalance={formattedNativeBalance}
            formattedTokenBalance={formattedTokenBalance}
            tokenSymbol={tokenSymbol}
            tokenPrice={tokenPrice}
            tokenAddress={tokenAddressNormalized}
            tokenInfo={tokenInfo}
          />

          <RpcPanel
            visible={showRpcPanel}
            onVisibleChange={setShowRpcPanel}
            settings={settings}
            locale={locale}
          />

          <DailyAnalysisPanel
            visible={showDailyAnalysisPanel}
            onVisibleChange={setShowDailyAnalysisPanel}
            settings={settings}
            address={siteInfo?.walletAddress ?? address}
          />

          <XTradePanel
            siteInfo={siteInfo}
            visible={showXTradePanel}
            activeTab={'xmonitor'}
            onVisibleChange={setShowXTradePanel}
            settings={settings}
            isUnlocked={isUnlocked}
          />
        </>
      )}
    </>
  );
}
