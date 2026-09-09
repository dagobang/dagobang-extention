import { Check, X } from 'lucide-react';
import { FLAP_CUSTOM_QUOTE_ID, type FlapCustomQuoteToken, type FlapPresetQuoteToken } from '@/constants/flap';
import { getTaxChipClass, renderFlapTokenAvatar } from './helpers';
import { TaxRateChips } from './TaxRateChips';
import type { FlapTaxMode } from './types';

type FlapPresetSectionProps = {
  isFlapStocksTemplate: boolean;
  flapQuoteTokens: readonly FlapPresetQuoteToken[];
  flapQuoteTokenId: FlapPresetQuoteToken['id'];
  onFlapQuoteTokenIdChange: (id: FlapPresetQuoteToken['id']) => void;
  selectedFlapQuoteToken: FlapPresetQuoteToken | null;
  flapCustomQuoteAddress: string;
  onFlapCustomQuoteAddressChange: (value: string) => void;
  flapCustomQuoteToken: FlapCustomQuoteToken | null;
  flapCustomQuoteChecking: boolean;
  flapCustomQuoteError: string | null;
  onCheckCustomQuote: () => void;
  onClearCustomQuote: () => void;
  flapTaxMode: FlapTaxMode;
  onFlapTaxModeChange: (mode: FlapTaxMode) => void;
  flapCustomDividendTokenAddress: string;
  onFlapCustomDividendTokenAddressChange: (value: string) => void;
  flapStockSearch: string;
  onFlapStockSearchChange: (value: string) => void;
  filteredFlapStockOptions: readonly FlapPresetQuoteToken[];
  flapSelectedStocks: string[];
  flapStocksPresetTokens: readonly FlapPresetQuoteToken[];
  onToggleFlapStockSymbol: (symbol: string) => void;
  flapBuyTaxBps: number;
  onFlapBuyTaxBpsChange: (bps: number) => void;
  flapSellTaxBps: number;
  onFlapSellTaxBpsChange: (bps: number) => void;
};

export function FlapPresetSection({
  isFlapStocksTemplate,
  flapQuoteTokens,
  flapQuoteTokenId,
  onFlapQuoteTokenIdChange,
  selectedFlapQuoteToken,
  flapCustomQuoteAddress,
  onFlapCustomQuoteAddressChange,
  flapCustomQuoteToken,
  flapCustomQuoteChecking,
  flapCustomQuoteError,
  onCheckCustomQuote,
  onClearCustomQuote,
  flapTaxMode,
  onFlapTaxModeChange,
  flapCustomDividendTokenAddress,
  onFlapCustomDividendTokenAddressChange,
  flapStockSearch,
  onFlapStockSearchChange,
  filteredFlapStockOptions,
  flapSelectedStocks,
  flapStocksPresetTokens,
  onToggleFlapStockSymbol,
  flapBuyTaxBps,
  onFlapBuyTaxBpsChange,
  flapSellTaxBps,
  onFlapSellTaxBpsChange,
}: FlapPresetSectionProps) {
  const isCustomQuote = flapQuoteTokenId === FLAP_CUSTOM_QUOTE_ID;

  return (
    <div className="space-y-3 rounded-lg border border-indigo-500/25 bg-indigo-500/5 p-2.5">
      <div className="text-[12px] font-semibold text-indigo-200">预设</div>

      <div className="space-y-1">
        <div className="text-[11px] text-zinc-400">底池币种</div>
        <div className="grid grid-cols-3 gap-2">
          {flapQuoteTokens.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(flapQuoteTokenId === item.id)}`}
              onClick={() => onFlapQuoteTokenIdChange(item.id)}
            >
              <span className="flex items-center gap-1.5">
                {renderFlapTokenAvatar(item)}
                <span className="min-w-0 truncate">{item.label}</span>
              </span>
            </button>
          ))}
          <button
            type="button"
            className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(isCustomQuote)}`}
            onClick={() => onFlapQuoteTokenIdChange(FLAP_CUSTOM_QUOTE_ID)}
          >
            自定义
          </button>
        </div>
      </div>

      {isCustomQuote && flapCustomQuoteToken ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-zinc-200">自定义底池</div>
            <Check size={14} className="shrink-0 text-emerald-400" />
          </div>
          <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5">
            {selectedFlapQuoteToken ? renderFlapTokenAvatar(selectedFlapQuoteToken, 'h-5 w-5') : null}
            <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-100">
              {flapCustomQuoteToken.symbol || flapCustomQuoteToken.name}
            </span>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
              onClick={onClearCustomQuote}
              aria-label="清除自定义底池"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}

      {isCustomQuote && !flapCustomQuoteToken ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
              value={flapCustomQuoteAddress}
              onChange={(e) => onFlapCustomQuoteAddressChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCheckCustomQuote();
              }}
              placeholder="输入 ERC20 合约地址"
            />
            <button
              type="button"
              className="shrink-0 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-50"
              onClick={onCheckCustomQuote}
              disabled={flapCustomQuoteChecking}
            >
              {flapCustomQuoteChecking ? '校验中' : '校验'}
            </button>
          </div>
          {flapCustomQuoteError ? (
            <div className="text-[10px] text-rose-400">{flapCustomQuoteError}</div>
          ) : (
            <div className="text-[10px] text-zinc-500">输入合约地址后校验是否可作为 Flap 底池</div>
          )}
        </div>
      ) : null}

      {!isFlapStocksTemplate ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-zinc-400">税收模式</div>
            <div className="text-[10px] text-zinc-500">
              当前默认按底池币种分红
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {([
              { value: 'quote', label: '按底池币种' },
              { value: 'self', label: '本币' },
              { value: 'custom', label: '自定义' },
            ] as const).map((item) => (
              <button
                key={item.value}
                type="button"
                className={`rounded-md border px-2 py-1.5 text-[11px] transition ${getTaxChipClass(flapTaxMode === item.value)}`}
                onClick={() => onFlapTaxModeChange(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {flapTaxMode === 'custom' && (
            <input
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
              value={flapCustomDividendTokenAddress}
              onChange={(e) => onFlapCustomDividendTokenAddressChange(e.target.value)}
              placeholder="自定义分红代币地址"
            />
          )}
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-[11px] text-zinc-400">
            <span className="flex items-center gap-1.5">
              {flapTaxMode === 'quote' && selectedFlapQuoteToken
                ? renderFlapTokenAvatar(selectedFlapQuoteToken)
                : null}
              <span>
                当前分红代币：{flapTaxMode === 'quote'
                  ? selectedFlapQuoteToken?.label || (isCustomQuote ? '待校验' : '-')
                  : flapTaxMode === 'self'
                    ? '本币'
                    : flapCustomDividendTokenAddress.trim() || '待填写'}
              </span>
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[11px] text-zinc-400">币股分红模板</div>
            <div className="text-[10px] text-zinc-500">已选 {flapSelectedStocks.length}/10</div>
          </div>
          <input
            className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[12px] outline-none"
            value={flapStockSearch}
            onChange={(e) => onFlapStockSearchChange(e.target.value)}
            placeholder="搜索币种符号"
          />
          <div className="grid grid-cols-2 gap-2">
            {filteredFlapStockOptions.map((token) => {
              const active = flapSelectedStocks.includes(token.symbol);
              return (
                <button
                  key={token.address}
                  type="button"
                  className={`rounded-md border px-2 py-2 text-left text-[11px] transition ${getTaxChipClass(active)}`}
                  onClick={() => onToggleFlapStockSymbol(token.symbol)}
                >
                  <span className="flex items-center gap-2">
                    {renderFlapTokenAvatar(token, 'h-5 w-5')}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-zinc-100">{token.symbol}</span>
                      <span className="block text-[10px] text-zinc-500">
                        {(token.tags?.[0] || token.category).toUpperCase()}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {flapSelectedStocks.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {flapSelectedStocks.map((symbol) => {
                const token = flapStocksPresetTokens.find((item) => item.symbol === symbol);
                return (
                  <button
                    key={symbol}
                    type="button"
                    className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-200"
                    onClick={() => onToggleFlapStockSymbol(symbol)}
                  >
                    <span className="flex items-center gap-1">
                      {token ? renderFlapTokenAvatar(token, 'h-3.5 w-3.5') : null}
                      <span>{symbol} ×</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <TaxRateChips
        buyTaxBps={flapBuyTaxBps}
        sellTaxBps={flapSellTaxBps}
        onBuyTaxBpsChange={onFlapBuyTaxBpsChange}
        onSellTaxBpsChange={onFlapSellTaxBpsChange}
      />
    </div>
  );
}
