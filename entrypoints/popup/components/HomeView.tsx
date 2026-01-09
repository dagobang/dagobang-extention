import { useState } from 'react';
import { call } from '@/utils/messaging';
import { Header } from './Header';
import type { BgGetStateResponse } from '@/types/extention';
import { Lock, Copy, Check, Settings, KeyRound } from 'lucide-react';
import { t, type Locale } from '@/utils/i18n';

type HomeViewProps = {
  state: BgGetStateResponse;
  balances: Record<string, string>;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onSettingsClick: () => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
};

export function HomeView({ state, balances, onRefresh, onError, onSettingsClick, locale, onLocaleChange }: HomeViewProps) {
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [isImport, setIsImport] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [addAccountPassword, setAddAccountPassword] = useState('');
  const [manageAddress, setManageAddress] = useState<`0x${string}` | null>(null);
  const [manageAlias, setManageAlias] = useState('');
  const [manageDefaultName, setManageDefaultName] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [exportedPrivateKey, setExportedPrivateKey] = useState<`0x${string}` | null>(null);
  const [copiedPk, setCopiedPk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
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

  const getCurrentAddress = () => {
    return state.wallet.address;
  };

  const formatBalance = (addr: string) => {
    try {
      const bal = balances[addr];
      if (!bal) return '...';
      return parseFloat(bal).toFixed(4);
    } catch (e) {
      return '0.0000';
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedAddr(text);
    setTimeout(() => setCopiedAddr(null), 1000);
  };

  const getAliasKey = (addr: `0x${string}`) => addr.toLowerCase();

  const openManage = (addr: `0x${string}`, fallbackName: string) => {
    const currentAlias = state.settings.accountAliases?.[getAliasKey(addr)] ?? '';
    setManageAddress(addr);
    setManageAlias(currentAlias || fallbackName);
    setManageDefaultName(fallbackName);
    setExportPassword('');
    setExportedPrivateKey(null);
    setCopiedPk(false);
  };

  const closeManage = () => {
    setManageAddress(null);
    setManageAlias('');
    setManageDefaultName('');
    setExportPassword('');
    setExportedPrivateKey(null);
    setCopiedPk(false);
  };

  return (
    <div className="relative w-[360px] bg-zinc-950 text-zinc-100 h-[500px] flex flex-col">
      <Header
        chainId={state.network.chainId}
        isUnlocked={state.wallet.isUnlocked}
        onSettingsClick={onSettingsClick}
        locale={locale}
        onLocaleChange={onLocaleChange}
      />

      {/* Account List / Switcher */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-zinc-400">{tt('popup.home.myAccounts')}</div>
          <button
            className="text-[12px] text-emerald-500 hover:text-emerald-400"
            onClick={() => {
                setShowAddAccount(!showAddAccount);
                setIsImport(false);
                setPrivateKey('');
            }}
          >
            {showAddAccount ? tt('common.cancel') : tt('popup.home.addNew')}
          </button>
        </div>

        {showAddAccount && (
          <div className="mb-3 rounded-md bg-zinc-900 p-3 border border-zinc-800 space-y-3">
            <div className="flex gap-2 bg-zinc-950 p-1 rounded-md border border-zinc-800">
                <button
                    className={`flex-1 py-1 text-[12px] rounded transition-colors ${!isImport ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
                    onClick={() => setIsImport(false)}
                >
                    {tt('popup.home.createNew')}
                </button>
                <button
                    className={`flex-1 py-1 text-[12px] rounded transition-colors ${isImport ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
                    onClick={() => setIsImport(true)}
                >
                    {tt('popup.home.importPrivateKey')}
                </button>
            </div>

            <input
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs outline-none"
              placeholder={tt('popup.home.accountNamePlaceholder')}
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
            />

            {isImport && (
                <input
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs outline-none font-mono placeholder:font-sans"
                  placeholder={tt('popup.home.privateKeyPlaceholder')}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                />
            )}

            <input
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs outline-none"
              placeholder={tt('popup.home.verifyPassword')}
              type="password"
              value={addAccountPassword}
              onChange={(e) => setAddAccountPassword(e.target.value)}
            />
            
            <button
              className="w-full rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors"
              disabled={busy || !addAccountPassword || (isImport && !privateKey)}
              onClick={() =>
                withBusy(async () => {
                  await call({
                    type: 'wallet:addAccount',
                    name: newAccountName,
                    password: addAccountPassword,
                    privateKey: isImport ? privateKey : undefined,
                  });
                  setNewAccountName('');
                  setAddAccountPassword('');
                  setPrivateKey('');
                  setShowAddAccount(false);
                  await onRefresh();
                })
              }
            >
              {isImport ? tt('popup.home.importAccount') : tt('popup.home.createAccount')}
            </button>
          </div>
        )}

        <div className="space-y-2">
          {state.wallet.accounts?.map((acc) => (
            <div
              key={acc.address}
              className={`flex items-center justify-between p-3 rounded-md transition-colors ${
                acc.address === getCurrentAddress()
                  ? 'bg-zinc-900 border border-emerald-500/30'
                  : 'bg-zinc-900/30 border border-transparent hover:bg-zinc-900'
              }`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div
                  className={`flex-shrink-0 w-2 h-2 rounded-full ${
                    acc.address === getCurrentAddress() ? 'bg-emerald-500' : 'bg-zinc-700'
                  }`}
                ></div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-medium text-zinc-200 truncate">
                      {state.settings.accountAliases?.[getAliasKey(acc.address)] ?? acc.name}
                    </div>
                    {acc.type === 'imported' && (
                        <span className="text-[9px] bg-amber-900/30 text-amber-500 px-1.5 py-0.5 rounded border border-amber-900/50">{tt('popup.home.imported')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                      <div className="text-[12px] text-zinc-500 font-mono truncate">
                        {acc.address.slice(0, 6)}...{acc.address.slice(-4)}
                      </div>
                      <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            copyToClipboard(acc.address);
                        }}
                        className="text-zinc-600 hover:text-zinc-400 transition-colors"
                        title={tt('popup.home.copyAddress')}
                      >
                          {copiedAddr === acc.address ? <Check size={10} className="text-emerald-500"/> : <Copy size={10} />}
                      </button>
                  </div>
                  <div className="text-[14px] text-zinc-400 font-mono mt-0.5">
                    {formatBalance(acc.address)} BNB
                  </div>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center gap-2">
                <button
                  className="w-7 h-7 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors flex items-center justify-center"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    openManage(acc.address, acc.name);
                  }}
                  title={tt('popup.home.manage.button')}
                >
                  <Settings size={14} />
                </button>
                {acc.address !== getCurrentAddress() && (
                  <button
                    className="px-2 py-1 rounded bg-zinc-800 text-[12px] hover:bg-zinc-700 transition-colors"
                    disabled={busy}
                    onClick={() =>
                      withBusy(async () => {
                        await call({ type: 'wallet:switchAccount', address: acc.address });
                        await onRefresh();
                      })
                    }
                  >
                    {tt('popup.home.switch')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-zinc-800">
        <button
          className="w-full rounded-md bg-zinc-900 border border-zinc-800 px-3 py-2 text-xs font-semibold hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2"
          onClick={() =>
            withBusy(async () => {
              await call({ type: 'wallet:lock' });
              await onRefresh();
            })
          }
        >
          <Lock size={12} />
          {tt('popup.home.lockWallet')}
        </button>
      </div>

      {manageAddress && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full rounded-md bg-zinc-950 border border-zinc-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold">{tt('popup.home.manage.title')}</div>
              <button
                className="text-[12px] text-zinc-400 hover:text-zinc-200"
                onClick={closeManage}
              >
                {tt('popup.home.manage.close')}
              </button>
            </div>

            <div className="text-[12px] text-zinc-500 font-mono">
              {manageAddress.slice(0, 6)}...{manageAddress.slice(-4)}
            </div>

            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.home.manage.alias')}</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
                placeholder={tt('popup.home.manage.aliasPlaceholder')}
                value={manageAlias}
                onChange={(e) => setManageAlias(e.target.value)}
              />
              <button
                className="w-full rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
                disabled={busy}
                onClick={() =>
                  withBusy(async () => {
                    const trimmed = manageAlias.trim();
                    const normalized = trimmed === manageDefaultName.trim() ? '' : trimmed;
                    await call({ type: 'settings:setAccountAlias', address: manageAddress, alias: normalized });
                    await onRefresh();
                    closeManage();
                  })
                }
              >
                {tt('popup.home.manage.save')}
              </button>
            </div>

            <div className="pt-3 border-t border-zinc-800 space-y-2">
              <div className="text-[14px] text-zinc-400">{tt('popup.home.manage.exportPrivateKey')}</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
                placeholder={tt('popup.home.manage.passwordPlaceholder')}
                value={exportPassword}
                type="password"
                onChange={(e) => setExportPassword(e.target.value)}
              />
              <button
                className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors flex items-center justify-center gap-2"
                disabled={busy || !exportPassword}
                onClick={() =>
                  withBusy(async () => {
                    const res = await call({
                      type: 'wallet:exportAccountPrivateKey',
                      address: manageAddress,
                      password: exportPassword,
                    });
                    setExportedPrivateKey(res.privateKey);
                    setExportPassword('');
                    setCopiedPk(false);
                  })
                }
              >
                <KeyRound size={14} />
                {tt('popup.home.manage.export')}
              </button>

              {exportedPrivateKey && (
                <div className="space-y-2">
                  <div className="text-[14px] text-zinc-400">{tt('popup.home.manage.privateKey')}</div>
                  <div className="rounded-md border border-zinc-800 bg-zinc-900 p-3 text-xs font-mono break-all">
                    {exportedPrivateKey}
                  </div>
                  <button
                    className="w-full rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors flex items-center justify-center gap-2"
                    disabled={busy}
                    onClick={() => {
                      navigator.clipboard.writeText(exportedPrivateKey);
                      setCopiedPk(true);
                      setTimeout(() => setCopiedPk(false), 1000);
                    }}
                  >
                    {copiedPk ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    {copiedPk ? tt('popup.home.manage.copied') : tt('popup.home.manage.copy')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
