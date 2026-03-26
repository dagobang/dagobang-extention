import { useEffect, useMemo, useState } from 'react';
import { formatShortAddress } from '@/utils/format';
import { navigateToUrl, parsePlatformTokenLink, type SiteInfo } from '@/utils/sites';

export type TokenSniperOrderRecord = {
  id: string;
  tsMs: number;
  taskId: string;
  taskCreatedAt?: number;
  action: 'matched' | 'buy' | 'buy_failed' | 'sell_order_created';
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountBnb?: number;
  accountScreen?: string;
  signalType?: string;
  signalId?: string;
  signalAtMs?: number;
  signalActionAtMs?: number;
  signalReceivedAtMs?: number;
  tweetId?: string;
  quotedTweetId?: string;
  txHash?: string;
  sellOrderIds?: string[];
  message?: string;
};

const orderActionLabel = (action: TokenSniperOrderRecord['action']) => {
  if (action === 'matched') return '命中';
  if (action === 'buy') return '买入成功';
  if (action === 'sell_order_created') return '卖单创建';
  return '买入失败';
};

const orderActionClass = (action: TokenSniperOrderRecord['action']) => {
  if (action === 'matched') return 'border-sky-500/40 bg-sky-500/15 text-sky-300';
  if (action === 'buy') return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
  if (action === 'sell_order_created') return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
  return 'border-rose-500/40 bg-rose-500/15 text-rose-300';
};

const formatDateTime = (ms?: number) => {
  const n = Number(ms || 0);
  if (!(n > 0)) return '-';
  return new Date(n).toLocaleString('zh-CN', { hour12: false });
};

export function XTokenSniperOrderHistory(props: {
  orderHistory: TokenSniperOrderRecord[];
  siteInfo: SiteInfo | null;
  onClear: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(20);
  useEffect(() => {
    setVisibleCount((prev) => Math.max(20, Math.min(prev, props.orderHistory.length || 20)));
  }, [props.orderHistory.length]);
  const visibleHistory = useMemo(() => props.orderHistory.slice(0, visibleCount), [props.orderHistory, visibleCount]);
  const hasMore = props.orderHistory.length > visibleCount;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/35 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-zinc-100">订单历史</div>
        <div className="flex items-center gap-2">
          <div className="text-[11px] text-zinc-500">共 {props.orderHistory.length} 条</div>
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
            disabled={!props.orderHistory.length}
            onClick={props.onClear}
          >
            清空
          </button>
        </div>
      </div>
      <div className="dagobang-scrollbar space-y-1 max-h-[420px] overflow-auto pr-1">
        {visibleHistory.map((item) => {
          const tokenLabel = item.tokenSymbol || formatShortAddress(item.tokenAddress);
          const userLabel = item.accountScreen ? `@${item.accountScreen.replace(/^@/, '')}` : '-';
          const signalTypeLabel = item.signalType || '-';
          const tweetId = item.tweetId || item.quotedTweetId || '';
          const txHashLabel = item.txHash ? formatShortAddress(item.txHash, 8, 6) : '-';
          const sellOrderLabel = item.sellOrderIds?.length ? `${item.sellOrderIds.length}` : '-';
          const taskCreatedMs = Number(item.taskCreatedAt || 0);
          const signalActionMs = Number(item.signalActionAtMs || 0);
          const tweetUrl = tweetId ? `https://x.com/i/web/status/${tweetId}` : '';
          const openTokenPage = () => {
            const tokenLink = props.siteInfo ? parsePlatformTokenLink(props.siteInfo, item.tokenAddress) : '';
            if (tokenLink) {
              navigateToUrl(tokenLink);
              return;
            }
            try {
              const href = window.location.href;
              const match = href.match(/0x[a-fA-F0-9]{40}/);
              if (!match) return;
              const current = match[0];
              if (current.toLowerCase() === item.tokenAddress.toLowerCase()) return;
              navigateToUrl(href.replace(new RegExp(current, 'i'), item.tokenAddress));
            } catch {
            }
          };
          return (
            <div key={item.id} className="rounded-md border border-zinc-800 bg-zinc-900/30 px-2 py-1 text-[11px] text-zinc-300 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className={`inline-flex shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${orderActionClass(item.action)}`}>{orderActionLabel(item.action)}</span>
                <button type="button" className="truncate font-medium text-zinc-100 hover:text-emerald-300" onClick={openTokenPage}>{tokenLabel}</button>
                <span className="truncate text-zinc-500">{userLabel}</span>
                <div className="ml-auto shrink-0 text-right text-[10px] leading-4 tabular-nums text-zinc-500">
                  <div className="whitespace-nowrap">推文动作时间 {formatDateTime(signalActionMs)}</div>
                  <div className="whitespace-nowrap">任务创建时间 {formatDateTime(taskCreatedMs)}</div>
                </div>
              </div>
              <div className="truncate text-[10px] text-zinc-500">
                {tweetUrl ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 text-emerald-300 underline decoration-emerald-500/60 underline-offset-2 hover:text-emerald-200"
                    onClick={() => window.open(tweetUrl, '_blank', 'noopener,noreferrer')}
                  >
                    <span>{signalTypeLabel}</span>
                    <span aria-hidden="true">↗</span>
                  </button>
                ) : signalTypeLabel}
                {' · '}
                挂{sellOrderLabel} · Tx {txHashLabel}{item.message ? ` · ${item.message}` : ''}
              </div>
            </div>
          );
        })}
        {!props.orderHistory.length ? <div className="text-[12px] text-zinc-500">暂无历史</div> : null}
      </div>
      {hasMore ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="rounded-md border border-zinc-700 px-3 py-1 text-[11px] text-zinc-300 hover:border-zinc-500"
            onClick={() => setVisibleCount((prev) => prev + 20)}
          >
            加载更多
          </button>
        </div>
      ) : null}
    </div>
  );
}
