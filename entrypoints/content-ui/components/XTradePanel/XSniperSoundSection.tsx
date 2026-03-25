import { ChevronDown, ChevronRight, Play } from 'lucide-react';
import type { TradeSuccessSoundPreset } from '@/types/extention';

type PresetOption = {
  value: TradeSuccessSoundPreset;
  label: string;
};

type XSniperSoundSectionProps = {
  open: boolean;
  canEdit: boolean;
  soundOffValue: string;
  soundSelectValue: string;
  deleteTweetSoundSelectValue: string;
  deleteTweetSoundPreset: TradeSuccessSoundPreset;
  twitterSnipe: any;
  presetOptions: PresetOption[];
  tt: (key: string, subs?: Array<string | number>) => string;
  onToggle: () => void;
  onTriggerSoundChange: (value: string) => void;
  onPreviewTriggerSound: () => void;
  onAutoSellEnabledChange: (checked: boolean) => void;
  onDeleteTweetSellPercentChange: (value: string) => void;
  onDeleteTweetSoundChange: (value: string) => void;
  onPreviewDeleteTweetSound: () => void;
};

export function XSniperSoundSection({
  open,
  canEdit,
  soundOffValue,
  soundSelectValue,
  deleteTweetSoundSelectValue,
  twitterSnipe,
  presetOptions,
  tt,
  onToggle,
  onTriggerSoundChange,
  onPreviewTriggerSound,
  onAutoSellEnabledChange,
  onDeleteTweetSellPercentChange,
  onDeleteTweetSoundChange,
  onPreviewDeleteTweetSound,
}: XSniperSoundSectionProps) {
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-md border border-zinc-800/70 bg-zinc-900/30 px-2 py-1.5 text-left text-[12px] text-zinc-300"
        onClick={onToggle}
      >
        <span>{tt('contentUi.autoTradeStrategy.sellAndSoundTitle')}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open ? (
      <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="text-[12px] text-zinc-400">{tt('contentUi.autoTradeStrategy.sectionSound')}</div>
          <select
            className="min-w-[120px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
            value={soundSelectValue}
            disabled={!canEdit}
            onChange={(e) => onTriggerSoundChange(e.target.value)}
          >
            <option value={soundOffValue}>{tt('contentUi.autoTradeStrategy.soundOff')}</option>
            {presetOptions.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800"
            onClick={onPreviewTriggerSound}
            title={tt('contentUi.autoTradeStrategy.soundPreview')}
          >
            <Play size={14} />
          </button>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3 w-3 accent-emerald-500"
              checked={!!twitterSnipe?.autoSellEnabled}
              disabled={!canEdit}
              onChange={(e) => onAutoSellEnabledChange(e.target.checked)}
            />
          {tt('contentUi.autoTradeStrategy.strategyAutoSell')}
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/60 pt-2">
        <div className="flex items-center gap-2 text-[12px] text-zinc-300">
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
        <div className="flex items-center gap-2 text-[12px] text-zinc-300">
          <div className="text-zinc-400">{tt('contentUi.autoTradeStrategy.deleteTweetSoundPreset')}</div>
          <select
            className="min-w-[140px] rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] outline-none"
            value={deleteTweetSoundSelectValue}
            disabled={!canEdit}
            onChange={(e) => onDeleteTweetSoundChange(e.target.value)}
          >
            <option value={soundOffValue}>{tt('contentUi.autoTradeStrategy.soundOff')}</option>
            {presetOptions.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50"
            disabled={!canEdit || deleteTweetSoundSelectValue === soundOffValue}
            onClick={onPreviewDeleteTweetSound}
            title={tt('contentUi.autoTradeStrategy.soundPreview')}
          >
            <Play size={14} />
          </button>
        </div>
      </div>
      </>
      ) : null}
    </div>
  );
}
