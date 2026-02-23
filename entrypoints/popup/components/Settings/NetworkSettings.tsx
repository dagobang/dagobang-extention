import { useEffect } from 'react';
import { validateSettings } from '@/utils/validate';
import type { SettingsDraftProps } from './types';

type NetworkSettingsProps = SettingsDraftProps;

export function NetworkSettings({ settingsDraft, setSettingsDraft, tt }: NetworkSettingsProps) {
  const chainId = settingsDraft.chainId;
  const protectedRpcUrlsDraft = settingsDraft.chains[chainId].protectedRpcUrls.map((x) => String(x ?? '').trim()).filter(Boolean);
  const protectedRpcUrlsValidated = validateSettings(settingsDraft)?.chains[chainId].protectedRpcUrls ?? [];
  const hasInvalidProtectedRpcUrls = protectedRpcUrlsValidated.length < protectedRpcUrlsDraft.length;

  useEffect(() => {
    setSettingsDraft((s) => {
      const cid = s.chainId;
      if (s.chains[cid]?.antiMev) return s;
      return {
        ...s,
        chains: {
          ...s.chains,
          [cid]: {
            ...s.chains[cid],
            antiMev: true,
          },
        },
      };
    });
  }, [setSettingsDraft, chainId]);

  return (
    <div className="space-y-6">
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
                    antiMev: true,
                    protectedRpcUrls: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.protectedRpcUrlsHint1')}</div>
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.protectedRpcUrlsHint2')}</div>
          {hasInvalidProtectedRpcUrls && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsInvalidWarning')}</div>
          )}
          {protectedRpcUrlsValidated.length === 0 && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsEmptyError')}</div>
          )}
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
    </div>
  );
}
