import { Play } from 'lucide-react';
import { normalizeLocale, type Locale } from '@/utils/i18n';
import { useTradeSuccessSound } from '@/hooks/useTradeSuccessSound';
import type { TradeSuccessSoundPreset } from '@/types/extention';
import type { SettingsDraftProps } from './types';

type UiSettingsProps = SettingsDraftProps & {
  onLocaleChange: (locale: Locale) => void;
};

const PRESETS: TradeSuccessSoundPreset[] = [
  'Bell',
  'Boom',
  'Cheer',
  'Coins',
  'Pop',
  'Handgun',
  'Kaching',
  'Nice',
  'Shotgun',
  'Sonumi',
  'Yes',
  'Alipay',
  'Wechat'
];

function isPreset(v: any): v is TradeSuccessSoundPreset {
  return PRESETS.includes(v);
}

export function UiSettings({ settingsDraft, setSettingsDraft, tt, onLocaleChange }: UiSettingsProps) {
  const tradeSuccessSoundEnabled = !!settingsDraft.tradeSuccessSoundEnabled;
  const tradeSuccessSoundPresetBuy = isPreset(settingsDraft.tradeSuccessSoundPresetBuy) ? settingsDraft.tradeSuccessSoundPresetBuy : 'Bell';
  const tradeSuccessSoundPresetSell = isPreset(settingsDraft.tradeSuccessSoundPresetSell) ? settingsDraft.tradeSuccessSoundPresetSell : 'Coins';
  const tradeSuccessSoundVolume = typeof settingsDraft.tradeSuccessSoundVolume === 'number'
    ? Math.max(0, Math.min(100, Math.floor(settingsDraft.tradeSuccessSoundVolume)))
    : 60;

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
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.uiSection')}</div>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.language')}</div>
          <select
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
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
        </label>

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

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.tradeSuccessSoundBuyPreset')}</div>
            <div className="flex items-center gap-2">
              <select
                className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
                value={tradeSuccessSoundPresetBuy}
                onChange={(e) => {
                  const next = e.target.value as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({ ...s, tradeSuccessSoundPresetBuy: next }));
                  if (tradeSuccessSoundEnabled) play(next);
                }}
              >
                {PRESETS.map((p) => (
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
                value={tradeSuccessSoundPresetSell}
                onChange={(e) => {
                  const next = e.target.value as TradeSuccessSoundPreset;
                  setSettingsDraft((s) => ({ ...s, tradeSuccessSoundPresetSell: next }));
                  if (tradeSuccessSoundEnabled) play(next);
                }}
              >
                {PRESETS.map((p) => (
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
