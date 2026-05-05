import { useState } from 'react';

type EvalMetric = {
  label: string;
  avg: number | null;
  winRate: number | null;
  samples: number;
};

export type SummaryRunMode = 'all' | 'live' | 'dry';

export type XSniperHistorySummaryData = {
  total: number;
  dry: number;
  live: number;
  confirmFail: number;
  weightedPnlAvg: number | null;
  weightedWinRate: number | null;
  weightedSamples: number;
  athPnlAvg: number | null;
  athWinRate: number | null;
  athSamples: number;
  winCount: number;
  lossCount: number;
  flatCount: number;
  realizedCount: number;
  mixedCount: number;
  unrealizedCount: number;
  avgSoldPct: number | null;
  avgRemainPct: number | null;
  sellParticipationRate: number | null;
  avgSellCount: number | null;
  tpCount: number;
  slCount: number;
  floorCount: number;
  otherReasonCount: number;
  takeProfitTriggeredRate: number | null;
  stopLossOnlyRate: number | null;
  stopLossGroupCount: number;
  reboundAfterStopLossCount: number;
  reboundAfterStopLossRate: number | null;
  givebackRate: number | null;
  evalMetrics: EvalMetric[];
};

const fmtPct = (v: number | null) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtRate = (v: number | null) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
const clamp01 = (v: number | null | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
};

const pnlClass = (v: number | null) => {
  if (v == null || !Number.isFinite(v)) return 'text-zinc-300';
  return v >= 0 ? 'text-emerald-300' : 'text-rose-300';
};

const evalToneClass = (v: number | null) => {
  if (v == null || !Number.isFinite(v)) return 'border-zinc-700 bg-zinc-900/60 text-zinc-400';
  if (v >= 10) return 'border-emerald-400/60 bg-emerald-500/25 text-emerald-100';
  if (v >= 3) return 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200';
  if (v > 0) return 'border-emerald-700/60 bg-emerald-500/10 text-emerald-300';
  if (v <= -10) return 'border-rose-400/60 bg-rose-500/25 text-rose-100';
  if (v <= -3) return 'border-rose-500/50 bg-rose-500/15 text-rose-200';
  return 'border-rose-700/60 bg-rose-500/10 text-rose-300';
};

const buildSuggestions = (data: XSniperHistorySummaryData) => {
  const tips: Array<{ level: 'warn' | 'info' | 'good'; text: string }> = [];
  if ((data.stopLossOnlyRate ?? 0) >= 0.45) {
    tips.push({ level: 'warn', text: '无止盈直接止损占比较高，优先提高入场过滤强度（账户质量、初始买卖比、确认窗口）并收紧开仓条件。' });
  }
  if ((data.reboundAfterStopLossRate ?? 0) >= 0.4) {
    tips.push({ level: 'warn', text: '止损后反拉率偏高，建议放宽硬止损触发或增加“二次确认”以降低被洗出概率。' });
  }
  if ((data.givebackRate ?? 0) >= 0.7) {
    tips.push({ level: 'warn', text: '回吐率很高，说明盈利锁定不足；建议提高首段止盈比例并提前启用跟踪止盈。' });
  }
  if (data.weightedWinRate != null && data.weightedWinRate < 0.25 && (data.tpCount + data.slCount) > 0) {
    tips.push({ level: 'info', text: '胜率偏低，建议减少弱势盘交易频次，优先交易早窗强、成交活跃且持有人增长更稳的标的。' });
  }
  if (data.evalMetrics.length) {
    const first = data.evalMetrics[0]?.avg;
    const last = data.evalMetrics[data.evalMetrics.length - 1]?.avg;
    if (first != null && last != null && first > 0 && last < 0) {
      tips.push({ level: 'info', text: '短窗转长窗明显衰减，策略更适合快进快出，可缩短持仓并前置止盈。' });
    }
  }
  if (tips.length === 0) {
    tips.push({ level: 'good', text: '当前策略统计表现较平衡，可小步优化止盈分段与仓位管理，避免一次性改动过大。' });
  }
  return tips.slice(0, 4);
};

type Props = {
  tt: (key: string, subs?: Array<string | number>) => string;
  data: XSniperHistorySummaryData;
  runMode: SummaryRunMode;
  onRunModeChange: (next: SummaryRunMode) => void;
};

export function XSniperHistorySummaryPanel({ tt, data, runMode, onRunModeChange }: Props) {
  const [showExecution, setShowExecution] = useState(true);
  const [showEval, setShowEval] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestions = buildSuggestions(data);
  const evalTrend = (() => {
    const vals = data.evalMetrics.map((m) => m.avg);
    let declineCount = 0;
    for (let i = 1; i < vals.length; i += 1) {
      const prev = vals[i - 1];
      const curr = vals[i];
      if (prev == null || curr == null) continue;
      if (curr < prev) declineCount += 1;
    }
    const validVals = vals.filter((v): v is number => v != null && Number.isFinite(v));
    const first = vals.find((v) => v != null && Number.isFinite(v)) ?? null;
    const last = [...vals].reverse().find((v) => v != null && Number.isFinite(v)) ?? null;
    const change = first != null && last != null ? last - first : null;
    const upCount = validVals.filter((v) => v > 0).length;
    const downCount = validVals.filter((v) => v < 0).length;
    return {
      declineCount,
      change,
      upCount,
      downCount,
      total: validVals.length,
    };
  })();

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px]">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-zinc-500">统计口径</span>
        {[
          { key: 'live', label: '仅实盘' },
          { key: 'dry', label: '仅Dry' },
          { key: 'all', label: '混合' },
        ].map((item) => {
          const active = runMode === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                active
                  ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
              }`}
              onClick={() => onRunModeChange(item.key as SummaryRunMode)}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-md border border-zinc-700 bg-zinc-900/70 px-2 py-1.5">
          <div className="text-zinc-500">样本概览</div>
          <div className="mt-0.5 text-zinc-100">{tt('contentUi.autoTradeStrategy.snipeHistorySummaryRecords')} {data.total}</div>
          <div className="text-zinc-400">实盘 {data.live} / {tt('contentUi.autoTradeStrategy.snipeHistorySummaryDry')} {data.dry} / WS拒绝 {data.confirmFail}</div>
        </div>
        <div className="rounded-md border border-zinc-700 bg-zinc-900/70 px-2 py-1.5">
          <div className="text-zinc-500">整体PnL</div>
          <div className={`mt-0.5 text-[13px] font-semibold ${pnlClass(data.weightedPnlAvg)}`}>{fmtPct(data.weightedPnlAvg)}</div>
          <div className="text-zinc-400">胜率 {fmtRate(data.weightedWinRate)} (样本 {data.weightedSamples})</div>
        </div>
        <div className="rounded-md border border-zinc-700 bg-zinc-900/70 px-2 py-1.5">
          <div className="text-zinc-500">ATH PnL</div>
          <div className={`mt-0.5 text-[13px] font-semibold ${pnlClass(data.athPnlAvg)}`}>{fmtPct(data.athPnlAvg)}</div>
          <div className="text-zinc-400">胜率 {fmtRate(data.athWinRate)} (样本 {data.athSamples})</div>
        </div>
        <div className="rounded-md border border-zinc-700 bg-zinc-900/70 px-2 py-1.5">
          <div className="text-zinc-500">胜负分布</div>
          <div className="mt-0.5 text-zinc-100">胜/负/平 {data.winCount}/{data.lossCount}/{data.flatCount}</div>
          <div className="text-zinc-400">回吐率 {fmtRate(data.givebackRate)} | 已实现 {data.realizedCount}</div>
        </div>
      </div>

      <div className="mt-2 space-y-1">
        <button
          type="button"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => setShowSuggestions((v) => !v)}
        >
          {showSuggestions ? '收起建议' : '展开建议'} ({suggestions.length})
        </button>
        {showSuggestions ? (
          <div className="space-y-1">
            {suggestions.map((tip, idx) => {
              const cls =
                tip.level === 'warn'
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                  : tip.level === 'good'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                    : 'border-sky-500/30 bg-sky-500/10 text-sky-100';
              const prefix = tip.level === 'warn' ? '建议' : tip.level === 'good' ? '结论' : '提示';
              return (
                <div key={idx} className={`rounded-md border px-2 py-1 text-[11px] ${cls}`}>
                  <span className="mr-1 font-semibold">{prefix}:</span>
                  <span>{tip.text}</span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => setShowExecution((v) => !v)}
        >
          {showExecution ? '收起执行统计' : '展开执行统计'}
        </button>
        <button
          type="button"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
          onClick={() => setShowEval((v) => !v)}
        >
          {showEval ? '收起Eval窗口' : '展开Eval窗口'}
        </button>
      </div>

      {showExecution ? (
        <div className="mt-2 space-y-1.5 text-[11px] text-zinc-300">
          <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5">
            <div className="mb-1 flex items-center justify-between">
              <span>平均仓位</span>
              <span>已卖 {fmtPct(data.avgSoldPct)} | 剩余 {fmtPct(data.avgRemainPct)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-zinc-800">
              <div className="h-2 bg-emerald-500/70" style={{ width: `${clamp01((data.avgSoldPct ?? 0) / 100) * 100}%` }} />
            </div>
          </div>

          <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5">
            <div className="mb-1 flex items-center justify-between">
              <span>卖出参与率</span>
              <span>{fmtRate(data.sellParticipationRate)} | 平均卖出笔数 {data.avgSellCount == null ? '-' : data.avgSellCount.toFixed(2)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-zinc-800">
              <div className="h-2 bg-sky-500/70" style={{ width: `${clamp01(data.sellParticipationRate) * 100}%` }} />
            </div>
          </div>

          <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5">
            <div className="mb-1">触发分布: 止盈 {data.tpCount} | 止损 {data.slCount} | 地板 {data.floorCount} | 其他 {data.otherReasonCount}</div>
            <div className="flex h-2 overflow-hidden rounded bg-zinc-800">
              {(() => {
                const total = data.tpCount + data.slCount + data.floorCount + data.otherReasonCount;
                const safeTotal = total > 0 ? total : 1;
                return (
                  <>
                    <div className="h-2 bg-emerald-500/70" style={{ width: `${(data.tpCount / safeTotal) * 100}%` }} />
                    <div className="h-2 bg-rose-500/70" style={{ width: `${(data.slCount / safeTotal) * 100}%` }} />
                    <div className="h-2 bg-violet-500/70" style={{ width: `${(data.floorCount / safeTotal) * 100}%` }} />
                    <div className="h-2 bg-zinc-500/70" style={{ width: `${(data.otherReasonCount / safeTotal) * 100}%` }} />
                  </>
                );
              })()}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
            <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between">
                <span>止盈触发率</span>
                <span>{fmtRate(data.takeProfitTriggeredRate)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-zinc-800">
                <div className="h-2 bg-emerald-500/70" style={{ width: `${clamp01(data.takeProfitTriggeredRate) * 100}%` }} />
              </div>
            </div>
            <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between">
                <span>无止盈直接止损</span>
                <span>{fmtRate(data.stopLossOnlyRate)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-zinc-800">
                <div className="h-2 bg-rose-500/70" style={{ width: `${clamp01(data.stopLossOnlyRate) * 100}%` }} />
              </div>
            </div>
            <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1.5 md:col-span-2">
              <div className="mb-1 flex items-center justify-between">
                <span>止损后反拉率</span>
                <span>{fmtRate(data.reboundAfterStopLossRate)} ({data.reboundAfterStopLossCount}/{data.stopLossGroupCount})</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-zinc-800">
                <div className="h-2 bg-amber-500/75" style={{ width: `${clamp01(data.reboundAfterStopLossRate) * 100}%` }} />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showEval ? (
        <div className="mt-2 space-y-1.5">
          <div className="rounded-md border border-zinc-800/80 bg-zinc-950/35 px-2 py-1 text-zinc-300">
            Eval趋势: 递减窗口 {evalTrend.declineCount}/{Math.max(0, data.evalMetrics.length - 1)} | 首尾变化 {fmtPct(evalTrend.change)} | 正/负窗口 {evalTrend.upCount}/{evalTrend.downCount}
          </div>
          <div className="grid grid-cols-3 gap-1 text-[11px] md:grid-cols-9">
            {data.evalMetrics.map((m) => (
              <div key={m.label} className={`rounded-md border px-1.5 py-1 text-center ${evalToneClass(m.avg)}`}>
                <div className="text-[10px]">{m.label}</div>
                <div className="font-semibold leading-tight">{fmtPct(m.avg)}</div>
                <div className="text-[10px] opacity-90">{fmtRate(m.winRate)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
