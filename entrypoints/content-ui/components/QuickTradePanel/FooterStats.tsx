
import { t, type Locale } from '@/utils/i18n';

type FooterStatsProps = {
  formattedTokenBalance: string;
  tokenSymbol: string | null;
  tokenName?: string | null;
  tokenLogo?: string | null;
  price?: number | null;
  quoteSymbol?: string | null;
  marketCap?: string | null;
  liquidity?: string | null;
  dexLabel?: string | null;
  poolAddress?: string | null;
  locale: Locale;
};

export function FooterStats({
  formattedTokenBalance,
  tokenSymbol,
  tokenName,
  tokenLogo,
  price,
  quoteSymbol,
  marketCap,
  liquidity,
  dexLabel,
  poolAddress,
  locale,
}: FooterStatsProps) {
  const hasPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;

  return (
    <div className="border-t border-zinc-800">
      <div className="flex items-center gap-2 px-3 pt-2">
        {tokenLogo && (
          <img
            src={tokenLogo}
            alt={tokenSymbol || ''}
            className="w-5 h-5 rounded-full border border-zinc-700 object-cover"
          />
        )}
        <div className="flex flex-col">
          <span className="text-[13px] text-zinc-100 leading-tight">
            {tokenSymbol || t('contentUi.common.token', locale)}
          </span>
          {tokenName && (
            <span className="text-[11px] text-zinc-500 leading-tight">
              {tokenName}
            </span>
          )}
        </div>
        <div className="ml-auto text-right">
          {hasPrice ? (
            <>
              <div className="text-[13px] text-emerald-400">
                {price?.toFixed(6)} {quoteSymbol || 'USD'}
              </div>
              <div className="text-[11px] text-zinc-500">
                ≈ {(price! * Number(formattedTokenBalance.replace('>0', '0')) || 0).toLocaleString()}
              </div>
            </>
          ) : (
            <div className="text-[11px] text-zinc-500">
              {t('contentUi.footer.balance', locale)} {formattedTokenBalance} {tokenSymbol}
            </div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 px-3 pt-2 pb-1 text-center">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{t('contentUi.footer.balance', locale)}</span>
          <span className="text-[13px] text-zinc-300">
            {formattedTokenBalance} {tokenSymbol}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{t('contentUi.footer.marketCap', locale)}</span>
          <span className="text-[13px] text-zinc-300">
            {marketCap ?? '--'}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-zinc-500">{t('contentUi.footer.liquidity', locale)}</span>
          <span className="text-[13px] text-zinc-300">
            {liquidity ?? '--'}
          </span>
        </div>
      </div>
      {(dexLabel || poolAddress) && (
        <div className="px-3 pb-2 flex items-center justify-between text-[11px] text-zinc-500">
          <div>
            <span>{t('contentUi.footer.dex', locale)}: </span>
            <span className="text-zinc-300">
              {dexLabel ?? '--'}
            </span>
          </div>
          {poolAddress && (
            <div className="truncate max-w-[150px]" title={poolAddress}>
              <span>{t('contentUi.footer.pool', locale)}: </span>
              <span className="text-zinc-300">
                {poolAddress.slice(0, 6)}...{poolAddress.slice(-4)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
