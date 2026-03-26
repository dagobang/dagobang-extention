import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Play, Trash2 } from 'lucide-react';
import { isAddress } from 'viem';
import { browser } from 'wxt/browser';
import { TRADE_SUCCESS_SOUND_PRESETS, type Settings, type TokenSnipeTask, type TokenSnipeTaskRuntimeStatus, type TradeSuccessSoundPreset } from '@/types/extention';
import { call } from '@/utils/messaging';
import { defaultSettings } from '@/utils/defaults';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';
import { TOKEN_SNIPER_STATUS_STORAGE_KEY } from '@/services/tokenSniper/tokenSniperTrade';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import { TokenAPI } from '@/hooks/TokenAPI';
import { formatAgeShort, formatShortAddress } from '@/utils/format';

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

const createTaskId = () => `token-task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const SOUND_OFF = '__off__';
const TWEET_TYPE_OPTIONS: Array<{ value: 'tweet' | 'reply' | 'quote' | 'retweet' | 'follow'; label: string }> = [
  { value: 'tweet', label: 'tweet' },
  { value: 'reply', label: 'reply' },
  { value: 'quote', label: 'quote' },
  { value: 'retweet', label: 'retweet' },
  { value: 'follow', label: 'follow' },
];
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
const formatTweetTypesLabel = (types: Array<(typeof TWEET_TYPE_OPTIONS)[number]['value']>) => {
  if (types.length >= TWEET_TYPE_OPTIONS.length) return '全部类型';
  return types.join('/');
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
  const normalized = useMemo(() => normalizeTokenSnipe(resolvedSettings), [resolvedSettings]);
  const normalizedKey = useMemo(() => JSON.stringify(normalized), [normalized]);
  const [enabled, setEnabled] = useState(normalized.enabled);
  const [tasks, setTasks] = useState<TokenSnipeTask[]>(normalized.tasks);
  const [taskStatusById, setTaskStatusById] = useState<Record<string, TokenSnipeTaskRuntimeStatus>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editTaskId, setEditTaskId] = useState<string | null>(null);
  const [expandedTaskById, setExpandedTaskById] = useState<Record<string, boolean>>({});

  const [tokenAddressInput, setTokenAddressInput] = useState('');
  const [tokenSymbolInput, setTokenSymbolInput] = useState('');
  const [tokenNameInput, setTokenNameInput] = useState('');
  const [tweetTypesInput, setTweetTypesInput] = useState<Array<(typeof TWEET_TYPE_OPTIONS)[number]['value']>>(TWEET_TYPE_OPTIONS.map((x) => x.value));
  const [targetUrlsInput, setTargetUrlsInput] = useState('');
  const [autoBuyInput, setAutoBuyInput] = useState(true);
  const [buyAmountInput, setBuyAmountInput] = useState('0.01');
  const [autoSellInput, setAutoSellInput] = useState(true);

  const [targetUsersInput, setTargetUsersInput] = useState(normalized.targetUsers.join('\n'));
  const [playSound, setPlaySound] = useState(normalized.playSound);
  const [soundPreset, setSoundPreset] = useState<TradeSuccessSoundPreset>(normalized.soundPreset);
  const soundSelectValue = playSound ? soundPreset : SOUND_OFF;
  const previewSound = useTradeSuccessSound({ enabled: true, volume: resolvedSettings?.tradeSuccessSoundVolume ?? 60 });

  useEffect(() => {
    if (!active) return;
    setEnabled(normalized.enabled);
    setTasks(normalized.tasks);
    setTargetUsersInput(normalized.targetUsers.join('\n'));
    setPlaySound(normalized.playSound);
    setSoundPreset(normalized.soundPreset);
  }, [active, normalizedKey]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
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
    void loadStatus();
    const onMessage = (message: any) => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'bg:stateChanged' || message.type === 'bg:tokenSniper:matched' || message.type === 'bg:tradeSuccess') {
        void loadStatus();
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      cancelled = true;
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
        playSound,
        soundPreset,
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
      setError(String(e?.message || '保存失败'));
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
    setAutoBuyInput(true);
    setBuyAmountInput('0.01');
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
    setTargetUrlsInput(task.targetUrls.join('\n'));
    setAutoBuyInput(task.autoBuy);
    setBuyAmountInput(task.buyAmountBnb);
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
      setError('代币地址不合法');
      return;
    }
    const targetUrls = parseList(targetUrlsInput);
    if (!targetUrls.length) {
      setError('请至少输入一个目标推文链接');
      return;
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
      autoBuy: autoBuyInput,
      buyAmountBnb: buyAmountInput.trim() || '0',
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
      playSound,
      soundPreset,
    });
    if (ok) setShowSettingsModal(false);
  };

  const stateLabel = (status?: TokenSnipeTaskRuntimeStatus) => {
    if (!status) return '未执行';
    switch (status.state) {
      case 'matched':
        return '已命中';
      case 'buying':
        return '买入中';
      case 'bought':
        return '买入成功';
      case 'sell_order_created':
        return '卖单已创建';
      case 'sold':
        return '已卖出';
      case 'failed':
        return '失败';
      default:
        return '待命';
    }
  };

  if (!active) return null;

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3">
        <label className="flex items-center justify-between gap-2 text-[13px] text-zinc-200">
          <span>是否启用代币狙击</span>
          <input
            type="checkbox"
            className="h-4 w-4 accent-emerald-500"
            checked={enabled}
            disabled={!resolvedSettings || !isUnlocked || saving}
            onChange={(e) => {
              void saveEnabled(e.target.checked);
            }}
          />
        </label>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold text-zinc-100">任务列表</div>
          <div className="text-[11px] text-zinc-500">共 {tasks.length} 条</div>
        </div>
        <div className="space-y-2 max-h-[360px] overflow-auto pr-1">
          {tasks.map((task) => {
            const status = taskStatusById[task.id];
            const tokenLink = siteInfo ? parsePlatformTokenLink(siteInfo, task.tokenAddress) : '';
            const tokenLabel = task.tokenSymbol || '-';
            const expanded = !!expandedTaskById[task.id];
            const ageLabel = formatAgeShort(status?.updatedAt ?? task.createdAt);
            const tweetTypes = normalizeTaskTweetTypes(task);
            const buyAmountLabel = `${task.buyAmountBnb || '0'} BNB`;
            const buyState =
              status?.state === 'buying'
                ? '买入中'
                : status?.buyTxHash || status?.state === 'bought' || status?.state === 'sell_order_created' || status?.state === 'sold'
                  ? '已买入'
                  : task.autoBuy
                    ? '待触发'
                    : '关闭';
            const sellState =
              status?.state === 'sell_order_created'
                ? '卖单已挂'
                : status?.sellTxHash || status?.state === 'sold'
                  ? '已卖出'
                  : task.autoSell
                    ? '待触发'
                    : '关闭';
            return (
              <div key={task.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-[12px]">
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <button
                        type="button"
                        className="text-zinc-400 hover:text-zinc-200"
                        onClick={() => setExpandedTaskById((prev) => ({ ...prev, [task.id]: !prev[task.id] }))}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <a
                        href={tokenLink || '#'}
                        className="truncate text-zinc-100 hover:underline"
                        onClick={(e) => {
                          if (!tokenLink) return;
                          e.preventDefault();
                          e.stopPropagation();
                          navigateToUrl(tokenLink);
                        }}
                      >
                        {tokenLabel}
                      </a>
                      <div className="truncate text-zinc-400">{task.tokenName || '-'}</div>
                      <div className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${status?.state === 'failed' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                        {stateLabel(status)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="inline-flex items-center text-zinc-300 hover:text-zinc-100 disabled:opacity-50"
                      disabled={saving || !resolvedSettings || !isUnlocked}
                      onClick={() => openEditModal(task)}
                    >
                      <Pencil size={13} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                    <div className="min-w-0 flex flex-1 items-center gap-2 overflow-hidden">
                      <span>{formatShortAddress(task.tokenAddress)}</span>
                      <span>·</span>
                      <span>{ageLabel}</span>
                      <span>·</span>
                      <span>{formatTweetTypesLabel(tweetTypes)}</span>
                      <span>·</span>
                      <span className={task.autoBuy ? 'text-emerald-300' : 'text-zinc-500'}>
                        买入 {buyAmountLabel}{task.autoBuy ? '' : '(手动)'}
                      </span>
                      <span>·</span>
                      <span className={task.autoSell ? 'text-emerald-300' : 'text-zinc-500'}>
                        卖出 {task.autoSell ? '自动' : '手动'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-rose-300 hover:text-rose-200 disabled:opacity-50"
                      disabled={saving || !resolvedSettings || !isUnlocked}
                      title="删除任务"
                      aria-label="删除任务"
                      onClick={() => {
                        void removeTask(task.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {expanded ? (
                  <div className="mt-2 space-y-1 border-t border-zinc-800/60 pt-2 text-[11px] text-zinc-400">
                    <div className="grid grid-cols-2 gap-2">
                      <div>买入状态：{buyState}</div>
                      <div>卖出状态：{sellState}</div>
                    </div>
                    <div className="space-y-1">
                      <div>目标链接：{task.targetUrls.length} 条</div>
                      <div className="space-y-0.5">
                        {task.targetUrls.map((url, idx) => (
                          <a
                            key={`${task.id}-url-${idx}`}
                            href={url}
                            className="block truncate text-emerald-300 hover:text-emerald-200 hover:underline"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigateToUrl(url);
                            }}
                          >
                            {idx + 1}. {url}
                          </a>
                        ))}
                      </div>
                    </div>
                    {status?.buyTxHash ? <div>买入Tx：{formatShortAddress(status.buyTxHash, 8, 6)}</div> : null}
                    {status?.sellTxHash ? <div>卖出Tx：{formatShortAddress(status.sellTxHash, 8, 6)}</div> : null}
                    {status?.sellOrderIds?.length ? <div>挂单ID：{status.sellOrderIds.slice(0, 3).join(', ')}</div> : null}
                    {status?.message ? <div>详情：{status.message}</div> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {!tasks.length ? <div className="text-[12px] text-zinc-500">暂无任务</div> : null}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          disabled={!resolvedSettings || !isUnlocked}
          onClick={openCreateModal}
        >
          新增任务
        </button>
        <button
          type="button"
          className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
          disabled={!resolvedSettings || !isUnlocked}
          onClick={() => setShowSettingsModal(true)}
        >
          狙击设置
        </button>
      </div>

      {showAddModal ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
            <div className="text-[13px] font-semibold text-zinc-100">{editTaskId ? '编辑任务' : '新增任务'}</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder="Token Address"
                value={tokenAddressInput}
                onChange={(e) => setTokenAddressInput(e.target.value)}
              />
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder="Token Symbol"
                value={tokenSymbolInput}
                onChange={(e) => setTokenSymbolInput(e.target.value)}
              />
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder="Token Name"
                value={tokenNameInput}
                onChange={(e) => setTokenNameInput(e.target.value)}
              />
              <div className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5">
                <div className="mb-1 text-[11px] text-zinc-400">推文类型（可多选）</div>
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
                        <span>{item.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
            <textarea
              className="w-full min-h-[72px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
              placeholder="目标推文链接（可多个）"
              value={targetUrlsInput}
              onChange={(e) => setTargetUrlsInput(e.target.value)}
            />
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <label className="flex items-center gap-2 text-zinc-300">
                <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={autoBuyInput} onChange={(e) => setAutoBuyInput(e.target.checked)} />
                自动买入
              </label>
              <input
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                placeholder="买入BNB"
                value={buyAmountInput}
                onChange={(e) => setBuyAmountInput(e.target.value)}
              />
              <label className="flex items-center gap-2 text-zinc-300">
                <input type="checkbox" className="h-4 w-4 accent-emerald-500" checked={autoSellInput} onChange={(e) => setAutoSellInput(e.target.checked)} />
                自动卖出
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
                取消
              </button>
              <button
                type="button"
                className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-200 disabled:opacity-50"
                disabled={saving}
                onClick={() => {
                  void saveTask();
                }}
              >
                {editTaskId ? '保存修改' : '保存任务'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showSettingsModal ? (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-[560px] rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-3">
            <div className="text-[13px] font-semibold text-zinc-100">狙击设置</div>
            <div className="space-y-1">
              <div className="text-[12px] text-zinc-400">目标用户（可多个，逗号/空格/换行分隔）</div>
              <textarea
                className="w-full min-h-[72px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-200 outline-none"
                value={targetUsersInput}
                onChange={(e) => setTargetUsersInput(e.target.value)}
                placeholder="@elonmusk"
              />
            </div>
            <div className="flex items-center gap-2 text-[12px] text-zinc-400">
              <div>触发音效</div>
              <select
                className="min-w-[180px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 outline-none"
                value={soundSelectValue}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === SOUND_OFF) {
                    setPlaySound(false);
                    return;
                  }
                  setPlaySound(true);
                  setSoundPreset(value as TradeSuccessSoundPreset);
                }}
              >
                <option value={SOUND_OFF}>关闭</option>
                {TRADE_SUCCESS_SOUND_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                disabled={!playSound}
                onClick={() => {
                  if (!playSound) return;
                  previewSound.ensureReady();
                  previewSound.playPreset(soundPreset);
                }}
                title="预览音效"
              >
                <Play size={14} />
              </button>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] text-zinc-200"
                onClick={() => setShowSettingsModal(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md border border-emerald-500/50 bg-emerald-500/20 px-3 py-1.5 text-[12px] text-emerald-200 disabled:opacity-50"
                disabled={saving}
                onClick={() => {
                  void saveSettings();
                }}
              >
                保存设置
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {error ? <div className="text-[12px] text-rose-300">{error}</div> : null}
    </div>
  );
}
