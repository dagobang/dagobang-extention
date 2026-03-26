import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { TRADE_SUCCESS_SOUND_PRESETS, type AutoTradeConfig, type AutoTradeInteractionType, type AutoTradeTwitterSnipePreset, type Settings, type TradeSuccessSoundPreset, type XSniperBuyRecord } from '@/types/extention';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { defaultSettings } from '@/utils/defaults';
import { call } from '@/utils/messaging';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import { browser } from 'wxt/browser';
import { SiteInfo } from '@/utils/sites';
import { clearXSniperHistory, XSNIPER_HISTORY_STORAGE_KEY } from '@/services/xSniper/xSniperHistory';
import { XSniperHistoryView } from './XSniperHistoryView';
import { XSniperBasicSection } from './XSniperBasicSection';
import { XSniperFilterSection } from './XSniperFilterSection';
import { XSniperRapidSection } from './XSniperRapidSection';
import { XSniperSoundSection } from './XSniperSoundSection';
import { XSniperWsConfirmSection } from './XSniperWsConfirmSection';
import { XSniperWsStatusSection } from './XSniperWsStatusSection';

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
  view?: 'config' | 'history';
  settings: Settings | null;
  isUnlocked: boolean;
};

const SOUND_OFF = '__off__';
const BOUGHT_ONCE_STORAGE_KEY = 'dagobang_xsniper_bought_once_v1';

const cloneAutoTrade = (value: AutoTradeConfig | null) => {
  if (!value) return null;
  return JSON.parse(JSON.stringify(value)) as AutoTradeConfig;
};

const normalizeAutoTrade = (input: AutoTradeConfig | null | undefined) => {
  const defaults = defaultSettings().autoTrade;
  const merged = !input ? defaults : {
    ...defaults,
    ...input,
    triggerSound: {
      ...defaults.triggerSound,
      ...(input as any).triggerSound,
    },
    twitterSnipe: {
      ...defaults.twitterSnipe,
      ...(input as any).twitterSnipe,
      rapidByType: {
        ...((defaults.twitterSnipe as any)?.rapidByType ?? {}),
        ...(((input as any).twitterSnipe as any)?.rapidByType ?? {}),
      },
    },
  };
  return {
    ...merged,
    twitterSnipe: resolveTwitterSnipeByActivePreset((merged as any).twitterSnipe),
  };
};

const parseList = (value: string) =>
  value
    .split(/[\n,]/)
    .flatMap((x) => x.split(/\s+/))
    .map((x) => x.trim())
    .filter(Boolean);

const createPresetId = () => `preset-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const buildNormalizedPresetStrategy = (raw: any) => {
  const base = { ...(defaultSettings().autoTrade.twitterSnipe as any) };
  delete (base as any).presets;
  delete (base as any).activePresetId;
  delete (base as any).buyOgCount;
  const next = {
    ...base,
    ...(raw && typeof raw === 'object' ? raw : {}),
    rapidByType: {
      ...((base as any).rapidByType ?? {}),
      ...(((raw && typeof raw === 'object' ? raw : {}) as any).rapidByType ?? {}),
    },
  };
  next.targetUsers = Array.isArray(next.targetUsers)
    ? next.targetUsers.map((x: any) => String(x).trim()).filter(Boolean)
    : [];
  next.interactionTypes = Array.isArray(next.interactionTypes)
    ? next.interactionTypes.map((x: any) => String(x).trim()).filter(Boolean)
    : base.interactionTypes;
  delete (next as any).presets;
  delete (next as any).activePresetId;
  delete (next as any).buyOgCount;
  return next;
};

const resolveTwitterSnipeByActivePreset = (twitterSnipe: any) => {
  const source = twitterSnipe ?? {};
  const presets = Array.isArray(source.presets) ? source.presets : [];
  const activePresetId = typeof source.activePresetId === 'string' ? source.activePresetId.trim() : '';
  const active = presets.find((item: any) => item && typeof item.id === 'string' && item.id === activePresetId);
  if (!active || !active.strategy || typeof active.strategy !== 'object') return source;
  return {
    ...source,
    ...active.strategy,
    presets,
    activePresetId,
  };
};

export function XSniperContent({
  siteInfo,
  active,
  view = 'config',
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
  const [presetJsonInput, setPresetJsonInput] = useState('');
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
  const [configSectionOpen, setConfigSectionOpen] = useState<Record<string, boolean>>({
    basic: true,
    filter: false,
    wsConfirm: false,
    rapid: true,
    sellSound: false,
  });
  const [buyHistory, setBuyHistory] = useState<XSniperBuyRecord[]>([]);
  const [latestTokenByAddr, setLatestTokenByAddr] = useState<Record<string, any>>({});
  const [athMcapByAddr, setAthMcapByAddr] = useState<Record<string, number>>({});

  const historyGroups = useMemo(() => {
    const normalizeAddr = (addr: string) => String(addr || '').trim().toLowerCase();
    const groups = new Map<string, { key: string; latestTsMs: number; records: XSniperBuyRecord[] }>();
    for (const r of buyHistory) {
      if (!r || typeof r.chainId !== 'number' || !r.tokenAddress) continue;
      const addr = normalizeAddr(r.tokenAddress);
      if (!addr) continue;
      const dryRun = r.dryRun === true;
      const key = `${dryRun ? 'dry:' : ''}${r.chainId}:${addr}`;
      const ts = typeof r.tsMs === 'number' && Number.isFinite(r.tsMs) ? r.tsMs : 0;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { key, latestTsMs: ts, records: [r] });
      } else {
        existing.records.push(r);
        if (ts > existing.latestTsMs) existing.latestTsMs = ts;
      }
    }
    const list = Array.from(groups.values()).sort((a, b) => b.latestTsMs - a.latestTsMs);
    return list
      .map((g) => {
        const sorted = g.records.slice().sort((a, b) => (Number(b.tsMs) || 0) - (Number(a.tsMs) || 0));
        const parent =
          sorted.find((x) => x && x.side !== 'sell' && x.reason !== 'ws_confirm_failed') ??
          sorted[0];
        if (!parent) return null;
        return { key: g.key, parent, children: sorted.filter((x) => x !== parent) };
      })
      .filter(Boolean) as Array<{ key: string; parent: XSniperBuyRecord; children: XSniperBuyRecord[] }>;
  }, [buyHistory]);

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
        const res = await browser.storage.local.get(XSNIPER_HISTORY_STORAGE_KEY);
        const raw = (res as any)?.[XSNIPER_HISTORY_STORAGE_KEY];
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
    if (!active) return;
    const handler = (changes: Record<string, any>, areaName: string) => {
      if (areaName !== 'local') return;
      const change = changes?.[XSNIPER_HISTORY_STORAGE_KEY];
      if (!change) return;
      const next = change.newValue;
      if (!Array.isArray(next)) return;
      setBuyHistory(next as XSniperBuyRecord[]);
    };
    browser.storage.onChanged.addListener(handler as any);
    return () => browser.storage.onChanged.removeListener(handler as any);
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
      const ath: Record<string, number> = {};
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
          const mcap = typeof t?.marketCapUsd === 'number' && Number.isFinite(t.marketCapUsd) && t.marketCapUsd >= 3000 ? t.marketCapUsd : null;
          if (mcap != null) {
            const prevAth = ath[key];
            ath[key] = prevAth != null && Number.isFinite(prevAth) ? Math.max(prevAth, mcap) : mcap;
          }
          next[key] = {
            updatedAtMs,
            marketCapUsd: typeof t?.marketCapUsd === 'number' ? t.marketCapUsd : undefined,
            priceUsd: typeof t?.priceUsd === 'number' ? t.priceUsd : undefined,
            holders: typeof t?.holders === 'number' ? t.holders : undefined,
            devHoldPercent: typeof t?.devHoldPercent === 'number' ? t.devHoldPercent : undefined,
            devHasSold: typeof t?.devHasSold === 'boolean' ? t.devHasSold : undefined,
            kol: typeof t?.kol === 'number' ? t.kol : undefined,
          };
        }
      }
      setLatestTokenByAddr(next);
      setAthMcapByAddr((prev) => {
        let changed = false;
        const merged: Record<string, number> = { ...prev };
        for (const [k, v] of Object.entries(ath)) {
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          const cur = merged[k];
          const nextV = cur != null && Number.isFinite(cur) ? Math.max(cur, v) : v;
          if (nextV !== cur) {
            merged[k] = nextV;
            changed = true;
          }
        }
        return changed ? merged : prev;
      });
    };

    readLatestFromCache();

    if (!wsMonitorEnabled) return;

    const onSignal = (e: Event) => {
      const signal = (e as CustomEvent<any>).detail as any;
      if (!signal || typeof signal !== 'object') return;
      const tokens = Array.isArray(signal.tokens) ? (signal.tokens as any[]) : [];
      if (!tokens.length) return;
      const signalTs = typeof signal.ts === 'number' ? signal.ts : 0;

      setAthMcapByAddr((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const t of tokens) {
          const addr = typeof t?.tokenAddress === 'string' ? String(t.tokenAddress).trim() : '';
          if (!addr) continue;
          const key = addr.toLowerCase();
          const mcap = typeof t?.marketCapUsd === 'number' && Number.isFinite(t.marketCapUsd) && t.marketCapUsd >= 3000 ? t.marketCapUsd : null;
          if (mcap == null) continue;
          const cur = next[key];
          const merged = cur != null && Number.isFinite(cur) ? Math.max(cur, mcap) : mcap;
          if (merged !== cur) {
            next[key] = merged;
            changed = true;
          }
        }
        return changed ? next : prev;
      });

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
            priceUsd: typeof t?.priceUsd === 'number' ? t.priceUsd : undefined,
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
  const snipePresets = Array.isArray((twitterSnipe as any)?.presets)
    ? ((twitterSnipe as any).presets as AutoTradeTwitterSnipePreset[])
    : [];
  const activeSnipePresetId = typeof (twitterSnipe as any)?.activePresetId === 'string'
    ? ((twitterSnipe as any).activePresetId as string)
    : '';
  const activeSnipePreset = snipePresets.find((item) => item.id === activeSnipePresetId) ?? null;

  const updateTwitterSnipe = (patch: Partial<AutoTradeConfig['twitterSnipe']>) => {
    setIsDirty(true);
    setDraft((prev) =>
      prev
        ? {
          ...prev,
          twitterSnipe: {
            ...(() => {
              const current = prev.twitterSnipe as any;
              const next = {
                ...current,
                ...patch,
              } as any;
              const presets = Array.isArray(next.presets) ? next.presets : [];
              const activeId = typeof next.activePresetId === 'string' ? next.activePresetId : '';
              if (activeId) {
                next.presets = presets.map((item: any) => {
                  if (!item || item.id !== activeId) return item;
                  return {
                    ...item,
                    strategy: {
                      ...(item.strategy ?? {}),
                      ...patch,
                    },
                  };
                });
              } else {
                next.presets = presets;
              }
              return next;
            })(),
          },
        }
        : prev
    );
  };
  const applyActivePreset = (presetId: string) => {
    setIsDirty(true);
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.twitterSnipe as any;
      const presets = Array.isArray(current.presets) ? current.presets : [];
      const preset = presets.find((item: any) => item && item.id === presetId);
      if (!preset || !preset.strategy || typeof preset.strategy !== 'object') return prev;
      const nextSnipe = {
        ...current,
        ...preset.strategy,
        presets,
        activePresetId: presetId,
      };
      const users = Array.isArray(nextSnipe.targetUsers) ? nextSnipe.targetUsers : [];
      setTargetUsersInput(users.join('\n'));
      return {
        ...prev,
        twitterSnipe: nextSnipe,
      };
    });
  };
  const addPresetFromCurrent = () => {
    setIsDirty(true);
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.twitterSnipe as any;
      const presets = Array.isArray(current.presets) ? current.presets : [];
      const nextId = createPresetId();
      const nextName = `方案 ${presets.length + 1}`;
      const strategy = {
        ...current,
        targetUsers: parseList(targetUsersInput),
      };
      delete (strategy as any).presets;
      delete (strategy as any).activePresetId;
      const nextPresets = [...presets, { id: nextId, name: nextName, strategy }];
      return {
        ...prev,
        twitterSnipe: {
          ...current,
          presets: nextPresets,
          activePresetId: nextId,
        },
      };
    });
  };
  const removeActivePreset = () => {
    setIsDirty(true);
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.twitterSnipe as any;
      const presets = Array.isArray(current.presets) ? current.presets : [];
      const activeId = typeof current.activePresetId === 'string' ? current.activePresetId : '';
      if (!activeId) return prev;
      const nextPresets = presets.filter((item: any) => item && item.id !== activeId);
      const nextActiveId = nextPresets[0]?.id ?? '';
      const nextActive = nextPresets.find((item: any) => item && item.id === nextActiveId);
      const nextSnipe = nextActive?.strategy
        ? {
          ...current,
          ...nextActive.strategy,
          presets: nextPresets,
          activePresetId: nextActiveId,
        }
        : {
          ...current,
          presets: nextPresets,
          activePresetId: nextActiveId,
        };
      const users = Array.isArray(nextSnipe.targetUsers) ? nextSnipe.targetUsers : [];
      setTargetUsersInput(users.join('\n'));
      return {
        ...prev,
        twitterSnipe: nextSnipe,
      };
    });
  };
  const exportActivePresetAsJson = () => {
    if (!activeSnipePreset) return;
    const payload = {
      id: activeSnipePreset.id,
      name: activeSnipePreset.name,
      strategy: buildNormalizedPresetStrategy(activeSnipePreset.strategy),
    };
    const text = JSON.stringify(payload, null, 2);
    setPresetJsonInput(text);
    void navigator.clipboard?.writeText(text).catch(() => { });
  };
  const importPresetFromJson = () => {
    const text = presetJsonInput.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      const isObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      if (!isObject) throw new Error('invalid_json');
      const incomingName = typeof (parsed as any).name === 'string' ? (parsed as any).name.trim() : '';
      const strategyRaw = (parsed as any).strategy && typeof (parsed as any).strategy === 'object'
        ? (parsed as any).strategy
        : parsed;
      const strategy = buildNormalizedPresetStrategy(strategyRaw);
      const nextId = typeof (parsed as any).id === 'string' && (parsed as any).id.trim()
        ? (parsed as any).id.trim()
        : createPresetId();
      const nextName = incomingName || '导入方案';
      setIsDirty(true);
      setDraft((prev) => {
        if (!prev) return prev;
        const current = prev.twitterSnipe as any;
        const presets = Array.isArray(current.presets) ? current.presets : [];
        const withoutSameId = presets.filter((item: any) => item && item.id !== nextId);
        const nextPresets = [...withoutSameId, { id: nextId, name: nextName, strategy }];
        const nextSnipe = {
          ...current,
          ...strategy,
          presets: nextPresets,
          activePresetId: nextId,
        };
        const users = Array.isArray(nextSnipe.targetUsers) ? nextSnipe.targetUsers : [];
        setTargetUsersInput(users.join('\n'));
        return {
          ...prev,
          twitterSnipe: nextSnipe,
        };
      });
    } catch {
      window.alert('配置JSON格式不正确');
    }
  };
  const soundSelectValue =
    draft?.triggerSound.enabled === false ? SOUND_OFF : (draft?.triggerSound.preset ?? 'Boom');
  const deleteTweetSoundPreset = (twitterSnipe?.deleteTweetSoundPreset ?? 'Handgun') as TradeSuccessSoundPreset;
  const deleteTweetSoundSelectValue =
    twitterSnipe?.deleteTweetPlaySound === false ? SOUND_OFF : deleteTweetSoundPreset;
  const rapidExitEnabled = (twitterSnipe as any)?.rapidExitEnabled !== false;
  const getRapidUnifiedValue = (field: string) => {
    if (field === 'takeProfitPct') return (twitterSnipe as any)?.rapidTakeProfitPct ?? '';
    if (field === 'stopLossPct') return (twitterSnipe as any)?.rapidStopLossPct ?? '';
    if (field === 'trailActivatePct') return (twitterSnipe as any)?.rapidTrailActivatePct ?? '';
    if (field === 'trailDropPct') return (twitterSnipe as any)?.rapidTrailDropPct ?? '';
    if (field === 'sellPercent') return (twitterSnipe as any)?.rapidSellPercent ?? '';
    if (field === 'minHoldMsForStopLoss') return (twitterSnipe as any)?.rapidMinHoldMsForStopLoss ?? '';
    if (field === 'minHoldMsForTakeProfit') return (twitterSnipe as any)?.rapidMinHoldMsForTakeProfit ?? '';
    if (field === 'minHoldMsForTrail') return (twitterSnipe as any)?.rapidMinHoldMsForTrail ?? '';
    return '';
  };
  const getRapidTypeFallbackValue = (field: string) => {
    const v = getRapidUnifiedValue(field);
    return v == null ? '' : String(v);
  };
  const getRapidTypeValue = (tweetType: AutoTradeInteractionType, field: string) => {
    const map = ((twitterSnipe as any)?.rapidByType ?? {}) as Record<string, any>;
    const node = map[tweetType];
    const value = node && typeof node === 'object' ? node[field] : undefined;
    if (value == null) return getRapidTypeFallbackValue(field);
    return String(value);
  };
  const getRapidTypeEnabled = (tweetType: AutoTradeInteractionType) => {
    const map = ((twitterSnipe as any)?.rapidByType ?? {}) as Record<string, any>;
    const node = map[tweetType];
    if (!node || typeof node !== 'object' || node.enabled == null) return true;
    return node.enabled !== false;
  };
  const updateRapidTypeValue = (tweetType: AutoTradeInteractionType, field: string, value: string | boolean) => {
    const currentMap = (((twitterSnipe as any)?.rapidByType ?? {}) as Record<string, any>);
    const currentNode = currentMap[tweetType] && typeof currentMap[tweetType] === 'object'
      ? currentMap[tweetType]
      : {};
    updateTwitterSnipe({
      rapidByType: {
        ...currentMap,
        [tweetType]: {
          ...currentNode,
          [field]: value,
        },
      },
    } as any);
  };
  const toggleConfigSection = (key: string) => {
    setConfigSectionOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const handleWsMonitorEnabledChange = async (next: boolean) => {
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
  };
  const handleActivePresetNameChange = (nextName: string) => {
    setIsDirty(true);
    setDraft((prev) => {
      if (!prev) return prev;
      const current = prev.twitterSnipe as any;
      const presets = Array.isArray(current.presets) ? current.presets : [];
      const nextPresets = presets.map((item: any) => {
        if (!item || item.id !== activeSnipePresetId) return item;
        return { ...item, name: nextName };
      });
      return {
        ...prev,
        twitterSnipe: {
          ...current,
          presets: nextPresets,
        },
      };
    });
  };
  const handleTargetUsersInputChange = (nextValue: string) => {
    setTargetUsersInput(nextValue);
    setIsDirty(true);
  };
  const handleInteractionTypeChange = (interactionType: AutoTradeInteractionType, checked: boolean) => {
    const current = twitterSnipe?.interactionTypes ?? [];
    const next = checked
      ? Array.from(new Set([...current, interactionType]))
      : current.filter((x) => x !== interactionType);
    updateTwitterSnipe({ interactionTypes: next });
  };
  const handleTriggerSoundChange = (value: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      setIsDirty(true);
      if (value === SOUND_OFF) return { ...prev, triggerSound: { ...prev.triggerSound, enabled: false } };
      return { ...prev, triggerSound: { ...prev.triggerSound, enabled: true, preset: value as TradeSuccessSoundPreset } };
    });
  };
  const handlePreviewTriggerSound = () => {
    const preset = draft?.triggerSound.preset ?? 'Boom';
    previewSound.ensureReady();
    previewSound.playPreset(preset);
  };
  const handleDeleteTweetSoundChange = (value: string) => {
    if (value === SOUND_OFF) {
      updateTwitterSnipe({ deleteTweetPlaySound: false } as any);
      return;
    }
    updateTwitterSnipe({ deleteTweetPlaySound: true, deleteTweetSoundPreset: value as TradeSuccessSoundPreset } as any);
  };
  const handlePreviewDeleteTweetSound = () => {
    if (deleteTweetSoundSelectValue === SOUND_OFF) return;
    previewSound.ensureReady();
    previewSound.playPreset(deleteTweetSoundPreset);
  };

  if (!active || !draft) return null;

  return (
    <>
      <div className="dagobang-scrollbar p-3 space-y-3 max-h-[64vh] overflow-y-auto">
        {view === 'config' ? (
          <>
            <XSniperBasicSection
              open={configSectionOpen.basic}
              canEdit={canEdit}
              wsMonitorEnabled={wsMonitorEnabled}
              twitterSnipe={twitterSnipe}
              targetUsersInput={targetUsersInput}
              presetJsonInput={presetJsonInput}
              activeSnipePresetId={activeSnipePresetId}
              snipePresets={snipePresets}
              activeSnipePreset={activeSnipePreset}
              tt={tt}
              onToggle={() => toggleConfigSection('basic')}
              onWsMonitorEnabledChange={(next) => {
                void handleWsMonitorEnabledChange(next);
              }}
              onTwitterSnipeEnabledChange={(checked) => updateTwitterSnipe({ enabled: checked })}
              onDryRunChange={(checked) => updateTwitterSnipe({ dryRun: checked })}
              onAddPresetFromCurrent={addPresetFromCurrent}
              onRemoveActivePreset={removeActivePreset}
              onApplyActivePreset={applyActivePreset}
              onActivePresetNameChange={handleActivePresetNameChange}
              onPresetJsonInputChange={setPresetJsonInput}
              onImportPresetFromJson={importPresetFromJson}
              onExportActivePresetAsJson={exportActivePresetAsJson}
              onTargetUsersInputChange={handleTargetUsersInputChange}
              onInteractionTypeChange={handleInteractionTypeChange}
              onBuyAmountBnbChange={(value) => updateTwitterSnipe({ buyAmountBnb: value })}
              onBuyNewCaCountChange={(value) => updateTwitterSnipe({ buyNewCaCount: value })}
            />
            <XSniperFilterSection
              open={configSectionOpen.filter}
              canEdit={canEdit}
              twitterSnipe={twitterSnipe}
              tt={tt}
              onToggle={() => toggleConfigSection('filter')}
              updateTwitterSnipe={updateTwitterSnipe}
            />
            <XSniperWsConfirmSection
              open={configSectionOpen.wsConfirm}
              canEdit={canEdit}
              twitterSnipe={twitterSnipe}
              tt={tt}
              onToggle={() => toggleConfigSection('wsConfirm')}
              updateTwitterSnipe={updateTwitterSnipe}
            />
            <XSniperRapidSection
              open={configSectionOpen.rapid}
              canEdit={canEdit}
              rapidExitEnabled={rapidExitEnabled}
              twitterSnipe={twitterSnipe}
              tt={tt}
              onToggle={() => toggleConfigSection('rapid')}
              updateTwitterSnipe={updateTwitterSnipe}
              getRapidTypeEnabled={getRapidTypeEnabled}
              getRapidTypeValue={getRapidTypeValue}
              getRapidTypeFallbackValue={getRapidTypeFallbackValue}
              updateRapidTypeValue={updateRapidTypeValue}
            />
            <XSniperSoundSection
              open={configSectionOpen.sellSound}
              canEdit={canEdit}
              soundOffValue={SOUND_OFF}
              soundSelectValue={soundSelectValue}
              deleteTweetSoundSelectValue={deleteTweetSoundSelectValue}
              deleteTweetSoundPreset={deleteTweetSoundPreset}
              twitterSnipe={twitterSnipe}
              presetOptions={presetOptions}
              tt={tt}
              onToggle={() => toggleConfigSection('sellSound')}
              onTriggerSoundChange={handleTriggerSoundChange}
              onPreviewTriggerSound={handlePreviewTriggerSound}
              onAutoSellEnabledChange={(checked) => updateTwitterSnipe({ autoSellEnabled: checked })}
              onDeleteTweetSellPercentChange={(value) => updateTwitterSnipe({ deleteTweetSellPercent: value })}
              onDeleteTweetSoundChange={handleDeleteTweetSoundChange}
              onPreviewDeleteTweetSound={handlePreviewDeleteTweetSound}
            />
          </>
        ) : null}
        {view === 'config' ? (
          <XSniperWsStatusSection
            wsStatus={wsStatus}
            showLogs={showLogs}
            tt={tt}
            onToggleLogs={() => setShowLogs((v) => !v)}
          />
        ) : null}
        {view === 'history' ? (
          <XSniperHistoryView
            siteInfo={siteInfo}
            settings={settings}
            isUnlocked={isUnlocked}
            canEdit={canEdit}
            tt={tt}
            buyHistory={buyHistory}
            historyGroups={historyGroups}
            latestTokenByAddr={latestTokenByAddr}
            athMcapByAddr={athMcapByAddr}
            onClearHistory={() => {
              void (async () => {
                try {
                  await clearXSniperHistory();
                  await browser.storage.local.remove(BOUGHT_ONCE_STORAGE_KEY);
                } finally {
                  setBuyHistory([]);
                }
              })();
            }}
          />
        ) : null}
      </div>

      {view === 'config' ? (
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
                const currentSnipe = (mergedDraft as any).twitterSnipe ?? {};
                const presets = Array.isArray(currentSnipe.presets) ? currentSnipe.presets : [];
                const activeId = typeof currentSnipe.activePresetId === 'string' ? currentSnipe.activePresetId : '';
                const strategyPatch = { ...currentSnipe };
                delete (strategyPatch as any).presets;
                delete (strategyPatch as any).activePresetId;
                const nextPresets = presets.map((item: any) => {
                  if (!item || item.id !== activeId) return item;
                  return {
                    ...item,
                    strategy: {
                      ...(item.strategy ?? {}),
                      ...strategyPatch,
                    },
                  };
                });
                (mergedDraft as any).twitterSnipe = {
                  ...currentSnipe,
                  presets: nextPresets,
                  activePresetId: activeId,
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
      ) : null}
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
