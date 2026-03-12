import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import { TRADE_SUCCESS_SOUND_PRESETS, type AutoTradeConfig, type AutoTradeInteractionType, type Settings, type TradeSuccessSoundPreset } from '@/types/extention';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { defaultSettings } from '@/utils/defaults';
import { call } from '@/utils/messaging';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import { browser } from 'wxt/browser';
import { SiteInfo } from '@/utils/sites';

type XSniperPanelProps = {
  siteInfo: SiteInfo
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  isUnlocked: boolean;
};

type XSniperContentProps = {
  siteInfo: SiteInfo | null;
  active: boolean;
  settings: Settings | null;
  isUnlocked: boolean;
};

const interactionOptions: Array<{ value: AutoTradeInteractionType; labelKey: string }> = [
  { value: 'tweet', labelKey: 'contentUi.autoTradeStrategy.interaction.tweet' },
  { value: 'reply', labelKey: 'contentUi.autoTradeStrategy.interaction.reply' },
  { value: 'quote', labelKey: 'contentUi.autoTradeStrategy.interaction.quote' },
  { value: 'retweet', labelKey: 'contentUi.autoTradeStrategy.interaction.retweet' },
  { value: 'follow', labelKey: 'contentUi.autoTradeStrategy.interaction.follow' },
];

const SOUND_OFF = '__off__';
const HISTORY_STORAGE_KEY = 'dagobang_xsniper_order_history_v1';

type XSniperBuyRecord = {
  id: string;
  side?: 'buy' | 'sell';
  tsMs: number;
  chainId: number;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountBnb?: number;
  sellPercent?: number;
  sellTokenAmountWei?: string;
  txHash?: string;
  entryPriceUsd?: number;
  dryRun?: boolean;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  createdAtMs?: number;
  devAddress?: string;
  devHoldPercent?: number;
  devHasSold?: boolean;
  userScreen?: string;
  userName?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  reason?: string;
};

const cloneAutoTrade = (value: AutoTradeConfig | null) => {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value)) as AutoTradeConfig;
};

const normalizeAutoTrade = (input: AutoTradeConfig | null | undefined) => {
  const defaults = defaultSettings().autoTrade;
  if (!input) return defaults;
  return {
    ...defaults,
    ...input,
    triggerSound: {
      ...defaults.triggerSound,
      ...(input as any).triggerSound,
    },
    twitterSnipe: {
      ...defaults.twitterSnipe,
      ...(input as any).twitterSnipe,
    },
  };
};

const parseList = (value: string) =>
  value
    .split(/[\n,]/)
    .flatMap((x) => x.split(/\s+/))
    .map((x) => x.trim())
    .filter(Boolean);

export function XSniperContent({
  siteInfo,
  active,
  settings,
  isUnlocked,
}: XSniperContentProps) {
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const normalizedAutoTrade = useMemo(
    () => normalizeAutoTrade(settings?.autoTrade ?? null),
    [settings?.autoTrade]
  );
  const autoTradeKey = useMemo(() => JSON.stringify(normalizedAutoTrade), [normalizedAutoTrade]);
  const lastAppliedKeyRef = useRef<string>('');
  const [draft, setDraft] = useState<AutoTradeConfig | null>(() => cloneAutoTrade(normalizedAutoTrade));
  const [targetUsersInput, setTargetUsersInput] = useState(
    () => normalizedAutoTrade.twitterSnipe.targetUsers.join('\n')
  );
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [wsStatus, setWsStatus] = useState(() => {
    const initial = (window as any).__DAGOBANG_WS_STATUS__;
    return initial ?? {
      connected: false,
      lastPacketAt: 0,
      lastSignalAt: 0,
      latencyMs: null,
      packetCount: 0,
      signalCount: 0,
      logs: [],
    };
  });
  const [showLogs, setShowLogs] = useState(false);
  const [buyHistory, setBuyHistory] = useState<XSniperBuyRecord[]>([]);
  const [latestTokenByAddr, setLatestTokenByAddr] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!active) return;
    if (isDirty) return;
    if (lastAppliedKeyRef.current === autoTradeKey) return;
    lastAppliedKeyRef.current = autoTradeKey;
    setDraft(cloneAutoTrade(normalizedAutoTrade));
    setTargetUsersInput(normalizedAutoTrade.twitterSnipe.targetUsers.join('\n'));
  }, [active, isDirty, autoTradeKey, normalizedAutoTrade]);

  useEffect(() => {
    if (!active) setIsDirty(false);
  }, [active]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<any>).detail;
      if (!detail) return;
      setWsStatus(detail);
    };
    window.addEventListener('dagobang-ws-status' as any, handler as any);
    return () => {
      window.removeEventListener('dagobang-ws-status' as any, handler as any);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await browser.storage.local.get(HISTORY_STORAGE_KEY);
        const raw = (res as any)?.[HISTORY_STORAGE_KEY];
        const list = Array.isArray(raw) ? (raw as XSniperBuyRecord[]) : [];
        if (!cancelled) setBuyHistory(list);
      } catch {
        if (!cancelled) setBuyHistory([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    const listener = (message: any) => {
      if (!message || message.type !== 'bg:xsniper:buy') return;
      const record = message.record as XSniperBuyRecord | undefined;
      if (!record || typeof record.tsMs !== 'number' || typeof record.tokenAddress !== 'string') return;
      setBuyHistory((prev) => [record, ...prev].slice(0, 200));
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  const canEdit = !!settings && isUnlocked;
  const [wsMonitorEnabled, setWsMonitorEnabled] = useState(() => normalizedAutoTrade.wsMonitorEnabled !== false);
  useEffect(() => {
    setWsMonitorEnabled(normalizedAutoTrade.wsMonitorEnabled !== false);
  }, [normalizedAutoTrade.wsMonitorEnabled]);

  useEffect(() => {
    if (!active) return;
    const readLatestFromCache = () => {
      const cache = (window as any).__DAGOBANG_UNIFIED_TWITTER_CACHE__ ?? null;
      const list = Array.isArray(cache?.list) ? (cache.list as any[]) : [];
      const next: Record<string, any> = {};
      for (const s of list) {
        if (!s) continue;
        const tokens = Array.isArray((s as any).tokens) ? ((s as any).tokens as any[]) : [];
        for (const t of tokens) {
          const addr = typeof t?.tokenAddress === 'string' ? String(t.tokenAddress).trim() : '';
          if (!addr) continue;
          const key = addr.toLowerCase();
          const updatedAtMs =
            typeof t?.updatedAtMs === 'number'
              ? t.updatedAtMs
              : typeof (s as any)?.ts === 'number'
                ? (s as any).ts
                : 0;
          const prev = next[key];
          if (prev && typeof prev.updatedAtMs === 'number' && updatedAtMs <= prev.updatedAtMs) continue;
          next[key] = {
            updatedAtMs,
            marketCapUsd: typeof t?.marketCapUsd === 'number' ? t.marketCapUsd : undefined,
            holders: typeof t?.holders === 'number' ? t.holders : undefined,
            devHoldPercent: typeof t?.devHoldPercent === 'number' ? t.devHoldPercent : undefined,
            devHasSold: typeof t?.devHasSold === 'boolean' ? t.devHasSold : undefined,
            kol: typeof t?.kol === 'number' ? t.kol : undefined,
          };
        }
      }
      setLatestTokenByAddr(next);
    };

    readLatestFromCache();

    if (!wsMonitorEnabled) return;

    const onSignal = (e: Event) => {
      const signal = (e as CustomEvent<any>).detail as any;
      if (!signal || typeof signal !== 'object') return;
      const tokens = Array.isArray(signal.tokens) ? (signal.tokens as any[]) : [];
      if (!tokens.length) return;
      const signalTs = typeof signal.ts === 'number' ? signal.ts : 0;

      setLatestTokenByAddr((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const t of tokens) {
          const addr = typeof t?.tokenAddress === 'string' ? String(t.tokenAddress).trim() : '';
          if (!addr) continue;
          const key = addr.toLowerCase();
          const updatedAtMs = typeof t?.updatedAtMs === 'number' ? t.updatedAtMs : signalTs;
          const cur = next[key];
          if (cur && typeof cur.updatedAtMs === 'number' && updatedAtMs <= cur.updatedAtMs) continue;
          next[key] = {
            updatedAtMs,
            marketCapUsd: typeof t?.marketCapUsd === 'number' ? t.marketCapUsd : undefined,
            holders: typeof t?.holders === 'number' ? t.holders : undefined,
            devHoldPercent: typeof t?.devHoldPercent === 'number' ? t.devHoldPercent : undefined,
            devHasSold: typeof t?.devHasSold === 'boolean' ? t.devHasSold : undefined,
            kol: typeof t?.kol === 'number' ? t.kol : undefined,
          };
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    window.addEventListener('dagobang-twitter-signal' as any, onSignal as any);
    return () => window.removeEventListener('dagobang-twitter-signal' as any, onSignal as any);
  }, [active, wsMonitorEnabled]);

  const presetOptions = useMemo(
    () => TRADE_SUCCESS_SOUND_PRESETS.map((preset) => ({ value: preset, label: preset })),
    []
  );
  const previewSound = useTradeSuccessSound({ enabled: true, volume: 60 });
  const twitterSnipe = draft?.twitterSnipe;
  const formatTs = (tsMs: number) => {
    try {
      return new Date(tsMs).toLocaleString();
    } catch {
      return String(tsMs);
    }
  };
  const formatCompact = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return '-';
    const abs = Math.abs(n);
    const fmt = (v: number, s: string) => `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)}${s}`;
    if (abs >= 1e9) return fmt(n / 1e9, 'B');
    if (abs >= 1e6) return fmt(n / 1e6, 'M');
    if (abs >= 1e3) return fmt(n / 1e3, 'K');
    return String(Math.round(n));
  };
  const formatBnb = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return '-';
    const s = (n >= 1 ? n.toFixed(4) : n.toFixed(6)).replace(/0+$/, '').replace(/\.$/, '');
    return s || '0';
  };
  const formatUsd = (n: number | null | undefined) => {
    if (n == null || !Number.isFinite(n)) return '-';
    const abs = Math.abs(n);
    const raw = abs >= 1 ? n.toFixed(4) : abs >= 0.01 ? n.toFixed(6) : n.toFixed(8);
    const s = raw.replace(/0+$/, '').replace(/\.$/, '');
    return `$${s || '0'}`;
  };
  const shortAddr = (addr: string) => {
    const a = String(addr || '').trim();
    if (!a) return '';
    if (a.length <= 12) return a;
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  };
  const updateTwitterSnipe = (patch: Partial<AutoTradeConfig['twitterSnipe']>) => {
    setIsDirty(true);
    setDraft((prev) =>
      prev
        ? {
          ...prev,
          twitterSnipe: {
            ...prev.twitterSnipe,
            ...patch,
          },
        }
        : prev
    );
  };
  const soundSelectValue =
    draft?.triggerSound.enabled === false ? SOUND_OFF : (draft?.triggerSound.preset ?? 'Boom');

  if (!active || !draft) return null;

  return (
    <>
      <div className="p-3 space-y-3 max-h-[64vh] overflow-y-auto">
        <div className="space-y-2 pb-3 border-b border-zinc-800/60">
          <label className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <div className="text-[14px] font-semibold text-zinc-200">{tt('contentUi.xMonitor.wsMonitorEnabled')}</div>
              <div className="text-[11px] text-zinc-500">{tt('contentUi.xMonitor.wsMonitorEnabledDesc')}</div>
            </div>
            <input
              type="checkbox"
              className="h-4 w-4 accent-emerald-500"
              checked={wsMonitorEnabled}
              disabled={!canEdit}
              onChange={async (e) => {
                const next = e.target.checked;
                setWsMonitorEnabled(next);
                try {
                  window.localStorage.setItem('dagobang_ws_monitor_enabled_v1', next ? '1' : '0');
                } catch {
                }
                setDraft((prev) => (prev ? { ...prev, wsMonitorEnabled: next } : prev));
                if (!settings) return;
                const nextSettings: Settings = {
                  ...settings,
                  autoTrade: {
                    ...(settings as any).autoTrade,
                    wsMonitorEnabled: next,
                  } as any,
                };
                (window as any).__DAGOBANG_SETTINGS__ = nextSettings;
                try {
                  await call({ type: 'settings:set', settings: nextSettings } as const);
                } catch {
                }
              }}
            />
          </label>
          {!wsMonitorEnabled ? (
            <div className="text-[11px] text-amber-200/90">{tt('contentUi.xMonitor.wsMonitorDisabledSniperTip')}</div>
          ) : null}
        </div>
        <div className="space-y-2 pb-3 border-b border-zinc-800/60">
          <div>
            {/* <div className="text-sm font-semibold">{tt('contentUi.autoTradeStrategy.twitterSnipe')}</div> */}
            <div className="text-xs text-zinc-500">{tt('contentUi.autoTradeStrategy.twitterSnipeDesc')}</div>
          </div>
          <label className="flex items-center justify-between gap-2 text-[12px] text-zinc-300">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-emerald-500"
                checked={twitterSnipe?.enabled !== false}
                disabled={!canEdit || !wsMonitorEnabled}
                onChange={(e) => updateTwitterSnipe({ enabled: e.target.checked })}
              />
              {tt('contentUi.autoTradeStrategy.twitterSnipeEnabled')}
            </div>
          </label>
          <label className="flex items-center justify-between gap-2 text-[12px] text-zinc-300">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-amber-500"
                checked={!!twitterSnipe?.dryRun}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ dryRun: e.target.checked })}
              />
              {tt('contentUi.autoTradeStrategy.twitterSnipeDryRun')}
            </div>
          </label>
          <label className="block space-y-1">
            <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.targetUsers')}</div>
            <textarea
              className="h-20 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
              value={targetUsersInput}
              disabled={!canEdit}
              aria-multiline={true}
              onChange={(e) => {
                const nextValue = e.target.value;
                setTargetUsersInput(nextValue);
                setIsDirty(true);
              }}
            />
          </label>
          <div className="space-y-1">
            <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.interactionTypes')}</div>
            <div className="flex flex-wrap gap-2">
              {interactionOptions.map((option) => {
                const checked = !!twitterSnipe?.interactionTypes.includes(option.value);
                return (
                  <label key={option.value} className="flex items-center gap-1 text-[12px] text-zinc-300">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-amber-500"
                      checked={checked}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const nextChecked = e.target.checked;
                        setDraft((prev) => {
                          if (!prev) return prev;
                          setIsDirty(true);
                          const current = prev.twitterSnipe.interactionTypes;
                          const next = nextChecked
                            ? Array.from(new Set([...current, option.value]))
                            : current.filter((x) => x !== option.value);
                          return {
                            ...prev,
                            twitterSnipe: { ...prev.twitterSnipe, interactionTypes: next },
                          };
                        });
                      }}
                    />
                    {tt(option.labelKey)}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.strategyBuyAmount')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.buyAmountBnb ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ buyAmountBnb: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.buyNewCaCount')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.buyNewCaCount ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ buyNewCaCount: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.buyOgCount')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.buyOgCount ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ buyOgCount: e.target.value })}
              />
            </label>
          </div>
        </div>
        <div className="space-y-3 pb-3 border-b border-zinc-800/60">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterMarketCap')}</div>
              <div className="grid flex-1 grid-cols-2 gap-2">
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-8 text-[13px] outline-none"
                    value={twitterSnipe?.minMarketCapUsd ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minMarketCapUsd: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">K</div>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-8 text-[13px] outline-none"
                    value={twitterSnipe?.maxMarketCapUsd ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxMarketCapUsd: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">K</div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterHolders')}</div>
              <div className="grid flex-1 grid-cols-2 gap-2">
                <div>
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                    value={twitterSnipe?.minHolders ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minHolders: e.target.value })}
                  />
                </div>
                <div>
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                    value={twitterSnipe?.maxHolders ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxHolders: e.target.value })}
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterTickerLen')}</div>
              <div className="grid flex-1 grid-cols-2 gap-2">
                <div>
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                    value={twitterSnipe?.minTickerLen ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minTickerLen: e.target.value })}
                  />
                </div>
                <div>
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                    value={twitterSnipe?.maxTickerLen ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxTickerLen: e.target.value })}
                  />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterTokenAge')}</div>
              <div className="grid flex-1 grid-cols-2 gap-2">
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                    value={twitterSnipe?.minTokenAgeSeconds ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minTokenAgeSeconds: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">s</div>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                    value={twitterSnipe?.maxTokenAgeSeconds ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxTokenAgeSeconds: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">s</div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterDevHold')}</div>
              <div className="grid flex-1 grid-cols-2 gap-2">
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-6 text-[13px] outline-none"
                    value={twitterSnipe?.minDevHoldPercent ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minDevHoldPercent: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">%</div>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-6 text-[13px] outline-none"
                    value={twitterSnipe?.maxDevHoldPercent ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxDevHoldPercent: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">%</div>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[12px] text-zinc-300">
              <input
                type="checkbox"
                className="h-3 w-3 accent-amber-500"
                checked={!!twitterSnipe?.blockIfDevSell}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ blockIfDevSell: e.target.checked })}
              />
              {tt('contentUi.autoTradeStrategy.blockIfDevSell')}
            </label>
            <div className="flex items-center gap-2 text-[12px] text-zinc-300">
              <div className="text-zinc-400">{tt('contentUi.autoTradeStrategy.deleteTweetSellPercent')}</div>
              <div className="relative w-[96px]">
                <input
                  type="number"
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-6 text-[13px] outline-none"
                  value={twitterSnipe?.deleteTweetSellPercent ?? ''}
                  disabled={!canEdit}
                  onChange={(e) => updateTwitterSnipe({ deleteTweetSellPercent: e.target.value })}
                />
                <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">%</div>
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.sectionSound')}</div>
            <select
              className="min-w-[120px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
              value={soundSelectValue}
              disabled={!canEdit}
              onChange={(e) => {
                const v = e.target.value;
                setDraft((prev) => {
                  if (!prev) return prev;
                  setIsDirty(true);
                  if (v === SOUND_OFF) return { ...prev, triggerSound: { ...prev.triggerSound, enabled: false } };
                  return { ...prev, triggerSound: { ...prev.triggerSound, enabled: true, preset: v as TradeSuccessSoundPreset } };
                });
              }}
            >
              <option value={SOUND_OFF}>{tt('contentUi.autoTradeStrategy.soundOff')}</option>
              {presetOptions.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800"
              onClick={() => {
                const preset = draft?.triggerSound.preset ?? 'Boom';
                previewSound.ensureReady();
                previewSound.playPreset(preset);
              }}
              title={tt('contentUi.autoTradeStrategy.soundPreview')}
            >
              <Play size={14} />
            </button>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3 w-3 accent-emerald-500"
              checked={!!twitterSnipe?.autoSellEnabled}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ autoSellEnabled: e.target.checked })}
            />
            {tt('contentUi.autoTradeStrategy.strategyAutoSell')}
          </label>
        </div>
        <div className="space-y-2 pt-3 border-t border-zinc-800/60">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.snipeHistoryTitle')}</div>
            <button
              type="button"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              disabled={!canEdit || buyHistory.length === 0}
              onClick={async () => {
                try {
                  await browser.storage.local.set({ [HISTORY_STORAGE_KEY]: [] } as any);
                } finally {
                  setBuyHistory([]);
                }
              }}
            >
              {tt('contentUi.autoTradeStrategy.snipeHistoryClear')}
            </button>
          </div>
          {buyHistory.length === 0 ? (
            <div className="text-[12px] text-zinc-500">{tt('contentUi.autoTradeStrategy.snipeHistoryEmpty')}</div>
          ) : (
            <div className="space-y-2">
              {buyHistory.slice(0, 20).map((r) => (
                <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  {(() => {
                    const latest = latestTokenByAddr[String(r.tokenAddress).toLowerCase()] ?? null;
                    const isSell = r.side === 'sell';
                    const orderMcap = typeof r.marketCapUsd === 'number' ? r.marketCapUsd : null;
                    const latestMcap = latest && typeof latest.marketCapUsd === 'number' ? (latest.marketCapUsd as number) : null;
                    const pnlPct =
                      orderMcap != null && latestMcap != null && orderMcap > 0
                        ? ((latestMcap / orderMcap) - 1) * 100
                        : null;
                    const pnlText = pnlPct == null || !Number.isFinite(pnlPct) ? '-' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
                    const pnlClass =
                      pnlPct == null || !Number.isFinite(pnlPct)
                        ? 'text-zinc-400'
                        : pnlPct >= 0
                          ? 'text-emerald-300'
                          : 'text-rose-300';
                    const tokenLabel =
                      (() => {
                        const sym = r.tokenSymbol ? String(r.tokenSymbol).trim() : '';
                        const name = r.tokenName ? String(r.tokenName).trim() : '';
                        if (sym && name && sym !== name) return `${sym} (${name})`;
                        return sym || name || shortAddr(r.tokenAddress);
                      })();
                    const tokenLink = parsePlatformTokenLink(siteInfo, r.tokenAddress);

                    return (
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[12px] text-zinc-200">
                            {r.dryRun ? (
                              <span className="mr-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
                                {tt('contentUi.autoTradeStrategy.snipeHistoryDry')}
                              </span>
                            ) : null}
                            <a href={tokenLink} className="hover:underline">
                              {tokenLabel}
                            </a>{' '}
                            <span className="text-zinc-500">{shortAddr(r.tokenAddress)}</span>
                          </div>
                          <div className="text-[11px] text-zinc-500">{formatTs(r.tsMs)}</div>
                        </div>
                        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                          <div>
                            {isSell
                              ? `${tt('contentUi.autoTradeStrategy.snipeHistorySellPercent')}: ${r.sellPercent == null ? '-' : `${r.sellPercent.toFixed(2)}%`}` 
                              : `${tt('contentUi.autoTradeStrategy.snipeHistoryBuyAmount')}: ${formatBnb(r.buyAmountBnb)}`}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryReason')}: {r.reason ? String(r.reason) : '-'}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryMarketCap')}: {formatCompact(r.marketCapUsd)}
                            {latestMcap != null ? <span className="text-zinc-500"> → {formatCompact(latestMcap)}</span> : null}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryHolders')}: {formatCompact(r.holders)}
                            {latest && typeof latest.holders === 'number' ? (
                              <span className="text-zinc-500"> → {formatCompact(latest.holders)}</span>
                            ) : null}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryDevHold')}:{' '}
                            {r.devHoldPercent == null ? '-' : `${r.devHoldPercent.toFixed(2)}%`}
                            {latest && typeof latest.devHoldPercent === 'number' ? (
                              <span className="text-zinc-500"> → {latest.devHoldPercent.toFixed(2)}%</span>
                            ) : null}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryDevSold')}:{' '}
                            {r.devHasSold === true ? 'Y' : r.devHasSold === false ? 'N' : '-'}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryKol')}: {formatCompact(r.kol)}
                            {latest && typeof latest.kol === 'number' ? (
                              <span className="text-zinc-500"> → {formatCompact(latest.kol)}</span>
                            ) : null}
                          </div>
                          <div className={pnlClass}>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryPnlMcap')}: {pnlText}
                          </div>
                          <div>
                            {tt('contentUi.autoTradeStrategy.snipeHistoryUser')}: {r.userScreen ? String(r.userScreen) : '-'}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end px-4 py-3 border-t border-zinc-800/60">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            onClick={() => {
              const nextDraft = cloneAutoTrade(normalizedAutoTrade);
              setIsDirty(false);
              lastAppliedKeyRef.current = autoTradeKey;
              setDraft(nextDraft);
              setTargetUsersInput(nextDraft?.twitterSnipe?.targetUsers.join('\n') ?? '');
            }}
          >
            {tt('contentUi.autoTradeStrategy.reset')}
          </button>
          <button
            type="button"
            className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
            disabled={!draft || !canEdit || saving}
            onClick={async () => {
              if (!settings || !draft) return;
              const mergedDraft = {
                ...draft,
                twitterSnipe: {
                  ...draft.twitterSnipe,
                  targetUsers: parseList(targetUsersInput),
                },
              };
              setSaving(true);
              try {
                await call({ type: 'settings:set', settings: { ...settings, autoTrade: mergedDraft } } as const);
                setIsDirty(false);
                lastAppliedKeyRef.current = JSON.stringify(normalizeAutoTrade(mergedDraft));
                setDraft(mergedDraft);
                setTargetUsersInput(mergedDraft.twitterSnipe.targetUsers.join('\n'));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? tt('contentUi.autoTradeStrategy.saving') : tt('contentUi.autoTradeStrategy.save')}
          </button>
        </div>
      </div>
    </>
  );
}

export function XSniperPanel({
  siteInfo,
  visible,
  onVisibleChange,
  settings,
  isUnlocked,
}: XSniperPanelProps) {
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const statusText = (() => {
    if (!settings) return tt('contentUi.autoTradeStrategy.statusSettingsNotLoaded');
    if (!isUnlocked) return tt('contentUi.autoTradeStrategy.statusLocked');
    return tt('contentUi.autoTradeStrategy.statusUnlocked');
  })();

  if (!visible) return null;

  return (
    <div
      className="fixed right-4 top-32 z-[2147483647] w-[360px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/30 font-sans"
    >
      <div
        className="flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800/60"
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-row gap-3 items-center">
            <div className="text-xs font-semibold text-emerald-300">{tt('contentUi.autoTradeStrategy.title')}</div>
            <div className="text-xs text-zinc-500">{statusText}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1 rounded-full text-[12px] bg-emerald-500/20 text-emerald-200 border border-emerald-400/40"
            >
              {tt('contentUi.autoTradeStrategy.twitterSnipe')}
            </button>
          </div>
        </div>
        <button type="button" className="text-zinc-400 hover:text-zinc-200" onClick={() => onVisibleChange(false)}>
          <X size={16} />
        </button>
      </div>
      <XSniperContent
        siteInfo={siteInfo}
        active={visible}
        settings={settings}
        isUnlocked={isUnlocked}
      />
    </div>
  );
}
