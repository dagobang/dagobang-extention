import { FLAP_TAX_RATE_OPTIONS } from './constants';
import { getTaxChipClass } from './helpers';

type TaxRateChipsProps = {
  buyTaxBps: number;
  sellTaxBps: number;
  onBuyTaxBpsChange: (bps: number) => void;
  onSellTaxBpsChange: (bps: number) => void;
  sellMinBps?: number;
};

export function TaxRateChips({
  buyTaxBps,
  sellTaxBps,
  onBuyTaxBpsChange,
  onSellTaxBpsChange,
  sellMinBps = 0,
}: TaxRateChipsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          <span>买入税率</span>
          <span>{buyTaxBps > 0 ? `${buyTaxBps / 100}%` : '0%'}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {FLAP_TAX_RATE_OPTIONS.map((bps) => (
            <button
              key={`buy-${bps}`}
              type="button"
              className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(buyTaxBps === bps)}`}
              onClick={() => onBuyTaxBpsChange(bps)}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
        <div className="text-[10px] text-zinc-500">再次点击已选税率可取消，未选中即 0%</div>
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
          <span>卖出税率</span>
          <span>{sellTaxBps > 0 ? `${sellTaxBps / 100}%` : '0%'}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {FLAP_TAX_RATE_OPTIONS.map((bps) => (
            <button
              key={`sell-${bps}`}
              type="button"
              className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(sellTaxBps === bps)}`}
              onClick={() => onSellTaxBpsChange(bps)}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
        <div className="text-[10px] text-zinc-500">
          {sellMinBps > 0
            ? `开启税收后卖出税率至少 ${sellMinBps / 100}%`
            : '再次点击已选税率可取消，未选中即 0%'}
        </div>
      </div>
    </div>
  );
}
