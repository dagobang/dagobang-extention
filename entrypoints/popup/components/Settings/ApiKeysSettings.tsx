import type { SettingsDraftProps } from './types';

type ApiKeysSettingsProps = SettingsDraftProps;

export function ApiKeysSettings({ settingsDraft, setSettingsDraft, tt }: ApiKeysSettingsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.apiKeysSection')}</div>
        <label className="hidden block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.seedreamApiKeyLabel')}</div>
          <input
            type="password"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={settingsDraft.seedreamApiKey ?? ''}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                seedreamApiKey: e.target.value,
              }))
            }
            placeholder={tt('popup.settings.seedreamApiKeyPlaceholder')}
          />
        </label>
        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.bloxrouteAuthHeaderLabel')}</div>
          <input
            type="password"
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={settingsDraft.bloxrouteAuthHeader ?? ''}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                bloxrouteAuthHeader: e.target.value,
              }))
            }
            placeholder={tt('popup.settings.bloxrouteAuthHeaderPlaceholder')}
          />
          <div className="text-[11px] text-zinc-500">
            {tt('popup.settings.bloxrouteAuthHeaderApplyHint')}{' '}
            <a className="underline hover:text-zinc-300" href="https://portal.bloxroute.com/" target="_blank" rel="noreferrer">
              https://portal.bloxroute.com/
            </a>
          </div>
        </label>
      </div>
    </div>
  );
}
