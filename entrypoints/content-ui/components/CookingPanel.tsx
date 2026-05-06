import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import toast from 'react-hot-toast';
import { call } from '@/utils/messaging';
import type { Account } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';
import { WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';
import GmgnAPI from '@/hooks/GmgnAPI';

type CookingPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  address: string | null;
  seedreamApiKey: string;
  walletAccounts: Account[];
  activeWalletAddress: `0x${string}` | null;
  siteInfo: SiteInfo | null;
  currentTokenName?: string | null;
  currentTokenSymbol?: string | null;
};

function clampCookingPanelPos(pos: { x: number; y: number }) {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  const clampedX = Math.min(Math.max(0, pos.x), Math.max(0, width - 340));
  const clampedY = Math.min(Math.max(0, pos.y), Math.max(0, height - 80));
  return { x: clampedX, y: clampedY };
}

export function CookingPanel({
  visible,
  onVisibleChange,
  address,
  seedreamApiKey,
  walletAccounts,
  activeWalletAddress,
  siteInfo,
  currentTokenName,
  currentTokenSymbol,
}: CookingPanelProps) {
  type LogoSearchImage = { url: string; thumbnail?: string; title?: string; source?: string };
  type LogoSearchTab = 'token' | 'google';
  const cookingConfigStorageKey = 'dagobang_cooking_config_v1';
  const DEFAULT_TOKEN_SUPPLY = 1_000_000_000;
  const MAX_AUTO_SELL_RULES = 5;
  type AutoSellRule = { marketCapUsd: string; sellPercent: string };
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
    const defaultY = 360;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_cooking_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      setPos(clampCookingPanelPos(parsed));
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const nextX = dragging.current.baseX + dx;
      const nextY = dragging.current.baseY + dy;
      setPos(clampCookingPanelPos({ x: nextX, y: nextY }));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const key = 'dagobang_cooking_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(clampCookingPanelPos(posRef.current)));
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

  const [logoPrompt, setLogoPrompt] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [logoLoading, setLogoLoading] = useState(false);
  const [tokenSymbolInput, setTokenSymbolInput] = useState('');
  const [tokenNameInput, setTokenNameInput] = useState('');
  const [twitterInput, setTwitterInput] = useState('');
  const [websiteInput, setWebsiteInput] = useState('');
  const [telegramInput, setTelegramInput] = useState('');
  const [deployWallet, setDeployWallet] = useState<`0x${string}` | null>(null);
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
  const autoSellEnabledRef = useRef(autoSellEnabled);
  const autoSellRulesRef = useRef(autoSellRules);

  const persistCookingConfig = (patch?: {
    deployWallet?: `0x${string}` | null;
    defaultBuyBnb?: string;
    autoSellEnabled?: boolean;
    autoSellRules?: AutoSellRule[];
  }) => {
    try {
      const payload = {
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
    const tokenKey = siteInfo.tokenAddress.toLowerCase();
    if (autoFillTokenKeyRef.current === tokenKey) return;
    if (!tokenNameInput.trim() && currentTokenName?.trim()) {
      setTokenNameInput(currentTokenName.trim());
    }
    if (!tokenSymbolInput.trim() && currentTokenSymbol?.trim()) {
      setTokenSymbolInput(currentTokenSymbol.trim());
    }
    autoFillTokenKeyRef.current = tokenKey;
  }, [visible, siteInfo?.tokenAddress, currentTokenName, currentTokenSymbol]);

  useEffect(() => {
    if (!deployWallet && activeWalletAddress) {
      setDeployWallet(activeWalletAddress);
      return;
    }
    if (!deployWallet && address) {
      setDeployWallet(address as `0x${string}`);
    }
  }, [address, activeWalletAddress, deployWallet]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(cookingConfigStorageKey);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        deployWallet?: string;
        defaultBuyBnb?: string;
        autoSellEnabled?: boolean;
        autoSellRules?: AutoSellRule[];
      };
      if (parsed.deployWallet) setDeployWallet(parsed.deployWallet as `0x${string}`);
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
  }, []);

  useEffect(() => {
    autoSellEnabledRef.current = autoSellEnabled;
  }, [autoSellEnabled]);

  useEffect(() => {
    autoSellRulesRef.current = autoSellRules;
  }, [autoSellRules]);

  useEffect(() => {
    persistCookingConfig();
  }, [deployWallet, defaultBuyBnb, autoSellEnabled, autoSellRules]);

  const selectedDeployWallet = useMemo(
    () => walletAccounts.find((acc) => acc.address.toLowerCase() === String(deployWallet || '').toLowerCase()) ?? null,
    [walletAccounts, deployWallet]
  );

  const clearImageAndTokenInputs = () => {
    setLogoPrompt('');
    setLogoUrl('');
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
      toast.success('本地图片已加载', { icon: '🖼️' });
    };
    reader.onerror = () => {
      toast.error('读取本地图片失败');
    };
    reader.readAsDataURL(file);
  };

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

  const handleGenerateLogo = async () => {
    const prompt = logoPrompt.trim();
    const apiKey = seedreamApiKey.trim();
    if (!prompt) {
      toast.error('请输入提示词');
      return;
    }
    if (!apiKey) {
      toast.error('请先在设置里配置 Seedream API Key');
      return;
    }
    try {
      setLogoLoading(true);
      const res = await call({ type: 'ai:generateLogo', prompt, size: '2K', apiKey });
      setLogoUrl(res.imageUrl);
      toast.success('Logo 生成成功', { icon: '✅' });
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : 'Logo 生成失败';
      toast.error(msg, { icon: '❌' });
    } finally {
      setLogoLoading(false);
    }
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

  const handleSubmitMemeForm = async () => {
    const symbol = tokenSymbolInput.trim();
    const name = tokenNameInput.trim();
    const img = logoUrl.trim();
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
    try {
      const toastId = toast.loading('正在创建 Meme Token...', { icon: '🔄' });
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
      const desc = descParts.join(' | ');
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
      if (latestAutoSellEnabled && data?.tokenAddress) {
        const tokenAddress = String(data.tokenAddress) as `0x${string}`;
        const normalizedRules = latestAutoSellRules
          .map((rule) => ({
            marketCapUsd: Number(String(rule.marketCapUsd || '').trim()),
            sellPercent: Number(String(rule.sellPercent || '').trim()),
          }))
          .filter((rule) =>
            Number.isFinite(rule.marketCapUsd)
            && rule.marketCapUsd > 0
            && Number.isFinite(rule.sellPercent)
            && rule.sellPercent > 0
            && rule.sellPercent <= 100
          );
        if (normalizedRules.length <= 0) {
          toast.error('自动卖出已开启，但没有有效的市值目标配置');
        } else {
          const tokenInfoForOrder: TokenInfo = {
            chain: 'bsc',
            address: tokenAddress,
            name,
            symbol,
            decimals: 18,
            logo: img,
            launchpad: 'fourmeme',
            launchpad_progress: 0,
            launchpad_platform: 'fourmeme',
            launchpad_status: 0,
            quote_token: 'BNB',
            tokenPrice: {
              price: '0',
              marketCap: '0',
              timestamp: Date.now(),
            },
          };
          const sellWallets = [deployWallet];
          const orderInputs = sellWallets.flatMap((wallet) =>
            normalizedRules.map((rule) => ({
              chainId: 56,
              tokenAddress,
              fromAddress: wallet,
              tokenSymbol: symbol,
              side: 'sell' as const,
              orderType: 'take_profit_sell' as const,
              triggerPriceUsd: rule.marketCapUsd / DEFAULT_TOKEN_SUPPLY,
              targetChangePercent: 0,
              sellPercentBps: Math.round(rule.sellPercent * 100),
              tokenInfo: tokenInfoForOrder,
            }))
          );
          const createResults = await Promise.allSettled(
            orderInputs.map((input) => call({ type: 'limitOrder:create', input } as const))
          );
          const okCount = createResults.filter((x) => x.status === 'fulfilled').length;
          toast.success(`自动卖出挂单已创建 ${okCount}/${orderInputs.length}`, { icon: '🧾' });
        }
      }
      if (data) {
        console.log('Fourmeme create token response', data);
      }
      clearImageAndTokenInputs();
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : '创建 Meme Token 失败';
      toast.error(msg, { icon: '❌' });
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
      <div className="w-[360px] h-[700px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-amber-500/40 text-[12px] flex flex-col">
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
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-300">
            平台：Fourmeme（当前仅支持）
          </div>

          <div className="space-y-2 rounded-lg border border-sky-500/25 bg-sky-500/5 p-2.5">
            <div className="text-[12px] font-semibold text-sky-200">图片</div>
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">提示词（生成 Logo）</div>
              <textarea
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none resize-none h-16"
                value={logoPrompt}
                onChange={(e) => setLogoPrompt(e.target.value)}
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="px-3 py-1 rounded-md bg-amber-500 text-[11px] font-semibold text-black hover:bg-amber-400 disabled:opacity-50"
                  onClick={handleGenerateLogo}
                  disabled={logoLoading}
                >
                  {logoLoading ? '生成中…' : '生成 Logo'}
                </button>
                <div className="text-[10px] text-zinc-500">
                  Seedream API Key 请在设置页配置
                </div>
              </div>
            </div>

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
              <div className="text-[11px] text-zinc-400">默认买入（发币钱包，BNB）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={defaultBuyBnb}
                onChange={(e) => setDefaultBuyBnb(e.target.value)}
              />
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
            className="w-full rounded-md bg-emerald-500 text-[13px] font-semibold text-black py-2.5 hover:bg-emerald-400 disabled:opacity-60"
            type="button"
            onClick={handleSubmitMemeForm}
          >
            发布
          </button>
        </div>
      </div>
    </div>
  );
}
