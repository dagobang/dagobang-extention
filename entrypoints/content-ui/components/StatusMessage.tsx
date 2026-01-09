import { X } from 'lucide-react';
import { t, type Locale } from '@/utils/i18n';

function explorerTxUrl(chainId: number, txHash: string) {
  return `https://bscscan.com/tx/${txHash}`;
}

type StatusMessageProps = {
    error: string | null;
    onErrorClear: () => void;
    txHash: string | null;
    onTxHashClear: () => void;
    chainId: number;
    locale: Locale;
};

export function StatusMessage({ error, onErrorClear, txHash, onTxHashClear, chainId, locale }: StatusMessageProps) {
    return (
        <div className="relative flex-1">
            {error && (
               <div className="mx-3 mt-2 rounded bg-red-900/20 px-2 py-1 text-[12px] text-red-400 border border-red-900/50 flex items-center justify-between">
                   <span>{error}</span>
                   <X size={10} className="cursor-pointer" onClick={onErrorClear} />
               </div>
            )}
            {txHash && (
                <div className="mx-3 mt-2 rounded bg-emerald-900/20 px-2 py-1 text-[12px] text-emerald-400 border border-emerald-900/50 flex items-center justify-between">
                   <a href={explorerTxUrl(chainId, txHash)} target="_blank" className="hover:underline">{t('contentUi.status.txSent', locale)}</a>
                   <X size={10} className="cursor-pointer" onClick={onTxHashClear} />
                </div>
            )}
        </div>
    );
}
