import { ChevronDown, ChevronRight } from 'lucide-react';

type XSniperWsConfirmSectionProps = {
  open: boolean;
  canEdit: boolean;
  twitterSnipe: any;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  updateTwitterSnipe: (patch: any) => void;
};

export function XSniperWsConfirmSection({
  open,
  canEdit,
  twitterSnipe,
  tt,
  onToggle,
  updateTwitterSnipe,
}: XSniperWsConfirmSectionProps) {
  return (
    <div className="space-y-2 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>{tt('contentUi.autoTradeStrategy.wsConfirmTitle')}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
      <>
      <div className="flex items-center justify-between gap-2 text-[12px] text-zinc-300">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-emerald-500"
            checked={twitterSnipe?.wsConfirmEnabled !== false}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmEnabled: e.target.checked } as any)}
          />
          <span>{tt('contentUi.autoTradeStrategy.wsConfirmTitle')}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmWindowMs')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmWindowMs ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmWindowMs: e.target.value } as any)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmMinMcapChangePct')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmMinMcapChangePct ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmMinMcapChangePct: e.target.value } as any)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmMinHoldersDelta')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmMinHoldersDelta ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmMinHoldersDelta: e.target.value } as any)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmMinBuySellRatio')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmMinBuySellRatio ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmMinBuySellRatio: e.target.value } as any)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmMinNetBuy24hUsd')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmMinNetBuy24hUsd ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmMinNetBuy24hUsd: e.target.value } as any)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmMinVol24hUsd')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmMinVol24hUsd ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmMinVol24hUsd: e.target.value } as any)}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.wsConfirmMinSmartMoney')}</div>
          <input
            type="number"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
            value={(twitterSnipe as any)?.wsConfirmMinSmartMoney ?? ''}
            disabled={!canEdit}
            onChange={(e) => updateTwitterSnipe({ wsConfirmMinSmartMoney: e.target.value } as any)}
          />
        </label>
      </div>
      </>
      ) : null}
    </div>
  );
}
