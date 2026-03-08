
import { SUPPORTED_CHAINS } from '@/constants/chains';
import type { SiteInfo } from '@/utils/sites';
import { t, type Locale } from '@/utils/i18n';

type OverlaysProps = {
  siteInfo: SiteInfo;
  isUnlocked: boolean;
  onUnlock: () => void;
  locale: Locale;
};

export function Overlays({ siteInfo, isUnlocked, onUnlock, locale }: OverlaysProps) {
  return (
    <>
      {!SUPPORTED_CHAINS.includes(siteInfo.chain) && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl bg-black/80 backdrop-blur-[1px]">
          <div className="text-zinc-400 text-xs font-mono">
            {t('contentUi.overlay.unsupportedChain', locale, [siteInfo.chain])}
          </div>
        </div>
      )}

      {!isUnlocked && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center rounded-b-xl bg-black/60 backdrop-blur-[1px] cursor-pointer"
          onClick={onUnlock}
        >
          <div className="rounded-lg bg-zinc-900 border border-zinc-700 p-4 text-center shadow-2xl">
            <div className="mb-2 text-sm font-semibold text-zinc-200">{t('contentUi.overlay.lockedTitle', locale)}</div>
            <div className="text-xs text-zinc-400">{t('contentUi.overlay.lockedSubtitle', locale)}</div>
          </div>
        </div>
      )}
    </>
  );
}
