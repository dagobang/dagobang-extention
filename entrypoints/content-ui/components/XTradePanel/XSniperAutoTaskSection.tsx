import { ChevronDown, ChevronRight } from 'lucide-react';

type XSniperAutoTaskSectionProps = {
  open: boolean;
  canEdit: boolean;
  saving: boolean;
  twitterSnipe: any;
  onToggle: () => void;
  updateTwitterSnipe: (patch: any) => void;
  platformOptions: Array<{ value: string; label: string }>;
};

const normalizePlatforms = (input: unknown, fallback: string[]): string[] => {
  const raw = Array.isArray(input) ? input : [];
  const set = new Set(
    raw
      .map((x) => String(x ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  const list = fallback.filter((x) => set.has(x));
  return list.length ? list : fallback;
};

export function XSniperAutoTaskSection({
  open,
  canEdit,
  saving,
  twitterSnipe,
  onToggle,
  updateTwitterSnipe,
  platformOptions,
}: XSniperAutoTaskSectionProps) {
  const fallbackPlatforms = platformOptions.map((x) => x.value);
  const selectedPlatforms = normalizePlatforms((twitterSnipe as any)?.autoTaskPlatforms, fallbackPlatforms);
  const enabled = (twitterSnipe as any)?.autoTaskFromWsEnabled !== false;
  const allSelected = platformOptions.length > 0 && platformOptions.every((x) => selectedPlatforms.includes(x.value));
  const disabled = !canEdit || saving;

  const togglePlatform = (value: string) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return;
    const set = new Set(selectedPlatforms);
    if (set.has(normalized)) set.delete(normalized);
    else set.add(normalized);
    const next = platformOptions.map((x) => x.value).filter((x) => set.has(x));
    updateTwitterSnipe({ autoTaskPlatforms: next.length ? next : fallbackPlatforms });
  };

  const toggleAllPlatforms = () => {
    if (!platformOptions.length) return;
    if (allSelected) {
      updateTwitterSnipe({ autoTaskPlatforms: fallbackPlatforms });
      return;
    }
    updateTwitterSnipe({ autoTaskPlatforms: platformOptions.map((x) => x.value) });
  };

  return (
    <div className="space-y-3 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>自动建任务</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="space-y-2 rounded-md border border-zinc-800/70 bg-zinc-900/30 p-2">
          <label className="flex items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3 w-3 accent-emerald-500"
              checked={enabled}
              disabled={disabled}
              onChange={(e) => updateTwitterSnipe({ autoTaskFromWsEnabled: e.target.checked })}
            />
            <span>启用：基于 WS 自动创建关键词任务</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">ATH 市值阈值(USD)</div>
              <input
                type="number"
                min="100"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskAthMcapUsd ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskAthMcapUsd: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">每条信号最多新增</div>
              <input
                type="number"
                min="1"
                max="50"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMaxPerSignal ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMaxPerSignal: e.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">市值范围 Min(USD)</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMinMarketCapUsd ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMinMarketCapUsd: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">市值范围 Max(USD)</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMaxMarketCapUsd ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMaxMarketCapUsd: e.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">币龄范围 Min(s)</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMinTokenAgeSeconds ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMinTokenAgeSeconds: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">币龄范围 Max(s)</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMaxTokenAgeSeconds ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMaxTokenAgeSeconds: e.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">持币人数 Min</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMinHolders ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMinHolders: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">持币人数 Max</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMaxHolders ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMaxHolders: e.target.value })}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">KOL人数 Min</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMinKol ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMinKol: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">KOL人数 Max</div>
              <input
                type="number"
                min="0"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={(twitterSnipe as any)?.autoTaskMaxKol ?? ''}
                disabled={disabled}
                onChange={(e) => updateTwitterSnipe({ autoTaskMaxKol: e.target.value })}
              />
            </label>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-16 pt-1 text-[12px] text-zinc-400">平台</div>
            <div className="flex-1 space-y-2">
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-60"
                  disabled={disabled}
                  onClick={toggleAllPlatforms}
                >
                  {allSelected ? '恢复默认' : '全选'}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {platformOptions.map((item) => {
                  const active = selectedPlatforms.includes(item.value);
                  return (
                    <button
                      key={item.value}
                      type="button"
                      className={`rounded-full border px-2.5 py-1 text-[12px] transition ${
                        active
                          ? 'border-emerald-500/80 bg-emerald-500/10 text-emerald-200'
                          : 'border-zinc-700 bg-zinc-900/40 text-zinc-400'
                      }`}
                      disabled={disabled}
                      onClick={() => togglePlatform(item.value)}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="text-[11px] text-zinc-500">
            规则：仅在选中平台里，且 WS 观测 ATH 市值达到阈值时，自动创建任务（关键词=name+symbol）。
          </div>
        </div>
      ) : null}
    </div>
  );
}
