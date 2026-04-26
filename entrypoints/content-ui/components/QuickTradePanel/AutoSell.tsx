import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, X, Trash2, Plus } from 'lucide-react';
import type { AdvancedAutoSellConfig, AdvancedAutoSellRuleType } from '@/types/extention';
import { t, type Locale } from '@/utils/i18n';

type AutoSellProps = {
  canEdit: boolean;
  locale: Locale;
  value: AdvancedAutoSellConfig | null;
  onChange: (next: AdvancedAutoSellConfig) => void;
};

type DraftRule = {
  id: string;
  type: AdvancedAutoSellRuleType;
  triggerPercent: string;
  sellPercent: string;
};

export function AutoSell({ canEdit, locale, value, onChange }: AutoSellProps) {
  const defaultConfig = useMemo<AdvancedAutoSellConfig>(() => {
    return value ?? {
      enabled: false,
      rules: [],
      trailingStop: {
        enabled: false,
        mode: 'trailing_stop',
        callbackPercent: 20,
        sellPercent: 80,
        rollingSellPercent: 15,
        rollingStepPercent: 25,
        rollingFloorPercent: 15,
        activationMode: 'after_first_take_profit',
      },
    };
  }, [value]);

  const [enabled, setEnabled] = useState<boolean>(defaultConfig.enabled);
  const [rules, setRules] = useState<DraftRule[]>(
    (defaultConfig.rules || []).map((r) => ({
      id: r.id,
      type: r.type,
      triggerPercent: String(r.triggerPercent),
      sellPercent: String(r.sellPercent),
    }))
  );
  const [trailingEnabled, setTrailingEnabled] = useState<boolean>(defaultConfig.trailingStop?.enabled ?? false);
  const [trailingMode, setTrailingMode] = useState<'trailing_stop' | 'rolling_take_profit'>(defaultConfig.trailingStop?.mode === 'rolling_take_profit' ? 'rolling_take_profit' : 'trailing_stop');
  const [trailingCallbackPercent, setTrailingCallbackPercent] = useState<string>(String(defaultConfig.trailingStop?.callbackPercent ?? 20));
  const [trailingSellPercent, setTrailingSellPercent] = useState<string>(String(defaultConfig.trailingStop?.sellPercent ?? 80));
  const [rollingSellPercent, setRollingSellPercent] = useState<string>(String(defaultConfig.trailingStop?.rollingSellPercent ?? 15));
  const [rollingStepPercent, setRollingStepPercent] = useState<string>(String(defaultConfig.trailingStop?.rollingStepPercent ?? 25));
  const [rollingFloorPercent, setRollingFloorPercent] = useState<string>(String(defaultConfig.trailingStop?.rollingFloorPercent ?? 15));
  const [trailingActivationMode, setTrailingActivationMode] = useState<'immediate' | 'after_first_take_profit' | 'after_last_take_profit'>(
    defaultConfig.trailingStop?.activationMode ?? 'after_first_take_profit'
  );
  const [open, setOpen] = useState(false);
  const [expandedMode, setExpandedMode] = useState<'trailing_stop' | 'rolling_take_profit' | null>(null);

  useEffect(() => {
    if (open) return;
    setEnabled(defaultConfig.enabled);
    setRules(
      (defaultConfig.rules || []).map((r) => ({
        id: r.id,
        type: r.type,
        triggerPercent: String(r.triggerPercent),
        sellPercent: String(r.sellPercent),
      }))
    );
    setTrailingMode(defaultConfig.trailingStop?.mode === 'rolling_take_profit' ? 'rolling_take_profit' : 'trailing_stop');
    setTrailingEnabled(defaultConfig.trailingStop?.enabled ?? false);
    setTrailingCallbackPercent(String(defaultConfig.trailingStop?.callbackPercent ?? 20));
    setTrailingSellPercent(String(defaultConfig.trailingStop?.sellPercent ?? 80));
    setRollingSellPercent(String(defaultConfig.trailingStop?.rollingSellPercent ?? 15));
    setRollingStepPercent(String(defaultConfig.trailingStop?.rollingStepPercent ?? 25));
    setRollingFloorPercent(String(defaultConfig.trailingStop?.rollingFloorPercent ?? 15));
    setTrailingActivationMode(defaultConfig.trailingStop?.activationMode ?? 'after_first_take_profit');
    setExpandedMode(null);
  }, [open, defaultConfig]);

  const commit = (next?: {
    enabled?: boolean;
    rules?: DraftRule[];
    trailingEnabled?: boolean;
    trailingMode?: 'trailing_stop' | 'rolling_take_profit';
    trailingCallbackPercent?: string;
    trailingSellPercent?: string;
    rollingSellPercent?: string;
    rollingStepPercent?: string;
    rollingFloorPercent?: string;
    trailingActivationMode?: 'immediate' | 'after_first_take_profit' | 'after_last_take_profit';
  }) => {
    const nextEnabled = next?.enabled ?? enabled;
    const rulesDraft = next?.rules ?? rules;
    const parsed = rulesDraft
      .map((r) => {
        const triggerRaw = Number(r.triggerPercent);
        const sellRaw = Number(r.sellPercent);
        if (!r.id) return null;
        if (!Number.isFinite(triggerRaw)) return null;
        if (!Number.isFinite(sellRaw)) return null;
        const sellPercent = Math.max(0, Math.min(100, sellRaw));
        const baseTrigger = Math.max(-99.9, Math.min(100000, triggerRaw));
        const triggerPercent = r.type === 'stop_loss' ? -Math.abs(baseTrigger) : Math.abs(baseTrigger);
        return { id: r.id, type: r.type, triggerPercent, sellPercent };
      })
      .filter(Boolean) as AdvancedAutoSellConfig['rules'];
    const nextTrailingEnabled = next?.trailingEnabled ?? trailingEnabled;
    const nextTrailingMode = next?.trailingMode ?? trailingMode;
    const rawTrailingCallback = Number(next?.trailingCallbackPercent ?? trailingCallbackPercent);
    const safeTrailingCallback = Number.isFinite(rawTrailingCallback)
      ? Math.round(Math.max(0.1, Math.min(99.9, rawTrailingCallback)) * 100) / 100
      : 20;
    const rawTrailingSell = Number(next?.trailingSellPercent ?? trailingSellPercent);
    const safeTrailingSell = Number.isFinite(rawTrailingSell)
      ? Math.round(Math.max(1, Math.min(100, rawTrailingSell)) * 100) / 100
      : 80;
    const rawRollingSell = Number(next?.rollingSellPercent ?? rollingSellPercent);
    const safeRollingSell = Number.isFinite(rawRollingSell)
      ? Math.round(Math.max(1, Math.min(100, rawRollingSell)) * 100) / 100
      : 15;
    const rawRollingStep = Number(next?.rollingStepPercent ?? rollingStepPercent);
    const safeRollingStep = Number.isFinite(rawRollingStep)
      ? Math.round(Math.max(0.1, Math.min(100000, rawRollingStep)) * 100) / 100
      : 25;
    const rawRollingFloor = Number(next?.rollingFloorPercent ?? rollingFloorPercent);
    const safeRollingFloor = Number.isFinite(rawRollingFloor)
      ? Math.round(Math.max(0, Math.min(100000, rawRollingFloor)) * 100) / 100
      : 15;
    const nextTrailingActivationMode = next?.trailingActivationMode ?? trailingActivationMode;
    onChange({
      enabled: nextEnabled,
      rules: parsed,
      trailingStop: {
        enabled: nextTrailingEnabled,
        mode: nextTrailingMode,
        callbackPercent: safeTrailingCallback,
        sellPercent: safeTrailingSell,
        rollingSellPercent: safeRollingSell,
        rollingStepPercent: safeRollingStep,
        rollingFloorPercent: safeRollingFloor,
        activationMode: nextTrailingActivationMode,
      },
    });
  };

  return (
    <>
      <label
        className={`flex items-center gap-1 select-none ${canEdit ? 'cursor-pointer hover:text-zinc-300' : 'opacity-50 cursor-not-allowed'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          className="h-3 w-3 accent-emerald-500"
          checked={enabled}
          disabled={!canEdit}
          onChange={(e) => {
            const next = e.target.checked;
            setEnabled(next);
            if (next) {
              setOpen(true);
              commit({ enabled: true });
            } else {
              setOpen(false);
              commit({ enabled: false });
            }
          }}
        />
        <span
          onClick={() => {
            if (!canEdit) return;
            if (!enabled) return;
            setOpen(true);
          }}
        >
          {t('contentUi.autoSell.advanced', locale)}
        </span>
      </label>

      {open ? (
        <div
          className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/60 backdrop-blur-[2px]"
          onClick={() => {
            setOpen(false);
            commit();
          }}
        >
          <div
            className="w-[640px] max-w-[92vw] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/30"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
              <div className="text-sm font-semibold text-zinc-100">{t('contentUi.autoSell.title', locale)}</div>
              <button
                type="button"
                className="text-zinc-400 hover:text-zinc-200"
                onClick={() => {
                  setOpen(false);
                  commit();
                }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div className="space-y-2">
                {rules.map((r) => (
                  <div key={r.id} className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={
                            r.type === 'take_profit'
                              ? 'inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-[12px] text-emerald-300'
                              : 'inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                          }
                          onClick={() => {
                            const nextType: AdvancedAutoSellRuleType = 'take_profit';
                            setRules((prev) =>
                              prev.map((x) => {
                                if (x.id !== r.id) return x;
                                const trigger = Number(x.triggerPercent);
                                const fixed = Number.isFinite(trigger) ? Math.abs(trigger) : 100;
                                return { ...x, type: nextType, triggerPercent: String(fixed) };
                              })
                            );
                          }}
                        >
                          <TrendingUp size={12} className="text-emerald-400" />
                          <span>{t('contentUi.limitOrder.type.takeProfitSell', locale)}</span>
                        </button>
                        <button
                          type="button"
                          className={
                            r.type === 'stop_loss'
                              ? 'inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/15 px-2 py-1 text-[12px] text-rose-300'
                              : 'inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                          }
                          onClick={() => {
                            const nextType: AdvancedAutoSellRuleType = 'stop_loss';
                            setRules((prev) =>
                              prev.map((x) => {
                                if (x.id !== r.id) return x;
                                const trigger = Number(x.triggerPercent);
                                const fixed = Number.isFinite(trigger) ? -Math.abs(trigger) : -50;
                                return { ...x, type: nextType, triggerPercent: String(fixed) };
                              })
                            );
                          }}
                        >
                          <TrendingDown size={12} className="text-rose-400" />
                          <span>{t('contentUi.limitOrder.type.stopLossSell', locale)}</span>
                        </button>
                      </div>

                      <div className="flex-1 relative">
                        <input
                          type="number"
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none"
                          value={r.triggerPercent}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, triggerPercent: v } : x)));
                          }}
                        />
                        <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                      </div>
                    </div>

                    <div className="flex-1 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-2">
                      <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.sell', locale)}</span>
                      <div className="flex-1 relative">
                        <input
                          type="number"
                          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none"
                          value={r.sellPercent}
                          onChange={(e) => {
                            const v = e.target.value;
                            setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, sellPercent: v } : x)));
                          }}
                        />
                        <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="p-2 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
                      onClick={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="w-full mt-2 px-3 py-3 rounded-lg border border-zinc-800 bg-zinc-900/30 text-[13px] text-zinc-200 hover:border-zinc-700"
                onClick={() => {
                  const id = (() => {
                    try {
                      return crypto.randomUUID();
                    } catch {
                      return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
                    }
                  })();
                  setRules((prev) => [...prev, { id, type: 'take_profit', triggerPercent: '100', sellPercent: '50' }]);
                }}
              >
                <span className="inline-flex items-center gap-2">
                  <Plus size={14} />
                  {t('contentUi.autoSell.addRule', locale)}
                </span>
              </button>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 space-y-3">
                <label
                  className={`flex items-center gap-2 select-none ${canEdit ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 accent-amber-500"
                    checked={trailingEnabled}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setTrailingEnabled(next);
                      commit({ trailingEnabled: next });
                    }}
                  />
                  <span className="inline-flex items-center gap-1 text-[13px] text-zinc-200">
                    <RefreshCw size={12} className="text-amber-400" />
                    {t('contentUi.autoSell.trailingStrategy', locale)}
                  </span>
                </label>

                <div className={`rounded-lg border p-3 ${trailingMode === 'trailing_stop' ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[13px] text-zinc-200">{t('contentUi.autoSell.trailingModeOption.trailingStop', locale)}</div>
                    <button
                      type="button"
                      disabled={!canEdit || !trailingEnabled}
                      className={trailingMode === 'trailing_stop'
                        ? 'px-2 py-1 rounded text-[12px] bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'px-2 py-1 rounded text-[12px] text-zinc-300 border border-zinc-700 hover:border-zinc-500 disabled:opacity-60'}
                      onClick={() => {
                        if (trailingMode === 'trailing_stop') {
                          setExpandedMode((prev) => (prev === 'trailing_stop' ? null : 'trailing_stop'));
                          return;
                        }
                        setTrailingMode('trailing_stop');
                        setExpandedMode('trailing_stop');
                        commit({ trailingMode: 'trailing_stop' });
                      }}
                    >
                      {trailingMode === 'trailing_stop' ? t('contentUi.autoSell.activeMode', locale) : t('contentUi.autoSell.useMode', locale)}
                    </button>
                  </div>
                  {trailingMode === 'trailing_stop' && expandedMode === 'trailing_stop' ? (
                    <div className="mt-2 space-y-2">
                      <div className="text-[11px] text-zinc-500">{t('contentUi.autoSell.modeHintTrailing', locale)}</div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.trailingStopCallback', locale)}</span>
                        <div className="relative w-[110px]">
                          <input
                            type="number"
                            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none disabled:opacity-60"
                            value={trailingCallbackPercent}
                            disabled={!canEdit || !trailingEnabled}
                            onChange={(e) => {
                              const v = e.target.value;
                              setTrailingCallbackPercent(v);
                              commit({ trailingCallbackPercent: v });
                            }}
                          />
                          <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.sell', locale)}</span>
                        <div className="relative w-[110px]">
                          <input
                            type="number"
                            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none disabled:opacity-60"
                            value={rollingSellPercent}
                            disabled={!canEdit || !trailingEnabled}
                            onChange={(e) => {
                              const v = e.target.value;
                              setRollingSellPercent(v);
                              commit({ rollingSellPercent: v });
                            }}
                          />
                          <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.trailingStopActivationMode', locale)}</span>
                        <select
                          className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-200 outline-none disabled:opacity-60"
                          value={trailingActivationMode}
                          disabled={!canEdit || !trailingEnabled}
                          onChange={(e) => {
                            const v = e.target.value as any;
                            if (v !== 'immediate' && v !== 'after_first_take_profit' && v !== 'after_last_take_profit') return;
                            setTrailingActivationMode(v);
                            commit({ trailingActivationMode: v });
                          }}
                        >
                          <option value="immediate">{t('contentUi.autoSell.trailingStopActivationModeOption.immediate', locale)}</option>
                          <option value="after_first_take_profit">{t('contentUi.autoSell.trailingStopActivationModeOption.afterFirstTakeProfit', locale)}</option>
                          <option value="after_last_take_profit">{t('contentUi.autoSell.trailingStopActivationModeOption.afterLastTakeProfit', locale)}</option>
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-zinc-500 truncate">{t('contentUi.autoSell.modeHintTrailing', locale)}</div>
                  )}
                </div>

                <div className={`rounded-lg border p-3 ${trailingMode === 'rolling_take_profit' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-950/40'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[13px] text-zinc-200">{t('contentUi.autoSell.trailingModeOption.rollingTakeProfit', locale)}</div>
                    <button
                      type="button"
                      disabled={!canEdit || !trailingEnabled}
                      className={trailingMode === 'rolling_take_profit'
                        ? 'px-2 py-1 rounded text-[12px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'px-2 py-1 rounded text-[12px] text-zinc-300 border border-zinc-700 hover:border-zinc-500 disabled:opacity-60'}
                      onClick={() => {
                        if (trailingMode === 'rolling_take_profit') {
                          setExpandedMode((prev) => (prev === 'rolling_take_profit' ? null : 'rolling_take_profit'));
                          return;
                        }
                        setTrailingMode('rolling_take_profit');
                        setExpandedMode('rolling_take_profit');
                        commit({ trailingMode: 'rolling_take_profit' });
                      }}
                    >
                      {trailingMode === 'rolling_take_profit' ? t('contentUi.autoSell.activeMode', locale) : t('contentUi.autoSell.useMode', locale)}
                    </button>
                  </div>
                  {trailingMode === 'rolling_take_profit' && expandedMode === 'rolling_take_profit' ? (
                    <div className="mt-2 space-y-2">
                      <div className="text-[11px] text-zinc-500">{t('contentUi.autoSell.modeHintRolling', locale)}</div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.rollingStepPercent', locale)}</span>
                        <div className="relative w-[110px]">
                          <input
                            type="number"
                            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none disabled:opacity-60"
                            value={rollingStepPercent}
                            disabled={!canEdit || !trailingEnabled}
                            onChange={(e) => {
                              const v = e.target.value;
                              setRollingStepPercent(v);
                              commit({ rollingStepPercent: v });
                            }}
                          />
                          <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.rollingSellPercent', locale)}</span>
                        <div className="relative w-[110px]">
                          <input
                            type="number"
                            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none disabled:opacity-60"
                            value={trailingSellPercent}
                            disabled={!canEdit || !trailingEnabled}
                            onChange={(e) => {
                              const v = e.target.value;
                              setTrailingSellPercent(v);
                              commit({ trailingSellPercent: v });
                            }}
                          />
                          <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.rollingFloorPercent', locale)}</span>
                        <div className="relative w-[110px]">
                          <input
                            type="number"
                            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 pr-6 text-[12px] outline-none disabled:opacity-60"
                            value={rollingFloorPercent}
                            disabled={!canEdit || !trailingEnabled}
                            onChange={(e) => {
                              const v = e.target.value;
                              setRollingFloorPercent(v);
                              commit({ rollingFloorPercent: v });
                            }}
                          />
                          <span className="absolute right-2 top-1.5 text-[12px] text-zinc-500">%</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-zinc-400">{t('contentUi.autoSell.trailingStopActivationMode', locale)}</span>
                        <select
                          className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] text-zinc-200 outline-none disabled:opacity-60"
                          value={trailingActivationMode}
                          disabled={!canEdit || !trailingEnabled}
                          onChange={(e) => {
                            const v = e.target.value as any;
                            if (v !== 'immediate' && v !== 'after_first_take_profit' && v !== 'after_last_take_profit') return;
                            setTrailingActivationMode(v);
                            commit({ trailingActivationMode: v });
                          }}
                        >
                          <option value="immediate">{t('contentUi.autoSell.trailingStopActivationModeOption.immediate', locale)}</option>
                          <option value="after_first_take_profit">{t('contentUi.autoSell.trailingStopActivationModeOption.afterFirstTakeProfit', locale)}</option>
                          <option value="after_last_take_profit">{t('contentUi.autoSell.trailingStopActivationModeOption.afterLastTakeProfit', locale)}</option>
                        </select>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-[11px] text-zinc-500 truncate">{t('contentUi.autoSell.modeHintRolling', locale)}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
