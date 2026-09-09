import { COOKING_PLATFORMS } from './constants';
import { getPlatformButtonClass } from './helpers';
import type { CookingLaunchPlatform } from './types';

type PlatformSelectorProps = {
  selectedPlatform: CookingLaunchPlatform;
  onSelectPlatform: (platform: CookingLaunchPlatform) => void;
};

export function PlatformSelector({ selectedPlatform, onSelectPlatform }: PlatformSelectorProps) {
  return (
    <div className="space-y-2 rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 p-2.5">
      <div className="text-[12px] font-semibold text-fuchsia-200">平台</div>
      <div className="grid grid-cols-2 gap-2">
        {COOKING_PLATFORMS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`rounded-md border px-2 py-2 text-[12px] font-medium transition ${getPlatformButtonClass(selectedPlatform === item.value)}`}
            onClick={() => onSelectPlatform(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {selectedPlatform === 'flap_stocks' && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
          币股模板先按官方 VaultPortal 路径做 fail-closed。当前版本支持预设与多选，不开放真正提交。
        </div>
      )}
      {selectedPlatform === 'openfour' && (
        <div className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1.5 text-[11px] text-cyan-200">
          OpenFour 按官方模板签名后调用 Core.createToken。当前先接入 4Stock，后续再加其它模式。
        </div>
      )}
    </div>
  );
}
