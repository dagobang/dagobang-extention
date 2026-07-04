import type { SettingsDraftProps } from './types';
import { defaultSettings } from '@/utils/defaults';
import { ChainId } from '@/constants/chains/chainId';
import { getNativeSymbol } from '@/constants/chains';
import { DEFAULT_SOLANA_TIP_PRESET_VALUES } from '@/utils/solanaTip';

type GasSettingsProps = SettingsDraftProps;

export function GasSettings({ settingsDraft, setSettingsDraft, tt }: GasSettingsProps) {
  const priorityDefaults = { none: '0', slow: '0.000025', standard: '0.00004', fast: '0.0001' } as const;
  const tipDefaults = DEFAULT_SOLANA_TIP_PRESET_VALUES;
  const defaults = defaultSettings();
  const chainId = settingsDraft.chainId;
  const fallbackChainDraft = defaults.chains[defaults.chainId];
  const chainDraft = settingsDraft.chains[chainId] ?? defaults.chains[chainId] ?? fallbackChainDraft;
  const nativeSymbol = getNativeSymbol(chainId);
  const supportsPriorityFee = chainId !== ChainId.HYPER;
  const prioritySectionTitle = 'Priority';
  const priorityLabel = '优先费';
  const buyPriorityLabel = `买入${priorityLabel}预设值(${nativeSymbol})`;
  const sellPriorityLabel = `卖出${priorityLabel}预设值(${nativeSymbol})`;
  const priorityHintLines = [
    '优先费预设值大于 0 时，会作为交易优先费提升确认优先级。',
    '若当前通道的广播能力或节点配置不足，交易确认可能变慢，请先检查网络设置。',
  ];
  const tipHintLines = [
    'Tip 仅在 SOL 的 SWQoS 通道下生效，并且建议只启用单一 Provider。',
    '启用后会在交易里额外插入一笔 SOL transfer，作为该 Provider 的 Tip transfer。',
  ];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.gasPreset')}</div>
        <div className="grid grid-cols-1 gap-3">
          <label className="block space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.gasPreset')}</div>
            <select
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
              value={chainDraft.gasPreset}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  chains: {
                    ...s.chains,
                    [s.chainId]: {
                      ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
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
          <label className="block space-y-1">
            <div className="text-[14px] text-zinc-400">Gas 计费模式</div>
            <select
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
              value={chainDraft.gasPriceMode ?? 'fixed'}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  chains: {
                    ...s.chains,
                    [s.chainId]: {
                      ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                      gasPriceMode: e.target.value === 'dynamic' ? 'dynamic' : 'fixed',
                    },
                  },
                }))
              }
            >
              <option value="fixed">固定 Gas（使用本页预设）</option>
              <option value="dynamic">动态 Gas（实时估算，ETH 推荐）</option>
            </select>
          </label>
          {(chainDraft.gasPriceMode ?? 'fixed') === 'dynamic' ? (
            <div className="rounded-md border border-cyan-800/40 bg-cyan-950/20 px-3 py-2 text-[11px] text-cyan-200">
              动态模式下，快捷面板的慢/标准/快/抢跑表示费率倍率（如 1.0x/1.1x/1.2x/1.4x），不是固定 gwei。
            </div>
          ) : null}

          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.buyGasGwei')}</div>
            <div className="grid grid-cols-2 gap-1">
              {(['slow', 'standard', 'fast', 'turbo'] as const).map((k) => (
                <div key={k} className="flex items-center gap-1">
                  <span className="w-8 shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{tt(`popup.settings.gas.${k}`)}</span>
                  <input
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                    value={chainDraft.buyGasGwei?.[k] ?? ''}
                    onChange={(e) =>
                      setSettingsDraft((s) => ({
                        ...s,
                        chains: {
                          ...s.chains,
                          [s.chainId]: {
                            ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                            buyGasGwei: {
                              ...(s.chains[s.chainId]?.buyGasGwei ?? defaults.chains[s.chainId]?.buyGasGwei ?? fallbackChainDraft.buyGasGwei),
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
                  <span className="w-8 shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{tt(`popup.settings.gas.${k}`)}</span>
                  <input
                    className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                    value={chainDraft.sellGasGwei?.[k] ?? ''}
                    onChange={(e) =>
                      setSettingsDraft((s) => ({
                        ...s,
                        chains: {
                          ...s.chains,
                          [s.chainId]: {
                            ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                            sellGasGwei: {
                              ...(s.chains[s.chainId]?.sellGasGwei ?? defaults.chains[s.chainId]?.sellGasGwei ?? fallbackChainDraft.sellGasGwei),
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

          <label className="block space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.approveGasGwei')}</div>
            <input
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
              value={chainDraft.approveGasGwei ?? ''}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  chains: {
                    ...s.chains,
                    [s.chainId]: {
                      ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                      approveGasGwei: e.target.value,
                    },
                  },
                }))
              }
              placeholder="0.06"
            />
          </label>
        </div>
      </div>
      {supportsPriorityFee ? (
        <div className="space-y-3 pt-4 border-t border-zinc-800">
          <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{prioritySectionTitle}</div>
          <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-200">
            {priorityHintLines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
          <div className="space-y-3">
            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{buyPriorityLabel}</div>
              <div className="grid grid-cols-2 gap-1">
                {(['none', 'slow', 'standard', 'fast'] as const).map((k) => (
                  <div key={k} className="flex items-center gap-1">
                    <span className="w-8 shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{k === 'none' ? '无' : tt(`popup.settings.gas.${k}`)}</span>
                    <input
                      className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                      value={chainDraft.buyPriorityFeePresets?.[k] ?? priorityDefaults[k]}
                      onChange={(e) =>
                        setSettingsDraft((s) => {
                          const chain = s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft;
                          const nextPresets = {
                            none: chain.buyPriorityFeePresets?.none ?? priorityDefaults.none,
                            slow: chain.buyPriorityFeePresets?.slow ?? priorityDefaults.slow,
                            standard: chain.buyPriorityFeePresets?.standard ?? priorityDefaults.standard,
                            fast: chain.buyPriorityFeePresets?.fast ?? priorityDefaults.fast,
                            [k]: e.target.value,
                          };
                          return {
                            ...s,
                            chains: {
                              ...s.chains,
                              [s.chainId]: {
                                ...chain,
                                buyPriorityFeePresets: nextPresets,
                              },
                            },
                          };
                        })
                      }
                      placeholder={k === 'none' ? '0' : '0.000025'}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[14px] text-zinc-400">{sellPriorityLabel}</div>
              <div className="grid grid-cols-2 gap-1">
                {(['none', 'slow', 'standard', 'fast'] as const).map((k) => (
                  <div key={k} className="flex items-center gap-1">
                    <span className="w-8 shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{k === 'none' ? '无' : tt(`popup.settings.gas.${k}`)}</span>
                    <input
                      className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                      value={chainDraft.sellPriorityFeePresets?.[k] ?? priorityDefaults[k]}
                      onChange={(e) =>
                        setSettingsDraft((s) => {
                          const chain = s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft;
                          const nextPresets = {
                            none: chain.sellPriorityFeePresets?.none ?? priorityDefaults.none,
                            slow: chain.sellPriorityFeePresets?.slow ?? priorityDefaults.slow,
                            standard: chain.sellPriorityFeePresets?.standard ?? priorityDefaults.standard,
                            fast: chain.sellPriorityFeePresets?.fast ?? priorityDefaults.fast,
                            [k]: e.target.value,
                          };
                          return {
                            ...s,
                            chains: {
                              ...s.chains,
                              [s.chainId]: {
                                ...chain,
                                sellPriorityFeePresets: nextPresets,
                              },
                            },
                          };
                        })
                      }
                      placeholder={k === 'none' ? '0' : '0.000025'}
                    />
                  </div>
                ))}
              </div>
            </div>
            {chainId === ChainId.SOL ? (
              <div className="space-y-3 rounded-md border border-cyan-800/40 bg-cyan-950/20 px-3 py-3">
                <div className="text-[12px] font-semibold text-cyan-200">Tip</div>
                <div className="space-y-0.5 text-[11px] text-cyan-100/90">
                  {tipHintLines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
                <div className="space-y-1">
                  <div className="text-[14px] text-zinc-400">买入 Tip 预设值({nativeSymbol})</div>
                  <div className="grid grid-cols-2 gap-1">
                    {(['none', 'slow', 'standard', 'fast'] as const).map((k) => (
                      <div key={k} className="flex items-center gap-1">
                        <span className="w-8 shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{k === 'none' ? '无' : tt(`popup.settings.gas.${k}`)}</span>
                        <input
                          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                          value={chainDraft.buyTipPresets?.[k] ?? tipDefaults[k]}
                          onChange={(e) =>
                            setSettingsDraft((s) => {
                              const chain = s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft;
                              const nextPresets = {
                                none: chain.buyTipPresets?.none ?? tipDefaults.none,
                                slow: chain.buyTipPresets?.slow ?? tipDefaults.slow,
                                standard: chain.buyTipPresets?.standard ?? tipDefaults.standard,
                                fast: chain.buyTipPresets?.fast ?? tipDefaults.fast,
                                [k]: e.target.value,
                              };
                              return {
                                ...s,
                                chains: {
                                  ...s.chains,
                                  [s.chainId]: {
                                    ...chain,
                                    buyTipPresets: nextPresets,
                                  },
                                },
                              };
                            })
                          }
                          placeholder={k === 'none' ? '0' : tipDefaults.slow}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-[14px] text-zinc-400">卖出 Tip 预设值({nativeSymbol})</div>
                  <div className="grid grid-cols-2 gap-1">
                    {(['none', 'slow', 'standard', 'fast'] as const).map((k) => (
                      <div key={k} className="flex items-center gap-1">
                        <span className="w-8 shrink-0 whitespace-nowrap text-[11px] text-zinc-500">{k === 'none' ? '无' : tt(`popup.settings.gas.${k}`)}</span>
                        <input
                          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-1 py-0.5 text-[12px] outline-none"
                          value={chainDraft.sellTipPresets?.[k] ?? tipDefaults[k]}
                          onChange={(e) =>
                            setSettingsDraft((s) => {
                              const chain = s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft;
                              const nextPresets = {
                                none: chain.sellTipPresets?.none ?? tipDefaults.none,
                                slow: chain.sellTipPresets?.slow ?? tipDefaults.slow,
                                standard: chain.sellTipPresets?.standard ?? tipDefaults.standard,
                                fast: chain.sellTipPresets?.fast ?? tipDefaults.fast,
                                [k]: e.target.value,
                              };
                              return {
                                ...s,
                                chains: {
                                  ...s.chains,
                                  [s.chainId]: {
                                    ...chain,
                                    sellTipPresets: nextPresets,
                                  },
                                },
                              };
                            })
                          }
                          placeholder={k === 'none' ? '0' : tipDefaults.slow}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
