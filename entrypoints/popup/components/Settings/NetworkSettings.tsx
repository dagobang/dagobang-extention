import { useEffect, useMemo, useState } from 'react';
import { validateSettings } from '@/utils/validate';
import { call } from '@/utils/messaging';
import type { SettingsDraftProps } from './types';

type NetworkSettingsProps = SettingsDraftProps;

export function NetworkSettings({ settingsDraft, setSettingsDraft, tt }: NetworkSettingsProps) {
  const chainId = settingsDraft.chainId;
  const chainDraft = settingsDraft.chains[chainId];
  const protectedRpcUrlsBuyDraft = (chainDraft.protectedRpcUrlsBuy ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const protectedRpcUrlsSellDraft = (chainDraft.protectedRpcUrlsSell ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const protectedRpcUrlsDraft = settingsDraft.chains[chainId].protectedRpcUrls.map((x) => String(x ?? '').trim()).filter(Boolean);
  const validatedChain = validateSettings(settingsDraft)?.chains[chainId];
  const protectedRpcUrlsValidated = validatedChain?.protectedRpcUrls ?? [];
  const protectedRpcUrlsBuyValidated = validatedChain?.protectedRpcUrlsBuy ?? [];
  const protectedRpcUrlsSellValidated = validatedChain?.protectedRpcUrlsSell ?? [];
  const hasInvalidProtectedRpcUrls = protectedRpcUrlsValidated.length < protectedRpcUrlsDraft.length && !settingsDraft.bloxrouteAuthHeader;
  const hasInvalidProtectedRpcUrlsBuy = protectedRpcUrlsBuyValidated.length < protectedRpcUrlsBuyDraft.length && !settingsDraft.bloxrouteAuthHeader;
  const hasInvalidProtectedRpcUrlsSell = protectedRpcUrlsSellValidated.length < protectedRpcUrlsSellDraft.length && !settingsDraft.bloxrouteAuthHeader;
  const [bloxProbe, setBloxProbe] = useState<null | { status: 'reachable' | 'failed'; httpStatus?: number; message?: string; hasAuthHeader: boolean }>(null);
  const [bloxProbeLoading, setBloxProbeLoading] = useState(false);
  const bloxAuthDraft = useMemo(() => String(settingsDraft.bloxrouteAuthHeader ?? '').replace(/[\r\n]+/g, '').trim(), [settingsDraft.bloxrouteAuthHeader]);

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
          {protectedRpcUrlsValidated.length === 0 && !settingsDraft.bloxrouteAuthHeader && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsEmptyError')}</div>
          )}
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.protectedRpcUrlsBuy')}</div>
          <textarea
            rows={3}
            aria-multiline={true}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
            value={(settingsDraft.chains[settingsDraft.chainId].protectedRpcUrlsBuy ?? []).join('\n')}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                chains: {
                  ...s.chains,
                  [s.chainId]: {
                    ...s.chains[s.chainId],
                    antiMev: true,
                    protectedRpcUrlsBuy: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.protectedRpcUrlsBuyHint')}</div>
          {hasInvalidProtectedRpcUrlsBuy && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsInvalidWarning')}</div>
          )}
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.protectedRpcUrlsSell')}</div>
          <textarea
            rows={3}
            aria-multiline={true}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
            value={(settingsDraft.chains[settingsDraft.chainId].protectedRpcUrlsSell ?? []).join('\n')}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                chains: {
                  ...s.chains,
                  [s.chainId]: {
                    ...s.chains[s.chainId],
                    antiMev: true,
                    protectedRpcUrlsSell: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.protectedRpcUrlsSellHint')}</div>
          {hasInvalidProtectedRpcUrlsSell && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsInvalidWarning')}</div>
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
          <div className="text-[11px] text-zinc-500">
            {tt('popup.settings.bloxrouteAuthHeaderApplyHint')}{' '}
            <a className="underline hover:text-zinc-300" href="https://portal.bloxroute.com/" target="_blank" rel="noreferrer">
              https://portal.bloxroute.com/
            </a>
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
              <div className="text-[12px] text-zinc-300">{tt('popup.settings.bloxrouteBuyEnabled')}</div>
              <input
                type="checkbox"
                checked={settingsDraft.chains[settingsDraft.chainId].bloxrouteBuyEnabled ?? true}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    chains: {
                      ...s.chains,
                      [s.chainId]: {
                        ...s.chains[s.chainId],
                        bloxrouteBuyEnabled: e.target.checked,
                      },
                    },
                  }))
                }
              />
            </label>
            <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
              <div className="text-[12px] text-zinc-300">{tt('popup.settings.bloxrouteSellEnabled')}</div>
              <input
                type="checkbox"
                checked={settingsDraft.chains[settingsDraft.chainId].bloxrouteSellEnabled ?? true}
                onChange={(e) =>
                  setSettingsDraft((s) => ({
                    ...s,
                    chains: {
                      ...s.chains,
                      [s.chainId]: {
                        ...s.chains[s.chainId],
                        bloxrouteSellEnabled: e.target.checked,
                      },
                    },
                  }))
                }
              />
            </label>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
              disabled={bloxProbeLoading}
              onClick={async () => {
                setBloxProbeLoading(true);
                try {
                  const res = await call({ type: 'bloxroute:probe', authHeader: bloxAuthDraft } as const);
                  setBloxProbe(res);
                } catch (e: any) {
                  setBloxProbe({ status: 'failed', message: String(e?.message || e || ''), hasAuthHeader: !!bloxAuthDraft });
                } finally {
                  setBloxProbeLoading(false);
                }
              }}
            >
              {bloxProbeLoading ? tt('popup.settings.bloxrouteProbeTesting') : tt('popup.settings.bloxrouteProbeTest')}
            </button>
            <button
              type="button"
              className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
              onClick={() => call({ type: 'bloxroute:openCertPage' } as const).catch(() => { })}
            >
              {tt('popup.settings.bloxrouteOpenCertPage')}
            </button>
          </div>
          {bloxProbe?.status === 'reachable' && (
            <div className="text-[11px] text-emerald-400">
              {tt('popup.settings.bloxrouteProbeOk')} {typeof bloxProbe.httpStatus === 'number' ? `(${bloxProbe.httpStatus})` : ''}
              {!bloxProbe.hasAuthHeader ? ` · ${tt('popup.settings.bloxrouteProbeNoAuth')}` : ''}
            </div>
          )}
          {bloxProbe?.status === 'failed' && (
            <div className="text-[11px] text-red-400">
              {tt('popup.settings.bloxrouteProbeFailed')}
              {bloxProbe.message ? `: ${bloxProbe.message}` : ''}
              {' · '}
              {tt('popup.settings.bloxrouteProbeFailedHint')}
            </div>
          )}
        </label>
      </div>
    </div>
  );
}
