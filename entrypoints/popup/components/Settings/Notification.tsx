import { Play } from 'lucide-react';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import { TRADE_SUCCESS_SOUND_PRESETS, type TradeSuccessSoundPreset } from '@/types/extention';
import type { SettingsDraftProps } from './types';

const OFF_VALUE = '__off__';

function isPreset(v: any): v is TradeSuccessSoundPreset {
  return TRADE_SUCCESS_SOUND_PRESETS.includes(v);
}

export function Notification({ settingsDraft, setSettingsDraft, tt }: SettingsDraftProps) {
  const tradeSuccessSoundEnabled = !!settingsDraft.tradeSuccessSoundEnabled;
  const tradeSuccessSoundPresetBuy = isPreset(settingsDraft.tradeSuccessSoundPresetBuy) ? settingsDraft.tradeSuccessSoundPresetBuy : 'Bell';
  const tradeSuccessSoundPresetSell = isPreset(settingsDraft.tradeSuccessSoundPresetSell) ? settingsDraft.tradeSuccessSoundPresetSell : 'Coins';
  const tokenSnipeSoundEnabled = settingsDraft.autoTrade.tokenSnipe?.playSound !== false;
  const tokenSnipeSoundPreset = isPreset(settingsDraft.autoTrade.tokenSnipe?.soundPreset) ? settingsDraft.autoTrade.tokenSnipe.soundPreset : 'Boom';
  const xSniperTriggerSoundEnabled = settingsDraft.autoTrade.triggerSound?.enabled !== false;
  const xSniperTriggerSoundPreset = isPreset(settingsDraft.autoTrade.triggerSound?.preset) ? settingsDraft.autoTrade.triggerSound.preset : 'Boom';
  const xSniperDeleteTweetSoundEnabled = settingsDraft.autoTrade.twitterSnipe?.deleteTweetPlaySound !== false;
  const xSniperDeleteTweetSoundPreset = isPreset(settingsDraft.autoTrade.twitterSnipe?.deleteTweetSoundPreset) ? settingsDraft.autoTrade.twitterSnipe.deleteTweetSoundPreset : 'Handgun';
  const tradeSuccessSoundVolume = typeof settingsDraft.tradeSuccessSoundVolume === 'number'
    ? Math.max(0, Math.min(100, Math.floor(settingsDraft.tradeSuccessSoundVolume)))
    : 60;

  const buySelectValue = tradeSuccessSoundEnabled ? tradeSuccessSoundPresetBuy : OFF_VALUE;
  const sellSelectValue = tradeSuccessSoundEnabled ? tradeSuccessSoundPresetSell : OFF_VALUE;
  const tokenSnipeSelectValue = tokenSnipeSoundEnabled ? tokenSnipeSoundPreset : OFF_VALUE;
  const xSniperTriggerSelectValue = xSniperTriggerSoundEnabled ? xSniperTriggerSoundPreset : OFF_VALUE;
  const xSniperDeleteTweetSelectValue = xSniperDeleteTweetSoundEnabled ? xSniperDeleteTweetSoundPreset : OFF_VALUE;

  const previewSound = useTradeSuccessSound({
    enabled: true,
    volume: tradeSuccessSoundVolume,
    buyPreset: tradeSuccessSoundPresetBuy,
    sellPreset: tradeSuccessSoundPresetSell,
  });

  const play = (preset: TradeSuccessSoundPreset) => {
    previewSound.ensureReady();
    previewSound.playPreset(preset);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.notification')}</div>

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

      <div className="space-y-3 pt-4 border-t border-zinc-800">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.tradeSuccessSound')}</div>

        <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="text-[14px] text-zinc-300">{tt('popup.settings.tradeSuccessSound')}</div>
          <input
            type="checkbox"
            checked={tradeSuccessSoundEnabled}
            onChange={(e) => setSettingsDraft((s) => ({ ...s, tradeSuccessSoundEnabled: e.target.checked }))}
          />
        </label>

        <div className="grid grid-cols-1 gap-3">
          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.tradeSuccessSoundBuyPreset')}</div>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={buySelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OFF_VALUE) {
                    setSettingsDraft((s) => ({ ...s, tradeSuccessSoundEnabled: false }));
                    return;
                  }
                  const next = v as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({ ...s, tradeSuccessSoundEnabled: true, tradeSuccessSoundPresetBuy: next }));
                  if (tradeSuccessSoundEnabled) play(next);
                }}
              >
                <option value={OFF_VALUE}>{tt('popup.settings.tradeSuccessSoundOff')}</option>
                {TRADE_SUCCESS_SOUND_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800"
                onClick={() => play(tradeSuccessSoundPresetBuy)}
                title={tt('popup.settings.previewSound')}
              >
                <Play size={16} />
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.tradeSuccessSoundSellPreset')}</div>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={sellSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OFF_VALUE) {
                    setSettingsDraft((s) => ({ ...s, tradeSuccessSoundEnabled: false }));
                    return;
                  }
                  const next = v as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({ ...s, tradeSuccessSoundEnabled: true, tradeSuccessSoundPresetSell: next }));
                  if (tradeSuccessSoundEnabled) play(next);
                }}
              >
                <option value={OFF_VALUE}>{tt('popup.settings.tradeSuccessSoundOff')}</option>
                {TRADE_SUCCESS_SOUND_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800"
                onClick={() => play(tradeSuccessSoundPresetSell)}
                title={tt('popup.settings.previewSound')}
              >
                <Play size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 pt-1">
          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('contentUi.autoTradeStrategy.fixedSnipe')} · {tt('contentUi.autoTradeStrategy.sectionSound')}</div>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={tokenSnipeSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OFF_VALUE) {
                    setSettingsDraft((s) => ({
                      ...s,
                      autoTrade: {
                        ...s.autoTrade,
                        tokenSnipe: {
                          ...s.autoTrade.tokenSnipe,
                          playSound: false,
                        },
                      },
                    }));
                    return;
                  }
                  const next = v as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({
                    ...s,
                    autoTrade: {
                      ...s.autoTrade,
                      tokenSnipe: {
                        ...s.autoTrade.tokenSnipe,
                        playSound: true,
                        soundPreset: next,
                      },
                    },
                  }));
                  play(next);
                }}
              >
                <option value={OFF_VALUE}>{tt('popup.settings.tradeSuccessSoundOff')}</option>
                {TRADE_SUCCESS_SOUND_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50"
                disabled={tokenSnipeSelectValue === OFF_VALUE}
                onClick={() => {
                  if (tokenSnipeSelectValue === OFF_VALUE) return;
                  play(tokenSnipeSoundPreset);
                }}
                title={tt('popup.settings.previewSound')}
              >
                <Play size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('contentUi.autoTradeStrategy.twitterSnipe')} · {tt('contentUi.autoTradeStrategy.sectionSound')}</div>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={xSniperTriggerSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OFF_VALUE) {
                    setSettingsDraft((s) => ({
                      ...s,
                      autoTrade: {
                        ...s.autoTrade,
                        triggerSound: {
                          ...s.autoTrade.triggerSound,
                          enabled: false,
                        },
                      },
                    }));
                    return;
                  }
                  const next = v as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({
                    ...s,
                    autoTrade: {
                      ...s.autoTrade,
                      triggerSound: {
                        ...s.autoTrade.triggerSound,
                        enabled: true,
                        preset: next,
                      },
                    },
                  }));
                  play(next);
                }}
              >
                <option value={OFF_VALUE}>{tt('popup.settings.tradeSuccessSoundOff')}</option>
                {TRADE_SUCCESS_SOUND_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50"
                disabled={xSniperTriggerSelectValue === OFF_VALUE}
                onClick={() => {
                  if (xSniperTriggerSelectValue === OFF_VALUE) return;
                  play(xSniperTriggerSoundPreset);
                }}
                title={tt('popup.settings.previewSound')}
              >
                <Play size={16} />
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('contentUi.autoTradeStrategy.deleteTweetSoundPreset')}</div>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={xSniperDeleteTweetSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OFF_VALUE) {
                    setSettingsDraft((s) => ({
                      ...s,
                      autoTrade: {
                        ...s.autoTrade,
                        twitterSnipe: {
                          ...s.autoTrade.twitterSnipe,
                          deleteTweetPlaySound: false,
                        },
                      },
                    }));
                    return;
                  }
                  const next = v as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({
                    ...s,
                    autoTrade: {
                      ...s.autoTrade,
                      twitterSnipe: {
                        ...s.autoTrade.twitterSnipe,
                        deleteTweetPlaySound: true,
                        deleteTweetSoundPreset: next,
                      },
                    },
                  }));
                  play(next);
                }}
              >
                <option value={OFF_VALUE}>{tt('popup.settings.tradeSuccessSoundOff')}</option>
                {TRADE_SUCCESS_SOUND_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 hover:bg-zinc-800 disabled:opacity-50"
                disabled={xSniperDeleteTweetSelectValue === OFF_VALUE}
                onClick={() => {
                  if (xSniperDeleteTweetSelectValue === OFF_VALUE) return;
                  play(xSniperDeleteTweetSoundPreset);
                }}
                title={tt('popup.settings.previewSound')}
              >
                <Play size={16} />
              </button>
            </div>
          </div>
        </div>

        <label className="block space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.tradeSuccessSoundVolume')}</div>
            <div className="text-[12px] text-zinc-500">{tradeSuccessSoundVolume}%</div>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            className="w-full accent-emerald-500"
            value={tradeSuccessSoundVolume}
            onChange={(e) => setSettingsDraft((s) => ({ ...s, tradeSuccessSoundVolume: Number(e.target.value) }))}
          />
        </label>
      </div>
    </div>
  );
}
