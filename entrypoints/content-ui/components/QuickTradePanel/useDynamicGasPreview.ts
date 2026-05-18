import { useEffect, useMemo, useState } from 'react';
import { formatGwei } from 'viem';
import { ChainId } from '@/constants/chains/chainId';
import type { Settings } from '@/types/extention';
import { RpcService } from '@/services/rpc';

const DYNAMIC_GAS_MULTIPLIER: Record<'slow' | 'standard' | 'fast' | 'turbo', number> = {
  slow: 1.0,
  standard: 1.1,
  fast: 1.2,
  turbo: 1.4,
};

export const formatGasGweiText = (value: bigint | null) => {
  if (value == null || value <= 0n) return '--';
  const text = formatGwei(value);
  const num = Number(text);
  if (!Number.isFinite(num)) return text;
  if (num >= 100) return num.toFixed(0);
  if (num >= 10) return num.toFixed(2);
  if (num >= 1) return num.toFixed(3);
  return num.toFixed(4);
};

const MULTIPLIER_BPS: Record<'slow' | 'standard' | 'fast' | 'turbo', bigint> = {
  slow: 10000n,
  standard: 11000n,
  fast: 12000n,
  turbo: 14000n,
};

export function getDynamicGasPreview(baseGasPriceWei: bigint | null, gasPreset: 'slow' | 'standard' | 'fast' | 'turbo') {
  const multiplierBps = MULTIPLIER_BPS[gasPreset] ?? 10000n;
  const multipliedGasPriceWei =
    baseGasPriceWei == null || baseGasPriceWei <= 0n
      ? null
      : (() => {
          const scaled = (baseGasPriceWei * multiplierBps + 9999n) / 10000n;
          return scaled > 0n ? scaled : 1n;
        })();

  return {
    baseGasPriceWei,
    multipliedGasPriceWei,
    baseGasPriceGweiText: formatGasGweiText(baseGasPriceWei),
    multipliedGasPriceGweiText: formatGasGweiText(multipliedGasPriceWei),
    multiplierLabel: `${DYNAMIC_GAS_MULTIPLIER[gasPreset] ?? 1}x`,
  };
}

export function useDynamicGasPreview(settings: Settings | null, enabled: boolean) {
  const [baseGasPriceWei, setBaseGasPriceWei] = useState<bigint | null>(null);
  const chainId = settings?.chainId ?? null;

  useEffect(() => {
    if (!settings || !enabled || !chainId) {
      setBaseGasPriceWei(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const resolved = await RpcService.withBalancedReadClient({
          chainId,
          caller: 'quickTrade.dynamicGas',
          run: async (client) => {
            if (chainId === ChainId.ETH) {
              const estimated = await client.estimateFeesPerGas();
              if (typeof estimated?.maxFeePerGas === 'bigint' && estimated.maxFeePerGas > 0n) {
                return estimated.maxFeePerGas;
              }
              if (typeof estimated?.maxPriorityFeePerGas === 'bigint' && estimated.maxPriorityFeePerGas > 0n) {
                return estimated.maxPriorityFeePerGas * 2n;
              }
            }
            return await client.getGasPrice();
          },
        });
        if (!cancelled && resolved > 0n) {
          setBaseGasPriceWei(resolved);
          return;
        }
        if (!cancelled) setBaseGasPriceWei(null);
      } catch {
        if (!cancelled) setBaseGasPriceWei(null);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [chainId, enabled, settings]);

  return useMemo(() => ({
    baseGasPriceWei,
    baseGasPriceGweiText: formatGasGweiText(baseGasPriceWei),
  }), [baseGasPriceWei]);
}
