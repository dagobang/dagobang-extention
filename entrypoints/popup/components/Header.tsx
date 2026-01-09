import { Globe, Settings } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { chainNames } from '@/constants/chains';

type HeaderProps = {
  chainId?: number;
  isUnlocked?: boolean;
  onSettingsClick?: () => void;
  locale?: Locale;
  onLocaleChange?: (locale: Locale) => void;
};

export function Header({ chainId, isUnlocked, onSettingsClick, locale: localeInput, onLocaleChange }: HeaderProps) {
  const locale = normalizeLocale(localeInput);
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 bg-zinc-900/50">
      <Logo size={{ width: '24px', height: '24px' }} />
      <div className="text-sm font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
        {t('common.appName', locale)}
      </div>
      <div className="flex items-center gap-2">
        {chainId && (
          <div className="text-[12px] bg-zinc-800 px-2 py-0.5 rounded text-zinc-400 flex flex-row gap-1 items-center">
            <ChainCoinIcon chainId={chainId} size={{ width: '12px', height: '12px' }} />
            <span className="uppercase">{chainNames[chainId]}</span>
          </div>
        )}
        <div className="flex flex-row items-center gap-1">
          <Globe size={14} />
          <select
            className="text-[12px] px-2 py-0.5 rounded text-zinc-300 outline-none"
            value={locale}
            onChange={(e) => onLocaleChange?.(normalizeLocale(e.target.value))}
          >
            <option value="zh_CN">{t('common.language.zh_CN', locale)}</option>
            <option value="zh_TW">{t('common.language.zh_TW', locale)}</option>
            <option value="en">{t('common.language.en', locale)}</option>
          </select>
        </div>
        {isUnlocked && (
          <div
            className="cursor-pointer text-zinc-400 hover:text-white"
            onClick={onSettingsClick}
          >
            <Settings size={14} />
          </div>
        )}
      </div>
    </div>
  );
}
