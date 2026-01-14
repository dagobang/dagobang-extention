import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { CustomToaster } from './components/CustomToaster';
import { Header } from './components/Header';
import { BuySection } from './components/BuySection';
import { SellSection } from './components/SellSection';
import { Overlays } from './components/Overlays';
import { CookingPanel } from './components/CookingPanel';
import { AutotradePanel } from './components/AutotradePanel';
import { RpcPanel } from './components/RpcPanel';
import type { BgGetStateResponse, Settings } from '@/types/extention';
import { parseCurrentUrl, type SiteInfo } from '@/utils/sites';
import { call } from '@/utils/messaging';
import { parseEther, zeroAddress } from 'viem';
import { TokenAPI } from '@/hooks/TokenAPI';
import GmgnAPI from '@/hooks/GmgnAPI';
import { type TokenStat } from '@/types/token';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { Logo } from '@/components/Logo';

export default function App() {
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
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
  const [marketCapDisplay, setMarketCapDisplay] = useState<string | null>(null);
  const [liquidityDisplay, setLiquidityDisplay] = useState<string | null>(null);
  const [pendingQuickBuy, setPendingQuickBuy] = useState<{ tokenAddress: string; amount: string } | null>(null);
  const [gmgnBuyEnabled, setGmgnBuyEnabled] = useState(false);
  const [gmgnSellEnabled, setGmgnSellEnabled] = useState(false);

  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
    const defaultY = 100;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const [showCookingPanel, setShowCookingPanel] = useState(false);
  const [showAutotradePanel, setShowAutotradePanel] = useState(false);
  const [showRpcPanel, setShowRpcPanel] = useState(false);
  const dragging = useRef<null | { target: 'main'; startX: number; startY: number; baseX: number; baseY: number }>(null);

  const isUnlocked = !!state?.wallet.isUnlocked;
  const settings: Settings | null = state?.settings ?? null;
  const address = state?.wallet.address ?? null;
  const locale: Locale = normalizeLocale(settings?.locale);
  const toastPosition = settings?.toastPosition ?? 'top-center';

  useEffect(() => {
    if (settings) {
      (window as any).__DAGOBANG_SETTINGS__ = settings;
    }
  }, [settings]);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_content_ui_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 340));
      const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
      setPos({ x: clampedX, y: clampedY });
    } catch {
    }
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
    const check = async () => {
      if (pendingQuickBuy) return;
      const info = await parseCurrentUrl(window.location.href);
      if (info == null || (JSON.stringify(info) !== JSON.stringify(siteInfo))) {
        setSiteInfo(info);
      }
    };
    check();
    const timer = setInterval(check, 500);
    return () => clearInterval(timer);
  }, [siteInfo, pendingQuickBuy]);

  const tokenAddressNormalized = useMemo(() => {
    if (!siteInfo?.tokenAddress) return null;
    const t = siteInfo.tokenAddress.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(t) ? (t as `0x${string}`) : null;
  }, [siteInfo]);

  useEffect(() => {
    if (!pendingQuickBuy) return;
    if (!settings) return;
    if (!tokenAddressNormalized) return;
    if (!tokenInfo) return;
    if (tokenAddressNormalized.toLowerCase() !== pendingQuickBuy.tokenAddress) return;
    handleBuy(pendingQuickBuy.amount);
    setPendingQuickBuy(null);
  }, [pendingQuickBuy, tokenAddressNormalized, tokenInfo, settings]);

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
    if (tokenStat && Number.isFinite(tokenStat.price) && tokenStat.price > 0) {
      return tokenStat.price;
    }
    if (tokenInfo && typeof (tokenInfo as any).tokenPrice?.price === 'string') {
      const v = Number((tokenInfo as any).tokenPrice.price);
      if (Number.isFinite(v) && v > 0) return v;
    }
    return null;
  }, [tokenStat, tokenInfo]);

  const isGmgnPlatform = siteInfo?.platform === 'gmgn';

  const handleToggleGmgnBuy = () => {
    setGmgnBuyEnabled((v) => !v);
  };

  const handleToggleGmgnSell = () => {
    setGmgnSellEnabled((v) => !v);
  };

  async function refreshAll() {
    if (document.hidden) return;
    const res = await call({ type: 'bg:getState' });
    setState(res);
    setError(null);
    if (res.wallet.address) {
      const tokenBalanceWei = await TokenAPI.getBalance(siteInfo?.platform ?? '', siteInfo?.chain ?? '', res.wallet.address, zeroAddress);
      setNativeBalanceWei(tokenBalanceWei ?? '0');
    }
  }

  const lastTokenRefresh = useRef(0);
  async function refreshToken(force = false) {
    if (document.hidden && !force) return;
    if (!tokenAddressNormalized || !siteInfo) {
      setTokenInfo(null);
      setTokenSymbol(null);
      setTokenDecimals(null);
      setTokenBalanceWei('0');
      setTokenStat(null);
      setMarketCapDisplay(null);
      setLiquidityDisplay(null);
      return;
    }

    // Throttle: don't refresh if less than 2s passed, unless forced
    const now = Date.now();
    if (!force && now - lastTokenRefresh.current < 2000) return;
    lastTokenRefresh.current = now;

    try {
      const meta = await TokenAPI.getTokenInfo(siteInfo.platform, siteInfo.chain, tokenAddressNormalized);
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

      if (address) {
        const holding = await TokenAPI.getTokenHolding(siteInfo.platform, siteInfo.chain, address, tokenAddressNormalized);
        setTokenBalanceWei(holding ?? '0');
      }
    } catch (e: any) {
      setTokenSymbol(null);
      setTokenDecimals(null);
      setTokenBalanceWei('0');
      setTokenStat(null);
      setMarketCapDisplay(null);
      setLiquidityDisplay(null);
      // Don't show error for token fetch to avoid noise
    }
  }

  useEffect(() => {
    refreshAll();
    const timer = setInterval(refreshAll, 5000);
    return () => clearInterval(timer);
  }, []);

  // Listen for background state changes (immediate update)
  useEffect(() => {
    const listener = (message: any) => {
      if (message.type === 'bg:stateChanged') {
        refreshAll();
        refreshToken(true);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [address, tokenAddressNormalized]);

  useEffect(() => {
    if (!tokenAddressNormalized || !siteInfo || !address) return;
    refreshToken(true);
  }, [tokenAddressNormalized, siteInfo, address]);

  useEffect(() => {
    refreshToken();
    const timer = setInterval(() => refreshToken(), 5000);
    return () => clearInterval(timer);
  }, [tokenAddressNormalized, address]);

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
        return raw;
      })();
      setError(message);
      toast.error(message, { icon: '❌' });
    }
  }

  const fastPollingRef = useRef<any>(null);

  const startFastPolling = () => {
    if (fastPollingRef.current) clearInterval(fastPollingRef.current);

    // Poll every 300ms for 9s to catch balance updates
    let count = 0;
    fastPollingRef.current = setInterval(() => {
      count++;
      refreshAll();
      refreshToken(true); // force refresh
      if (count >= 30) {
        if (fastPollingRef.current) clearInterval(fastPollingRef.current);
        fastPollingRef.current = null;
      }
    }, 300);
  };

  const handleBuy = (amountStr: string) => {
    withBusy(async () => {
      if (!settings) throw new Error('Settings not ready');
      if (!tokenAddressNormalized) throw new Error('Invalid token');
      const amountIn = parseEther(amountStr);
      if (!amountIn) throw new Error('Invalid amount');
      if (BigInt(nativeBalanceWei || '0') < amountIn) throw new Error('Insufficient balance');

      const sym = tokenSymbol ?? '';
      const toastId = toast.loading(t('contentUi.toast.trading', locale, [sym]), { icon: '🔄' });
      const startTime = Date.now();

      const mainTrade = (async () => {
        const res = await call({
          type: 'tx:buy',
          input: { chainId: settings.chainId, tokenAddress: tokenAddressNormalized, bnbAmountWei: amountIn.toString(), tokenInfo: tokenInfo ?? undefined },
        } as const);

        const elapsed = (Date.now() - startTime) / 1000;
        setTxHash(res.txHash);
        setPendingBuyTokenMinOutWei(res.tokenMinOutWei ?? null);
        toast.success(t('contentUi.toast.buySuccessTime', locale, [sym, elapsed.toFixed(2)]), { id: toastId, icon: '✅' });

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
        if (!receipt.ok) throw new Error('Transaction failed');
        toast.success(t('contentUi.toast.buyDone', locale, [sym, amountStr]), { icon: '✅' });
        setPendingBuyTokenMinOutWei(null);

        await Promise.all([refreshToken(true), refreshAll()]);
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
      } else {
        const pending = BigInt(pendingBuyTokenMinOutWei || '0');
        if (bal <= 0n && pending <= 0n) throw new Error('No balance');
      }
      const amountWei = bal > 0n ? (bal * BigInt(pct)) / 100n : 0n;

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

        const elapsed = (Date.now() - startTime) / 1000;
        setTxHash(res.txHash);
        toast.success(t('contentUi.toast.sellSuccessTime', locale, [sym, elapsed.toFixed(2)]), { id: toastId, icon: '✅' });

        await Promise.all([refreshToken(true), refreshAll()]);
        startFastPolling();

        const receipt = await call({
          type: 'tx:waitForReceipt',
          hash: res.txHash,
          chainId: settings.chainId
        });
        if (!receipt.ok) throw new Error('Transaction failed');
        toast.success(t('contentUi.toast.sellDone', locale, [sym, pct]), { icon: '✅' });
        await Promise.all([refreshToken(true), refreshAll()]);
        setPendingBuyTokenMinOutWei(null);
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

  const handleToggleAntiMev = () => {
    if (!settings) return;
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
            antiMev: !currentChainSettings.antiMev,
          },
        },
      },
    }).then(refreshAll);
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

  const handleUnlock = () => {
    call({ type: 'bg:openPopup' });
  };

  const handleToggleCookingPanel = () => {
    setShowCookingPanel((v) => !v);
  };

  const handleToggleAutotradePanel = () => {
    setShowAutotradePanel((v) => !v);
  };

  const handleToggleRpcPanel = () => {
    setShowRpcPanel((v) => !v);
  };

  return (
    <>
      <CustomToaster position={toastPosition} />

      {siteInfo && (
        <>
          {minimized ? (
            <div
              className="fixed z-[2147483647] flex cursor-pointer items-center justify-center rounded-full bg-zinc-900 p-3 shadow-xl border border-zinc-700 hover:border-zinc-500 transition-colors"
              style={{ left: pos.x, top: pos.y }}
              onPointerDown={(e) => {
                dragging.current = {
                  target: 'main',
                  startX: e.clientX,
                  startY: e.clientY,
                  baseX: posRef.current.x,
                  baseY: posRef.current.y,
                };
              }}
              onClick={() => {
                if (!dragging.current) setMinimized(false);
              }}
            >
              <Logo />
            </div>
          ) : (
            <div
              className="fixed z-[2147483647] w-[300px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/50 font-sans flex flex-col"
              style={{ left: pos.x, top: pos.y }}
            >
              <Header
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
                onToggleCooking={handleToggleCookingPanel}
                cookingActive={showCookingPanel}
                onToggleAutotrade={handleToggleAutotradePanel}
                autotradeActive={showAutotradePanel}
                onToggleRpc={handleToggleRpcPanel}
                rpcActive={showRpcPanel}
              />
              <div className="relative flex flex-col">
                <BuySection
                  formattedNativeBalance={formattedNativeBalance}
                  busy={busy}
                  isUnlocked={isUnlocked}
                  onBuy={handleBuy}
                  settings={settings}
                  onToggleMode={handleToggleMode}
                  onToggleGas={handleToggleBuyGas}
                  onToggleSlippage={handleToggleSlippage}
                  isEditing={isEditing}
                  onUpdatePreset={handleUpdateBuyPreset}
                  draftPresets={draftBuyPresets}
                  locale={locale}
                  gmgnVisible={false} //isGmgnPlatform
                  gmgnEnabled={gmgnBuyEnabled}
                  onToggleGmgn={handleToggleGmgnBuy}
                />

                <div className="h-px bg-zinc-800 mx-3"></div>

                <SellSection
                  formattedTokenBalance={formattedTokenBalance}
                  tokenSymbol={tokenSymbol}
                  busy={busy}
                  isUnlocked={isUnlocked}
                  onSell={handleSell}
                  settings={settings}
                  onToggleMode={handleToggleMode}
                  onToggleGas={handleToggleSellGas}
                  onToggleSlippage={handleToggleSlippage}
                  onApprove={handleApprove}
                  isEditing={isEditing}
                  onUpdatePreset={handleUpdateSellPreset}
                  draftPresets={draftSellPresets}
                  locale={locale}
                  gmgnVisible={false} // isGmgnPlatform
                  gmgnEnabled={gmgnSellEnabled}
                  onToggleGmgn={handleToggleGmgnSell}
                />

                <Overlays
                  siteInfo={siteInfo}
                  isUnlocked={isUnlocked}
                  onUnlock={handleUnlock}
                  locale={locale}
                />
              </div>
            </div>
          )}

          {/* <CookingPanel
            visible={showCookingPanel}
            onVisibleChange={setShowCookingPanel}
            address={address}
            seedreamApiKey={settings?.seedreamApiKey ?? ''}
          />

          <AutotradePanel
            visible={showAutotradePanel}
            onVisibleChange={setShowAutotradePanel}
            settings={settings}
            isUnlocked={isUnlocked}
            address={address}
          /> */}

          <RpcPanel
            visible={showRpcPanel}
            onVisibleChange={setShowRpcPanel}
            settings={settings}
            locale={locale}
          />
        </>
      )}
    </>
  );
}
