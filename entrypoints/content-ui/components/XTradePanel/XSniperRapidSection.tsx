import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

type XSniperRapidSectionProps = {
  open: boolean;
  canEdit: boolean;
  rapidExitEnabled: boolean;
  twitterSnipe: any;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  updateTwitterSnipe: (patch: any) => void;
};

export function XSniperRapidSection({
  open,
  canEdit,
  rapidExitEnabled,
  twitterSnipe,
  tt,
  onToggle,
  updateTwitterSnipe,
}: XSniperRapidSectionProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const numInput = (label: string, key: string) => (
    <label className="space-y-1 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <input
        type="number"
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
        value={(twitterSnipe as any)?.[key] ?? ''}
        disabled={!canEdit}
        onChange={(e) => updateTwitterSnipe({ [key]: e.target.value } as any)}
      />
    </label>
  );

  return (
    <div className="space-y-3 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>{tt('contentUi.autoTradeStrategy.rapidExitTitle')}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <div className="space-y-3 rounded-md border border-cyan-900/40 bg-cyan-950/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-zinc-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-cyan-500"
                checked={rapidExitEnabled}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ rapidExitEnabled: e.target.checked } as any)}
              />
              <span>时间窗口快速止盈止损</span>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {numInput('最大持仓时长(秒)', 'rapidHoldSeconds')}
            {numInput('紧急止损(%)', 'rapidEmergencyStopLossPct')}
            {numInput('20秒全卖阈值(秒)', 'rapidExit20Sec')}
            {numInput('路由阈值1(%)', 'rapidRouteCut1Pct')}
            {numInput('路由阈值2(%)', 'rapidRouteCut2Pct')}
          </div>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border border-zinc-800/60 bg-zinc-950/40 px-2 py-1.5 text-[12px] text-zinc-400"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <span>高级参数（默认隐藏）</span>
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {showAdvanced ? (
            <>
              <div className="text-[11px] text-zinc-500">分批窗口（秒 / 盈利阈值% / 卖出占原仓位%）</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {numInput('固定评估间隔(秒)', 'rapidEvalStepSec')}
                {numInput('移动窗口长度(秒)', 'rapidLookbackSec')}
                {numInput('紧急止损确认步数', 'rapidEmergencyConfirmSteps')}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
                {numInput('阶段1时间', 'rapidStage1Sec')}
                {numInput('阶段1盈利阈值', 'rapidStage1ProfitPct')}
                {numInput('阶段1卖出', 'rapidStage1SellPct')}
                {numInput('阶段2时间', 'rapidStage2Sec')}
                {numInput('阶段2盈利阈值', 'rapidStage2ProfitPct')}
                {numInput('阶段2卖出', 'rapidStage2SellPct')}
                {numInput('阶段3时间', 'rapidStage3Sec')}
                {numInput('阶段3盈利阈值', 'rapidStage3ProfitPct')}
                {numInput('阶段3卖出', 'rapidStage3SellPct')}
                {numInput('阶段4时间', 'rapidStage4Sec')}
                {numInput('阶段4盈利阈值', 'rapidStage4ProfitPct')}
                {numInput('阶段4卖出', 'rapidStage4SellPct')}
              </div>

              <div className="text-[11px] text-zinc-500">Runner 回撤退出（峰值分段）</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {numInput('Runner启动盈利(%)', 'rapidRunnerArmProfitPct')}
                {numInput('峰值分段1(%)', 'rapidRunnerPeakCut1Pct')}
                {numInput('峰值分段2(%)', 'rapidRunnerPeakCut2Pct')}
                {numInput('低峰值回撤阈值(%)', 'rapidRunnerDrawdown1Pct')}
                {numInput('中峰值回撤阈值(%)', 'rapidRunnerDrawdown2Pct')}
                {numInput('高峰值回撤阈值(%)', 'rapidRunnerDrawdown3Pct')}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
