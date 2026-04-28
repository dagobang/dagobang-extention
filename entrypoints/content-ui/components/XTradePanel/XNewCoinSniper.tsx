import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { browser } from 'wxt/browser';
import type { AutoTradeNewCoinSnipeConfig, NewCoinXmodeSnipeTask, Settings, XSniperBuyRecord } from '@/types/extention';
import { call } from '@/utils/messaging';
import { NEW_COIN_SNIPER_HISTORY_STORAGE_KEY, type NewCoinSniperOrderRecord } from '@/services/newCoinSniper/newCoinSniperHistory';
import { type SiteInfo } from '@/utils/sites';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { defaultSettings } from '@/utils/defaults';
import { XSniperHistoryView } from './XSniperHistoryView';
import { XSniperFilterSection } from './XSniperFilterSection';
import { XSniperRapidSection } from './XSniperRapidSection';
import { XSniperWsConfirmSection } from './XSniperWsConfirmSection';
import { PLATFORM_OPTIONS, extractLaunchpadPlatform } from '@/constants/launchpad';

type XNewCoinSniperContentProps = {
  siteInfo: SiteInfo | null;
  active: boolean;
  view?: 'config' | 'history';
  onOpenConfig?: () => void;
  onOpenTaskManager?: () => void;
  configMode?: 'full' | 'task';
  settings: Settings | null;
  isUnlocked: boolean;
};

type NewCoinHistoryGroup = {
  key: string;
  parent: NewCoinSniperOrderRecord;
  children: NewCoinSniperOrderRecord[];
};

const normalizePlatforms = (input: unknown): string[] => {
  const raw = Array.isArray(input) ? input : [];
  const list = raw
    .map((x) => String(x).trim().toLowerCase())
    .filter((x) => PLATFORM_OPTIONS.some((p) => p.value === x));
  return list.length ? Array.from(new Set(list)) : PLATFORM_OPTIONS.map((x) => x.value);
};

const normalizeTaskKeywords = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)));
};

const normalizeXmodeTasks = (input: unknown): NewCoinXmodeSnipeTask[] => {
  const raw = Array.isArray(input) ? input : [];
  const tasks: NewCoinXmodeSnipeTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as any).id || '').trim();
    if (!id) continue;
    tasks.push({
      id,
      enabled: (item as any).enabled !== false,
      taskName: String((item as any).taskName || '').trim(),
      keywords: normalizeTaskKeywords((item as any).keywords),
      matchMode: (item as any).matchMode === 'all' ? 'all' : 'any',
      maxTokenAgeSeconds: String((item as any).maxTokenAgeSeconds ?? '600'),
      buyAmountBnb: String((item as any).buyAmountBnb ?? ''),
      buyGasGwei: String((item as any).buyGasGwei ?? ''),
      buyBribeBnb: String((item as any).buyBribeBnb ?? ''),
      autoSellEnabled: (item as any).autoSellEnabled !== false,
      createdAt: Number((item as any).createdAt) > 0 ? Number((item as any).createdAt) : Date.now(),
    });
  }
  return tasks;
};

const normalizeNewCoinStrategy = (input: unknown): AutoTradeNewCoinSnipeConfig => {
  const base = defaultSettings().autoTrade.newCoinSnipe as AutoTradeNewCoinSnipeConfig;
  const merged = {
    ...base,
    ...(input && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
  } as AutoTradeNewCoinSnipeConfig;
  return {
    ...merged,
    signalSources: normalizeSources((merged as any).signalSources),
    platforms: normalizePlatforms((merged as any).platforms),
    xmodeTasks: normalizeXmodeTasks((merged as any).xmodeTasks),
  };
};

const normalizeSources = (input: unknown): Array<'new_pool' | 'token_update'> => {
  const raw = Array.isArray(input) ? input : [];
  const list = raw
    .map((x) => String(x).trim())
    .filter((x): x is 'new_pool' | 'token_update' => x === 'new_pool' || x === 'token_update');
  return list.length ? Array.from(new Set(list)) : ['new_pool', 'token_update'];
};

export function XNewCoinSniperContent({
  siteInfo,
  active,
  view = 'history',
  onOpenConfig,
  onOpenTaskManager,
  configMode = 'full',
  settings,
  isUnlocked,
}: XNewCoinSniperContentProps) {
  const resolvedSettings = useMemo<Settings | null>(() => {
    if (settings) return settings;
    return (window as any).__DAGOBANG_SETTINGS__ ?? null;
  }, [settings]);
  const locale: Locale = normalizeLocale(resolvedSettings?.locale ?? 'zh_CN');
  const ttBase = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const tt = (key: string, subs?: Array<string | number>) => {
    if (key === 'contentUi.autoTradeStrategy.twitterSnipeEnabledShort') return '自动狙击启用';
    if (key === 'contentUi.autoTradeStrategy.twitterSnipeEnabledDesc') return '开启后监听 new_pool / token_update 自动狙击';
    if (key === 'contentUi.autoTradeStrategy.twitterSnipeDesc') return '基于 WS 的 new_pool / token_update 信号自动执行新币狙击';
    if (key === 'contentUi.autoTradeStrategy.twitterSnipeDryRunShort') return 'Dry Run';
    if (key === 'contentUi.autoTradeStrategy.twitterSnipeDryRun') return 'Dry Run（仅记录，不真实下单）';
    if (key === 'contentUi.autoTradeStrategy.snipeSettings') return '策略配置';
    return ttBase(key, subs);
  };
  const wsMonitorEnabled = resolvedSettings?.autoTrade?.wsMonitorEnabled !== false;
  const strategy = useMemo(
    () => normalizeNewCoinStrategy((resolvedSettings?.autoTrade as any)?.newCoinSnipe ?? null),
    [resolvedSettings?.autoTrade]
  );
  const strategyKey = useMemo(() => JSON.stringify(strategy), [strategy]);

  const [draft, setDraft] = useState<AutoTradeNewCoinSnipeConfig>(() => strategy);
  const [isDirty, setIsDirty] = useState(false);
  const [configSectionOpen, setConfigSectionOpen] = useState<Record<string, boolean>>({
    basic: true,
    tasks: true,
    filter: false,
    wsConfirm: false,
    rapid: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [taskManagerOnly, setTaskManagerOnly] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [expandedTaskById, setExpandedTaskById] = useState<Record<string, boolean>>({});
  const [taskModalMode, setTaskModalMode] = useState<'create' | 'edit' | null>(null);
  const [taskEditor, setTaskEditor] = useState<NewCoinXmodeSnipeTask | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string>('');
  const [history, setHistory] = useState<NewCoinSniperOrderRecord[]>([]);
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

  useEffect(() => {
    if (isDirty) return;
    setDraft(strategy);
  }, [strategyKey, strategy, isDirty]);

  useEffect(() => {
    if (view !== 'config') return;
    if (configMode === 'task') {
      setTaskManagerOnly(true);
      setConfigSectionOpen((prev) => ({ ...prev, basic: false, tasks: true, filter: false, wsConfirm: false, rapid: false }));
      return;
    }
    setTaskManagerOnly(false);
  }, [view, configMode]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await browser.storage.local.get(NEW_COIN_SNIPER_HISTORY_STORAGE_KEY);
        const raw = (res as any)?.[NEW_COIN_SNIPER_HISTORY_STORAGE_KEY];
        if (cancelled) return;
        setHistory(Array.isArray(raw) ? (raw as NewCoinSniperOrderRecord[]) : []);
      } catch {
        if (!cancelled) setHistory([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onChanged = (changes: Record<string, any>, areaName: string) => {
      if (areaName !== 'local') return;
      const next = changes?.[NEW_COIN_SNIPER_HISTORY_STORAGE_KEY]?.newValue;
      if (!Array.isArray(next)) return;
      setHistory(next as NewCoinSniperOrderRecord[]);
    };
    browser.storage.onChanged.addListener(onChanged as any);
    return () => browser.storage.onChanged.removeListener(onChanged as any);
  }, [active]);

  useEffect(() => {
    const listener = (message: any) => {
      if (!message || message.type !== 'bg:newCoinSniper:order') return;
      const record = message.record as NewCoinSniperOrderRecord | undefined;
      if (!record || typeof record.tokenAddress !== 'string') return;
      setHistory((prev) => [record, ...prev].slice(0, 300));
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

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

  const normalizedHistory = useMemo(
    () =>
      history.map((record) => {
        const launchpadPlatform = extractLaunchpadPlatform(record as any);
        return launchpadPlatform
          ? ({ ...record, launchpadPlatform } as NewCoinSniperOrderRecord)
          : record;
      }),
    [history],
  );
  const historyGroups = useMemo<NewCoinHistoryGroup[]>(() => {
    if (!normalizedHistory.length) return [];
    const sortedAsc = normalizedHistory
      .slice()
      .sort((a, b) => {
        const ta = Number(a.tsMs) || 0;
        const tb = Number(b.tsMs) || 0;
        if (ta !== tb) return ta - tb;
        return String(a.id).localeCompare(String(b.id));
      });
    const groupsById = new Map<string, NewCoinHistoryGroup>();
    const latestBuyByTokenKey = new Map<string, NewCoinHistoryGroup>();
    const standaloneSellGroups: NewCoinHistoryGroup[] = [];
    for (const r of sortedAsc) {
      const chainId = typeof r.chainId === 'number' ? r.chainId : 0;
      const addr = String(r.tokenAddress || '').toLowerCase();
      const dryFlag = r.dryRun === true ? 'dry' : 'live';
      const tokenKey = `${chainId}:${addr}:${dryFlag}`;
      if (r.side === 'sell') {
        const parentGroup = latestBuyByTokenKey.get(tokenKey);
        if (parentGroup) {
          parentGroup.children.push(r);
        } else {
          standaloneSellGroups.push({ key: `standalone:${r.id}`, parent: r, children: [] });
        }
        continue;
      }
      const group: NewCoinHistoryGroup = { key: r.id, parent: r, children: [] };
      groupsById.set(r.id, group);
      latestBuyByTokenKey.set(tokenKey, group);
    }
    const merged = [...groupsById.values(), ...standaloneSellGroups];
    merged.sort((a, b) => (Number(b.parent.tsMs) || 0) - (Number(a.parent.tsMs) || 0));
    for (const g of merged) {
      g.children.sort((a, b) => (Number(a.tsMs) || 0) - (Number(b.tsMs) || 0));
    }
    return merged;
  }, [normalizedHistory]);
  const canEdit = !!resolvedSettings && isUnlocked;
  const { latestTokenByAddr, athMcapByAddr } = useMemo(() => {
    const latest: Record<string, any> = {};
    const ath: Record<string, number> = {};
    const sorted = normalizedHistory.slice().sort((a, b) => (Number(b.tsMs) || 0) - (Number(a.tsMs) || 0));
    for (const r of sorted) {
      const addr = String(r.tokenAddress || '').toLowerCase();
      if (!addr) continue;
      const mcap = typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) ? r.marketCapUsd : null;
      if (mcap != null) {
        const curAth = ath[addr];
        ath[addr] = typeof curAth === 'number' && Number.isFinite(curAth) ? Math.max(curAth, mcap) : mcap;
      }
      const prev = latest[addr];
      if (!prev) {
        latest[addr] = {
          updatedAtMs: r.tsMs,
          marketCapUsd: r.marketCapUsd,
          holders: r.holders,
          devHoldPercent: r.devHoldPercent,
          devHasSold: r.devHasSold,
          kol: r.kol,
          launchpadPlatform: (r as any).launchpadPlatform,
        };
        continue;
      }
      latest[addr] = {
        updatedAtMs: Math.max(Number(prev.updatedAtMs) || 0, Number(r.tsMs) || 0),
        marketCapUsd:
          typeof prev.marketCapUsd === 'number' && Number.isFinite(prev.marketCapUsd)
            ? prev.marketCapUsd
            : r.marketCapUsd,
        holders:
          typeof prev.holders === 'number' && Number.isFinite(prev.holders)
            ? prev.holders
            : r.holders,
        devHoldPercent:
          typeof prev.devHoldPercent === 'number' && Number.isFinite(prev.devHoldPercent)
            ? prev.devHoldPercent
            : r.devHoldPercent,
        devHasSold:
          typeof prev.devHasSold === 'boolean'
            ? prev.devHasSold
            : r.devHasSold,
        kol:
          typeof prev.kol === 'number' && Number.isFinite(prev.kol)
            ? prev.kol
            : r.kol,
        launchpadPlatform:
          typeof prev.launchpadPlatform === 'string' && prev.launchpadPlatform.trim()
            ? prev.launchpadPlatform
            : (r as any).launchpadPlatform,
      };
    }
    return { latestTokenByAddr: latest, athMcapByAddr: ath };
  }, [normalizedHistory]);

  const persistDraft = async (nextDraft: AutoTradeNewCoinSnipeConfig) => {
    if (!resolvedSettings || !isUnlocked) return;
    setSaving(true);
    setError('');
    try {
      const nextNewCoin = {
        ...nextDraft,
        signalSources: normalizeSources((nextDraft as any).signalSources),
        platforms: normalizePlatforms((nextDraft as any).platforms),
      };
      const nextSettings: Settings = {
        ...resolvedSettings,
        autoTrade: {
          ...(resolvedSettings.autoTrade as any),
          newCoinSnipe: nextNewCoin,
        } as any,
      };
      (window as any).__DAGOBANG_SETTINGS__ = nextSettings;
      await call({ type: 'settings:set', settings: nextSettings } as const);
      setDraft(normalizeNewCoinStrategy(nextNewCoin));
      setIsDirty(false);
    } catch (e: any) {
      setError(String(e?.message || '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const persistQuickPatch = async (patch: Partial<AutoTradeNewCoinSnipeConfig>) => {
    const nextDraft = normalizeNewCoinStrategy({
      ...draft,
      ...patch,
    });
    setDraft(nextDraft);
    await persistDraft(nextDraft);
  };

  const updateDraft = (patch: Partial<AutoTradeNewCoinSnipeConfig>) => {
    setIsDirty(true);
    setDraft((prev) =>
      normalizeNewCoinStrategy({
        ...prev,
        ...patch,
      })
    );
  };

  const openTaskManager = () => {
    if (onOpenTaskManager) {
      onOpenTaskManager();
      return;
    }
    setTaskManagerOnly(true);
    setConfigSectionOpen((prev) => ({
      ...prev,
      basic: false,
      tasks: true,
      filter: false,
      wsConfirm: false,
      rapid: false,
    }));
    onOpenConfig?.();
  };

  const buildNewTask = async () => {
    const now = Date.now();
    let presetKeywords: string[] = [];
    const currentTokenAddress = String(siteInfo?.tokenAddress || '').trim().toLowerCase();
    if (currentTokenAddress.startsWith('0x')) {
      try {
        const metaRes = await call({ type: 'token:getMeta', tokenAddress: currentTokenAddress as `0x${string}` } as const);
        const symbol = String((metaRes as any)?.symbol || '').trim();
        if (symbol) presetKeywords.push(symbol);
      } catch {
      }
      try {
        const tokenInfoRes = await call({
          type: 'token:getTokenInfo:fourmemeHttp',
          platform: siteInfo?.platform ?? 'gmgn',
          chain: String(siteInfo?.chain || 'bsc'),
          address: currentTokenAddress as `0x${string}`,
        } as const);
        const name = String((tokenInfoRes as any)?.tokenInfo?.name || '').trim();
        if (name) presetKeywords.push(name);
      } catch {
      }
    }
    presetKeywords = Array.from(new Set(presetKeywords.map((x) => x.toLowerCase()).filter(Boolean)));
    const newTask: NewCoinXmodeSnipeTask = {
      id: `task_${now}_${Math.floor(Math.random() * 1000)}`,
      enabled: true,
      taskName: '',
      keywords: presetKeywords,
      matchMode: 'any',
      maxTokenAgeSeconds: '600',
      buyAmountBnb: '',
      buyGasGwei: '',
      buyBribeBnb: '',
      autoSellEnabled: true,
      createdAt: now,
    };
    return newTask;
  };

  const openCreateTaskModal = async () => {
    const newTask = await buildNewTask();
    setEditingTaskId('');
    setTaskEditor(newTask);
    setTaskModalMode('create');
  };

  const openEditTaskModal = (task: NewCoinXmodeSnipeTask) => {
    setEditingTaskId(task.id);
    setTaskEditor({
      ...task,
      keywords: [...(task.keywords ?? [])],
    });
    setTaskModalMode('edit');
  };

  const closeTaskModal = () => {
    setTaskModalMode(null);
    setTaskEditor(null);
    setEditingTaskId('');
  };

  const saveTaskModal = () => {
    if (!taskEditor) return;
    const normalized = normalizeXmodeTasks([taskEditor])[0];
    if (!normalized) return;
    const current = normalizeXmodeTasks(draft.xmodeTasks);
    if (taskModalMode === 'create') {
      const next = current.concat(normalized);
      updateDraft({ xmodeTasks: next });
      setSelectedTaskId(normalized.id);
    } else if (taskModalMode === 'edit' && editingTaskId) {
      const next = current.map((item) => (item.id === editingTaskId ? { ...normalized, id: editingTaskId } : item));
      updateDraft({ xmodeTasks: next });
      setSelectedTaskId(editingTaskId);
    }
    closeTaskModal();
  };

  const removeTask = (taskId: string) => {
    const next = normalizeXmodeTasks(draft.xmodeTasks).filter((t) => t.id !== taskId);
    updateDraft({ xmodeTasks: next });
    if (selectedTaskId === taskId) {
      setSelectedTaskId(next[0]?.id ?? '');
    }
  };

  const clearHistory = async () => {
    try {
      await browser.storage.local.set({ [NEW_COIN_SNIPER_HISTORY_STORAGE_KEY]: [] } as any);
      setHistory([]);
    } catch {
    }
  };

  const rapidExitEnabled = draft?.rapidExitEnabled !== false;
  const taskList = normalizeXmodeTasks(draft.xmodeTasks);
  const taskHistoryById = useMemo(() => {
    const grouped: Record<string, NewCoinSniperOrderRecord[]> = {};
    for (const item of normalizedHistory) {
      if (item.strategyMode !== 'xmode_task') continue;
      const taskId = String(item.taskId || '').trim();
      if (!taskId) continue;
      if (!grouped[taskId]) grouped[taskId] = [];
      grouped[taskId].push(item);
    }
    return grouped;
  }, [normalizedHistory]);
  const getTaskRuntimeBadge = (task: NewCoinXmodeSnipeTask) => {
    const list = taskHistoryById[task.id] ?? [];
    const latest = list[0];
    const latestSuccessBuy = list.find((x) => x.side === 'buy' && !x.reason);
    if (latest?.side === 'buy' && latest?.reason) {
      return { text: '命中', className: 'bg-sky-500/15 text-sky-200' };
    }
    if (latestSuccessBuy) {
      return { text: '已买', className: 'bg-emerald-500/15 text-emerald-300' };
    }
    return { text: '待命', className: 'bg-zinc-800 text-zinc-400' };
  };
  const selectedTask = taskList.find((x) => x.id === selectedTaskId) ?? taskList[0] ?? null;
  const updateTaskEditor = (patch: Partial<NewCoinXmodeSnipeTask>) => {
    setTaskEditor((prev) => (prev ? { ...prev, ...patch } : prev));
  };
  const toggleConfigSection = (key: string) => {
    setConfigSectionOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    if (!taskList.length) {
      if (selectedTaskId) setSelectedTaskId('');
      return;
    }
    const exists = taskList.some((x) => x.id === selectedTaskId);
    if (!exists) setSelectedTaskId(taskList[0].id);
  }, [taskList, selectedTaskId]);

  if (!active) return null;

  return (
    <>
      <div className="dagobang-scrollbar p-2 space-y-2 max-h-[64vh] overflow-y-auto">
      {error ? <div className="text-[12px] text-rose-300">{error}</div> : null}

      {view === 'config' ? (
        <>
          {taskManagerOnly ? (
            <div className="flex items-center justify-between rounded-md border border-sky-800/50 bg-sky-950/20 px-2 py-1.5 text-[12px] text-sky-200">
              <span>任务管理（简洁模式）</span>
              <button
                type="button"
                className="rounded border border-sky-700 px-2 py-0.5 text-[11px] text-sky-200 hover:border-sky-500"
                onClick={() => {
                  setTaskManagerOnly(false);
                  setConfigSectionOpen((prev) => ({ ...prev, basic: true, tasks: true }));
                }}
              >
                进入完整设置
              </button>
            </div>
          ) : null}
          {!taskManagerOnly ? (
          <div className="space-y-2 pb-3 border-b border-zinc-800/60">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
              onClick={() => toggleConfigSection('basic')}
            >
              <span>基础策略与方案</span>
              {configSectionOpen.basic ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {configSectionOpen.basic ? (
              <div className="space-y-2">
                <div className="text-xs text-zinc-500">{tt('contentUi.autoTradeStrategy.twitterSnipeDesc')}</div>
                <div className="space-y-2 rounded-md border border-zinc-800/70 bg-zinc-900/30 p-2">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block space-y-1">
                      <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.strategyBuyAmount')}</div>
                      <input
                        type="number"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                        value={draft.buyAmountBnb ?? ''}
                        disabled={!canEdit || saving}
                        onChange={(e) => updateDraft({ buyAmountBnb: e.target.value })}
                      />
                    </label>
                    <label className="block space-y-1">
                      <div className="text-[12px] text-zinc-400">买入CA数量</div>
                      <input
                        type="number"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                        value={draft.buyNewCaCount ?? ''}
                        disabled={!canEdit || saving}
                        onChange={(e) => updateDraft({ buyNewCaCount: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block space-y-1">
                      <div className="text-[12px] text-zinc-400">自动狙击 Gas(Gwei)</div>
                      <input
                        type="number"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                        value={draft.buyGasGwei ?? ''}
                        disabled={!canEdit || saving}
                        onChange={(e) => updateDraft({ buyGasGwei: e.target.value })}
                      />
                    </label>
                    <label className="block space-y-1">
                      <div className="text-[12px] text-zinc-400">自动狙击 贿赂费(BNB)</div>
                      <input
                        type="number"
                        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                        value={draft.buyBribeBnb ?? ''}
                        disabled={!canEdit || saving}
                        onChange={(e) => updateDraft({ buyBribeBnb: e.target.value })}
                      />
                    </label>
                  </div>
                  <div className="text-[11px] text-zinc-500">仅运行当前保存配置，修改后需点击保存生效</div>
                </div>
              </div>
            ) : null}
          </div>
          ) : null}
          <div className="space-y-2 pb-3 border-b border-zinc-800/60">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
              onClick={() => toggleConfigSection('tasks')}
            >
              <span>xmode 联动任务</span>
              {configSectionOpen.tasks ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {configSectionOpen.tasks ? (
              <div className="space-y-2 rounded-md border border-zinc-800/70 bg-zinc-900/30 p-2">
                <div className="flex items-center justify-between text-[11px] text-zinc-400">
                  <span>任务模式仅新增关键词过滤，平台与全局过滤条件共用</span>
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-500"
                    disabled={!canEdit || saving}
                    onClick={() => {
                      void openCreateTaskModal();
                    }}
                  >
                    新增任务
                  </button>
                </div>
                {taskList.length ? (
                  <div className="space-y-1">
                    {taskList.map((task, idx) => {
                      const name = String(task.taskName || '').trim() || `任务 ${idx + 1}`;
                      const kwText = (task.keywords || []).join(', ');
                      const enabled = task.enabled !== false;
                      const expanded = expandedTaskById[task.id] === true;
                      const runtimeBadge = getTaskRuntimeBadge(task);
                      return (
                        <div
                          key={task.id}
                          className={`w-full rounded border px-2 py-1.5 text-left text-[12px] ${
                            selectedTask?.id === task.id
                              ? 'border-sky-600 bg-sky-950/30 text-sky-200'
                              : 'border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex flex-1 items-center gap-1.5">
                              <button
                                type="button"
                                className="text-zinc-400 hover:text-zinc-200"
                                onClick={() => setExpandedTaskById((prev) => ({ ...prev, [task.id]: !prev[task.id] }))}
                              >
                                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                              <button
                                type="button"
                                className="truncate text-left hover:underline"
                                onClick={() => setSelectedTaskId(task.id)}
                              >
                                {name}
                              </button>
                            </div>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}>
                              {enabled ? '启用' : '停用'}
                            </span>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${runtimeBadge.className}`}>{runtimeBadge.text}</span>
                            <button
                              type="button"
                              className="shrink-0 text-[11px] text-zinc-300 hover:text-zinc-100"
                              disabled={!canEdit || saving}
                              onClick={() => {
                                setSelectedTaskId(task.id);
                                openEditTaskModal(task);
                              }}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="shrink-0 text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
                              disabled={!canEdit || saving}
                              onClick={() => removeTask(task.id)}
                            >
                              删除
                            </button>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                            关键词 {task.keywords.length} 个 · 买入 {task.buyAmountBnb || '-'} BNB
                          </div>
                          {expanded ? (
                            <div className="mt-1.5 space-y-1 border-t border-zinc-800/60 pt-1.5 text-[11px] text-zinc-400">
                              <div className="truncate">关键词：{kwText || '无'}</div>
                              <div>匹配：{task.matchMode === 'all' ? '全部命中' : '任意命中'} · 最大币龄：{task.maxTokenAgeSeconds || '600'} 秒</div>
                              <div>Gas：{task.buyGasGwei || '-'} Gwei · 贿赂费：{task.buyBribeBnb || '-'} BNB</div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : <div className="text-[11px] text-zinc-500">暂无任务，点击“新增任务”创建。</div>}
              </div>
            ) : null}
          </div>
          {!taskManagerOnly ? <XSniperFilterSection
            open={configSectionOpen.filter}
            canEdit={canEdit && !saving}
            twitterSnipe={draft}
            tt={tt}
            onToggle={() => toggleConfigSection('filter')}
            updateTwitterSnipe={updateDraft}
            showTweetAge={false}
            platformOptions={[...PLATFORM_OPTIONS]}
          /> : null}
          {!taskManagerOnly ? <XSniperWsConfirmSection
            open={configSectionOpen.wsConfirm}
            canEdit={canEdit && !saving}
            twitterSnipe={draft}
            tt={tt}
            onToggle={() => toggleConfigSection('wsConfirm')}
            updateTwitterSnipe={updateDraft}
          /> : null}
          {!taskManagerOnly ? <XSniperRapidSection
            open={configSectionOpen.rapid}
            canEdit={canEdit && !saving}
            rapidExitEnabled={rapidExitEnabled}
            twitterSnipe={draft}
            tt={tt}
            onToggle={() => toggleConfigSection('rapid')}
            updateTwitterSnipe={updateDraft}
          /> : null}
        </>
      ) : (
        <XSniperHistoryView
          siteInfo={siteInfo}
          settings={resolvedSettings}
          isUnlocked={isUnlocked}
          canEdit={canEdit}
          tt={tt}
          buyHistory={normalizedHistory as unknown as XSniperBuyRecord[]}
          historyGroups={historyGroups as unknown as Array<{ key: string; parent: XSniperBuyRecord; children: XSniperBuyRecord[] }>}
          latestTokenByAddr={latestTokenByAddr}
          athMcapByAddr={athMcapByAddr}
          wsStatus={wsStatus}
          wsMonitorEnabled={wsMonitorEnabled}
          twitterSnipeEnabled={draft.enabled === true}
          taskModeEnabled={draft.taskModeEnabled !== false}
          twitterSnipeDryRun={draft.dryRun !== false}
          onTwitterSnipeEnabledChange={(next) => {
            void persistQuickPatch(next ? { enabled: true, taskModeEnabled: false } : { enabled: false });
          }}
          onTaskModeEnabledChange={(next) => {
            void persistQuickPatch(next ? { taskModeEnabled: true, enabled: false } : { taskModeEnabled: false });
          }}
          onTwitterSnipeDryRunChange={(next) => {
            void persistQuickPatch({ dryRun: next });
          }}
          onOpenConfig={() => {
            setTaskManagerOnly(false);
            onOpenConfig?.();
          }}
          onOpenTaskManager={openTaskManager}
          onOpenCreateTask={() => {
            void openCreateTaskModal();
          }}
          onClearHistory={() => {
            void clearHistory();
          }}
        />
      )}
      </div>
      {taskModalMode && taskEditor ? (
        <div className="fixed inset-0 z-[2147483648] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/20">
            <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-3">
              <div className="text-[13px] font-semibold text-emerald-300">
                {taskModalMode === 'create' ? '新增任务' : '编辑任务'}
              </div>
              <button
                type="button"
                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500"
                onClick={closeTaskModal}
              >
                关闭
              </button>
            </div>
            <div className="max-h-[70vh] space-y-2 overflow-y-auto p-4">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-[12px] text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-emerald-500"
                    checked={taskEditor.enabled !== false}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ enabled: e.target.checked })}
                  />
                  <span>启用任务</span>
                </label>
                <label className="flex items-center gap-2 text-[12px] text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-amber-500"
                    checked={taskEditor.autoSellEnabled !== false}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ autoSellEnabled: e.target.checked })}
                  />
                  <span>启用自动卖出</span>
                </label>
              </div>
              <input
                type="text"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                placeholder="任务名称（可选）"
                value={taskEditor.taskName ?? ''}
                disabled={!canEdit || saving}
                onChange={(e) => updateTaskEditor({ taskName: e.target.value })}
              />
              <label className="block space-y-1">
                <div className="text-[11px] text-zinc-400">任务关键词(逗号分隔)</div>
                <input
                  type="text"
                  className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                  placeholder="关键词，逗号分隔"
                  value={taskEditor.keywords.join(', ')}
                  disabled={!canEdit || saving}
                  onChange={(e) =>
                    updateTaskEditor({
                      keywords: Array.from(new Set(e.target.value.split(/[,，]/).map((x) => x.trim().toLowerCase()).filter(Boolean))),
                    })
                  }
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <div className="text-[11px] text-zinc-400">匹配模式</div>
                  <select
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={taskEditor.matchMode === 'all' ? 'all' : 'any'}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ matchMode: e.target.value === 'all' ? 'all' : 'any' })}
                  >
                    <option value="any">任意关键词命中</option>
                    <option value="all">全部关键词命中</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <div className="text-[11px] text-zinc-400">最大币龄(秒)</div>
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={taskEditor.maxTokenAgeSeconds ?? '600'}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ maxTokenAgeSeconds: e.target.value })}
                  />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <div className="text-[11px] text-zinc-400">买入 BNB</div>
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={taskEditor.buyAmountBnb ?? ''}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ buyAmountBnb: e.target.value })}
                  />
                </label>
                <div />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <div className="text-[11px] text-zinc-400">任务 Gas(Gwei)</div>
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={taskEditor.buyGasGwei ?? ''}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ buyGasGwei: e.target.value })}
                  />
                </label>
                <label className="block space-y-1">
                  <div className="text-[11px] text-zinc-400">任务 贿赂费(BNB)</div>
                  <input
                    type="number"
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                    value={taskEditor.buyBribeBnb ?? ''}
                    disabled={!canEdit || saving}
                    onChange={(e) => updateTaskEditor({ buyBribeBnb: e.target.value })}
                  />
                </label>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-800/60 px-4 py-3">
              <button
                type="button"
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500"
                onClick={closeTaskModal}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
                disabled={!canEdit || saving}
                onClick={saveTaskModal}
              >
                保存任务
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {view === 'config' ? (
        <div className="flex items-center justify-end px-4 py-3 border-t border-zinc-800/60">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500"
              onClick={() => {
                setIsDirty(false);
                setError('');
                setDraft(strategy);
              }}
            >
              {tt('contentUi.autoTradeStrategy.reset')}
            </button>
            <button
              type="button"
              className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
              disabled={!canEdit || saving || !isDirty}
              onClick={() => {
                void persistDraft(draft);
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
