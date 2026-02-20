import type { SettingsDraftProps } from './types';

type GasSettingsProps = SettingsDraftProps;

export function GasSettings({ settingsDraft, setSettingsDraft, tt }: GasSettingsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
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
    </div>
  );
}

