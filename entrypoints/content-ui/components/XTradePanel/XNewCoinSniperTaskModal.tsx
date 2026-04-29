import type { NewCoinXmodeSnipeTask } from '@/types/extention';

type XNewCoinSniperTaskModalProps = {
  mode: 'create' | 'edit';
  taskEditor: NewCoinXmodeSnipeTask;
  canEdit: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: () => void;
  onTaskEditorChange: (patch: Partial<NewCoinXmodeSnipeTask>) => void;
};

export function XNewCoinSniperTaskModal({
  mode,
  taskEditor,
  canEdit,
  saving,
  error,
  onClose,
  onSave,
  onTaskEditorChange,
}: XNewCoinSniperTaskModalProps) {
  return (
    <div className="fixed inset-0 z-[2147483648] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-[560px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-xl shadow-emerald-500/20">
        <div className="flex items-center justify-between border-b border-zinc-800/60 px-4 py-3">
          <div className="text-[13px] font-semibold text-emerald-300">
            {mode === 'create' ? '新增任务' : '编辑任务'}
          </div>
          <button
            type="button"
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500"
            onClick={onClose}
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
                onChange={(e) => onTaskEditorChange({ enabled: e.target.checked })}
              />
              <span>启用任务</span>
            </label>
            <label className="flex items-center gap-2 text-[12px] text-zinc-300">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-amber-500"
                checked={taskEditor.autoSellEnabled !== false}
                disabled={!canEdit || saving}
                onChange={(e) => onTaskEditorChange({ autoSellEnabled: e.target.checked })}
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
            onChange={(e) => onTaskEditorChange({ taskName: e.target.value })}
          />
          <label className="block space-y-1">
            <div className="text-[11px] text-zinc-400">Token Address（可选）</div>
            <input
              type="text"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
              placeholder="0x..."
              value={taskEditor.tokenAddress ?? ''}
              disabled={!canEdit || saving}
              onChange={(e) => {
                const raw = e.target.value.trim();
                onTaskEditorChange({ tokenAddress: raw ? (raw as `0x${string}`) : undefined });
              }}
            />
          </label>
          <label className="block space-y-1">
            <div className="text-[11px] text-zinc-400">任务关键词(逗号分隔)</div>
            <input
              type="text"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
              placeholder="关键词，逗号分隔"
              value={taskEditor.keywords.join(', ')}
              disabled={!canEdit || saving}
              onChange={(e) =>
                onTaskEditorChange({
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
                onChange={(e) => onTaskEditorChange({ matchMode: e.target.value === 'all' ? 'all' : 'any' })}
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
                onChange={(e) => onTaskEditorChange({ maxTokenAgeSeconds: e.target.value })}
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
                onChange={(e) => onTaskEditorChange({ buyAmountBnb: e.target.value })}
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
                onChange={(e) => onTaskEditorChange({ buyGasGwei: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[11px] text-zinc-400">任务 贿赂费(BNB)</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
                value={taskEditor.buyBribeBnb ?? ''}
                disabled={!canEdit || saving}
                onChange={(e) => onTaskEditorChange({ buyBribeBnb: e.target.value })}
              />
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800/60 px-4 py-3">
          {error ? <div className="mr-auto text-[12px] text-rose-300">{error}</div> : null}
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-emerald-500/20 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
            disabled={!canEdit || saving}
            onClick={onSave}
          >
            保存任务
          </button>
        </div>
      </div>
    </div>
  );
}
