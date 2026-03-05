import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import { TRADE_SUCCESS_SOUND_PRESETS, type AutoTradeConfig, type AutoTradeInteractionType, type Settings, type TradeSuccessSoundPreset } from '@/types/extention';
import { t, normalizeLocale, type Locale } from '@/utils/i18n';
import { defaultSettings } from '@/utils/defaults';
import { call } from '@/utils/messaging';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';

type AutoTradeStrategyPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
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

export function AutoTradeStrategyPanel({
  visible,
  onVisibleChange,
  settings,
  isUnlocked,
}: AutoTradeStrategyPanelProps) {
  const panelWidth = 560;
  const locale: Locale = normalizeLocale(settings?.locale ?? 'zh_CN');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - panelWidth);
    const defaultY = 120;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  const normalizedAutoTrade = useMemo(
    () => normalizeAutoTrade(settings?.autoTrade ?? null),
    [settings?.autoTrade]
  );
  const [draft, setDraft] = useState<AutoTradeConfig | null>(() => cloneAutoTrade(normalizedAutoTrade));
  const [saving, setSaving] = useState(false);
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

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_auto_trade_strategy_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - panelWidth));
      const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
      setPos({ x: clampedX, y: clampedY });
    } catch {
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setDraft(cloneAutoTrade(normalizedAutoTrade));
  }, [visible, normalizedAutoTrade]);

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
        const key = 'dagobang_auto_trade_strategy_panel_pos';
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

  const statusText = (() => {
    if (!settings) return tt('contentUi.autoTradeStrategy.statusSettingsNotLoaded');
    if (!isUnlocked) return tt('contentUi.autoTradeStrategy.statusLocked');
    return tt('contentUi.autoTradeStrategy.statusUnlocked');
  })();

  const canEdit = !!settings && isUnlocked;

  const presetOptions = useMemo(
    () => TRADE_SUCCESS_SOUND_PRESETS.map((preset) => ({ value: preset, label: preset })),
    []
  );
  const previewSound = useTradeSuccessSound({ enabled: true, volume: 60 });
  const twitterSnipe = draft?.twitterSnipe;
  const formatAge = (ts?: number) => {
    if (!ts) return '--';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m ${r}s`;
  };
  const formatLatency = (ms?: number) => (ms == null ? '--' : `${Math.round(ms)}ms`);
  const updateTwitterSnipe = (patch: Partial<AutoTradeConfig['twitterSnipe']>) => {
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

  if (!visible || !draft) return null;

  return (
    <div
      className="fixed z-[2147483647] w-[560px] select-none rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/30 font-sans"
      style={{ left: pos.x, top: pos.y }}
    >
      <div
        className="flex items-start justify-between gap-3 px-4 py-3 border-b border-zinc-800/60 cursor-grab"
        onPointerDown={(e) => {
          dragging.current = {
            startX: e.clientX,
            startY: e.clientY,
            baseX: posRef.current.x,
            baseY: posRef.current.y,
          };
        }}
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
        <button
          type="button"
          className="text-zinc-400 hover:text-zinc-200"
          onClick={() => onVisibleChange(false)}
        >
          <X size={16} />
        </button>
      </div>

      <div className="p-3 space-y-3 max-h-[64vh] overflow-y-auto">
        <div className="space-y-2 pb-3 border-b border-zinc-800/60">
          <div>
            {/* <div className="text-sm font-semibold">{tt('contentUi.autoTradeStrategy.twitterSnipe')}</div> */}
            <div className="text-xs text-zinc-500">{tt('contentUi.autoTradeStrategy.twitterSnipeDesc')}</div>
          </div>
          <label className="block space-y-1">
            <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.targetUsers')}</div>
            <textarea
              className="h-20 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
              value={twitterSnipe?.targetUsers.join('\n') ?? ''}
              disabled={!canEdit}
              onChange={(e) => updateTwitterSnipe({ targetUsers: parseList(e.target.value) })}
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
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-8 text-[13px] outline-none"
                    value={twitterSnipe?.minHolders ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minHolders: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">K</div>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-8 text-[13px] outline-none"
                    value={twitterSnipe?.maxHolders ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxHolders: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">K</div>
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
                    value={twitterSnipe?.minTokenAgeMinutes ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ minTokenAgeMinutes: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">min</div>
                </div>
                <div className="relative">
                  <input
                    type="number"
                    placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                    value={twitterSnipe?.maxTokenAgeMinutes ?? ''}
                    disabled={!canEdit}
                    onChange={(e) => updateTwitterSnipe({ maxTokenAgeMinutes: e.target.value })}
                  />
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">min</div>
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
        <div className="space-y-2 pt-2 border-t border-zinc-800/60">
          <div className="flex items-center justify-between gap-3 text-[12px] text-zinc-300">
            <div className="flex items-center gap-3">
              <div className="text-zinc-500">{tt('contentUi.autoTradeStrategy.wsStatusShort')}</div>
              <div className="flex items-center gap-1">
                <div className="text-zinc-500">{tt('contentUi.autoTradeStrategy.wsConnection')}</div>
                <div className={wsStatus.connected ? 'text-emerald-300' : 'text-zinc-400'}>
                  {wsStatus.connected ? tt('contentUi.autoTradeStrategy.wsConnected') : tt('contentUi.autoTradeStrategy.wsDisconnected')}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <div className="text-zinc-500">{tt('contentUi.autoTradeStrategy.wsSignalAndLast')}</div>
                <div>{wsStatus.signalCount ?? 0}</div>
                <div className="text-zinc-500">/</div>
                <div>{formatAge(wsStatus.lastSignalAt)}</div>
              </div>
              <div className="flex items-center gap-1">
                <div className="text-zinc-500">{tt('contentUi.autoTradeStrategy.wsPacketAndLast')}</div>
                <div>{wsStatus.packetCount ?? 0}</div>
                <div className="text-zinc-500">/</div>
                <div>{formatAge(wsStatus.lastPacketAt)}</div>
              </div>
            </div>
            <button
              type="button"
              className="text-[11px] text-zinc-400 hover:text-zinc-200"
              onClick={() => setShowLogs((prev) => !prev)}
            >
              {showLogs ? tt('contentUi.autoTradeStrategy.wsHideLogs') : tt('contentUi.autoTradeStrategy.wsShowLogs')}
            </button>
          </div>
          {showLogs ? (
            <div className="max-h-28 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-300">
              {(wsStatus.logs || []).slice().reverse().map((log: any, idx: number) => (
                <div key={`${log.ts}-${idx}`} className="flex items-center gap-2 py-0.5">
                  <div className="text-zinc-500">{formatAge(log.ts)}</div>
                  <div className="text-zinc-400">{log.type}</div>
                  <div className="truncate">{log.message}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800/60">
        <div className="text-xs text-zinc-500">{tt('contentUi.autoTradeStrategy.footerHint')}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            onClick={() => setDraft(cloneAutoTrade(normalizedAutoTrade))}
          >
            {tt('contentUi.autoTradeStrategy.reset')}
          </button>
          <button
            type="button"
            className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
            disabled={!draft || !canEdit || saving}
            onClick={async () => {
              if (!settings || !draft) return;
              setSaving(true);
              try {
                await call({ type: 'settings:set', settings: { ...settings, autoTrade: draft } } as const);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? tt('contentUi.autoTradeStrategy.saving') : tt('contentUi.autoTradeStrategy.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
