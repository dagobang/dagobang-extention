import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import type { TokenSnipeTask, TokenSnipeTaskRuntimeStatus } from '@/types/extention';
import { formatAgeShort, formatShortAddress } from '@/utils/format';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';
import { t, type Locale } from '@/utils/i18n';

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

const formatTweetTypesLabel = (types: Array<(typeof TWEET_TYPE_OPTIONS)[number]['value']>, tt: (key: string, subs?: Array<string | number>) => string) => {
  if (types.length >= TWEET_TYPE_OPTIONS.length) return tt('contentUi.tokenSniper.taskList.allTypes');
  return types.map((type) => tt(`contentUi.autoTradeStrategy.interaction.${type}`)).join('/');
};
const normalizeBuyMethod = (task: TokenSnipeTask): 'all' | 'dagobang' | 'gmgn' => {
  const raw = typeof (task as any)?.buyMethod === 'string' ? String((task as any).buyMethod).trim().toLowerCase() : '';
  if (raw === 'all' || raw === 'dagobang' || raw === 'gmgn') return raw;
  return 'dagobang';
};
const formatBuyMethodLabel = (task: TokenSnipeTask, tt: (key: string, subs?: Array<string | number>) => string) => {
  const method = normalizeBuyMethod(task);
  if (method === 'all') return tt('contentUi.tokenSniper.buyMethodAll');
  if (method === 'gmgn') return tt('contentUi.tokenSniper.buyMethodGmgn');
  return tt('contentUi.tokenSniper.buyMethodDagobang');
};
const getBuyMethodBadgeClass = (task: TokenSnipeTask) => {
  const method = normalizeBuyMethod(task);
  if (method === 'all') return 'bg-violet-500/20 text-violet-300 border border-violet-500/30';
  if (method === 'gmgn') return 'bg-sky-500/20 text-sky-300 border border-sky-500/30';
  return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
};

const stateLabel = (status: TokenSnipeTaskRuntimeStatus | undefined, tt: (key: string, subs?: Array<string | number>) => string) => {
  if (!status) return tt('contentUi.tokenSniper.taskList.statePending');
  switch (status.state) {
    case 'matched':
      return tt('contentUi.tokenSniper.taskList.stateMatched');
    case 'buying':
      return tt('contentUi.tokenSniper.taskList.stateBuying');
    case 'bought':
      return tt('contentUi.tokenSniper.taskList.stateBought');
    case 'sell_order_created':
      return tt('contentUi.tokenSniper.taskList.stateSellOrderCreated');
    case 'sold':
      return tt('contentUi.tokenSniper.taskList.stateSold');
    case 'failed':
      return tt('contentUi.tokenSniper.taskList.stateFailed');
    default:
      return tt('contentUi.tokenSniper.taskList.stateIdle');
  }
};

export function XTokenSniperTaskList(props: {
  tasks: TokenSnipeTask[];
  taskStatusById: Record<string, TokenSnipeTaskRuntimeStatus>;
  expandedTaskById: Record<string, boolean>;
  locale: Locale;
  siteInfo: SiteInfo | null;
  canEdit: boolean;
  onToggleExpand: (taskId: string) => void;
  onEdit: (task: TokenSnipeTask) => void;
  onRemove: (taskId: string) => void;
}) {
  const tt = (key: string, subs?: Array<string | number>) => t(key, props.locale, subs);
  const [visibleCount, setVisibleCount] = useState(12);
  useEffect(() => {
    setVisibleCount((prev) => Math.max(12, Math.min(prev, props.tasks.length || 12)));
  }, [props.tasks.length]);
  const visibleTasks = useMemo(() => props.tasks.slice(0, visibleCount), [props.tasks, visibleCount]);
  const hasMore = props.tasks.length > visibleCount;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-zinc-100">{tt('contentUi.tokenSniper.taskList.title')}</div>
        <div className="text-[11px] text-zinc-500">{tt('contentUi.tokenSniper.taskList.total', [props.tasks.length])}</div>
      </div>
      <div className="dagobang-scrollbar space-y-2 max-h-[360px] overflow-auto pr-1">
        {visibleTasks.map((task) => {
          const status = props.taskStatusById[task.id];
          const tokenLink = props.siteInfo ? parsePlatformTokenLink(props.siteInfo, task.tokenAddress) : '';
          const tokenLabel = task.tokenSymbol || '-';
          const expanded = !!props.expandedTaskById[task.id];
          const ageLabel = formatAgeShort(status?.updatedAt ?? task.createdAt);
          const tweetTypes = normalizeTaskTweetTypes(task);
          const targetUrls = Array.isArray(task.targetUrls) ? task.targetUrls : [];
          const keywords = Array.isArray(task.keywords) ? task.keywords : [];
          const buyAmountLabel = `${task.buyAmountBnb || '0'} BNB`;
          const buyGasGweiLabel = typeof task.buyGasGwei === 'string' ? String(task.buyGasGwei).trim() : '';
          const buyMethodLabel = formatBuyMethodLabel(task, tt);
          const buyMethodBadgeClass = getBuyMethodBadgeClass(task);
          const buyState =
            status?.state === 'buying'
              ? tt('contentUi.tokenSniper.taskList.buyStateBuying')
              : status?.buyTxHash || status?.state === 'bought' || status?.state === 'sell_order_created' || status?.state === 'sold'
                ? tt('contentUi.tokenSniper.taskList.buyStateBought')
                : task.autoBuy
                  ? tt('contentUi.tokenSniper.taskList.stateWaiting')
                  : tt('contentUi.tokenSniper.taskList.stateOff');
          const sellState =
            status?.state === 'sell_order_created'
              ? tt('contentUi.tokenSniper.taskList.sellStateOrderPlaced')
              : status?.sellTxHash || status?.state === 'sold'
                ? tt('contentUi.tokenSniper.taskList.sellStateSold')
                : task.autoSell
                  ? tt('contentUi.tokenSniper.taskList.stateWaiting')
                  : tt('contentUi.tokenSniper.taskList.stateOff');
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
                    <div className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${buyMethodBadgeClass}`}>
                      {buyMethodLabel}
                    </div>
                    <div className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] ${status?.state === 'failed' ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                      {stateLabel(status, tt)}
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
                    <span>{formatTweetTypesLabel(tweetTypes, tt)}</span>
                    <span>·</span>
                    <span className={task.autoBuy ? 'text-emerald-300' : 'text-zinc-500'}>
                      {tt('contentUi.tokenSniper.taskList.buyAmount', [buyAmountLabel])}{task.autoBuy ? '' : tt('contentUi.tokenSniper.taskList.manualTag')}
                    </span>
                    {buyGasGweiLabel ? (
                      <>
                        <span>·</span>
                        <span className={task.autoBuy ? 'text-emerald-300' : 'text-zinc-500'}>
                          {tt('contentUi.tokenSniper.taskList.buyGasGwei', [buyGasGweiLabel])}
                        </span>
                      </>
                    ) : null}
                    <span>·</span>
                    <span className={task.autoSell ? 'text-emerald-300' : 'text-zinc-500'}>
                      {tt('contentUi.tokenSniper.taskList.sellMode', [task.autoSell ? tt('contentUi.tokenSniper.taskList.modeAuto') : tt('contentUi.tokenSniper.taskList.modeManual')])}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-rose-300 hover:text-rose-200 disabled:opacity-50"
                    disabled={!props.canEdit}
                    title={tt('contentUi.tokenSniper.taskList.deleteTask')}
                    aria-label={tt('contentUi.tokenSniper.taskList.deleteTask')}
                    onClick={() => props.onRemove(task.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {expanded ? (
                <div className="mt-2 space-y-1 border-t border-zinc-800/60 pt-2 text-[11px] text-zinc-400">
                  <div className="grid grid-cols-2 gap-2">
                    <div>{tt('contentUi.tokenSniper.taskList.buyStatus', [buyState])}</div>
                    <div>{tt('contentUi.tokenSniper.taskList.sellStatus', [sellState])}</div>
                  </div>
                  <div className="space-y-1">
                    <div>{tt('contentUi.tokenSniper.taskList.targetLinks', [targetUrls.length])}</div>
                    <div className="space-y-0.5">
                      {targetUrls.map((url, idx) => (
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
                  <div className="space-y-1">
                    <div>{tt('contentUi.tokenSniper.taskList.targetKeywords', [keywords.length])}</div>
                    <div className="space-y-0.5">
                      {keywords.map((word, idx) => (
                        <div key={`${task.id}-kw-${idx}`} className="truncate text-emerald-300">
                          {idx + 1}. {word}
                        </div>
                      ))}
                    </div>
                  </div>
                  {status?.buyTxHash ? <div>{tt('contentUi.tokenSniper.taskList.buyTx', [formatShortAddress(status.buyTxHash, 8, 6)])}</div> : null}
                  {status?.sellTxHash ? <div>{tt('contentUi.tokenSniper.taskList.sellTx', [formatShortAddress(status.sellTxHash, 8, 6)])}</div> : null}
                  {status?.sellOrderIds?.length ? <div>{tt('contentUi.tokenSniper.taskList.orderIds', [status.sellOrderIds.slice(0, 3).join(', ')])}</div> : null}
                  {status?.message ? <div>{tt('contentUi.tokenSniper.taskList.detail', [status.message])}</div> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {!props.tasks.length ? <div className="text-[12px] text-zinc-500">{tt('contentUi.tokenSniper.taskList.empty')}</div> : null}
      </div>
      {hasMore ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:border-zinc-500"
            onClick={() => setVisibleCount((prev) => prev + 12)}
          >
            {tt('contentUi.tokenSniper.taskList.loadMore')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
