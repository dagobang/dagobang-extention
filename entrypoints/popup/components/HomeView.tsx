import { useEffect, useState } from 'react';
import { call } from '@/utils/messaging';
import { Header } from './Header';
import type { BgGetStateResponse } from '@/types/extention';
import { Lock, Copy, Check, Settings, KeyRound, Send } from 'lucide-react';
import { t, type Locale } from '@/utils/i18n';
import { formatEther, formatUnits, isAddress, parseUnits, zeroAddress } from 'viem';
import { getNativeSymbol } from '@/constants/chains';
import { getChainRuntime } from '@/constants/chains/runtime';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { USDC, USDT } from '@/constants/tokens/chains/common';
import { formatPriceValue } from '@/utils/format';
import { SymbolCoinIcon } from '@/components/Coins';

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
  const [tradeBaseBalances, setTradeBaseBalances] = useState<Record<string, string>>({});
  const [convertAddress, setConvertAddress] = useState<`0x${string}` | null>(null);
  const [convertAmount, setConvertAmount] = useState('');
  const [convertMode, setConvertMode] = useState<'wrap' | 'unwrap'>('wrap');
  const [allowances, setAllowances] = useState<Record<string, string>>({});
  const [approveDialogAddress, setApproveDialogAddress] = useState<`0x${string}` | null>(null);
  const [approvingAddress, setApprovingAddress] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [eip7702ByAddress, setEip7702ByAddress] = useState<Record<string, {
    loading: boolean;
    delegated: boolean;
    delegateAddress?: `0x${string}`;
    code?: `0x${string}`;
    revoking?: boolean;
  }>>({});
  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);
  const chainId = state.settings.chainId;
  const nativeSymbol = getNativeSymbol(chainId);
  const tradeBaseToken = String(state.settings.tradeBaseToken ?? 'BNB').toUpperCase();
  const wrappedNativeAddress = getChainRuntime(chainId).wrappedNativeAddress;
  const tradeBaseTokenAddress = tradeBaseToken === 'WBNB'
    ? wrappedNativeAddress
    : tradeBaseToken === 'USDC'
      ? (USDC[chainId as keyof typeof USDC]?.address ?? zeroAddress)
      : tradeBaseToken === 'USDT'
        ? (USDT[chainId as keyof typeof USDT]?.address ?? zeroAddress)
        : zeroAddress;
  const tradeBaseSymbol = tradeBaseTokenAddress.toLowerCase() === wrappedNativeAddress.toLowerCase()
    ? `W${nativeSymbol}`
    : tradeBaseTokenAddress.toLowerCase() === (USDC[chainId as keyof typeof USDC]?.address ?? '').toLowerCase()
      ? 'USDC'
      : tradeBaseTokenAddress.toLowerCase() === (USDT[chainId as keyof typeof USDT]?.address ?? '').toLowerCase()
        ? 'USDT'
        : nativeSymbol;
  const tradeBaseDecimals = tradeBaseTokenAddress.toLowerCase() === zeroAddress.toLowerCase()
    ? 18
    : tradeBaseTokenAddress.toLowerCase() === wrappedNativeAddress.toLowerCase()
      ? 18
      : tradeBaseTokenAddress.toLowerCase() === (USDC[chainId as keyof typeof USDC]?.address ?? '').toLowerCase()
        ? (USDC[chainId as keyof typeof USDC]?.decimals ?? 18)
        : tradeBaseTokenAddress.toLowerCase() === (USDT[chainId as keyof typeof USDT]?.address ?? '').toLowerCase()
          ? (USDT[chainId as keyof typeof USDT]?.decimals ?? 18)
          : 18;
  const routerAddress = DeployAddress[chainId as keyof typeof DeployAddress]?.[ContractNames.DagobangRouter]?.address;
  const MAX_UINT256 = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  const APPROVAL_READY_THRESHOLD = '1000000000000000000000'; // 1000 tokens
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

  const formatTradeBaseBalance = (addr: string) => {
    try {
      const bal = tradeBaseBalances[addr.toLowerCase()];
      if (!bal) return '...';
      const numeric = Number(formatUnits(BigInt(bal), tradeBaseDecimals));
      const formatted = formatPriceValue(numeric, 4, 6);
      return formatted === '-' ? '0' : formatted;
    } catch {
      return '0.0000';
    }
  };
  const getNativeBalanceValue = (addr: string) => {
    const raw = balances[addr];
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const getTradeBaseBalanceValue = (addr: string) => {
    const raw = tradeBaseBalances[addr.toLowerCase()];
    if (!raw) return null;
    try {
      const n = Number(formatUnits(BigInt(raw), tradeBaseDecimals));
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  };
  const getBalanceColorClass = (value: number | null) => {
    if (value == null) return 'text-zinc-500';
    if (value <= 0) return 'text-zinc-500';
    return 'text-amber-400';
  };
  const formatAllowance = (wei: string | undefined) => {
    if (!wei) return '0';
    try {
      const v = BigInt(wei);
      if (v >= BigInt(MAX_UINT256) / 2n) return 'MAX';
      return parseFloat(formatEther(v)).toFixed(4);
    } catch {
      return '0';
    }
  };
  const getAllowanceStatus = (addr: string): 'unknown' | 'ready' | 'not_ready' => {
    const raw = allowances[addr.toLowerCase()];
    if (typeof raw !== 'string') return 'unknown';
    try {
      return BigInt(raw) >= BigInt(APPROVAL_READY_THRESHOLD) ? 'ready' : 'not_ready';
    } catch {
      return 'unknown';
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedAddr(text);
    setTimeout(() => setCopiedAddr(null), 1000);
  };
  const showActionNotice = (type: 'success' | 'error', text: string) => {
    setActionNotice({ type, text });
    setTimeout(() => setActionNotice(null), 2200);
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

  useEffect(() => {
    let disposed = false;
    const accounts = state.wallet.accounts ?? [];
    if (!state.wallet.isUnlocked || tradeBaseTokenAddress.toLowerCase() === zeroAddress.toLowerCase() || accounts.length === 0) {
      setTradeBaseBalances({});
      return () => {
        disposed = true;
      };
    }
    void (async () => {
      const entries = await Promise.all(
        accounts.map(async (acc) => {
          try {
            const res = await call({ type: 'token:getBalance', tokenAddress: tradeBaseTokenAddress, address: acc.address });
            return [acc.address.toLowerCase(), res.balanceWei] as const;
          } catch {
            return [acc.address.toLowerCase(), '0'] as const;
          }
        })
      );
      if (disposed) return;
      const next: Record<string, string> = {};
      for (const [k, v] of entries) next[k] = v;
      setTradeBaseBalances(next);
    })();
    return () => {
      disposed = true;
    };
  }, [state.wallet.isUnlocked, accountAddressListKey, tradeBaseTokenAddress]);

  useEffect(() => {
    let disposed = false;
    const accounts = state.wallet.accounts ?? [];
    if (!state.wallet.isUnlocked || tradeBaseTokenAddress.toLowerCase() === zeroAddress.toLowerCase() || !routerAddress || accounts.length === 0) {
      setAllowances({});
      return () => {
        disposed = true;
      };
    }
    void (async () => {
      const entries = await Promise.all(
        accounts.map(async (acc) => {
          try {
            const res = await call({
              type: 'token:getAllowance',
              tokenAddress: tradeBaseTokenAddress,
              owner: acc.address,
              spender: routerAddress as `0x${string}`,
            });
            return [acc.address.toLowerCase(), res.allowanceWei] as const;
          } catch {
            return [acc.address.toLowerCase(), '0'] as const;
          }
        })
      );
      if (disposed) return;
      const next: Record<string, string> = {};
      for (const [k, v] of entries) next[k] = v;
      setAllowances(next);
    })();
    return () => {
      disposed = true;
    };
  }, [state.wallet.isUnlocked, accountAddressListKey, tradeBaseTokenAddress, routerAddress]);

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

  const openConvert = (addr: `0x${string}`) => {
    setConvertAddress(addr);
    setConvertAmount('');
    setConvertMode('wrap');
  };

  const closeConvert = () => {
    setConvertAddress(null);
    setConvertAmount('');
    setConvertMode('wrap');
  };
  const openApproveDialog = (addr: `0x${string}`) => setApproveDialogAddress(addr);
  const closeApproveDialog = () => setApproveDialogAddress(null);

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
          {state.wallet.accounts?.map((acc) => {
            const isCurrent = acc.address === getCurrentAddress();
            const nativeBalanceText = formatBalance(acc.address);
            const tradeBaseBalanceText = formatTradeBaseBalance(acc.address);
            const nativeBalanceColor = getBalanceColorClass(getNativeBalanceValue(acc.address));
            const tradeBaseBalanceColor = getBalanceColorClass(getTradeBaseBalanceValue(acc.address));
            return (
              <div
                key={acc.address}
                className={`p-2.5 rounded-md transition-colors ${
                  isCurrent
                    ? 'bg-zinc-900 border border-emerald-500/30'
                    : 'bg-zinc-900/30 border border-transparent hover:bg-zinc-900'
                }`}
              >
                <div className="space-y-1.5 overflow-hidden">
                  <div className="min-w-0 flex items-center gap-1.5">
                    <div className="text-[13px] font-semibold text-zinc-100 truncate">
                      {state.settings.accountAliases?.[getAliasKey(acc.address)] ?? acc.name}
                    </div>
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
                      {copiedAddr === acc.address ? <Check size={10} className="text-emerald-500" /> : <Copy size={10} />}
                    </button>
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

                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`flex items-center gap-1 text-[13px] font-mono font-semibold tabular-nums leading-4 ${nativeBalanceColor}`}>
                        <SymbolCoinIcon symbol={nativeSymbol} chainId={chainId} size={{ width: '12px', height: '12px' }} />
                        <span>{nativeBalanceText} <span className="text-[11px] text-zinc-400">{nativeSymbol}</span></span>
                      </div>
                      {tradeBaseTokenAddress.toLowerCase() !== zeroAddress.toLowerCase() && (
                        <div className={`flex items-center gap-1 text-[11px] font-mono tabular-nums leading-4 ${tradeBaseBalanceColor}`}>
                          <SymbolCoinIcon symbol={tradeBaseSymbol} chainId={chainId} size={{ width: '11px', height: '11px' }} />
                          <span>{tradeBaseBalanceText} <span className="text-[10px] text-zinc-500">{tradeBaseSymbol}</span></span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        className="h-7 w-7 rounded-md bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 transition-colors flex items-center justify-center disabled:opacity-60"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          openManage(acc.address, acc.name);
                        }}
                        title={tt('popup.home.manage.button')}
                      >
                        <Settings size={13} />
                      </button>
                      <button
                        className="h-7 w-7 rounded-md bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 transition-colors flex items-center justify-center disabled:opacity-60"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          openTransfer(acc.address);
                        }}
                        title={tt('popup.home.transfer.button')}
                      >
                        <Send size={13} />
                      </button>
                      {isCurrent ? (
                        <div className="h-7 px-2 rounded-md border border-emerald-700/60 text-emerald-300 bg-emerald-900/30 flex items-center justify-center text-[11px]" title={locale === 'en' ? 'Active' : '当前'}>
                          {locale === 'en' ? 'ON' : '当前'}
                        </div>
                      ) : (
                        <button
                          className="h-7 px-2 rounded-md bg-zinc-900 border border-zinc-700 hover:bg-zinc-800 transition-colors flex items-center justify-center disabled:opacity-60 text-[12px]"
                          disabled={busy}
                          onClick={() =>
                            withBusy(async () => {
                              await call({ type: 'wallet:switchAccount', address: acc.address });
                              showActionNotice('success', '已切换钱包');
                              await onRefresh();
                            })
                          }
                          title={tt('popup.home.switch')}
                        >
                          {tt('popup.home.switch')}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="pt-0.5 flex flex-wrap items-center gap-1.5">
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
                              showActionNotice('success', '7702 撤销交易已提交');
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
                    {tradeBaseTokenAddress.toLowerCase() !== zeroAddress.toLowerCase() && routerAddress && (
                      (() => {
                        const status = getAllowanceStatus(acc.address);
                        const statusLabel = status === 'ready' ? '已授权' : (status === 'unknown' ? '检测中' : '授权');
                        return (
                          <button
                            className={`px-2 py-1 rounded text-[11px] transition-colors disabled:opacity-60 ${
                              status === 'ready'
                                ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50 hover:bg-emerald-900/55'
                                : 'bg-zinc-800 hover:bg-zinc-700'
                            }`}
                            disabled={busy || approvingAddress === acc.address.toLowerCase() || status === 'unknown'}
                            onClick={(e) => {
                              e.stopPropagation();
                              openApproveDialog(acc.address);
                            }}
                            title={`授权 ${tradeBaseSymbol} 给路由合约`}
                          >
                            {approvingAddress === acc.address.toLowerCase() ? '授权中' : statusLabel}
                          </button>
                        );
                      })()
                    )}
                    {tradeBaseTokenAddress.toLowerCase() !== zeroAddress.toLowerCase() && (
                      <button
                        className="px-2 py-1 rounded bg-zinc-800 text-[11px] hover:bg-zinc-700 transition-colors"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          openConvert(acc.address);
                        }}
                        title={`${nativeSymbol} / ${tradeBaseSymbol} 兑换`}
                      >
                        兑换
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {actionNotice && (
        <div className="px-4 pb-2">
          <div className={`rounded-md px-3 py-2 text-[11px] border ${
            actionNotice.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-900/60 text-emerald-200'
              : 'bg-red-950/60 border-red-900/60 text-red-200'
          }`}>
            {actionNotice.text}
          </div>
        </div>
      )}

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

      {convertAddress && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full rounded-md bg-zinc-950 border border-zinc-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold">兑换 / 包装</div>
              <button
                className="text-[12px] text-zinc-400 hover:text-zinc-200"
                onClick={closeConvert}
              >
                关闭
              </button>
            </div>
            <div className="text-[12px] text-zinc-500">
              钱包 {convertAddress.slice(0, 6)}...{convertAddress.slice(-4)}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={`rounded-md px-2 py-2 text-xs border ${convertMode === 'wrap' ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`}
                onClick={() => setConvertMode('wrap')}
                disabled={busy}
              >
                <span className="flex items-center justify-center gap-1">
                  <SymbolCoinIcon symbol={nativeSymbol} chainId={chainId} size={{ width: '12px', height: '12px' }} />
                  <span>{nativeSymbol} {'->'} {tradeBaseSymbol}</span>
                </span>
              </button>
              <button
                type="button"
                className={`rounded-md px-2 py-2 text-xs border ${convertMode === 'unwrap' ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`}
                onClick={() => setConvertMode('unwrap')}
                disabled={busy}
              >
                <span className="flex items-center justify-center gap-1">
                  <SymbolCoinIcon symbol={tradeBaseSymbol} chainId={chainId} size={{ width: '12px', height: '12px' }} />
                  <span>{tradeBaseSymbol} {'->'} {nativeSymbol}</span>
                </span>
              </button>
            </div>
            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">数量</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs outline-none font-mono"
                placeholder="0.0"
                value={convertAmount}
                onChange={(e) => setConvertAmount(e.target.value)}
                disabled={busy}
                inputMode="decimal"
              />
            </div>
            <button
              className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors"
              disabled={busy || !convertAmount.trim()}
              onClick={() =>
                withBusy(async () => {
                  const amountWei = parseUnits(convertAmount.trim(), tradeBaseDecimals).toString();
                  if (convertMode === 'wrap') {
                    await call({ type: 'tx:wrapNative', chainId, fromAddress: convertAddress, amountWei });
                  } else {
                    await call({ type: 'tx:unwrapWrapped', chainId, fromAddress: convertAddress, amountWei });
                  }
                  closeConvert();
                  await onRefresh();
                })
              }
            >
              确认兑换
            </button>
          </div>
        </div>
      )}

      {approveDialogAddress && tradeBaseTokenAddress.toLowerCase() !== zeroAddress.toLowerCase() && routerAddress && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-4">
          <div className="w-full rounded-md bg-zinc-950 border border-zinc-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold">授权 {tradeBaseSymbol}</div>
              <button
                className="text-[12px] text-zinc-400 hover:text-zinc-200"
                onClick={closeApproveDialog}
              >
                关闭
              </button>
            </div>
            <div className="text-[12px] text-zinc-500">
              钱包 {approveDialogAddress.slice(0, 6)}...{approveDialogAddress.slice(-4)}
            </div>
            <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 space-y-1">
              <div className="text-[12px] text-zinc-400">当前授权额度</div>
              <div className="text-[13px] font-mono text-zinc-200">
                {formatAllowance(allowances[approveDialogAddress.toLowerCase()])} {tradeBaseSymbol}
              </div>
              <div className="text-[11px] text-zinc-500 break-all">
                Spender: {routerAddress}
              </div>
            </div>
            <button
              className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500 transition-colors"
              disabled={busy || approvingAddress === approveDialogAddress.toLowerCase()}
              onClick={() => {
                const key = approveDialogAddress.toLowerCase();
                withBusy(async () => {
                  setApprovingAddress(key);
                  try {
                    const rsp = await call({
                      type: 'tx:approve',
                      chainId,
                      tokenAddress: tradeBaseTokenAddress,
                      spender: routerAddress as `0x${string}`,
                      amountWei: MAX_UINT256,
                      fromAddress: approveDialogAddress,
                    });
                    setAllowances((prev) => ({ ...prev, [key]: MAX_UINT256 }));
                    showActionNotice('success', `授权已提交: ${String(rsp.txHash).slice(0, 10)}...`);
                    closeApproveDialog();
                    await onRefresh();
                  } finally {
                    setApprovingAddress((prev) => (prev === key ? null : prev));
                  }
                });
              }}
            >
              {approvingAddress === approveDialogAddress.toLowerCase() ? '提交中...' : '授权最大额度'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
