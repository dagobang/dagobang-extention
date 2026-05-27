import { Repeat2 } from 'lucide-react';
import { useMemo, useState } from 'react';

export type FooterHoldingStats = {
  balanceUsd: number | null;
  currentBuyUsd: number | null;
  currentSellUsd: number | null;
  currentProfitUsd: number | null;
  currentProfitPnl: number | null;
  totalBuyUsd: number | null;
  totalSellUsd: number | null;
  totalProfitUsd: number | null;
  totalProfitPnl: number | null;
  walletsCount?: number;
  updatedAt?: number | null;
};

type FooterStatsProps = {
  holdingStats?: FooterHoldingStats | null;
};

function formatUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs > 0 && abs < 1) return `${value < 0 ? '-' : ''}<$1`;
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : 2;
  const formatted = abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

function formatPnlRatio(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  const pct = value * 100;
  const formatted = Math.abs(pct) < 0.01 ? '0' : Math.abs(pct).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `${pct >= 0 ? '+' : '-'}${formatted}%`;
}

function getValueToneClass(value: number | null | undefined, mode: 'neutral' | 'profit' | 'buy' | 'sell' | 'ratio') {
  if (mode === 'buy') return 'text-emerald-400';
  if (mode === 'sell') return 'text-rose-400';
  if (mode === 'ratio') {
    if (value == null || !Number.isFinite(value) || value === 0) return 'text-zinc-300';
    return value > 0 ? 'text-emerald-400' : 'text-rose-400';
  }
  if (mode === 'profit') {
    if (value == null || !Number.isFinite(value) || value === 0) return 'text-zinc-300';
    return value > 0 ? 'text-emerald-400' : 'text-rose-400';
  }
  return 'text-zinc-100';
}

export function FooterStats({ holdingStats }: FooterStatsProps) {
  const [holdingMode, setHoldingMode] = useState<'current' | 'total'>('current');
  const holdingItems = useMemo(() => {
    if (holdingMode === 'current') {
      return [
        {
          key: 'holding',
          label: '持仓',
          value: holdingStats?.balanceUsd ?? null,
          tone: 'neutral' as const,
        },
        {
          key: 'buy',
          label: '当前买入',
          value: holdingStats?.currentBuyUsd ?? null,
          tone: 'buy' as const,
        },
        {
          key: 'profit',
          label: '当前盈亏',
          value: holdingStats?.currentProfitUsd ?? null,
          tone: 'profit' as const,
          subValue: holdingStats?.currentProfitPnl ?? null,
        },
      ];
    }
    return [
      {
        key: 'holding',
        label: '持仓',
        value: holdingStats?.balanceUsd ?? null,
        tone: 'neutral' as const,
      },
      {
        key: 'buy',
        label: '总买入',
        value: holdingStats?.totalBuyUsd ?? null,
        tone: 'buy' as const,
      },
      {
        key: 'profit',
        label: '总盈亏',
        value: holdingStats?.totalProfitUsd ?? null,
        tone: 'profit' as const,
        subValue: holdingStats?.totalProfitPnl ?? null,
      },
    ];
  }, [holdingMode, holdingStats]);

  return (
    <button
      type="button"
      className="flex w-full items-start gap-3 border-t border-zinc-800/80 bg-zinc-950/20 px-2 py-2 text-left transition-colors hover:bg-zinc-950/35"
      onClick={() => setHoldingMode((prev) => prev === 'current' ? 'total' : 'current')}
      title={`点击切换${holdingMode === 'current' ? '总' : '当前'}维度`}
    >
      {holdingItems.map((item, index) => (
        <div
          key={item.key}
          className={
            index === holdingItems.length - 1
              ? 'ml-auto min-w-0 px-0.5 text-right'
              : 'min-w-0 flex-1 px-0.5'
          }
        >
          <div className={`flex items-center gap-1 text-[11px] text-zinc-500 ${index === holdingItems.length - 1 ? 'justify-end' : ''}`}>
            <span className="truncate">{item.label}</span>
            {index === holdingItems.length - 1 && (
              <Repeat2 size={11} className="shrink-0 text-zinc-400" />
            )}
          </div>
          <div
            className={`whitespace-nowrap font-semibold ${index === holdingItems.length - 1 ? 'text-[13px] tracking-tight' : 'text-[14px]'} ${getValueToneClass(item.value, item.tone)}`}
          >
            {formatUsd(item.value)}
            {'subValue' in item && (
              <span className={`ml-1 whitespace-nowrap text-[12px] font-semibold ${getValueToneClass(item.subValue, 'ratio')}`}>
                ({formatPnlRatio(item.subValue) ?? '-'})
              </span>
            )}
          </div>
        </div>
      ))}
    </button>
  );
}
