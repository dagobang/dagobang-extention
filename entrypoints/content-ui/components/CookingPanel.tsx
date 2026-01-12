import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { call } from '@/utils/messaging';

type CookingPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  address: string | null;
  seedreamApiKey: string;
};

export function CookingPanel({ visible, onVisibleChange, address, seedreamApiKey }: CookingPanelProps) {
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
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 340));
      const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
      setPos({ x: clampedX, y: clampedY });
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
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const key = 'dagobang_cooking_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(posRef.current));
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
  const [creatorAddressInput, setCreatorAddressInput] = useState('');
  const [defaultBuyBnb, setDefaultBuyBnb] = useState('0.1');
  const [bundleWallets, setBundleWallets] = useState<string[]>(['']);
  const [bundleAmount, setBundleAmount] = useState('');

  useEffect(() => {
    if (address && !creatorAddressInput) {
      setCreatorAddressInput(address);
    }
  }, [address, creatorAddressInput]);

  const handleAddBundleWallet = () => {
    setBundleWallets((list) => {
      if (list.length >= 5) return list;
      return [...list, ''];
    });
  };

  const handleUpdateBundleWallet = (index: number, value: string) => {
    setBundleWallets((list) => {
      const next = [...list];
      next[index] = value;
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

  const handleSubmitMemeForm = async () => {
    const symbol = tokenSymbolInput.trim();
    const name = tokenNameInput.trim();
    const img = logoUrl.trim();
    const creator = creatorAddressInput.trim();
    if (!symbol || !name) {
      toast.error('请填写代币符号和名称');
      return;
    }
    if (!img) {
      toast.error('请先生成或填入 Logo 链接');
      return;
    }
    if (!creator) {
      toast.error('请填写创建人钱包地址');
      return;
    }
    try {
      const toastId = toast.loading('正在创建 Meme Token...', { icon: '🔄' });
      const descParts: string[] = [];
      if (twitterInput.trim()) descParts.push(`Twitter: ${twitterInput.trim()}`);
      if (websiteInput.trim()) descParts.push(`Website: ${websiteInput.trim()}`);
      if (telegramInput.trim()) descParts.push(`Telegram: ${telegramInput.trim()}`);
      if (defaultBuyBnb.trim()) descParts.push(`DefaultBuyBNB: ${defaultBuyBnb.trim()}`);
      if (bundleAmount.trim()) descParts.push(`BundleBNB: ${bundleAmount.trim()}`);
      const nonEmptyBundle = bundleWallets.map((x) => x.trim()).filter(Boolean);
      if (nonEmptyBundle.length > 0) descParts.push(`BundleWallets: ${nonEmptyBundle.join(',')}`);
      const desc = descParts.join(' | ');
      const preSale = defaultBuyBnb.trim() || '0';

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
      if (data) {
        console.log('Fourmeme create token response', data);
      }
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
      <div className="w-[320px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-amber-500/40 text-[12px]">
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
        <div className="p-3 space-y-3">
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

          <div className="space-y-1">
            <div className="text-[11px] text-zinc-400">钱包地址（创建人）</div>
            <input
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none font-mono"
              value={creatorAddressInput}
              onChange={(e) => setCreatorAddressInput(e.target.value)}
              placeholder="默认使用当前钱包地址"
            />
          </div>

          <div className="grid grid-cols-[1.2fr_1.8fr] gap-3 items-end">
            <div className="space-y-1">
              <div className="text-[11px] text-zinc-400">默认买入（BNB）</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
                value={defaultBuyBnb}
                onChange={(e) => setDefaultBuyBnb(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-zinc-400">多钱包捆绑（最多 5 个）</div>
                <button
                  className="text-[11px] text-amber-400 hover:text-amber-300 disabled:opacity-40"
                  type="button"
                  onClick={handleAddBundleWallet}
                  disabled={bundleWallets.length >= 5}
                >
                  添加
                </button>
              </div>
              <div className="space-y-1 mt-1">
                {bundleWallets.map((addr, idx) => (
                  <input
                    key={idx}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] outline-none font-mono"
                    value={addr}
                    onChange={(e) => handleUpdateBundleWallet(idx, e.target.value)}
                    placeholder="钱包地址"
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] text-zinc-400">捆绑金额（每个钱包）</div>
            <input
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
              value={bundleAmount}
              onChange={(e) => setBundleAmount(e.target.value)}
              placeholder="单位 BNB"
            />
          </div>

          <button
            className="w-full mt-2 rounded-md bg-emerald-500 text-[12px] font-semibold text-black py-2 hover:bg-emerald-400 disabled:opacity-60"
            type="button"
            onClick={handleSubmitMemeForm}
          >
            一键生成 Meme 配置
          </button>
        </div>
      </div>
    </div>
  );
}
