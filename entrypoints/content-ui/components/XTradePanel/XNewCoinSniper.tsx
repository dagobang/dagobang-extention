import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { browser } from 'wxt/browser';
import type { AutoTradeNewCoinSnipeConfig, Settings, XSniperBuyRecord } from '@/types/extention';
import { call } from '@/utils/messaging';
import { NEW_COIN_SNIPER_HISTORY_STORAGE_KEY, type NewCoinSniperOrderRecord } from '@/services/newCoinSniper/newCoinSniperHistory';
import { type SiteInfo } from '@/utils/sites';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { defaultSettings } from '@/utils/defaults';
import { XSniperHistoryView } from './XSniperHistoryView';
import { XSniperFilterSection } from './XSniperFilterSection';
import { XSniperRapidSection } from './XSniperRapidSection';
import { XSniperWsConfirmSection } from './XSniperWsConfirmSection';
import { PLATFORM_OPTIONS } from '@/constants/launchpad';

type XNewCoinSniperContentProps = {
  siteInfo: SiteInfo | null;
  active: boolean;
  view?: 'config' | 'history';
  onOpenConfig?: () => void;
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
    if (key === 'contentUi.autoTradeStrategy.twitterSnipeEnabledShort') return '新币狙击启用';
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
    filter: false,
    wsConfirm: false,
    rapid: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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

  const historyGroups = useMemo<NewCoinHistoryGroup[]>(() => {
    if (!history.length) return [];
    const sortedAsc = history
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
  }, [history]);
  const canEdit = !!resolvedSettings && isUnlocked;
  const { latestTokenByAddr, athMcapByAddr } = useMemo(() => {
    const latest: Record<string, any> = {};
    const ath: Record<string, number> = {};
    const sorted = history.slice().sort((a, b) => (Number(b.tsMs) || 0) - (Number(a.tsMs) || 0));
    for (const r of sorted) {
      const addr = String(r.tokenAddress || '').toLowerCase();
      if (!addr) continue;
      const mcap = typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) ? r.marketCapUsd : null;
      if (mcap != null) {
        const curAth = ath[addr];
        ath[addr] = typeof curAth === 'number' && Number.isFinite(curAth) ? Math.max(curAth, mcap) : mcap;
      }
      if (!latest[addr]) {
        latest[addr] = {
          updatedAtMs: r.tsMs,
          marketCapUsd: r.marketCapUsd,
          holders: r.holders,
          devHoldPercent: r.devHoldPercent,
          devHasSold: r.devHasSold,
          kol: r.kol,
        };
      }
    }
    return { latestTokenByAddr: latest, athMcapByAddr: ath };
  }, [history]);

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

  const updateSources = (nextNewPool: boolean, nextTokenUpdate: boolean) => {
    const nextSources: Array<'new_pool' | 'token_update'> = [];
    if (nextNewPool) nextSources.push('new_pool');
    if (nextTokenUpdate) nextSources.push('token_update');
    updateDraft({ signalSources: nextSources.length ? nextSources : ['new_pool', 'token_update'] });
  };

  const clearHistory = async () => {
    try {
      await browser.storage.local.set({ [NEW_COIN_SNIPER_HISTORY_STORAGE_KEY]: [] } as any);
      setHistory([]);
    } catch {
    }
  };

  if (!active) return null;

  const sources = normalizeSources(draft?.signalSources);
  const sourceNewPool = sources.includes('new_pool');
  const sourceTokenUpdate = sources.includes('token_update');
  const rapidExitEnabled = draft?.rapidExitEnabled !== false;
  const toggleConfigSection = (key: string) => {
    setConfigSectionOpen((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <>
      <div className="dagobang-scrollbar p-2 space-y-2 max-h-[64vh] overflow-y-auto">
      {error ? <div className="text-[12px] text-rose-300">{error}</div> : null}

      {view === 'config' ? (
        <>
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
                  <label className="flex items-center gap-2 px-1 py-1 text-[13px] text-zinc-200" title={wsMonitorEnabled ? '开启后监听 new_pool / token_update 自动狙击' : '请先在推特监控里开启 WS 监控'}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-emerald-500"
                      checked={draft.enabled === true}
                      disabled={!canEdit || saving || !wsMonitorEnabled}
                      onChange={(e) => updateDraft({ enabled: e.target.checked })}
                    />
                    <span className={!wsMonitorEnabled ? 'text-zinc-500' : ''}>启用新币狙击</span>
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-zinc-300">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-amber-500"
                      checked={draft.dryRun !== false}
                      disabled={!canEdit || saving}
                      onChange={(e) => updateDraft({ dryRun: e.target.checked })}
                    />
                    <span>Dry Run（仅记录，不真实下单）</span>
                  </label>
                  <div className="text-[11px] text-zinc-400">信号来源</div>
                  <div className="flex items-center gap-4 text-[12px] text-zinc-300">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-500"
                        checked={sourceNewPool}
                        disabled={!canEdit || saving}
                        onChange={(e) => updateSources(e.target.checked, sourceTokenUpdate)}
                      />
                      <span>new_pool</span>
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-500"
                        checked={sourceTokenUpdate}
                        disabled={!canEdit || saving}
                        onChange={(e) => updateSources(sourceNewPool, e.target.checked)}
                      />
                      <span>token_update</span>
                    </label>
                  </div>
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
                  <div className="text-[11px] text-zinc-500">仅运行当前保存配置，修改后需点击保存生效</div>
                </div>
              </div>
            ) : null}
          </div>
          <XSniperFilterSection
            open={configSectionOpen.filter}
            canEdit={canEdit && !saving}
            twitterSnipe={draft}
            tt={tt}
            onToggle={() => toggleConfigSection('filter')}
            updateTwitterSnipe={updateDraft}
            showTweetAge={false}
            platformOptions={[...PLATFORM_OPTIONS]}
          />
          <XSniperWsConfirmSection
            open={configSectionOpen.wsConfirm}
            canEdit={canEdit && !saving}
            twitterSnipe={draft}
            tt={tt}
            onToggle={() => toggleConfigSection('wsConfirm')}
            updateTwitterSnipe={updateDraft}
          />
          <XSniperRapidSection
            open={configSectionOpen.rapid}
            canEdit={canEdit && !saving}
            rapidExitEnabled={rapidExitEnabled}
            twitterSnipe={draft}
            tt={tt}
            onToggle={() => toggleConfigSection('rapid')}
            updateTwitterSnipe={updateDraft}
          />
        </>
      ) : (
        <XSniperHistoryView
          siteInfo={siteInfo}
          settings={resolvedSettings}
          isUnlocked={isUnlocked}
          canEdit={canEdit}
          tt={tt}
          buyHistory={history as unknown as XSniperBuyRecord[]}
          historyGroups={historyGroups as unknown as Array<{ key: string; parent: XSniperBuyRecord; children: XSniperBuyRecord[] }>}
          latestTokenByAddr={latestTokenByAddr}
          athMcapByAddr={athMcapByAddr}
          wsStatus={wsStatus}
          wsMonitorEnabled={wsMonitorEnabled}
          twitterSnipeEnabled={draft.enabled === true}
          twitterSnipeDryRun={draft.dryRun !== false}
          onTwitterSnipeEnabledChange={(next) => {
            void persistQuickPatch({ enabled: next });
          }}
          onTwitterSnipeDryRunChange={(next) => {
            void persistQuickPatch({ dryRun: next });
          }}
          onOpenConfig={onOpenConfig}
          onClearHistory={() => {
            void clearHistory();
          }}
        />
      )}
      </div>
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
