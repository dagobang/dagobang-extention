import { ChevronDown, ChevronRight } from 'lucide-react';

type XSniperFilterSectionProps = {
  open: boolean;
  canEdit: boolean;
  twitterSnipe: any;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  updateTwitterSnipe: (patch: any) => void;
};

export function XSniperFilterSection({
  open,
  canEdit,
  twitterSnipe,
  tt,
  onToggle,
  updateTwitterSnipe,
}: XSniperFilterSectionProps) {
  return (
    <div className="space-y-3 pb-3 border-b border-zinc-800/60">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>过滤条件</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
      <>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterMarketCap')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-8 text-[13px] outline-none"
                value={twitterSnipe?.minMarketCapUsd ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minMarketCapUsd: e.target.value })}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">K</div>
            </div>
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-8 text-[13px] outline-none"
                value={twitterSnipe?.maxMarketCapUsd ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxMarketCapUsd: e.target.value })}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">K</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterHolders')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div>
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.minHolders ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minHolders: e.target.value })}
              />
            </div>
            <div>
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.maxHolders ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxHolders: e.target.value })}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterKol')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div>
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.minKol ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minKol: e.target.value })}
              />
            </div>
            <div>
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.maxKol ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxKol: e.target.value })}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterTickerLen')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div>
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.minTickerLen ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minTickerLen: e.target.value })}
              />
            </div>
            <div>
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[13px] outline-none"
                value={twitterSnipe?.maxTickerLen ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxTickerLen: e.target.value })}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterTokenAge')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                value={twitterSnipe?.minTokenAgeSeconds ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minTokenAgeSeconds: e.target.value })}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">s</div>
            </div>
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                value={twitterSnipe?.maxTokenAgeSeconds ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxTokenAgeSeconds: e.target.value })}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">s</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterTweetAge')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                value={(twitterSnipe as any)?.minTweetAgeSeconds ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minTweetAgeSeconds: e.target.value } as any)}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">s</div>
            </div>
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-9 text-[13px] outline-none"
                value={(twitterSnipe as any)?.maxTweetAgeSeconds ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxTweetAgeSeconds: e.target.value } as any)}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">s</div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-16 text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.filterDevHold')}</div>
          <div className="grid flex-1 grid-cols-2 gap-2">
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMin')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-6 text-[13px] outline-none"
                value={twitterSnipe?.minDevHoldPercent ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ minDevHoldPercent: e.target.value })}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">%</div>
            </div>
            <div className="relative">
              <input
                type="number"
                placeholder={tt('contentUi.autoTradeStrategy.placeholderMax')}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-6 text-[13px] outline-none"
                value={twitterSnipe?.maxDevHoldPercent ?? ''}
                disabled={!canEdit}
                onChange={(e) => updateTwitterSnipe({ maxDevHoldPercent: e.target.value })}
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">%</div>
            </div>
          </div>
        </div>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-zinc-300">
        <input
          type="checkbox"
          className="h-3 w-3 accent-amber-500"
          checked={!!twitterSnipe?.blockIfDevSell}
          disabled={!canEdit}
          onChange={(e) => updateTwitterSnipe({ blockIfDevSell: e.target.checked })}
        />
        {tt('contentUi.autoTradeStrategy.blockIfDevSell')}
      </label>
      </>
      ) : null}
    </div>
  );
}
