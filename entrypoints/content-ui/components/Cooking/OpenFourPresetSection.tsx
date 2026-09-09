import { OPENFOUR_4STOCK_TEMPLATE, OPENFOUR_LAUNCH_MODES, type OpenFourLaunchMode } from '@/constants/openfour';
import { getTaxChipClass } from './helpers';
import { TaxRateChips } from './TaxRateChips';
import { ToggleRow } from './ToggleRow';
import { sumOpenFourTaxAlloc, type OpenFourTaxAlloc } from './types';

type OpenFourPresetSectionProps = {
  mode: OpenFourLaunchMode;
  onModeChange: (mode: OpenFourLaunchMode) => void;
  template?: {
    quoteSymbol?: string;
    raisedAmount?: string;
    createFee?: string;
  } | null;
  antiSniperEnabled: boolean;
  onAntiSniperEnabledChange: (enabled: boolean) => void;
  taxEnabled: boolean;
  onTaxEnabledChange: (enabled: boolean) => void;
  buyTaxBps: number;
  sellTaxBps: number;
  onBuyTaxBpsChange: (bps: number) => void;
  onSellTaxBpsChange: (bps: number) => void;
  taxAlloc: OpenFourTaxAlloc;
  onTaxAllocChange: (patch: Partial<OpenFourTaxAlloc>) => void;
};

const ALLOC_ROWS: Array<{ key: keyof OpenFourTaxAlloc; label: string; dot: string }> = [
  { key: 'founder', label: '资金接收钱包', dot: 'bg-rose-400' },
  { key: 'burn', label: '销毁（减少供应量）', dot: 'bg-emerald-400' },
  { key: 'holder', label: '分配给持有者', dot: 'bg-violet-400' },
  { key: 'liquidity', label: '添加至流动性', dot: 'bg-sky-400' },
];

export function OpenFourPresetSection({
  mode,
  onModeChange,
  template,
  antiSniperEnabled,
  onAntiSniperEnabledChange,
  taxEnabled,
  onTaxEnabledChange,
  buyTaxBps,
  sellTaxBps,
  onBuyTaxBpsChange,
  onSellTaxBpsChange,
  taxAlloc,
  onTaxAllocChange,
}: OpenFourPresetSectionProps) {
  const allocSum = sumOpenFourTaxAlloc(taxAlloc);

  return (
    <div className="space-y-3 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-2.5">
      <div className="text-[12px] font-semibold text-cyan-200">OpenFour 模式</div>
      <div className="grid grid-cols-2 gap-2">
        {OPENFOUR_LAUNCH_MODES.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`rounded-md border px-2 py-2 text-left text-[11px] transition ${getTaxChipClass(mode === item.value)}`}
            onClick={() => onModeChange(item.value)}
          >
            <span className="block font-medium">{item.label}</span>
            <span className="block text-[10px] text-zinc-500">{item.tag}</span>
          </button>
        ))}
      </div>
      <div className="text-[11px] text-zinc-400">{OPENFOUR_LAUNCH_MODES.find((item) => item.value === mode)?.descr}</div>

      <div className="space-y-1">
        <div className="text-[11px] text-zinc-400">募集币种</div>
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-100">
          <div className="font-medium">
            {template?.quoteSymbol || OPENFOUR_4STOCK_TEMPLATE.quoteSymbol}
          </div>
          <div className="text-[10px] text-emerald-200/80">
            募集目标 {template?.raisedAmount || OPENFOUR_4STOCK_TEMPLATE.raisedAmount}{' '}
            {template?.quoteSymbol || OPENFOUR_4STOCK_TEMPLATE.quoteSymbol}
            {template?.createFee && Number(template.createFee) > 0 ? ` · 创建费 ${template.createFee} BNB` : ''}
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950/50 p-2">
        <ToggleRow
          checked={antiSniperEnabled}
          onChange={onAntiSniperEnabledChange}
          label="反狙击"
          hint="代币创建后的前几个区块将收取高额交易费。"
        />
        <ToggleRow
          checked={taxEnabled}
          onChange={onTaxEnabledChange}
          label="启用税收"
        />
      </div>

      {taxEnabled && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-zinc-400">税收模式</div>
            <div className="text-[10px] text-zinc-500">税率 1% ~ 10%，交互与 Flap 相同</div>
          </div>
          <TaxRateChips
            buyTaxBps={buyTaxBps}
            sellTaxBps={sellTaxBps}
            onBuyTaxBpsChange={onBuyTaxBpsChange}
            onSellTaxBpsChange={onSellTaxBpsChange}
            sellMinBps={100}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-zinc-400">税费分配</div>
              <div className={`text-[10px] ${allocSum === 100 ? 'text-emerald-300' : 'text-rose-300'}`}>
                总分配 {allocSum}%{allocSum === 100 ? '' : '，必须为 100%'}
              </div>
            </div>
            <div className="space-y-1.5">
              {ALLOC_ROWS.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${row.dot}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">{row.label}</span>
                  <div className="flex items-center gap-1">
                    <input
                      className="w-14 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-right text-[11px] outline-none"
                      inputMode="numeric"
                      value={String(taxAlloc[row.key])}
                      onChange={(e) => {
                        const next = Number(e.target.value.replace(/[^\d]/g, ''));
                        onTaxAllocChange({
                          [row.key]: Number.isFinite(next) ? Math.min(100, Math.max(0, next)) : 0,
                        });
                      }}
                    />
                    <span className="text-[11px] text-zinc-500">%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
