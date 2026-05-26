import { ChevronDown, CircleCheckBig, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SubmitChannel } from '@/types/extention';

type SubmitChannelStatusView = {
  channel: SubmitChannel;
  configured: boolean;
  available: boolean;
  reason: string;
};

type ChannelSwitcherProps = {
  submitChannel: SubmitChannel;
  submitChannelStatuses: SubmitChannelStatusView[];
  onSelectSubmitChannel: (channel: SubmitChannel) => void;
  prewarmIndicatorState?: 'hidden' | 'warming' | 'done';
  prewarmIndicatorTitle?: string;
  inline?: boolean;
  menuPlacement?: 'up' | 'down';
};

const CHANNEL_LABELS: Record<SubmitChannel, string> = {
  blox: 'Blox',
  blockrazor: 'Razor',
  protectRpcs: 'Protect',
};

export function ChannelSwitcher({
  submitChannel,
  submitChannelStatuses,
  onSelectSubmitChannel,
  prewarmIndicatorState,
  prewarmIndicatorTitle,
  inline = false,
  menuPlacement = 'up',
}: ChannelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeStatus = useMemo(
    () => submitChannelStatuses.find((item) => item.channel === submitChannel) ?? submitChannelStatuses[0],
    [submitChannel, submitChannelStatuses]
  );
  const prewarmToneClass = prewarmIndicatorState === 'done'
    ? 'text-emerald-300 hover:text-emerald-200'
    : prewarmIndicatorState === 'warming'
      ? 'text-sky-300 hover:text-sky-200'
      : 'text-zinc-500 hover:text-zinc-300';
  const prewarmHint = prewarmIndicatorTitle ?? '进入代币详情页后开始预热';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const wrapperClassName = inline
    ? 'inline-flex items-center align-middle'
    : 'border-t border-zinc-800/50 px-3 py-1';
  const contentClassName = inline
    ? 'inline-flex items-center'
    : 'flex items-center justify-between gap-2';
  const menuPositionClassName = menuPlacement === 'down'
    ? 'top-7 left-0'
    : 'bottom-8 left-0';

  return (
    <div className={wrapperClassName}>
      <div className={contentClassName}>
        <div ref={rootRef} className="relative min-w-0">
          <button
            type="button"
            className={inline
              ? 'inline-flex h-5 items-center gap-0.5 rounded-md px-1 text-left text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200'
              : 'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-left text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200'}
            onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => {
              e.stopPropagation();
            }}
            onClick={(e: ReactPointerEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              setOpen((prev) => !prev);
            }}
            title={activeStatus ? `${CHANNEL_LABELS[activeStatus.channel]}: ${activeStatus.reason}` : undefined}
          >
            <span className={inline ? 'truncate text-[10px] font-medium text-zinc-200' : 'truncate text-[11px] font-semibold text-zinc-100'}>
              {activeStatus ? CHANNEL_LABELS[activeStatus.channel] : CHANNEL_LABELS[submitChannel]}
            </span>
            {prewarmIndicatorState && prewarmIndicatorState !== 'hidden' && (
              <span
                className={`inline-flex items-center justify-center rounded-sm ${inline ? 'ml-0.5 h-4 w-4' : 'ml-1 h-5 w-5'} ${prewarmToneClass}`}
                title={prewarmHint}
              >
                {prewarmIndicatorState === 'done'
                  ? <CircleCheckBig size={inline ? 9 : 11} />
                  : <LoaderCircle size={inline ? 9 : 11} className={prewarmIndicatorState === 'warming' ? 'animate-spin' : ''} />}
              </span>
            )}
            <ChevronDown size={inline ? 10 : 12} className={open ? 'shrink-0 rotate-180 text-zinc-500 transition-transform' : 'shrink-0 text-zinc-500 transition-transform'} />
          </button>
          {open && (
            <div
              className={`absolute z-40 w-44 rounded-lg border border-zinc-700 bg-[#141416] p-1.5 shadow-xl ${menuPositionClassName}`}
              onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => e.stopPropagation()}
            >
              {submitChannelStatuses.map((item) => {
                const active = submitChannel === item.channel;
                const disabled = !item.available;
                return (
                  <button
                    key={item.channel}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      onSelectSubmitChannel(item.channel);
                      setOpen(false);
                    }}
                    className={[
                      'mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors last:mb-0',
                      active
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'text-zinc-200 hover:bg-zinc-800',
                      disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent' : '',
                    ].join(' ')}
                    title={item.reason}
                  >
                    <span className="text-[12px] font-medium">{CHANNEL_LABELS[item.channel]}</span>
                    <span className="text-[10px] text-zinc-500">{item.reason}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
