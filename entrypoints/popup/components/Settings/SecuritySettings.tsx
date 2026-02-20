import { useMemo, useState } from 'react';
import { call } from '@/utils/messaging';
import type { TFunc } from './types';

type SecuritySettingsProps = {
  tt: TFunc;
  busy: boolean;
  withBusy: (fn: () => Promise<void>) => Promise<void>;
  onBackup: (mnemonic: string) => void;
  onRefresh: () => Promise<void>;
};

export function SecuritySettings({ tt, busy, withBusy, onBackup, onRefresh }: SecuritySettingsProps) {
  const [exportPassword, setExportPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const passwordsMatch = useMemo(() => newPassword.length >= 6 && newPassword === confirmPassword, [confirmPassword, newPassword]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.security')}</div>
        <input
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
          placeholder={tt('popup.settings.exportPassword')}
          value={exportPassword}
          type="password"
          onChange={(e) => setExportPassword(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700"
            disabled={busy || !exportPassword}
            onClick={() =>
              withBusy(async () => {
                const res = await call({ type: 'wallet:exportPrivateKey', password: exportPassword });
                onBackup(res.privateKey);
                setExportPassword('');
              })
            }
          >
            {tt('popup.settings.exportPk')}
          </button>
          <button
            type="button"
            className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700"
            disabled={busy || !exportPassword}
            onClick={() =>
              withBusy(async () => {
                const res = await call({ type: 'wallet:exportMnemonic', password: exportPassword });
                onBackup(res.mnemonic);
                setExportPassword('');
              })
            }
          >
            {tt('popup.settings.exportMnemonic')}
          </button>
        </div>
      </div>

      <div className="space-y-3 pt-4 border-t border-zinc-800">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.changePassword')}</div>
        <div className="space-y-2">
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
            placeholder={tt('popup.settings.currentPassword')}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
            placeholder={tt('popup.settings.newPassword')}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
            placeholder={tt('popup.settings.confirmPassword')}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <div className="text-[10px] text-red-400">{tt('popup.welcome.passwordNotMatch')}</div>
          )}
          <button
            type="button"
            className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500"
            disabled={busy || !currentPassword || !passwordsMatch}
            onClick={() =>
              withBusy(async () => {
                await call({ type: 'wallet:updatePassword', oldPassword: currentPassword, newPassword });
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                alert(tt('popup.settings.passwordChanged'));
              })
            }
          >
            {tt('popup.settings.changePassword')}
          </button>
        </div>
      </div>

      <div className="pt-4 border-t border-zinc-800">
        <button
          type="button"
          className="w-full rounded-md bg-red-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-red-500"
          disabled={busy}
          onClick={() => {
            if (confirm(tt('popup.unlock.confirmWipe'))) {
              withBusy(async () => {
                await call({ type: 'wallet:wipe' });
                await onRefresh();
              });
            }
          }}
        >
          {tt('popup.unlock.resetWipe')}
        </button>
      </div>
    </div>
  );
}

