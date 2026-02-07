import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, X, Trash2, Plus } from 'lucide-react';
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
    return value ?? { enabled: false, rules: [] };
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
  const [open, setOpen] = useState(false);

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
  }, [open, defaultConfig]);

  const commit = (next?: { enabled?: boolean; rules?: DraftRule[] }) => {
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
    onChange({ enabled: nextEnabled, rules: parsed });
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
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
