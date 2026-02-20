import { ChevronRight, ExternalLink } from 'lucide-react';
import type { SettingsSectionId, TFunc } from './types';

type SettingsHomeProps = {
  tt: TFunc;
  busy: boolean;
  onOpenSection: (section: Exclude<SettingsSectionId, 'root'>) => void;
};

const HELP_DOCS_URL = 'https://seasonsrich.gitbook.io/dagobang';

function getExtensionVersion(): string | undefined {
  try {
    const runtime = (globalThis as any)?.chrome?.runtime;
    const v = runtime?.getManifest?.()?.version;
    if (typeof v === 'string' && v.length > 0) return v;
    return undefined;
  } catch {
    return undefined;
  }
}

export function SettingsHome({ tt, busy, onOpenSection }: SettingsHomeProps) {
  const version = getExtensionVersion();
  const Item = (props: { title: string; onClick: () => void }) => (
    <button
      type="button"
      className="w-full flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 hover:bg-zinc-800 transition-colors"
      onClick={props.onClick}
    >
      <div className="text-[14px] text-zinc-200">{props.title}</div>
      <ChevronRight size={16} className="text-zinc-500" />
    </button>
  );

  return (
    <div className="space-y-3">
      <Item title={tt('popup.settings.network')} onClick={() => onOpenSection('network')} />
      <Item title={tt('popup.settings.trade')} onClick={() => onOpenSection('trade')} />
      <Item title={tt('popup.settings.gasPreset')} onClick={() => onOpenSection('gas')} />
      <Item title={tt('popup.settings.uiSection')} onClick={() => onOpenSection('ui')} />
      <Item title={tt('popup.settings.security')} onClick={() => onOpenSection('security')} />

      <button
        type="button"
        className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2"
        disabled={busy}
        onClick={() => {
          try {
            window.open(HELP_DOCS_URL, '_blank', 'noopener,noreferrer');
          } catch {
          }
        }}
      >
        <ExternalLink size={14} />
        {tt('popup.settings.helpDocs')}
      </button>

      {version && (
        <div className="pt-2 text-center text-[11px] text-zinc-600">{tt('popup.settings.version', [version])}</div>
      )}
    </div>
  );
}
