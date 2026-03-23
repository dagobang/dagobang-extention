import { useEffect, useMemo, useRef, useState } from 'react';
import { BookUser, ExternalLink, RefreshCw, X } from 'lucide-react';
import type { TokenInfo } from '@/types/token';
import type { Settings, UnifiedTokenPulse, UnifiedTwitterSignal } from '@/types/extention';
import type { SiteInfo } from '@/utils/sites';
import { formatCompactNumber } from '@/utils/format';
import { evaluateQuickJudge } from '@/services/evaluation/quickJudge';

type QuickJudgePanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  siteInfo: SiteInfo | null;
  settings: Settings | null;
  tokenAddress: string | null;
  tokenInfo: TokenInfo | null;
  tokenPriceUsd: number | null;
  marketCapDisplay: string | null;
  onRefreshToken: () => void;
};

const panelWidth = 292;
const socialListStorageKey = 'dagobang_quick_judge_social_accounts_v1';

const clampPos = (x: number, y: number) => {
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  return {
    x: Math.min(Math.max(0, x), Math.max(0, w - panelWidth)),
    y: Math.min(Math.max(0, y), Math.max(0, h - 80)),
  };
};

const fmtUsd = (n: number | null) => formatCompactNumber(n) ?? '-';

const normalizeUser = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

const readSignalTokens = (signal: UnifiedTwitterSignal): string[] =>
  (Array.isArray(signal.tokens) ? signal.tokens : [])
    .map((item) => (typeof item?.tokenAddress === 'string' ? item.tokenAddress.toLowerCase() : ''))
    .filter(Boolean);

export function QuickJudgePanel({
  visible,
  onVisibleChange,
  siteInfo,
  settings,
  tokenAddress,
  tokenInfo,
  tokenPriceUsd,
  marketCapDisplay,
  onRefreshToken,
}: QuickJudgePanelProps) {
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    return { x: Math.max(0, width - panelWidth - 20), y: 180 };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  const [showSocialEditor, setShowSocialEditor] = useState(false);
  const [trustedListText, setTrustedListText] = useState('');
  const [wsPulse, setWsPulse] = useState<UnifiedTokenPulse | null>(null);
  const [latestSignalAccount, setLatestSignalAccount] = useState<string | null>(null);
  const [latestTweetUrl, setLatestTweetUrl] = useState<string | null>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('dagobang_quick_judge_panel_pos');
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      setPos(clampPos(parsed.x, parsed.y));
    } catch {
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(socialListStorageKey);
      if (!stored) return;
      if (typeof stored === 'string') setTrustedListText(stored);
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const next = clampPos(dragging.current.baseX + dx, dragging.current.baseY + dy);
      setPos(next);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        window.localStorage.setItem('dagobang_quick_judge_panel_pos', JSON.stringify(posRef.current));
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

  useEffect(() => {
    try {
      window.localStorage.setItem(socialListStorageKey, trustedListText);
    } catch {
    }
  }, [trustedListText]);

  useEffect(() => {
    const addr = tokenAddress?.toLowerCase();
    if (!addr) {
      setWsPulse(null);
      return;
    }
    const bag = ((window as any).__DAGOBANG_TOKEN_PULSE_BY_ADDR__ ?? {}) as Record<string, UnifiedTokenPulse>;
    setWsPulse(bag[addr] ?? null);
  }, [tokenAddress]);

  useEffect(() => {
    const onPulse = (ev: Event) => {
      const detail = (ev as CustomEvent<UnifiedTokenPulse>).detail;
      if (!detail || typeof detail.tokenAddress !== 'string') return;
      if (!tokenAddress) return;
      if (detail.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) return;
      setWsPulse(detail);
    };
    window.addEventListener('dagobang-token-pulse' as any, onPulse as any);
    return () => window.removeEventListener('dagobang-token-pulse' as any, onPulse as any);
  }, [tokenAddress]);

  useEffect(() => {
    const pulseAccount = typeof wsPulse?.tweetAccount === 'string' ? normalizeUser(wsPulse.tweetAccount) : '';
    if (pulseAccount) setLatestSignalAccount(pulseAccount);
    const pulseTweetUrl = typeof wsPulse?.tweetUrl === 'string' ? wsPulse.tweetUrl.trim() : '';
    if (pulseTweetUrl) setLatestTweetUrl(pulseTweetUrl);
  }, [wsPulse]);

  const trustedFromSettings = useMemo(
    () =>
      (settings?.autoTrade?.twitterSnipe?.targetUsers ?? [])
        .map((item) => normalizeUser(String(item)))
        .filter(Boolean)
        .map((user) => ({ user, category: '关注列表' })),
    [settings],
  );

  const trustedFromCustom = useMemo(() => {
    const lines = trustedListText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const rows: Array<{ user: string; category: string }> = [];
    for (const line of lines) {
      const [userRaw, categoryRaw] = line.split(',');
      const user = normalizeUser(userRaw ?? '');
      if (!user) continue;
      rows.push({ user, category: (categoryRaw ?? '自定义').trim() || '自定义' });
    }
    return rows;
  }, [trustedListText]);

  const trustedMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of trustedFromSettings) {
      if (!map.has(row.user)) map.set(row.user, row.category);
    }
    for (const row of trustedFromCustom) {
      map.set(row.user, row.category);
    }
    return map;
  }, [trustedFromSettings, trustedFromCustom]);

  useEffect(() => {
    const onSignal = (ev: Event) => {
      const signal = (ev as CustomEvent<UnifiedTwitterSignal>).detail;
      if (!signal || !tokenAddress) return;
      const tokens = readSignalTokens(signal);
      if (!tokens.includes(tokenAddress.toLowerCase())) return;
      const accountRaw = typeof signal.userScreen === 'string' ? signal.userScreen : '';
      const account = normalizeUser(accountRaw);
      setLatestSignalAccount(account || null);
      const tweetId = typeof signal.tweetId === 'string' ? signal.tweetId.trim() : '';
      if (tweetId) {
        const url = account ? `https://x.com/${account}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`;
        setLatestTweetUrl(url);
      }
    };
    window.addEventListener('dagobang-twitter-signal' as any, onSignal as any);
    return () => window.removeEventListener('dagobang-twitter-signal' as any, onSignal as any);
  }, [tokenAddress]);

  const trustedSource = useMemo(() => {
    const account = latestSignalAccount ? normalizeUser(latestSignalAccount) : '';
    if (!account) return { hit: false } as const;
    const category = trustedMap.get(account);
    if (!category) return { hit: false, account } as const;
    return { hit: true, account, category } as const;
  }, [latestSignalAccount, trustedMap]);

  const result = useMemo(
    () =>
      evaluateQuickJudge({
        siteInfo,
        tokenInfo,
        tokenPriceUsd,
        marketCapDisplay,
        wsPulse,
        trustedSource,
      }),
    [siteInfo, tokenInfo, tokenPriceUsd, marketCapDisplay, wsPulse, trustedSource],
  );

  if (!visible) return null;

  const decisionCls =
    result.decision === 'go'
      ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
      : result.decision === 'scout'
        ? 'bg-amber-500/20 text-amber-200 border-amber-500/40'
        : 'bg-rose-500/20 text-rose-200 border-rose-500/40';
  const scorePct = Math.max(0, Math.min(100, Math.round(result.totalScore)));
  const narrativePct = Math.max(0, Math.min(100, Math.round((result.narrativeScore / 50) * 100)));
  const entryPct = Math.max(0, Math.min(100, Math.round((result.entryScore / 50) * 100)));
  const riskPct = Math.max(0, Math.min(100, Math.round((result.riskPenalty / 20) * 100)));
  const tweetUrl = wsPulse?.tweetUrl ?? latestTweetUrl;
  const tweetAccount = wsPulse?.tweetAccount ?? latestSignalAccount;
  const webUrl = wsPulse?.web_url ?? null;

  return (
    <div className="fixed z-[2147483647]" style={{ left: pos.x, top: pos.y }}>
      <div className="relative w-[292px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/20">
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-grab"
          onPointerDown={(e) => {
            dragging.current = { startX: e.clientX, startY: e.clientY, baseX: posRef.current.x, baseY: posRef.current.y };
          }}
        >
          <div className="text-[13px] font-semibold text-emerald-300">叙事评估</div>
          <div className="flex items-center gap-2">
            <button
              className={`text-zinc-400 hover:text-zinc-200 ${showSocialEditor ? 'text-emerald-300' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setShowSocialEditor((v) => !v)}
              title="社交账号库"
            >
              <BookUser size={14} />
            </button>
            <button
              className="text-zinc-400 hover:text-zinc-200"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onRefreshToken()}
              title="刷新行情"
            >
              <RefreshCw size={14} />
            </button>
            <button
              className="text-zinc-400 hover:text-zinc-200"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onVisibleChange(false)}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="p-2.5 space-y-2 text-[11px]">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div className="flex items-center gap-2">
              <div
                className="relative h-14 w-14 rounded-full"
                style={{
                  background: `conic-gradient(rgba(16,185,129,0.92) ${scorePct * 3.6}deg, rgba(63,63,70,0.6) 0deg)`,
                }}
              >
                <div className="absolute inset-[5px] rounded-full bg-[#0F0F11] flex items-center justify-center text-[13px] font-bold text-emerald-300">
                  {scorePct}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-zinc-200">{tokenInfo?.symbol || '--'} · {siteInfo?.platform || '--'}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] ${decisionCls}`}>{result.decisionText}</span>
                  <span className="text-zinc-500">时机 {result.autoEntryTiming === 'early' ? '早' : result.autoEntryTiming === 'middle' ? '中' : '晚'}</span>
                </div>
                <div className="mt-1 text-zinc-400">
                  价 {tokenPriceUsd && tokenPriceUsd > 0 ? `$${tokenPriceUsd.toPrecision(4)}` : '-'} · 市值 ${fmtUsd(result.marketCapUsd)}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 space-y-1.5">
            <div className="flex items-center justify-between text-zinc-400">
              <span>叙事</span>
              <span className="text-zinc-300">{result.narrativeScore}/50</span>
            </div>
            <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
              <div className="h-full bg-emerald-400/90" style={{ width: `${narrativePct}%` }} />
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>入场</span>
              <span className="text-zinc-300">{result.entryScore}/50</span>
            </div>
            <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
              <div className="h-full bg-sky-400/90" style={{ width: `${entryPct}%` }} />
            </div>
            <div className="flex items-center justify-between text-zinc-400">
              <span>风险扣分</span>
              <span className="text-zinc-300">-{result.riskPenalty}</span>
            </div>
            <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
              <div className="h-full bg-rose-400/90" style={{ width: `${riskPct}%` }} />
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 grid grid-cols-2 gap-1.5 text-zinc-300">
            <div className="rounded border border-zinc-800 px-1.5 py-1">持币 {result.holders ? Math.round(result.holders).toLocaleString() : '-'}</div>
            <div className="rounded border border-zinc-800 px-1.5 py-1">KOL {result.kol ? Math.round(result.kol) : '-'}</div>
            <div className="rounded border border-zinc-800 px-1.5 py-1 col-span-2 truncate">
              来源 {result.trustedSourceHit ? `${result.trustedSourceAccount ?? ''}${result.trustedSourceCategory ? ` · ${result.trustedSourceCategory}` : ''}` : '未命中关注账号'}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">推文账号</span>
              <span className="text-zinc-200 truncate ml-2">{tweetAccount ? `@${tweetAccount}` : '-'}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">推文链接</span>
              {tweetUrl ? (
                <a className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200" href={tweetUrl} target="_blank" rel="noreferrer">
                  打开 <ExternalLink size={11} />
                </a>
              ) : (
                <span className="text-zinc-500">-</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-400">web_url</span>
              {webUrl ? (
                <a className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200" href={webUrl} target="_blank" rel="noreferrer">
                  打开 <ExternalLink size={11} />
                </a>
              ) : (
                <span className="text-zinc-500">-</span>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 space-y-1 text-zinc-300">
            <div className="text-zinc-400">建议：止损 {result.stopLossPct}% · 止盈1 {result.takeProfit1Pct}% · 止盈2 {result.takeProfit2Pct}%</div>
            {result.reasons.slice(0, 2).map((r, idx) => (
              <div key={`${r}-${idx}`} className="truncate">• {r}</div>
            ))}
          </div>
        </div>

        {showSocialEditor ? (
          <div className="absolute left-[298px] top-0 w-[248px] rounded-xl border border-zinc-800 bg-[#0F0F11] shadow-lg shadow-zinc-900/70 p-2.5">
            <div className="text-[11px] text-zinc-400 mb-1.5">社交账号库（独立维护）</div>
            <textarea
              value={trustedListText}
              onChange={(e) => setTrustedListText(e.target.value)}
              className="w-full min-h-[132px] rounded border border-zinc-700 bg-[#0c0c0f] px-2 py-1.5 text-[11px] text-zinc-200 outline-none focus:border-emerald-500/50"
              placeholder="@账号,一级KOL"
            />
            <div className="mt-1.5 text-[10px] text-zinc-500">每行一个：账号,分类</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
