import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import type { TokenSnipeTask, TokenSnipeTaskRuntimeStatus } from '@/types/extention';
import { formatAgeShort, formatShortAddress } from '@/utils/format';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';

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

export function XTokenSniperTaskList(props: {
  tasks: TokenSnipeTask[];
  taskStatusById: Record<string, TokenSnipeTaskRuntimeStatus>;
  expandedTaskById: Record<string, boolean>;
  siteInfo: SiteInfo | null;
  canEdit: boolean;
  onToggleExpand: (taskId: string) => void;
  onEdit: (task: TokenSnipeTask) => void;
  onRemove: (taskId: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(12);
  useEffect(() => {
    setVisibleCount((prev) => Math.max(12, Math.min(prev, props.tasks.length || 12)));
  }, [props.tasks.length]);
  const visibleTasks = useMemo(() => props.tasks.slice(0, visibleCount), [props.tasks, visibleCount]);
  const hasMore = props.tasks.length > visibleCount;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-zinc-100">任务列表</div>
        <div className="text-[11px] text-zinc-500">共 {props.tasks.length} 条</div>
      </div>
      <div className="dagobang-scrollbar space-y-2 max-h-[420px] overflow-auto pr-1">
        {visibleTasks.map((task) => {
          const status = props.taskStatusById[task.id];
          const tokenLink = props.siteInfo ? parsePlatformTokenLink(props.siteInfo, task.tokenAddress) : '';
          const tokenLabel = task.tokenSymbol || '-';
          const expanded = !!props.expandedTaskById[task.id];
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
                      onClick={() => props.onToggleExpand(task.id)}
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
                    disabled={!props.canEdit}
                    onClick={() => props.onEdit(task)}
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
                    disabled={!props.canEdit}
                    title="删除任务"
                    aria-label="删除任务"
                    onClick={() => props.onRemove(task.id)}
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
        {!props.tasks.length ? <div className="text-[12px] text-zinc-500">暂无任务</div> : null}
      </div>
      {hasMore ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:border-zinc-500"
            onClick={() => setVisibleCount((prev) => prev + 12)}
          >
            加载更多
          </button>
        </div>
      ) : null}
    </div>
  );
}
