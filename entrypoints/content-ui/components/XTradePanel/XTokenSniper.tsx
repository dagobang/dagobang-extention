import { useEffect, useMemo, useRef, useState } from 'react';
import { isAddress } from 'viem';
import { browser } from 'wxt/browser';
import { TRADE_SUCCESS_SOUND_PRESETS, type Settings, type TokenSnipeBuyMethod, type TokenSnipeTask, type TokenSnipeTaskRuntimeStatus, type TradeSuccessSoundPreset } from '@/types/extention';
import { call } from '@/utils/messaging';
import { defaultSettings } from '@/utils/defaults';
import { type SiteInfo } from '@/utils/sites';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { TOKEN_SNIPER_HISTORY_STORAGE_KEY, TOKEN_SNIPER_STATUS_STORAGE_KEY } from '@/services/tokenSniper/tokenSniperTrade';
import { TokenAPI } from '@/hooks/TokenAPI';
import { XTokenSniperTaskList } from '@/entrypoints/content-ui/components/XTradePanel/XTokenSniperTaskList';
import { XTokenSniperOrderHistory, type TokenSniperOrderRecord } from '@/entrypoints/content-ui/components/XTradePanel/XTokenSniperOrderHistory';

type XTokenSniperContentProps = {
  siteInfo: SiteInfo | null;
  active: boolean;
  settings: Settings | null;
  isUnlocked: boolean;
};

type TokenSnipeDraft = {
  enabled: boolean;
  targetUsers: string[];
  playSound: boolean;
  soundPreset: TradeSuccessSoundPreset;
  tasks: TokenSnipeTask[];
};

const parseList = (value: string) =>
  value
    .split(/[\n,]/)
    .flatMap((x) => x.split(/\s+/))
    .map((x) => x.trim())
    .filter(Boolean);

const parseCommaOrLineList = (value: string) =>
  value
    .split(/[\n,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

const createTaskId = () => `token-task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const MIN_BRIBE_BNB = 0.000025;
const TWEET_TYPE_OPTIONS: Array<{ value: 'tweet' | 'reply' | 'quote' | 'retweet' | 'follow'; label: string }> = [
  { value: 'tweet', label: 'tweet' },
  { value: 'reply', label: 'reply' },
  { value: 'quote', label: 'quote' },
  { value: 'retweet', label: 'retweet' },
  { value: 'follow', label: 'follow' },
];
const BUY_METHOD_OPTIONS: Array<{ value: TokenSnipeBuyMethod; labelKey: string }> = [
  { value: 'all', labelKey: 'contentUi.tokenSniper.buyMethodAll' },
  { value: 'dagobang', labelKey: 'contentUi.tokenSniper.buyMethodDagobang' },
  { value: 'gmgn', labelKey: 'contentUi.tokenSniper.buyMethodGmgn' },
];
const normalizeBuyMethod = (task: TokenSnipeTask | null | undefined): TokenSnipeBuyMethod => {
  const raw = typeof (task as any)?.buyMethod === 'string' ? String((task as any).buyMethod).trim().toLowerCase() : '';
  if (raw === 'all' || raw === 'dagobang' || raw === 'gmgn') return raw;
  return 'dagobang';
};
const normalizeTaskTweetTypes = (task: TokenSnipeTask) => {
  const fromArray = Array.isArray((task as any)?.tweetTypes)
    ? (task as any).tweetTypes
      .map((x: any) => String(x).trim().toLowerCase())
      .filter((x: string) => TWEET_TYPE_OPTIONS.some((opt) => opt.value === x))
    : [];
  if (fromArray.length) return Array.from(new Set(fromArray)) as Array<(typeof TWEET_TYPE_OPTIONS)[number]['value']>;
  if (task.tweetType === 'all') return TWEET_TYPE_OPTIONS.map((x) => x.value);
  if (TWEET_TYPE_OPTIONS.some((opt) => opt.value === task.tweetType)) return [task.tweetType as any];
  return TWEET_TYPE_OPTIONS.map((x) => x.value);
};
const normalizeTokenSnipe = (settings: Settings | null | undefined): TokenSnipeDraft => {
  const defaults = defaultSettings().autoTrade.tokenSnipe;
  const raw = (settings as any)?.autoTrade?.tokenSnipe ?? null;
  const merged = !raw ? defaults : { ...defaults, ...raw };
  return {
    enabled: merged.enabled !== false,
    targetUsers: Array.isArray(merged.targetUsers) ? merged.targetUsers.map((x: any) => String(x).trim()).filter(Boolean) : [],
    playSound: merged.playSound !== false,
    soundPreset: TRADE_SUCCESS_SOUND_PRESETS.includes((merged as any).soundPreset) ? (merged as any).soundPreset : 'Boom',
    tasks: Array.isArray(merged.tasks) ? (merged.tasks as TokenSnipeTask[]) : [],
  };
};

export function XTokenSniperContent({
  siteInfo,
  active,
  settings,
  isUnlocked,
}: XTokenSniperContentProps) {
  const resolvedSettings = useMemo<Settings | null>(() => {
    if (settings) return settings;
    return (window as any).__DAGOBANG_SETTINGS__ ?? null;
  }, [settings]);
  const locale: Locale = normalizeLocale(resolvedSettings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const normalized = useMemo(() => normalizeTokenSnipe(resolvedSettings), [resolvedSettings]);
  const normalizedKey = useMemo(() => JSON.stringify(normalized), [normalized]);
  const wsMonitorEnabled = resolvedSettings?.autoTrade?.wsMonitorEnabled !== false;
  const [enabled, setEnabled] = useState(normalized.enabled);
  const [tasks, setTasks] = useState<TokenSnipeTask[]>(normalized.tasks);
  const [taskStatusById, setTaskStatusById] = useState<Record<string, TokenSnipeTaskRuntimeStatus>>({});
  const [orderHistory, setOrderHistory] = useState<TokenSniperOrderRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'tasks' | 'history'>('tasks');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [expandedTaskById, setExpandedTaskById] = useState<Record<string, boolean>>({});
  const reloadTimerRef = useRef<number | null>(null);
  const reloadingRef = useRef(false);

  const [tokenAddressInput, setTokenAddressInput] = useState('');
  const [tokenSymbolInput, setTokenSymbolInput] = useState('');
  const [tokenNameInput, setTokenNameInput] = useState('');
  const [tweetTypesInput, setTweetTypesInput] = useState<Array<(typeof TWEET_TYPE_OPTIONS)[number]['value']>>(TWEET_TYPE_OPTIONS.map((x) => x.value));
  const [targetUrlsInput, setTargetUrlsInput] = useState('');
  const [keywordsInput, setKeywordsInput] = useState('');
  const [autoBuyInput, setAutoBuyInput] = useState(true);
  const [buyAmountInput, setBuyAmountInput] = useState('0.01');
  const [buyGasGweiInput, setBuyGasGweiInput] = useState('');
  const [buyBribeBnbInput, setBuyBribeBnbInput] = useState('');
  const [buyMethodInput, setBuyMethodInput] = useState<TokenSnipeBuyMethod>('dagobang');
  const [autoSellInput, setAutoSellInput] = useState(true);

  const [targetUsersInput, setTargetUsersInput] = useState(normalized.targetUsers.join('\n'));

  useEffect(() => {
    if (!active) return;
    setEnabled(normalized.enabled);
    setTasks(normalized.tasks);
    setTargetUsersInput(normalized.targetUsers.join('\n'));
  }, [active, normalizedKey]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const reloadWindowMs = 100;
    const loadStatus = async () => {
      try {
        const res = await browser.storage.local.get(TOKEN_SNIPER_STATUS_STORAGE_KEY);
        const raw = (res as any)?.[TOKEN_SNIPER_STATUS_STORAGE_KEY];
        if (cancelled) return;
        if (!raw || typeof raw !== 'object') {
          setTaskStatusById({});
          return;
        }
        setTaskStatusById(raw as Record<string, TokenSnipeTaskRuntimeStatus>);
      } catch {
      }
    };
    const reloadAll = async () => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      try {
        await Promise.all([loadStatus(), loadOrderHistory()]);
      } finally {
        reloadingRef.current = false;
      }
    };
    const scheduleReload = () => {
      if (reloadTimerRef.current != null) return;
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void reloadAll();
      }, reloadWindowMs);
    };
    const loadOrderHistory = async () => {
      try {
        const res = await browser.storage.local.get(TOKEN_SNIPER_HISTORY_STORAGE_KEY);
        const raw = (res as any)?.[TOKEN_SNIPER_HISTORY_STORAGE_KEY];
        if (cancelled) return;
        if (!Array.isArray(raw)) {
          setOrderHistory([]);
          return;
        }
        setOrderHistory(raw as TokenSniperOrderRecord[]);
      } catch {
      }
    };
    void reloadAll();
    const onMessage = (message: any) => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'bg:stateChanged' || message.type === 'bg:tokenSniper:matched') {
        scheduleReload();
        return;
      }
      if (message.type === 'bg:tradeSuccess' && message?.source === 'tokenSniper') {
        scheduleReload();
        return;
      }
      if (message.type === 'bg:tradeSuccess') {
        scheduleReload();
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      cancelled = true;
      if (reloadTimerRef.current != null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, [active]);

  const persistTokenSnipe = async (patch: Partial<TokenSnipeDraft>) => {
    if (!resolvedSettings) return false;
    setSaving(true);
    setError('');
    try {
      const latest = normalizeTokenSnipe(resolvedSettings);
      const nextTokenSnipe = {
        ...latest,
        enabled,
        tasks,
        targetUsers: parseList(targetUsersInput),
        ...patch,
      };
      const nextSettings: Settings = {
        ...resolvedSettings,
        autoTrade: {
          ...(resolvedSettings as any).autoTrade,
          tokenSnipe: nextTokenSnipe,
        } as any,
      };
      (window as any).__DAGOBANG_SETTINGS__ = nextSettings;
      await call({ type: 'settings:set', settings: nextSettings } as const);
      return true;
    } catch (e: any) {
      setError(String(e?.message || tt('contentUi.tokenSniper.errorSaveFailed')));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveEnabled = async (checked: boolean) => {
    setEnabled(checked);
    await persistTokenSnipe({ enabled: checked });
  };

  const resetTaskForm = () => {
    setEditTaskId(null);
    const tokenAddress = siteInfo?.tokenAddress && isAddress(siteInfo.tokenAddress) ? siteInfo.tokenAddress : '';
    setTokenAddressInput(tokenAddress);
    setTokenSymbolInput('');
    setTokenNameInput('');
    setTweetTypesInput(TWEET_TYPE_OPTIONS.map((x) => x.value));
    setTargetUrlsInput('');
    setKeywordsInput('');
    setAutoBuyInput(true);
    setBuyAmountInput('0.01');
    setBuyGasGweiInput('');
    setBuyBribeBnbInput('');
    setBuyMethodInput('dagobang');
    setAutoSellInput(true);
  };

  const openCreateModal = () => {
    resetTaskForm();
    setError('');
    setShowAddModal(true);
  };

  const openEditModal = (task: TokenSnipeTask) => {
    setEditTaskId(task.id);
    setTokenAddressInput(task.tokenAddress);
    setTokenSymbolInput(task.tokenSymbol ?? '');
    setTokenNameInput(task.tokenName ?? '');
    setTweetTypesInput(normalizeTaskTweetTypes(task));
    setTargetUrlsInput(Array.isArray(task.targetUrls) ? task.targetUrls.join('\n') : '');
    setKeywordsInput(Array.isArray(task.keywords) ? task.keywords.join('\n') : '');
    setAutoBuyInput(task.autoBuy);
    setBuyAmountInput(task.buyAmountNative);
    setBuyGasGweiInput(typeof task.buyGasGwei === 'string' ? task.buyGasGwei : '');
    setBuyBribeBnbInput(typeof task.buyBribeBnb === 'string' ? task.buyBribeBnb : '');
    setBuyMethodInput(normalizeBuyMethod(task));
    setAutoSellInput(task.autoSell);
    setError('');
    setShowAddModal(true);
  };

  useEffect(() => {
    if (!showAddModal || editTaskId) return;
    const tokenAddress = tokenAddressInput.trim();
    if (!tokenAddress || !isAddress(tokenAddress)) return;
    if (!siteInfo?.platform || !siteInfo?.chain) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const info = await TokenAPI.getTokenInfo(siteInfo.platform, siteInfo.chain, tokenAddress);
        if (cancelled || !info) return;
        setTokenSymbolInput((prev) => (prev.trim() ? prev : (info.symbol || '')));
        setTokenNameInput((prev) => (prev.trim() ? prev : (info.name || '')));
      } catch {
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [showAddModal, editTaskId, tokenAddressInput, siteInfo?.platform, siteInfo?.chain]);

  const removeTask = async (id: string) => {
    const nextTasks = tasks.filter((x) => x.id !== id);
    setTasks(nextTasks);
    await persistTokenSnipe({ tasks: nextTasks });
  };

  const saveTask = async () => {
    const tokenAddress = tokenAddressInput.trim();
    if (!isAddress(tokenAddress)) {
      setError(tt('contentUi.tokenSniper.errorInvalidTokenAddress'));
      return;
    }
    const targetUrls = parseList(targetUrlsInput);
    const keywords = parseCommaOrLineList(keywordsInput);
    if (!targetUrls.length && !keywords.length) {
      setError(tt('contentUi.tokenSniper.errorTargetRequired'));
      return;
    }
    const buyBribeBnbRaw = buyBribeBnbInput.trim();
    if (buyBribeBnbRaw) {
      const bribeNum = Number(buyBribeBnbRaw);
      if (!Number.isFinite(bribeNum) || bribeNum < 0 || (bribeNum > 0 && bribeNum < MIN_BRIBE_BNB)) {
        setError(tt('contentUi.tokenSniper.errorInvalidBuyBribeBnb'));
        return;
      }
    }
    const selectedTweetTypes = tweetTypesInput.length
      ? tweetTypesInput
      : TWEET_TYPE_OPTIONS.map((x) => x.value);
    const currentTask = editTaskId ? tasks.find((x) => x.id === editTaskId) : null;
    const nextTask: TokenSnipeTask = {
      id: currentTask?.id ?? createTaskId(),
      chain: resolvedSettings?.chainId ?? 56,
      tokenAddress: tokenAddress as `0x${string}`,
      tokenSymbol: tokenSymbolInput.trim() || undefined,
      tokenName: tokenNameInput.trim() || undefined,
      tweetType: selectedTweetTypes.length === TWEET_TYPE_OPTIONS.length ? 'all' : selectedTweetTypes[0],
      tweetTypes: selectedTweetTypes,
      targetUrls,
      keywords,
      autoBuy: autoBuyInput,
      buyAmountNative: buyAmountInput.trim() || '0',
      buyGasGwei: buyGasGweiInput.trim() || undefined,
      buyBribeBnb: buyBribeBnbRaw || undefined,
      buyMethod: buyMethodInput,
      autoSell: autoSellInput,
      createdAt: currentTask?.createdAt ?? Date.now(),
    };
    const nextTasks = editTaskId ? tasks.map((x) => (x.id === editTaskId ? nextTask : x)) : [nextTask, ...tasks];
    setTasks(nextTasks);
    const ok = await persistTokenSnipe({ tasks: nextTasks });
    if (!ok) return;
    resetTaskForm();
    setShowAddModal(false);
  };

  const saveSettings = async () => {
    const ok = await persistTokenSnipe({
      targetUsers: parseList(targetUsersInput),
    });
    if (ok) setShowSettingsModal(false);
  };

  const clearOrderHistory = async () => {
    try {
      await browser.storage.local.set({ [TOKEN_SNIPER_HISTORY_STORAGE_KEY]: [] } as any);
      setOrderHistory([]);
    } catch {
    }
  };

  if (!active) return null;

  return (
    <div className="px-4 py-2 space-y-2">
      <label
        className="flex items-center gap-2 px-1 py-1 text-[13px] text-zinc-200"
        title={wsMonitorEnabled ? tt('contentUi.tokenSniper.enableDesc') : tt('contentUi.xMonitor.wsMonitorDisabledSniperTip')}
      >
        <input
          type="checkbox"
          className="h-4 w-4 accent-emerald-500"
          checked={enabled}
          disabled={!resolvedSettings || !isUnlocked || saving || !wsMonitorEnabled}
          onChange={(e) => {
            void saveEnabled(e.target.checked);
          }}
        />
        <span className={!wsMonitorEnabled ? 'text-zinc-500' : ''}>{tt('contentUi.tokenSniper.enableShort')}</span>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`rounded-md border px-3 py-1.5 text-[12px] ${activeTab === 'tasks' ? 'border-emerald-500/70 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'}`}
          onClick={() => setActiveTab('tasks')}
        >
          {tt('contentUi.tokenSniper.taskListTab', [tasks.length])}
        </button>
        <button
          type="button"
          className={`rounded-md border px-3 py-1.5 text-[12px] ${activeTab === 'history' ? 'border-emerald-500/70 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'}`}
          onClick={() => setActiveTab('history')}
        >
          {tt('contentUi.tokenSniper.orderHistoryTab', [orderHistory.length])}
        </button>
      </div>

      {activeTab === 'tasks' ? (
        <XTokenSniperTaskList
          tasks={tasks}
          taskStatusById={taskStatusById}
          expandedTaskById={expandedTaskById}
          locale={locale}
          siteInfo={siteInfo}
          canEdit={!saving && !!resolvedSettings && isUnlocked}
          onToggleExpand={(taskId) => setExpandedTaskById((prev) => ({ ...prev, [taskId]: !prev[taskId] }))}
          onEdit={openEditModal}
          onRemove={(taskId) => {
            void removeTask(taskId);
          }}
        />
      ) : (
        <XTokenSniperOrderHistory
          orderHistory={orderHistory}
          locale={locale}
          siteInfo={siteInfo}
          onClear={() => {
            void clearOrderHistory();
          }}
        />
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          disabled={!resolvedSettings || !isUnlocked}
          onClick={openCreateModal}
        >
          {tt('contentUi.tokenSniper.addTask')}
        </button>
        <button
          type="button"
          className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
          disabled={!resolvedSettings || !isUnlocked}
          onClick={() => setShowSettingsModal(true)}
        >
          {tt('contentUi.tokenSniper.sniperSettings')}
        </button>
      </div>

      {showAddModal ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
            <div className="text-[13px] font-semibold text-zinc-100">{editTaskId ? tt('contentUi.tokenSniper.editTask') : tt('contentUi.tokenSniper.newTask')}</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder={tt('contentUi.tokenSniper.tokenAddressPlaceholder')}
                value={tokenAddressInput}
                onChange={(e) => setTokenAddressInput(e.target.value)}
              />
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder={tt('contentUi.tokenSniper.tokenSymbolPlaceholder')}
                value={tokenSymbolInput}
                onChange={(e) => setTokenSymbolInput(e.target.value)}
              />
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder={tt('contentUi.tokenSniper.tokenNamePlaceholder')}
                value={tokenNameInput}
                onChange={(e) => setTokenNameInput(e.target.value)}
              />
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5">
                <div className="mb-1 text-[11px] text-zinc-400">{tt('contentUi.tokenSniper.tweetTypesMulti')}</div>
                <div className="flex flex-wrap gap-2 text-[12px]">
                  {TWEET_TYPE_OPTIONS.map((item) => {
                    const checked = tweetTypesInput.includes(item.value);
                    return (
                      <label key={item.value} className="inline-flex items-center gap-1 text-zinc-300">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-emerald-500"
                          checked={checked}
                          onChange={(e) => {
                            const nextChecked = e.target.checked;
                            setTweetTypesInput((prev) => {
                              const next = nextChecked
                                ? [...prev, item.value]
                                : prev.filter((x) => x !== item.value);
                              return Array.from(new Set(next));
                            });
                          }}
                        />
                        <span>{tt(`contentUi.autoTradeStrategy.interaction.${item.label}`)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <textarea
              className="w-full min-h-[72px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
              placeholder={tt('contentUi.tokenSniper.targetTweetUrlsPlaceholder')}
              value={targetUrlsInput}
              onChange={(e) => setTargetUrlsInput(e.target.value)}
            />
            <textarea
              className="w-full min-h-[72px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
              placeholder={tt('contentUi.tokenSniper.keywordsPlaceholder')}
              value={keywordsInput}
              onChange={(e) => setKeywordsInput(e.target.value)}
            />
            <div className="grid grid-cols-4 gap-2 text-[12px]">
              <label className="flex items-center gap-2 text-zinc-300">
                <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={autoBuyInput} onChange={(e) => setAutoBuyInput(e.target.checked)} />
                {tt('contentUi.tokenSniper.autoBuy')}
              </label>
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder={tt('contentUi.tokenSniper.buyAmountNativePlaceholder')}
                value={buyAmountInput}
                onChange={(e) => setBuyAmountInput(e.target.value)}
              />
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder={tt('contentUi.tokenSniper.buyGasGweiPlaceholder')}
                value={buyGasGweiInput}
                onChange={(e) => setBuyGasGweiInput(e.target.value)}
              />
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder={tt('contentUi.tokenSniper.buyBribeBnbPlaceholder')}
                value={buyBribeBnbInput}
                onChange={(e) => setBuyBribeBnbInput(e.target.value)}
              />
              <div className="col-span-4 space-y-1">
                <div className="text-[11px] text-zinc-400">{tt('contentUi.tokenSniper.buyMethodTitle')}</div>
                <div className="grid grid-cols-3 gap-1">
                  {BUY_METHOD_OPTIONS.map((option) => {
                    const active = buyMethodInput === option.value;
                    const toneClass = option.value === 'all'
                      ? (active ? 'border-violet-400 bg-violet-500/20 text-violet-200' : 'border-violet-500/30 bg-zinc-900 text-violet-300')
                      : option.value === 'gmgn'
                        ? (active ? 'border-sky-400 bg-sky-500/20 text-sky-200' : 'border-sky-500/30 bg-zinc-900 text-sky-300')
                        : (active ? 'border-emerald-400 bg-emerald-500/20 text-emerald-200' : 'border-emerald-500/30 bg-zinc-900 text-emerald-300');
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`rounded-md border px-2 py-1.5 text-[12px] transition-colors ${toneClass}`}
                        onClick={() => setBuyMethodInput(option.value)}
                      >
                        {tt(option.labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="col-span-4 flex items-center gap-2 text-zinc-300">
                <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={autoSellInput} onChange={(e) => setAutoSellInput(e.target.checked)} />
                {tt('contentUi.tokenSniper.autoSell')}
              </label>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-200"
                onClick={() => {
                  setShowAddModal(false);
                  resetTaskForm();
                }}
              >
                {tt('common.cancel')}
              </button>
              <button
                type="button"
                className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-200 disabled:opacity-50"
                disabled={saving}
                onClick={() => {
                  void saveTask();
                }}
              >
                {editTaskId ? tt('contentUi.tokenSniper.saveChanges') : tt('contentUi.tokenSniper.saveTask')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showSettingsModal ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-3">
            <div className="text-[13px] font-semibold text-zinc-100">{tt('contentUi.tokenSniper.settingsTitle')}</div>
            <div className="space-y-1">
              <div className="text-[12px] text-zinc-400">{tt('contentUi.tokenSniper.targetUsersHint')}</div>
              <textarea
                className="w-full min-h-[72px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                value={targetUsersInput}
                onChange={(e) => setTargetUsersInput(e.target.value)}
                placeholder={tt('contentUi.tokenSniper.targetUsersPlaceholder')}
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-200"
                onClick={() => setShowSettingsModal(false)}
              >
                {tt('common.cancel')}
              </button>
              <button
                type="button"
                className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-200 disabled:opacity-50"
                disabled={saving}
                onClick={() => {
                  void saveSettings();
                }}
              >
                {tt('contentUi.tokenSniper.saveSettings')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="text-[12px] text-rose-300">{error}</div> : null}
    </div>
  );
}
