import { ChevronDown, ChevronRight } from 'lucide-react';

type XSniperSoundSectionProps = {
  open: boolean;
  canEdit: boolean;
  twitterSnipe: any;
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  onDeleteTweetSellPercentChange: (value: string) => void;
};

export function XSniperSoundSection({
  open,
  canEdit,
  twitterSnipe,
  tt,
  onToggle,
  onDeleteTweetSellPercentChange,
}: XSniperSoundSectionProps) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>{tt('contentUi.autoTradeStrategy.sectionAutoSell')}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
        <>
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/60 pt-2">
          <div className="text-zinc-400">{tt('contentUi.autoTradeStrategy.deleteTweetSellPercent')}</div>
          <div className="relative w-[100px]">
            <input
              type="number"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 pr-6 text-[13px] outline-none"
              value={twitterSnipe?.deleteTweetSellPercent ?? ''}
              disabled={!canEdit}
              onChange={(e) => onDeleteTweetSellPercentChange(e.target.value)}
            />
            <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">%</div>
          </div>
        </div>
        </>
      ) : null}
    </div>
  );
}
