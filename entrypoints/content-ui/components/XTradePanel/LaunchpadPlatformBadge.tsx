import { normalizeLaunchpadPlatform } from '@/constants/launchpad';

type LaunchpadPlatformBadgeProps = {
  platform: unknown;
  fallback?: string;
  className?: string;
};

type LaunchpadBadgeMeta = {
  title: string;
  iconText: string;
  capsuleClassName: string;
  iconClassName: string;
  agent: boolean;
};

const LAUNCHPAD_BADGES: Record<string, LaunchpadBadgeMeta> = {
  fourmeme: {
    title: 'Fourmeme',
    iconText: '4',
    capsuleClassName: 'border-emerald-500/55 bg-emerald-500/10 text-emerald-200',
    iconClassName: 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200',
    agent: false,
  },
  fourmeme_agent: {
    title: 'Fourmeme Agent',
    iconText: '4',
    capsuleClassName: 'border-emerald-500/55 bg-emerald-500/10 text-emerald-200',
    iconClassName: 'border-emerald-400/60 bg-emerald-500/20 text-emerald-100',
    agent: true,
  },
  xmode: {
    title: 'X Mode',
    iconText: 'X',
    capsuleClassName: 'border-amber-500/55 bg-amber-500/10 text-amber-200',
    iconClassName: 'border-amber-400/60 bg-amber-500/20 text-amber-100',
    agent: false,
  },
  xmode_agent: {
    title: 'X Mode Agent',
    iconText: 'X',
    capsuleClassName: 'border-amber-500/55 bg-amber-500/10 text-amber-200',
    iconClassName: 'border-amber-400/60 bg-amber-500/20 text-amber-100',
    agent: true,
  },
  flap: {
    title: 'Flap',
    iconText: 'F',
    capsuleClassName: 'border-violet-500/55 bg-violet-500/10 text-violet-200',
    iconClassName: 'border-violet-400/60 bg-violet-500/20 text-violet-100',
    agent: false,
  },
};

export function LaunchpadPlatformBadge({
  platform,
  fallback = '-',
  className = '',
}: LaunchpadPlatformBadgeProps) {
  const normalized = normalizeLaunchpadPlatform(platform);
  if (!normalized) return <span className={`text-zinc-400 ${className}`}>{fallback}</span>;

  const meta = LAUNCHPAD_BADGES[normalized];
  if (!meta) {
    return (
      <span className={`inline-flex items-center px-1 py-0.5 text-[10px] text-zinc-200 ${className}`}>
        {normalized}
      </span>
    );
  }

  return (
    <>
      {
        meta.agent ? (<span
          title={meta.title}
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center border text-[9px] font-semibold leading-none rounded-full ${meta.iconClassName}`}
        >
          {meta.iconText}
        </span>)
          : (<span className={`inline-flex items-center gap-1.5 rounded-full border px-1 py-0.5 text-[10px] font-medium leading-none ${meta.capsuleClassName} ${className}`}>{meta.title}</span>)
      }
    </>
  );
}
