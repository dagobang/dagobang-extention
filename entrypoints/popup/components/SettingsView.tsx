import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { call } from '@/utils/messaging';
import type { Settings } from '@/types/extention';
import { defaultSettings } from '@/utils/defaults';
import { validateSettings } from '@/utils/validate';
import { t, type Locale } from '@/utils/i18n';
import { SettingsHome } from './Settings/SettingsHome';
import { NetworkSettings } from './Settings/NetworkSettings';
import { TradeSettings } from './Settings/TradeSettings';
import { GasSettings } from './Settings/GasSettings';
import { UiSettings } from './Settings/UiSettings';
import { SecuritySettings } from './Settings/SecuritySettings';
import type { SettingsSectionId } from './Settings/types';

type SettingsViewProps = {
  initialSettings: Settings;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onBack: () => void;
  onBackup: (mnemonic: string) => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

export function SettingsView({ initialSettings, onRefresh, onError, onBack, onBackup, locale, onLocaleChange }: SettingsViewProps) {
  const [settingsDraft, setSettingsDraft] = useState<Settings>(initialSettings);
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<SettingsSectionId>('root');
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  async function withBusy(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      onError(e?.message ? String(e.message) : tt('popup.error.unknown'));
    } finally {
      setBusy(false);
    }
  }

  const onSave = () =>
    withBusy(async () => {
      const validated = validateSettings(settingsDraft) ?? defaultSettings();
      await call({ type: 'settings:set', settings: validated });
      await onRefresh();
      onBack();
    });

  const chainId = settingsDraft.chainId;
  const validated = validateSettings(settingsDraft);
  const protectedRpcUrlsValidated = validated?.chains?.[chainId]?.protectedRpcUrls ?? [];
  const saveDisabled = section === 'network' && protectedRpcUrlsValidated.length === 0;

  const titleBySection: Record<SettingsSectionId, string> = {
    root: tt('popup.settings.title'),
    network: tt('popup.settings.network'),
    trade: tt('popup.settings.trade'),
    gas: tt('popup.settings.gasPreset'),
    ui: tt('popup.settings.uiSection'),
    security: tt('popup.settings.security'),
  };

  return (
    <div className="w-[360px] bg-zinc-950 text-zinc-100 h-[500px] flex flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 bg-zinc-900/50">
        <button
          type="button"
          onClick={() => {
            if (section === 'root') onBack();
            else setSection('root');
          }}
          className="hover:text-emerald-400"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-sm font-semibold flex-1">{titleBySection[section]}</div>
        <div className="w-[16px]" />
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {section === 'root' && <SettingsHome tt={tt} busy={busy} onOpenSection={(next) => setSection(next)} />}
        {section === 'network' && <NetworkSettings settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} tt={tt} busy={busy} />}
        {section === 'trade' && <TradeSettings settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} tt={tt} busy={busy} />}
        {section === 'gas' && <GasSettings settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} tt={tt} busy={busy} />}
        {section === 'ui' && (
          <UiSettings
            settingsDraft={settingsDraft}
            setSettingsDraft={setSettingsDraft}
            tt={tt}
            busy={busy}
            onLocaleChange={onLocaleChange}
          />
        )}
        {section === 'security' && <SecuritySettings tt={tt} busy={busy} withBusy={withBusy} onBackup={onBackup} onRefresh={onRefresh} />}

        {section !== 'root' && section !== 'security' && (
          <button
            type="button"
            className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500"
            disabled={busy || saveDisabled}
            onClick={onSave}
          >
            {tt('popup.settings.saveChanges')}
          </button>
        )}
      </div>
    </div>
  );
}
