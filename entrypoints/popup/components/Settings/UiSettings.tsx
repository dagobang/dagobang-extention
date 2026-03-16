import type { SettingsDraftProps } from './types';

type UiSettingsProps = SettingsDraftProps;

export function UiSettings({ settingsDraft, setSettingsDraft, tt }: UiSettingsProps) {
  const showToolbar = settingsDraft.ui?.showToolbar ?? true;
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.ui')}</div>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.showToolbar')}</div>
          <input
            type="checkbox"
            checked={showToolbar}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                ui: {
                  ...(s.ui ?? {}),
                  showToolbar: e.target.checked,
                },
              }))
            }
          />
        </label>
      </div>
    </div>
  );
}
