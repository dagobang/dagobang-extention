type XSniperWsStatusSectionProps = {
  wsStatus: any;
  showLogs: boolean;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggleLogs: () => void;
};

const formatWsTime = (ts: number) => {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const formatWsLatency = (n: any) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '--';
  return `${Math.round(v)}ms`;
};

export function XSniperWsStatusSection({
  wsStatus,
  showLogs,
  tt,
  onToggleLogs,
}: XSniperWsStatusSectionProps) {
  return (
    <div className="space-y-2 pt-3 border-t border-zinc-800/60">
      <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-400">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={wsStatus?.connected ? 'text-emerald-300' : 'text-rose-300'}>
            {tt('contentUi.autoTradeStrategy.wsStatusShort')} {wsStatus?.connected ? tt('contentUi.autoTradeStrategy.wsStatusOn') : tt('contentUi.autoTradeStrategy.wsStatusOff')}
          </span>
          <span>{tt('contentUi.autoTradeStrategy.wsLatency')} {formatWsLatency((wsStatus as any)?.latencyMs)}</span>
          <span>{tt('contentUi.autoTradeStrategy.wsPackets')} {Number.isFinite((wsStatus as any)?.packetCount) ? (wsStatus as any).packetCount : 0}</span>
          <span>{tt('contentUi.autoTradeStrategy.wsSignals')} {Number.isFinite((wsStatus as any)?.signalCount) ? (wsStatus as any).signalCount : 0}</span>
          <span>{tt('contentUi.autoTradeStrategy.wsLastPacket')} {formatWsTime((wsStatus as any)?.lastPacketAt || 0)}</span>
          <span>{tt('contentUi.autoTradeStrategy.wsLastSignal')} {formatWsTime((wsStatus as any)?.lastSignalAt || 0)}</span>
        </div>
        <button
          type="button"
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          disabled={!Array.isArray((wsStatus as any)?.logs) || (wsStatus as any).logs.length === 0}
          onClick={onToggleLogs}
        >
          {showLogs ? tt('contentUi.autoTradeStrategy.wsHideLogs') : tt('contentUi.autoTradeStrategy.wsLogs')}
        </button>
      </div>
      {showLogs ? (
        <div className="dagobang-scrollbar max-h-[180px] overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-[11px] text-zinc-300 whitespace-pre-wrap break-words">
          {(
            Array.isArray((wsStatus as any)?.logs) ? ((wsStatus as any).logs as any[]) : []
          )
            .slice(-80)
            .map((x, idx) => {
              const obj = x && typeof x === 'object' ? (x as any) : null;
              const type = obj && typeof obj.type === 'string' ? obj.type : 'log';
              const message = obj && typeof obj.message === 'string' ? obj.message : String(x);
              const ts = obj && typeof obj.ts === 'number' ? obj.ts : 0;
              const badgeClass =
                type === 'signal'
                  ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-200'
                  : type === 'error'
                    ? 'border-rose-500/40 bg-rose-500/20 text-rose-200'
                    : 'border-zinc-700 bg-zinc-800/40 text-zinc-200';
              return (
                <div key={idx} className="flex items-start justify-between gap-2 py-0.5">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${badgeClass}`}>
                      {type}
                    </span>
                    <div className="min-w-0 text-zinc-300">{message}</div>
                  </div>
                  <div className="shrink-0 text-[10px] text-zinc-500">{formatWsTime(ts)}</div>
                </div>
              );
            })}
        </div>
      ) : null}
    </div>
  );
}
