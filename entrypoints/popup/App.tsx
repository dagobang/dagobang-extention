import { useEffect, useRef, useState } from 'react';
import { formatEther } from 'viem';
import type { BgGetStateResponse } from '@/types/extention';
import { defaultSettings } from '@/utils/defaults';
import { call } from '@/utils/messaging';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';

import { BackupView } from './components/BackupView';
import { WelcomeView } from './components/WelcomeView';
import { UnlockView } from './components/UnlockView';
import { SettingsView } from './components/SettingsView';
import { HomeView } from './components/HomeView';

type View = 'loading' | 'welcome' | 'unlock' | 'home' | 'settings';

function App() {
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<BgGetStateResponse | null>(null);
  const [view, setView] = useState<View>('loading');
  const viewRef = useRef(view);
  const [locale, setLocale] = useState<Locale>('zh_CN');

  // Keep ref in sync
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // Data
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [backupMnemonic, setBackupMnemonic] = useState<string | null>(null);

  const handleLocaleChange = (loc: Locale) => {
    setLocale(loc);
    const current = state?.settings ?? defaultSettings();
    void call({ type: 'settings:set', settings: { ...current, locale: loc } })
      .then(refresh)
      .catch((e: any) => {
        setError(t('popup.error.serviceUnavailable', loc, [e?.message || String(e)]));
      });
  };

  const handleChildError = (raw: string) => {
    const msg = (() => {
      if (raw === 'Invalid password' || raw.includes('Invalid password')) return t('popup.error.invalidPassword', locale);
      return raw;
    })();
    setError(msg);
  };

  async function refresh() {
    if (document.hidden) return;
    setError(null);
    try {
      const res = await call({ type: 'bg:getState' });
      setState(res);
      setLocale(normalizeLocale(res.settings.locale));

      const currentView = viewRef.current;

      // Determine view if not manually navigating
      if (currentView === 'loading') {
        if (!res.wallet.hasEncrypted) setView('welcome');
        else if (!res.wallet.isUnlocked) setView('unlock');
        else setView('home');
      } else {
        // Only redirect if critical state changes (e.g., wallet locked)
        // Do NOT redirect if just switching between unlocked states (home <-> settings)
        if (!res.wallet.isUnlocked && (currentView === 'home' || currentView === 'settings')) {
          setView('unlock');
        }
        // Redirect to home if unlocked and currently on unlock page
        if (res.wallet.isUnlocked && currentView === 'unlock') {
          setView('home');
        }
      }

      // Fetch balances for all accounts if unlocked
      if (res.wallet.isUnlocked && res.wallet.accounts) {
        const newBalances: Record<string, string> = {};
        await Promise.all(
          res.wallet.accounts.map(async (acc) => {
            try {
              const balRes = await call({ type: 'chain:getBalance', address: acc.address });
              newBalances[acc.address] = formatEther(BigInt(balRes.balanceWei));
            } catch (e) {
              console.error(`Failed to fetch balance for ${acc.address}`, e);
              newBalances[acc.address] = '0';
            }
          })
        );
        setBalances(newBalances);
      }
    } catch (e: any) {
      console.error('Refresh failed:', e);
      setError(t('popup.error.serviceUnavailable', locale, [e?.message || String(e)]));
    }
  }

  const savedRefresh = useRef(refresh);
  useEffect(() => {
    savedRefresh.current = refresh;
  });

  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) savedRefresh.current();
    };
    document.addEventListener('visibilitychange', onVis);

    refresh();
    return () => {
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []); // eslint-disable-line

  let content: React.ReactNode;

  if (backupMnemonic) {
    content = <BackupView mnemonic={backupMnemonic} onConfirm={() => setBackupMnemonic(null)} locale={locale} />;
  } else if (view === 'loading') {
    content = (
      <div className="w-[360px] h-[500px] bg-zinc-950 flex items-center justify-center text-zinc-500 text-xs">
        {t('common.loading', locale)}
      </div>
    );
  } else if (view === 'welcome') {
    content = (
      <WelcomeView
        onBackup={setBackupMnemonic}
        onRefresh={refresh}
        onError={handleChildError}
        locale={locale}
        onLocaleChange={handleLocaleChange}
      />
    );
  } else if (view === 'unlock') {
    content = (
      <UnlockView
        onRefresh={refresh}
        onError={handleChildError}
        locale={locale}
        onLocaleChange={handleLocaleChange}
      />
    );
  } else if (view === 'settings') {
    content = (
      <SettingsView
        initialSettings={state?.settings ?? defaultSettings()}
        onRefresh={refresh}
        onError={handleChildError}
        onBack={() => setView('home')}
        onBackup={setBackupMnemonic}
        locale={locale}
        onLocaleChange={handleLocaleChange}
      />
    );
  } else if (state && view === 'home') {
    content = (
      <HomeView
        state={state}
        balances={balances}
        onRefresh={refresh}
        onError={handleChildError}
        onSettingsClick={() => setView('settings')}
        locale={locale}
        onLocaleChange={handleLocaleChange}
      />
    );
  } else {
    content = (
      <div className="w-[360px] h-[500px] bg-zinc-950 flex items-center justify-center text-zinc-500 text-xs">
        {t('common.initializing', locale)}
      </div>
    );
  }

  return (
    <div className="relative">
      {content}
      {error && (
        <div className="absolute bottom-4 left-4 right-4 bg-red-950 border border-red-900 text-red-200 p-2 rounded-md text-xs shadow-lg">
          {error}
          <button className="absolute top-1 right-1 p-1 hover:text-white" onClick={() => setError(null)}>×</button>
        </div>
      )}
    </div>
  );
}

export default App;
