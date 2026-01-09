import { useState } from 'react';
import { call } from '@/utils/messaging';
import { Header } from './Header';
import { Lock } from 'lucide-react';
import { t, type Locale } from '@/utils/i18n';

type UnlockViewProps = {
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

export function UnlockView({ onRefresh, onError, locale, onLocaleChange }: UnlockViewProps) {
  const [password, setPassword] = useState('');
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

  const handleUnlock = () =>
    withBusy(async () => {
      await call({ type: 'wallet:unlock', input: { password } });
      setPassword('');
      await onRefresh();
    });

  return (
    <div className="w-[360px] bg-zinc-950 text-zinc-100 h-[500px] flex flex-col">
      <Header locale={locale} onLocaleChange={onLocaleChange} />
      <div className="flex-1 flex flex-col items-center justify-center p-6 space-y-4">
        <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center mb-2">
          <Lock className="text-emerald-500" size={24} />
        </div>
        <div className="text-center">
          <div className="font-semibold">{tt('popup.unlock.title')}</div>
          <div className="text-xs text-zinc-400">{tt('popup.unlock.subtitle')}</div>
        </div>
        <input
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none focus:border-emerald-500"
          placeholder={tt('popup.unlock.passwordPlaceholder')}
          value={password}
          type="password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
        />
        <button
          className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors"
          disabled={busy || !password}
          onClick={handleUnlock}
        >
          {tt('popup.unlock.unlock')}
        </button>
      </div>
    </div>
  );
}
