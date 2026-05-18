import type { SettingsDraftProps } from './types';

type SwitchSettingsProps = SettingsDraftProps;

export function SwitchSettings({ settingsDraft, setSettingsDraft, tt }: SwitchSettingsProps) {
  const showToolbar = settingsDraft.ui?.showToolbar ?? true;
  const limitTradePanelOnlyOnTokenPage = settingsDraft.ui?.limitTradePanelOnlyOnTokenPage ?? false;
  const quickCookingEnabled = settingsDraft.ui?.quickCookingEnabled ?? false;
  const newPoolMonitorEnabled = settingsDraft.ui?.newPoolMonitorEnabled ?? false;
  const newCoinSniperEnabled = settingsDraft.ui?.newCoinSniperEnabled ?? false;
  const visionReportEnabled = settingsDraft.ui?.visionReportEnabled ?? false;
  const consoleLogsEnabled = settingsDraft.ui?.consoleLogsEnabled ?? false;

  const updateUi = (patch: Partial<NonNullable<typeof settingsDraft.ui>>) =>
    setSettingsDraft((s) => ({
      ...s,
      ui: {
        showToolbar: s.ui?.showToolbar ?? true,
        limitTradePanelOnlyOnTokenPage: s.ui?.limitTradePanelOnlyOnTokenPage ?? false,
        quickCookingEnabled: s.ui?.quickCookingEnabled ?? false,
        newPoolMonitorEnabled: s.ui?.newPoolMonitorEnabled ?? false,
        newCoinSniperEnabled: s.ui?.newCoinSniperEnabled ?? false,
        visionReportEnabled: s.ui?.visionReportEnabled ?? false,
        consoleLogsEnabled: s.ui?.consoleLogsEnabled ?? false,
        ...patch,
      },
    }));

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.ui')}</div>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.showToolbar')}</div>
          <input
            type="checkbox"
            checked={showToolbar}
            onChange={(e) => updateUi({ showToolbar: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.limitTradePanelOnlyOnTokenPage')}</div>
          <input
            type="checkbox"
            checked={limitTradePanelOnlyOnTokenPage}
            onChange={(e) => updateUi({ limitTradePanelOnlyOnTokenPage: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.quickCooking')}</div>
          <input
            type="checkbox"
            checked={quickCookingEnabled}
            onChange={(e) => updateUi({ quickCookingEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.newPoolMonitor')}</div>
          <input
            type="checkbox"
            checked={newPoolMonitorEnabled}
            onChange={(e) => updateUi({ newPoolMonitorEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.newCoinSniper')}</div>
          <input
            type="checkbox"
            checked={newCoinSniperEnabled}
            onChange={(e) => updateUi({ newCoinSniperEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.visionReport')}</div>
          <input
            type="checkbox"
            checked={visionReportEnabled}
            onChange={(e) => updateUi({ visionReportEnabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.consoleLogs')}</div>
          <input
            type="checkbox"
            checked={consoleLogsEnabled}
            onChange={(e) => updateUi({ consoleLogsEnabled: e.target.checked })}
          />
        </label>
      </div>
    </div>
  );
}
