import { ChevronDown, Globe, Settings } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { normalizeLocale, t, type Locale } from '@/utils/i18n';
import { ChainCoinIcon } from '@/components/Coins';
import { ChainId } from '@/constants/chains/chainId';

type HeaderProps = {
  chainId?: number;
  onChainChange?: (chainId: number) => void;
  isUnlocked?: boolean;
  onSettingsClick?: () => void;
  locale?: Locale;
  onLocaleChange?: (locale: Locale) => void;
};

export function Header({ chainId, onChainChange, isUnlocked, onSettingsClick, locale: localeInput, onLocaleChange }: HeaderProps) {
  const locale = normalizeLocale(localeInput);
  const selectClassName = 'h-7 appearance-none rounded-md border border-zinc-700 bg-zinc-800/90 px-2 pr-7 text-[12px] font-medium text-zinc-100 outline-none transition-colors hover:border-zinc-500 focus:border-emerald-500';
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3 bg-zinc-900/50">
      <Logo size={{ width: '24px', height: '24px' }} />
      <div className="text-sm font-bold bg-gradient-to-r from-emerald-400 to-teal-400 bg-clip-text text-transparent">
        {t('common.appName', locale)}
      </div>
      <div className="flex items-center gap-2">
        {chainId && (
          <label className="flex items-center gap-1 text-zinc-300">
            <ChainCoinIcon chainId={chainId} size={{ width: '12px', height: '12px' }} />
            <span className="relative inline-flex items-center">
              <select
                className={selectClassName}
                value={chainId}
                onChange={(e) => onChainChange?.(Number(e.target.value))}
              >
                <option value={ChainId.BNB}>BNB</option>
                <option value={ChainId.HYPER}>HYPER</option>
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-2 text-zinc-400" />
            </span>
          </label>
        )}
        <div className="flex flex-row items-center gap-1 text-zinc-300">
          <Globe size={14} />
          <span className="relative inline-flex items-center">
            <select
              className={selectClassName}
              value={locale}
              onChange={(e) => onLocaleChange?.(normalizeLocale(e.target.value))}
            >
              <option value="zh_CN">{t('common.language.zh_CN', locale)}</option>
              <option value="zh_TW">{t('common.language.zh_TW', locale)}</option>
              <option value="en">{t('common.language.en', locale)}</option>
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-2 text-zinc-400" />
          </span>
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
