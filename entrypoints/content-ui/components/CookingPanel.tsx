import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { call } from '@/utils/messaging';
import type { Account } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { WalletSelectorDropdown, WalletSelectorTrigger } from '@/entrypoints/content-ui/components/WalletSelector';

type CookingPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  address: string | null;
  seedreamApiKey: string;
  walletAccounts: Account[];
  activeWalletAddress: `0x${string}` | null;
  defaultSelectedWallets: `0x${string}`[];
  walletNativeBalancesWei: Record<string, string>;
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
  defaultSelectedWallets,
  walletNativeBalancesWei,
}: CookingPanelProps) {
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
  const [autoBuyWallets, setAutoBuyWallets] = useState<`0x${string}`[]>([]);
  const [walletSniperAmounts, setWalletSniperAmounts] = useState<Record<string, string>>({});
  const [deployWalletSelectorOpen, setDeployWalletSelectorOpen] = useState(false);
  const [autoBuyWalletSelectorOpen, setAutoBuyWalletSelectorOpen] = useState(false);
  const [googleQuery, setGoogleQuery] = useState('');
  const [googleSearching, setGoogleSearching] = useState(false);
  const [googleImages, setGoogleImages] = useState<Array<{ url: string; thumbnail?: string; title?: string; source?: string }>>([]);
  const [googlePage, setGooglePage] = useState(0);

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
        autoBuyWallets?: string[];
        walletSniperAmounts?: Record<string, string>;
        defaultBuyBnb?: string;
        autoSellEnabled?: boolean;
        autoSellRules?: AutoSellRule[];
      };
      if (parsed.deployWallet) setDeployWallet(parsed.deployWallet as `0x${string}`);
      if (Array.isArray(parsed.autoBuyWallets)) {
        const next = parsed.autoBuyWallets.filter((x) => typeof x === 'string') as `0x${string}`[];
        setAutoBuyWallets(next);
      }
      if (parsed.walletSniperAmounts && typeof parsed.walletSniperAmounts === 'object') {
        setWalletSniperAmounts(parsed.walletSniperAmounts);
      }
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
    try {
      const payload = {
        deployWallet: deployWallet || undefined,
        autoBuyWallets,
        walletSniperAmounts,
        defaultBuyBnb,
        autoSellEnabled,
        autoSellRules,
      };
      window.localStorage.setItem(cookingConfigStorageKey, JSON.stringify(payload));
    } catch {
    }
  }, [deployWallet, autoBuyWallets, walletSniperAmounts, defaultBuyBnb, autoSellEnabled, autoSellRules]);

  useEffect(() => {
    if (autoBuyWallets.length > 0) return;
    if (defaultSelectedWallets.length > 0) {
      setAutoBuyWallets(defaultSelectedWallets.slice(0, 5));
    }
  }, [autoBuyWallets.length, defaultSelectedWallets]);

  const walletTotalCount = walletAccounts.length;
  const selectedDeployWallet = useMemo(
    () => walletAccounts.find((acc) => acc.address.toLowerCase() === String(deployWallet || '').toLowerCase()) ?? null,
    [walletAccounts, deployWallet]
  );

  const toggleAutoBuyWallet = (wallet: `0x${string}`) => {
    setAutoBuyWallets((list) => {
      const exists = list.some((x) => x.toLowerCase() === wallet.toLowerCase());
      if (exists) return list.filter((x) => x.toLowerCase() !== wallet.toLowerCase());
      if (list.length >= 5) {
        toast.error('最多选择 5 个自动买入钱包');
        return list;
      }
      return [...list, wallet];
    });
  };

  const updateWalletSniperAmount = (wallet: `0x${string}`, amount: string) => {
    setWalletSniperAmounts((prev) => ({ ...prev, [wallet.toLowerCase()]: amount }));
  };

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
  };

  const updateAutoSellRule = (index: number, patch: Partial<AutoSellRule>) => {
    setAutoSellRules((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const addAutoSellRule = () => {
    setAutoSellRules((list) => {
      if (list.length >= MAX_AUTO_SELL_RULES) return list;
      return [...list, { marketCapUsd: '', sellPercent: '' }];
    });
  };

  const removeAutoSellRule = (index: number) => {
    setAutoSellRules((list) => {
      if (list.length <= 1) return list;
      return list.filter((_, i) => i !== index);
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

  const handleSubmitMemeForm = async () => {
    const symbol = tokenSymbolInput.trim();
    const name = tokenNameInput.trim();
    const img = logoUrl.trim();
    if (!symbol || !name) {
      toast.error('请填写代币符号和名称');
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
      const descParts: string[] = [];
      if (twitterInput.trim()) descParts.push(`Twitter: ${twitterInput.trim()}`);
      if (websiteInput.trim()) descParts.push(`Website: ${websiteInput.trim()}`);
      if (telegramInput.trim()) descParts.push(`Telegram: ${telegramInput.trim()}`);
      if (defaultBuyBnb.trim()) descParts.push(`DefaultBuyBNB: ${defaultBuyBnb.trim()}`);
      if (autoSellEnabled) descParts.push('AutoSellMode: marketCapTargets');
      const desc = descParts.join(' | ');
      const preSale = defaultBuyBnb.trim() || '0';
      const autoBuyWalletInputs = autoBuyWallets
        .map((wallet) => ({
          address: wallet,
          amountBnb: (walletSniperAmounts[wallet.toLowerCase()] || defaultBuyBnb).trim(),
        }))
        .filter((item) => item.amountBnb);

      const res = await call({
        type: 'token:createFourmeme',
        input: {
          name,
          shortName: symbol,
          desc,
          imgUrl: img,
          webUrl: websiteInput.trim() || undefined,
          twitterUrl: twitterInput.trim() || undefined,
          telegramUrl: telegramInput.trim() || undefined,
          preSale,
          onlyMPC: false,
          fromAddress: deployWallet,
          autoBuy: {
            bundleEnabled: true,
            sniperEnabled: true,
            wallets: autoBuyWalletInputs,
            sniperMaxAttempts: 25,
            sniperRetryMs: 1200,
          },
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
      } else {
        toast.success('创建 Meme Token 参数已生成', { id: toastId, icon: '✅' });
      }
      const autoBuy = (res as any)?.autoBuy;
      if (autoBuy) {
        toast(
          `自动买入结果：捆绑成功 ${autoBuy.bundleSuccess}/${autoBuy.bundleSuccess + autoBuy.bundleFailed}，狙击成功 ${autoBuy.sniperSuccess}/${autoBuy.sniperSuccess + autoBuy.sniperFailed}`,
          { icon: '🎯', duration: 4500 }
        );
      }
      if (autoSellEnabled && data?.tokenAddress) {
        const tokenAddress = String(data.tokenAddress) as `0x${string}`;
        const normalizedRules = autoSellRules
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
          const sellWallets = Array.from(
            new Set([deployWallet, ...autoBuyWalletInputs.map((x) => x.address)].map((x) => x.toLowerCase()))
          ).map((lower) => {
            const found = [deployWallet, ...autoBuyWalletInputs.map((x) => x.address)].find((x) => x.toLowerCase() === lower);
            return found!;
          });
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
              <div className="text-[11px] text-zinc-400">Google 搜图</div>
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                  value={googleQuery}
                  onChange={(e) => setGoogleQuery(e.target.value)}
                  placeholder="输入关键词搜索图片"
                />
                <button
                  type="button"
                  className="px-2 py-1 rounded-md border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500"
                  onClick={() => handleSearchGoogleImages(0)}
                  disabled={googleSearching}
                >
                  搜索
                </button>
                <button
                  type="button"
                  className="px-2 py-1 rounded-md border border-zinc-700 text-[11px] text-zinc-200 hover:border-zinc-500 disabled:opacity-40"
                  onClick={() => handleSearchGoogleImages(googlePage + 1)}
                  disabled={googleSearching || !googleImages.length}
                >
                  更多
                </button>
              </div>
              {googleImages.length > 0 && (
                <div className="grid grid-cols-4 gap-2 max-h-40 overflow-auto pr-1">
                  {googleImages.map((item, idx) => (
                    <button
                      key={`${item.url}-${idx}`}
                      type="button"
                      className="h-16 rounded-md overflow-hidden border border-zinc-800 hover:border-emerald-500"
                      onClick={() => setLogoUrl(item.url)}
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
                  onChange={(e) => setTokenSymbolInput(e.target.value.toUpperCase())}
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

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-zinc-400">自动买入钱包（最多 5 个）</div>
                <WalletSelectorTrigger
                  walletSelectorOpen={autoBuyWalletSelectorOpen}
                  walletSelectedCount={autoBuyWallets.length}
                  walletTotalCount={walletTotalCount}
                  onToggleWalletSelector={() => setAutoBuyWalletSelectorOpen((v) => !v)}
                  title="选择自动买入钱包"
                />
              </div>
              <WalletSelectorDropdown
                open={autoBuyWalletSelectorOpen}
                selectedTradeWallets={autoBuyWallets}
                walletAccounts={walletAccounts}
                activeWalletAddress={activeWalletAddress}
                onToggleTradeWallet={toggleAutoBuyWallet}
                walletNativeBalancesWei={walletNativeBalancesWei}
                walletTokenBalancesWei={{}}
                tokenDecimals={18}
                multiWalletBuyMode="uniform"
                onChangeMultiWalletBuyMode={() => { }}
                childWalletBuyPresetAmountsNative={{}}
                onUpdateChildWalletBuyPresetAmount={() => { }}
                className="rounded-md border border-zinc-700 bg-[#141416] p-2 shadow-xl"
                onRequestClose={() => setAutoBuyWalletSelectorOpen(false)}
              />
              {autoBuyWallets.length > 0 ? (
                <div className="space-y-1">
                  {autoBuyWallets.map((wallet) => (
                    <div key={wallet} className="grid grid-cols-[1fr_92px] gap-2 items-center">
                      <div className="rounded border border-zinc-700 px-2 py-1 text-[11px] font-mono text-zinc-300">
                        {wallet.slice(0, 6)}...{wallet.slice(-4)}
                      </div>
                      <input
                        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-100 outline-none"
                        value={walletSniperAmounts[wallet.toLowerCase()] ?? defaultBuyBnb}
                        onChange={(e) => updateWalletSniperAmount(wallet, e.target.value)}
                        placeholder="狙击BNB"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-zinc-500">未选择自动买入钱包</div>
              )}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-zinc-300">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={autoSellEnabled} onChange={(e) => setAutoSellEnabled(e.target.checked)} />
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
