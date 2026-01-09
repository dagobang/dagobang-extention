import { useState } from 'react';
import { call } from '@/utils/messaging';
import { Header } from './Header';
import { isHexPrivateKey } from '@/utils/format';
import type { WalletImportInput } from '@/types/extention';
import { t, type Locale } from '@/utils/i18n';

type WelcomeViewProps = {
  onBackup: (mnemonic: string) => void;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

export function WelcomeView({ onBackup, onRefresh, onError, locale, onLocaleChange }: WelcomeViewProps) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
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

  const passwordsMatch = newPassword.length >= 6 && newPassword === confirmPassword;

  return (
    <div className="w-[360px] bg-zinc-950 text-zinc-100 h-[500px] flex flex-col">
      <Header locale={locale} onLocaleChange={onLocaleChange} />
      <div className="p-4 flex-1 flex flex-col justify-center space-y-4">
        <div className="text-center mb-4">
          <div className="text-lg font-bold">{tt('popup.welcome.title')}</div>
          <div className="text-xs text-zinc-400">{tt('popup.welcome.subtitle')}</div>
        </div>

        <div className="space-y-2">
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none focus:border-emerald-500"
            placeholder={tt('popup.welcome.passwordPlaceholder')}
            value={newPassword}
            type="password"
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none focus:border-emerald-500"
            placeholder={tt('popup.welcome.confirmPasswordPlaceholder')}
            value={confirmPassword}
            type="password"
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <div className="text-[10px] text-red-400">{tt('popup.welcome.passwordNotMatch')}</div>
          )}
          <button
            className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors"
            disabled={busy || !passwordsMatch}
            onClick={() =>
              withBusy(async () => {
                const res = await call({ type: 'wallet:create', input: { password: newPassword } });
                if (res.mnemonic) onBackup(res.mnemonic);
                await onRefresh();
              })
            }
          >
            {tt('popup.welcome.createWallet')}
          </button>
        </div>

        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-zinc-800"></span>
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-zinc-950 px-2 text-zinc-500">{tt('common.or')}</span>
          </div>
        </div>

        <div className="space-y-2">
          <textarea
            className="w-full h-16 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none focus:border-emerald-500 resize-none"
            placeholder={tt('popup.welcome.importPlaceholder')}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <button
            className="w-full rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
            disabled={busy || !passwordsMatch || !importText.trim()}
            onClick={() =>
              withBusy(async () => {
                const trimmed = importText.trim();
                const input: WalletImportInput = { password: newPassword };
                if (isHexPrivateKey(trimmed)) input.privateKey = trimmed;
                else input.mnemonic = trimmed;
                const res = await call({ type: 'wallet:import', input });
                if (res.mnemonic) onBackup(res.mnemonic);
                await onRefresh();
              })
            }
          >
            {tt('popup.welcome.importWallet')}
          </button>
        </div>
      </div>
    </div>
  );
}
