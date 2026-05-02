import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { NewCoinXmodeSnipeTask } from '@/types/extention';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';

type XNewCoinSniperTasksSectionProps = {
  open: boolean;
  canEdit: boolean;
  saving: boolean;
  taskList: NewCoinXmodeSnipeTask[];
  siteInfo: SiteInfo | null;
  expandedTaskById: Record<string, boolean>;
  selectedTaskId: string;
  onToggle: () => void;
  onCreateTask: () => void;
  onToggleTaskExpanded: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  onEditTask: (task: NewCoinXmodeSnipeTask) => void;
  onRemoveTask: (taskId: string) => void;
  onClearAllTasks: () => void;
  getTaskRuntimeBadge: (task: NewCoinXmodeSnipeTask) => { text: string; className: string };
};

export function XNewCoinSniperTasksSection({
  open,
  canEdit,
  saving,
  taskList,
  siteInfo,
  expandedTaskById,
  selectedTaskId,
  onToggle,
  onCreateTask,
  onToggleTaskExpanded,
  onSelectTask,
  onEditTask,
  onRemoveTask,
  onClearAllTasks,
  getTaskRuntimeBadge,
}: XNewCoinSniperTasksSectionProps) {
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [taskList.length, open]);
  const visibleTasks = useMemo(() => taskList.slice(0, visibleCount), [taskList, visibleCount]);
  const hasMore = taskList.length > visibleCount;

  return (
    <div className="space-y-2 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>xmode 联动任务</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="space-y-2 rounded-md border border-zinc-800/70 bg-zinc-900/30 p-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <span>任务模式仅新增关键词过滤，平台与全局过滤条件共用</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-zinc-500"
                disabled={!canEdit || saving}
                onClick={onCreateTask}
              >
                新增任务
              </button>
              <button
                type="button"
                className="rounded border border-rose-700/70 px-2 py-0.5 text-[11px] text-rose-300 hover:border-rose-500 disabled:opacity-50"
                disabled={!canEdit || saving || taskList.length <= 0}
                onClick={onClearAllTasks}
              >
                清空全部
              </button>
            </div>
          </div>
          {taskList.length ? (
            <div className="space-y-1">
              {visibleTasks.map((task, idx) => {
                const name = String(task.taskName || '').trim() || `任务 ${idx + 1}`;
                const kwText = (task.keywords || []).join(', ');
                const enabled = task.enabled !== false;
                const expanded = expandedTaskById[task.id] === true;
                const runtimeBadge = getTaskRuntimeBadge(task);
                const tokenLink =
                  siteInfo && task.tokenAddress
                    ? parsePlatformTokenLink(siteInfo, task.tokenAddress)
                    : '';
                return (
                  <div
                    key={task.id}
                    className={`w-full rounded border px-2 py-1.5 text-left text-[12px] ${
                      selectedTaskId === task.id
                        ? 'border-sky-600 bg-sky-950/30 text-sky-200'
                        : 'border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex flex-1 items-center gap-1.5">
                        <button
                          type="button"
                          className="text-zinc-400 hover:text-zinc-200"
                          onClick={() => onToggleTaskExpanded(task.id)}
                        >
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <button
                          type="button"
                          className="truncate text-left hover:underline"
                          onClick={() => {
                            onSelectTask(task.id);
                            if (tokenLink) navigateToUrl(tokenLink);
                          }}
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
                        onClick={() => onEditTask(task)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="shrink-0 text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50"
                        disabled={!canEdit || saving}
                        onClick={() => onRemoveTask(task.id)}
                      >
                        删除
                      </button>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                      关键词 {task.keywords.length} 个 · 买入 {task.buyAmountNative || '-'} BNB
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
              {hasMore ? (
                <div className="pt-1">
                  <button
                    type="button"
                    className="w-full rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-60"
                    disabled={!open}
                    onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
                  >
                    加载更多（已显示 {visibleCount}/{taskList.length}）
                  </button>
                </div>
              ) : null}
            </div>
          ) : <div className="text-[11px] text-zinc-500">暂无任务，点击“新增任务”创建。</div>}
        </div>
      ) : null}
    </div>
  );
}
