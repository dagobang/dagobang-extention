import { useEffect, useState } from 'react';
import { call } from '@/utils/messaging';
import { Header } from './Header';
import type { BgGetStateResponse } from '@/types/extention';
import { Lock, Copy, Check, Settings, KeyRound, Send } from 'lucide-react';
import { t, type Locale } from '@/utils/i18n';
import { formatEther, isAddress } from 'viem';
import { getNativeSymbol } from '@/constants/chains';

type HomeViewProps = {
  state: BgGetStateResponse;
  balances: Record<string, string>;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onSettingsClick: () => void;
  onOpenNetworkSettings: () => void;
  onChainChange: (chainId: number) => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  bloxrouteUnlockWarning?: string | null;
};

export function HomeView({
  state,
  balances,
  onRefresh,
  onError,
  onSettingsClick,
  onOpenNetworkSettings,
  onChainChange,
  locale,
  onLocaleChange,
  bloxrouteUnlockWarning,
}: HomeViewProps) {
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
  const [transferFromAddress, setTransferFromAddress] = useState<`0x${string}` | null>(null);
  const [transferToAddress, setTransferToAddress] = useState('');
  const [transferAmountBnb, setTransferAmountBnb] = useState('');
  const [transferUseMax, setTransferUseMax] = useState(false);
  const [transferPassword, setTransferPassword] = useState('');
  const [transferBalanceWei, setTransferBalanceWei] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [eip7702ByAddress, setEip7702ByAddress] = useState<Record<string, {
    loading: boolean;
    delegated: boolean;
    delegateAddress?: `0x${string}`;
    code?: `0x${string}`;
    revoking?: boolean;
  }>>({});
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const nativeSymbol = getNativeSymbol(state.settings.chainId);
  const accountAddressListKey = (state.wallet.accounts ?? []).map((acc) => acc.address.toLowerCase()).join('|');

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
  const get7702Key = (addr: `0x${string}`) => addr.toLowerCase();

  useEffect(() => {
    let disposed = false;
    const accounts = state.wallet.accounts ?? [];
    if (!state.wallet.isUnlocked || accounts.length === 0) {
      setEip7702ByAddress({});
      return () => {
        disposed = true;
      };
    }
    setEip7702ByAddress((prev) => {
      const next: Record<string, {
        loading: boolean;
        delegated: boolean;
        delegateAddress?: `0x${string}`;
        code?: `0x${string}`;
        revoking?: boolean;
      }> = {};
      for (const acc of accounts) {
        const key = get7702Key(acc.address);
        next[key] = { loading: true, delegated: false, revoking: prev[key]?.revoking === true };
      }
      return next;
    });
    void (async () => {
      const results = await Promise.all(
        accounts.map(async (acc) => {
          try {
            const res = await call({ type: 'wallet:getEip7702Status', address: acc.address });
            return {
              key: get7702Key(acc.address),
              delegated: !!res.delegated,
              delegateAddress: res.delegateAddress,
              code: res.code,
            };
          } catch {
            return {
              key: get7702Key(acc.address),
              delegated: false,
              delegateAddress: undefined,
              code: undefined,
            };
          }
        }),
      );
      if (disposed) return;
      setEip7702ByAddress((prev) => {
        const next = { ...prev };
        for (const item of results) {
          const old = next[item.key];
          next[item.key] = {
            loading: false,
            delegated: item.delegated,
            delegateAddress: item.delegateAddress,
            code: item.code,
            revoking: old?.revoking === true,
          };
        }
        return next;
      });
    })();
    return () => {
      disposed = true;
    };
  }, [state.wallet.isUnlocked, state.settings.chainId, accountAddressListKey]);

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

  const openTransfer = (addr: `0x${string}`) => {
    setTransferFromAddress(addr);
    setTransferToAddress('');
    setTransferAmountBnb('');
    setTransferUseMax(false);
    setTransferPassword('');
    setTransferBalanceWei(null);
    withBusy(async () => {
      const balRes = await call({ type: 'chain:getBalance', address: addr });
      setTransferBalanceWei(balRes.balanceWei);
    });
  };

  const closeTransfer = () => {
    setTransferFromAddress(null);
    setTransferToAddress('');
    setTransferAmountBnb('');
    setTransferUseMax(false);
    setTransferPassword('');
    setTransferBalanceWei(null);
  };

  const getTransferBalanceBnb = () => {
    const addr = transferFromAddress;
    if (!addr) return null;
    if (transferBalanceWei) {
      try {
        return formatEther(BigInt(transferBalanceWei));
      } catch {
      }
    }
    return balances[addr] ?? null;
  };

  const canSubmitTransfer = (() => {
    if (!transferFromAddress) return false;
    const to = transferToAddress.trim();
    if (!to || !isAddress(to)) return false;
    if (!transferPassword) return false;
    if (transferUseMax) return true;
    const raw = transferAmountBnb.trim();
    const n = Number(raw);
    return raw.length > 0 && Number.isFinite(n) && n > 0;
  })();

  return (
    <div className="relative w-[360px]  h-full bg-zinc-950 text-zinc-100 flex flex-col">
      <Header
        chainId={state.settings.chainId}
        onChainChange={onChainChange}
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
                    {eip7702ByAddress[get7702Key(acc.address)]?.delegated && (
                        <span
                          className="text-[9px] bg-fuchsia-900/30 text-fuchsia-400 px-1.5 py-0.5 rounded border border-fuchsia-900/50"
                          title={`该地址启用了 EIP-7702 智能账户委托（Delegated Account）。
部分节点会对这类账户施加更严格的 in-flight/pending 限制，可能导致交易发送失败或 nonce 步进异常。
如果你使用高频买卖/狙击，建议点击“取消7702”恢复普通 EOA 模式，以提升交易稳定性。
当前委托目标：${eip7702ByAddress[get7702Key(acc.address)]?.delegateAddress || 'unknown'}`}
                        >
                          7702
                        </span>
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
                  {eip7702ByAddress[get7702Key(acc.address)]?.delegated && (
                    <div className="text-[10px] text-fuchsia-400/80 mt-0.5">
                      7702 to {String(eip7702ByAddress[get7702Key(acc.address)]?.delegateAddress || '').slice(0, 6)}...{String(eip7702ByAddress[get7702Key(acc.address)]?.delegateAddress || '').slice(-4)}
                    </div>
                  )}
                  <div className="text-[14px] text-zinc-400 font-mono mt-0.5">
                    {formatBalance(acc.address)} {nativeSymbol}
                  </div>
                </div>
              </div>

              <div className="flex-shrink-0 flex items-center gap-2">
                {eip7702ByAddress[get7702Key(acc.address)]?.delegated && (
                  <button
                    className="px-2 py-1 rounded bg-fuchsia-900/30 text-[10px] text-fuchsia-300 border border-fuchsia-900/50 hover:bg-fuchsia-900/40 transition-colors disabled:opacity-60"
                    disabled={busy || eip7702ByAddress[get7702Key(acc.address)]?.revoking}
                    onClick={() =>
                      withBusy(async () => {
                        const ok = window.confirm('检测到该地址启用了 EIP-7702 委托。确认发送撤销交易？');
                        if (!ok) return;
                        const key = get7702Key(acc.address);
                        setEip7702ByAddress((prev) => ({
                          ...prev,
                          [key]: { ...(prev[key] ?? { loading: false, delegated: true }), revoking: true },
                        }));
                        try {
                          await call({ type: 'wallet:revokeEip7702', address: acc.address });
                          const status = await call({ type: 'wallet:getEip7702Status', address: acc.address });
                          setEip7702ByAddress((prev) => ({
                            ...prev,
                            [key]: {
                              loading: false,
                              delegated: !!status.delegated,
                              delegateAddress: status.delegateAddress,
                              code: status.code,
                              revoking: false,
                            },
                          }));
                          await onRefresh();
                        } catch (e: any) {
                          setEip7702ByAddress((prev) => ({
                            ...prev,
                            [key]: { ...(prev[key] ?? { loading: false, delegated: true }), revoking: false },
                          }));
                          throw e;
                        }
                      })
                    }
                    title="取消 EIP-7702 智能账户委托，恢复普通 EOA 交易模式（通常更稳定）"
                  >
                    {eip7702ByAddress[get7702Key(acc.address)]?.revoking ? '撤销中' : '取消7702'}
                  </button>
                )}
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
                <button
                  className="w-7 h-7 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors flex items-center justify-center"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    openTransfer(acc.address);
                  }}
                  title={tt('popup.home.transfer.button')}
                >
                  <Send size={14} />
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

      {bloxrouteUnlockWarning && (
        <div className="px-4 pb-2">
          <div className="rounded-md border border-amber-900/60 bg-amber-950/60 px-3 py-2">
            <div className="text-[11px] text-amber-200">{bloxrouteUnlockWarning}</div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                className="rounded-md bg-amber-900/40 px-2 py-1 text-[11px] font-semibold text-amber-100 hover:bg-amber-900/55 transition-colors"
                onClick={onOpenNetworkSettings}
              >
                {tt('popup.home.bloxrouteWarningOpenSettings')}
              </button>
              <button
                type="button"
                className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] font-semibold text-zinc-100 hover:bg-zinc-700 transition-colors"
                onClick={() => call({ type: 'bloxroute:openCertPage' } as const).catch(() => { })}
              >
                {tt('popup.home.bloxrouteWarningOpenCert')}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {transferFromAddress && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full rounded-md bg-zinc-950 border border-zinc-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold">{tt('popup.home.transfer.title')}</div>
              <button
                className="text-[12px] text-zinc-400 hover:text-zinc-200"
                onClick={closeTransfer}
              >
                {tt('popup.home.transfer.close')}
              </button>
            </div>

            <div className="text-[12px] text-zinc-500">
              {tt('popup.home.transfer.from')} {transferFromAddress.slice(0, 6)}...{transferFromAddress.slice(-4)}
            </div>

            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.home.transfer.to')}</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none font-mono placeholder:font-sans"
                placeholder={tt('popup.home.transfer.toPlaceholder')}
                value={transferToAddress}
                onChange={(e) => setTransferToAddress(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="text-[14px] text-zinc-400">{tt('popup.home.transfer.amount')}</div>
                <div className="text-[12px] text-zinc-500">
                  {tt('popup.home.transfer.available')} {getTransferBalanceBnb() ?? '...'} {nativeSymbol}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none font-mono placeholder:font-sans"
                  placeholder={transferUseMax ? tt('popup.home.transfer.maxSelected') : '0.0'}
                  value={transferUseMax ? '' : transferAmountBnb}
                  onChange={(e) => setTransferAmountBnb(e.target.value)}
                  disabled={busy || transferUseMax}
                  inputMode="decimal"
                />
                <button
                  type="button"
                  className="rounded-md bg-zinc-800 px-2 py-2 text-xs font-semibold hover:bg-zinc-700 transition-colors disabled:opacity-60"
                  disabled={busy}
                  onClick={() => {
                    if (transferUseMax) {
                      setTransferUseMax(false);
                    } else {
                      setTransferUseMax(true);
                      setTransferAmountBnb('');
                    }
                  }}
                >
                  {transferUseMax ? tt('popup.home.transfer.unmax') : tt('popup.home.transfer.max')}
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.home.transfer.password')}</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none"
                placeholder={tt('popup.home.transfer.passwordPlaceholder')}
                value={transferPassword}
                type="password"
                onChange={(e) => setTransferPassword(e.target.value)}
              />
            </div>

            <button
              className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors"
              disabled={busy || !canSubmitTransfer}
              onClick={() =>
                withBusy(async () => {
                  const to = transferToAddress.trim() as `0x${string}`;
                  await call({
                    type: 'tx:transferNative',
                    fromAddress: transferFromAddress,
                    toAddress: to,
                    amountBnb: transferAmountBnb.trim(),
                    useMax: transferUseMax,
                    password: transferPassword,
                  });
                  closeTransfer();
                  await onRefresh();
                })
              }
            >
              {tt('popup.home.transfer.confirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
