import type { SettingsDraftProps } from './types';

type TradeSettingsProps = SettingsDraftProps;

export function TradeSettings({ settingsDraft, setSettingsDraft, tt }: TradeSettingsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
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
    </div>
  );
}

