import { useState } from 'react';
import { call } from '@/utils/messaging';
import type { Settings } from '@/types/extention';
import { defaultSettings } from '@/utils/defaults';
import { validateSettings } from '@/utils/validate';
import { ChevronLeft } from 'lucide-react';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';

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
  const [exportPassword, setExportPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
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
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3 bg-zinc-900/50">
        <button onClick={onBack} className="hover:text-emerald-400">
          <ChevronLeft size={16} />
        </button>
        <div className="text-sm font-semibold flex-1">{tt('popup.settings.title')}</div>
        <select
          className="text-[12px] bg-zinc-800 px-2 py-0.5 rounded text-zinc-300 outline-none"
          value={normalizeLocale(settingsDraft.locale)}
          onChange={(e) => {
            const next = normalizeLocale(e.target.value);
            setSettingsDraft((s) => ({ ...s, locale: next }));
            onLocaleChange(next);
          }}
        >
          <option value="zh_CN">{tt('common.language.zh_CN')}</option>
          <option value="zh_TW">{tt('common.language.zh_TW')}</option>
          <option value="en">{tt('common.language.en')}</option>
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Chain Selector */}
        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.chainId')}</div>
          <select
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
            value={settingsDraft.chainId}
            onChange={(e) => setSettingsDraft((s) => ({ ...s, chainId: Number(e.target.value) as 56 }))}
          >
            <option value={56}>{tt('popup.settings.bsc')}</option>
          </select>
        </label>

        {/* Network Settings */}
        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.network')}</div>
          <label className="block space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.rpcUrls')}</div>
            <textarea
              rows={4}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
              value={settingsDraft.chains[settingsDraft.chainId].rpcUrls.join('\n')}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  chains: {
                    ...s.chains,
                    [s.chainId]: {
                      ...s.chains[s.chainId],
                      rpcUrls: e.target.value.split('\n'),
                    },
                  },
                }))
              }
            />
          </label>
          <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
            <div className="text-[14px] text-zinc-300">{tt('popup.settings.antiMev')}</div>
            <input
              type="checkbox"
              checked={settingsDraft.chains[settingsDraft.chainId].antiMev}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  chains: {
                    ...s.chains,
                    [s.chainId]: {
                      ...s.chains[s.chainId],
                      antiMev: e.target.checked,
                    },
                  },
                }))
              }
            />
          </label>
          {settingsDraft.chains[settingsDraft.chainId].antiMev && (
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.protectedRpcUrls')}</div>
              <textarea
                rows={4}
                aria-multiline={true}
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
                value={settingsDraft.chains[settingsDraft.chainId].protectedRpcUrls.join('\n')}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    chains: {
                      ...s.chains,
                      [s.chainId]: {
                        ...s.chains[s.chainId],
                        protectedRpcUrls: e.target.value.split('\n'),
                      },
                    },
                  }))
                }
              />
            </label>
          )}
        </div>

        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.trade')}</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.slippageBps')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.chains[settingsDraft.chainId].slippageBps}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    chains: {
                      ...s.chains,
                      [s.chainId]: {
                        ...s.chains[s.chainId],
                        slippageBps: Number(e.target.value),
                      },
                    },
                  }))
                }
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.deadlineSeconds')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.chains[settingsDraft.chainId].deadlineSeconds}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    chains: {
                      ...s.chains,
                      [s.chainId]: {
                        ...s.chains[s.chainId],
                        deadlineSeconds: Number(e.target.value),
                      },
                    },
                  }))
                }
              />
          </label>
        </div>

        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.gasPreset')}</div>
          <div className="grid grid-cols-1 gap-3">
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.gasPreset')}</div>
              <select
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.chains[settingsDraft.chainId].gasPreset}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    chains: {
                      ...s.chains,
                      [s.chainId]: {
                        ...s.chains[s.chainId],
                        gasPreset: e.target.value as any,
                      },
                    },
                  }))
                }
              >
                <option value="slow">{tt('popup.settings.gas.slow')}</option>
                <option value="standard">{tt('popup.settings.gas.standard')}</option>
                <option value="fast">{tt('popup.settings.gas.fast')}</option>
                <option value="turbo">{tt('popup.settings.gas.turbo')}</option>
              </select>
            </label>
            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.buyGasGwei')}</div>
              <div className="grid grid-cols-2 gap-1">
                {(['slow', 'standard', 'fast', 'turbo'] as const).map((k) => (
                  <div key={k} className="flex items-center gap-1">
                    <span className="text-[11px] text-zinc-500">{tt(`popup.settings.gas.${k}`)}</span>
                    <input
                      className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                      value={settingsDraft.chains[settingsDraft.chainId].buyGasGwei?.[k] ?? ''}
                      onChange={(e) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          chains: {
                            ...s.chains,
                            [s.chainId]: {
                              ...s.chains[s.chainId],
                              buyGasGwei: {
                                ...s.chains[s.chainId].buyGasGwei,
                                [k]: e.target.value,
                              },
                            },
                          },
                        }))
                      }
                      placeholder="0.12"
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.sellGasGwei')}</div>
              <div className="grid grid-cols-2 gap-1">
                {(['slow', 'standard', 'fast', 'turbo'] as const).map((k) => (
                  <div key={k} className="flex items-center gap-1">
                    <span className="text-[11px] text-zinc-500">{tt(`popup.settings.gas.${k}`)}</span>
                    <input
                      className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                      value={settingsDraft.chains[settingsDraft.chainId].sellGasGwei?.[k] ?? ''}
                      onChange={(e) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          chains: {
                            ...s.chains,
                            [s.chainId]: {
                              ...s.chains[s.chainId],
                              sellGasGwei: {
                                ...s.chains[s.chainId].sellGasGwei,
                                [k]: e.target.value,
                              },
                            },
                          },
                        }))
                      }
                      placeholder="0.12"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">GMGN</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.quickBuy1Bnb')}</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.quickBuy1Bnb ?? ''}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    quickBuy1Bnb: e.target.value,
                  }))
                }
                placeholder="0.02"
              />
            </label>
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.quickBuy2Bnb')}</div>
              <input
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.quickBuy2Bnb ?? ''}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    quickBuy2Bnb: e.target.value,
                  }))
                }
                placeholder="0.1"
              />
            </label>
          </div>
        </div>

        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.apiKeysSection')}</div>
          <label className="hidden block space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.seedreamApiKeyLabel')}</div>
            <input
              type="password"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
              value={settingsDraft.seedreamApiKey ?? ''}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  seedreamApiKey: e.target.value,
                }))
              }
              placeholder={tt('popup.settings.seedreamApiKeyPlaceholder')}
            />
          </label>
          <label className="block space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.bloxrouteAuthHeaderLabel')}</div>
            <input
              type="password"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
              value={settingsDraft.bloxrouteAuthHeader ?? ''}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  bloxrouteAuthHeader: e.target.value,
                }))
              }
              placeholder={tt('popup.settings.bloxrouteAuthHeaderPlaceholder')}
            />
          </label>
        </div>

        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.uiSection')}</div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.toastPosition')}</div>
              <select
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.toastPosition ?? 'top-center'}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    toastPosition: e.target.value as any,
                  }))
                }
              >
                <option value="top-left">{tt('popup.settings.toastPositionOptions.topLeft')}</option>
                <option value="top-center">{tt('popup.settings.toastPositionOptions.topCenter')}</option>
                <option value="top-right">{tt('popup.settings.toastPositionOptions.topRight')}</option>
                <option value="bottom-left">{tt('popup.settings.toastPositionOptions.bottomLeft')}</option>
                <option value="bottom-center">{tt('popup.settings.toastPositionOptions.bottomCenter')}</option>
                <option value="bottom-right">{tt('popup.settings.toastPositionOptions.bottomRight')}</option>
              </select>
            </label>
            <label className="block space-y-1">
              <div className="text-[14px] text-zinc-400">{tt('popup.settings.autoLockSeconds')}</div>
              <input
                type="number"
                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={settingsDraft.autoLockSeconds}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, autoLockSeconds: Number(e.target.value) }))}
              />
            </label>
          </div>
        </div>
          <button
            className="w-full rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-emerald-500"
            disabled={busy}
            onClick={() =>
              withBusy(async () => {
                const validated = validateSettings(settingsDraft) ?? defaultSettings();
                await call({ type: 'settings:set', settings: validated });
                await onRefresh();
                onBack();
              })
            }
          >
            {tt('popup.settings.saveChanges')}
          </button>
        </div>


        {/* Export Settings */}
        <div className="space-y-3 pt-4 border-t border-zinc-800">
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

          {/* Change Password */}
          <div className="pt-3 border-t border-zinc-800 space-y-2">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.changePassword')}</div>
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
          {/* Reset Wallet */}
          <div className="pt-3 border-t border-zinc-800">
            <button
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

      </div>
    </div>
  );
}
