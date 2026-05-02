import { ChevronDown, ChevronRight } from 'lucide-react';

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
              <span>Milestone Runner 里程碑分批止盈</span>
            </label>
          </div>
          <div className="rounded-md border border-cyan-800/40 bg-cyan-950/30 px-2.5 py-2 text-[11px] leading-5 text-cyan-100/90">
            <div className="font-medium text-cyan-100">使用说明</div>
            <div>1. 固定评估间隔到点后，按当前市值相对买入市值的涨跌幅判断是否卖出。</div>
            <div>2. 先触发硬止损：跌到“硬止损阈值”以下时，直接卖出剩余全部仓位。</div>
            <div>3. 达到“首档止盈触发”后，每次再上涨“后续递增阈值”，先按“每档卖出占比”卖到“前段保本仓位占比”。</div>
            <div>4. 当前段仓位卖完后，改为每档按“后段每档卖出(剩余仓位)”继续卖，尽量吃单边趋势。</div>
            <div>5. 一旦进入止盈阶段，若回撤到“绝对涨幅清仓地板”以下，会触发地板清仓（卖出剩余仓位）。</div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {numInput('固定评估间隔(秒)', 'rapidEvalStepSec')}
            {numInput('Watchdog间隔(秒)', 'rapidWatchdogSec')}
            {numInput('硬止损阈值(%)', 'rapidStopLossPct')}
            {numInput('首档止盈触发(%)', 'rapidTakeProfitTriggerPct')}
            {numInput('后续递增阈值(%)', 'rapidTakeProfitStepUpPct')}
            {numInput('每档卖出占比(%)', 'rapidTakeProfitBatchPct')}
            {numInput('前段保本仓位占比(%)', 'rapidProtectQuotaPct')}
            {numInput('后段每档卖出(剩余仓位%)', 'rapidTailSellPctOfRemaining')}
            {numInput('绝对涨幅清仓地板(%)', 'rapidTakeProfitFloorPct')}
          </div>
        </div>
      ) : null}
    </div>
  );
}
