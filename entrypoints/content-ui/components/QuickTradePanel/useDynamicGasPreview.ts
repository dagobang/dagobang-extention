import { useEffect, useMemo, useState } from 'react';
import { createPublicClient, formatGwei, http } from 'viem';
import { ChainId } from '@/constants/chains/chainId';
import { getChainRuntime } from '@/constants/chains/runtime';
import type { Settings } from '@/types/extention';

const DYNAMIC_GAS_MULTIPLIER: Record<'slow' | 'standard' | 'fast' | 'turbo', number> = {
  slow: 1.0,
  standard: 1.1,
  fast: 1.2,
  turbo: 1.4,
};

const normalizeUrls = (urls: string[] | undefined, fallbackUrls: readonly string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of [...(urls ?? []), ...fallbackUrls]) {
    const url = String(raw ?? '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
};

const formatGweiText = (value: bigint | null) => {
  if (value == null || value <= 0n) return '--';
  const text = formatGwei(value);
  const num = Number(text);
  if (!Number.isFinite(num)) return text;
  if (num >= 100) return num.toFixed(0);
  if (num >= 10) return num.toFixed(2);
  if (num >= 1) return num.toFixed(3);
  return num.toFixed(4);
};

export function useDynamicGasPreview(
  settings: Settings | null,
  gasPreset: 'slow' | 'standard' | 'fast' | 'turbo',
  enabled: boolean,
) {
  const [baseGasPriceWei, setBaseGasPriceWei] = useState<bigint | null>(null);

  const rpcUrls = useMemo(() => {
    if (!settings) return [] as string[];
    const runtime = getChainRuntime(settings.chainId);
    const fallbackUrls = runtime.viemChain.rpcUrls.default.http;
    return normalizeUrls(settings.chains[settings.chainId]?.rpcUrls ?? [], fallbackUrls);
  }, [settings]);

  useEffect(() => {
    if (!settings || !enabled || rpcUrls.length <= 0) {
      setBaseGasPriceWei(null);
      return;
    }
    let cancelled = false;
    const chain = getChainRuntime(settings.chainId).viemChain;
    const clients = rpcUrls.slice(0, 4).map((url) => createPublicClient({
      chain,
      transport: http(url),
    }));
    const pickMedian = (values: bigint[]) => {
      if (values.length <= 0) return null;
      const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return sorted[Math.floor(sorted.length / 2)] ?? null;
    };
    const load = async () => {
      try {
        const samples = await Promise.allSettled(
          clients.map(async (client) => {
            if (settings.chainId === ChainId.ETH) {
              const estimated = await client.estimateFeesPerGas();
              if (typeof estimated?.maxFeePerGas === 'bigint' && estimated.maxFeePerGas > 0n) {
                return estimated.maxFeePerGas;
              }
              if (typeof estimated?.maxPriorityFeePerGas === 'bigint' && estimated.maxPriorityFeePerGas > 0n) {
                return estimated.maxPriorityFeePerGas * 2n;
              }
            }
            return await client.getGasPrice();
          })
        );
        const positiveValues = samples
          .filter((item): item is PromiseFulfilledResult<bigint> => item.status === 'fulfilled')
          .map((item) => item.value)
          .filter((value) => value > 0n);
        const resolved = pickMedian(positiveValues);
        if (!cancelled && resolved && resolved > 0n) {
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
  }, [enabled, rpcUrls, settings, gasPreset]);

  const multipliedGasPriceWei = useMemo(() => {
    const multiplierBpsMap: Record<'slow' | 'standard' | 'fast' | 'turbo', bigint> = {
      slow: 10000n,
      standard: 11000n,
      fast: 12000n,
      turbo: 14000n,
    };
    const multiplierBps = multiplierBpsMap[gasPreset] ?? 10000n;
    if (baseGasPriceWei == null || baseGasPriceWei <= 0n) return null;
    const scaled = (baseGasPriceWei * multiplierBps + 9999n) / 10000n;
    return scaled > 0n ? scaled : 1n;
  }, [baseGasPriceWei, gasPreset]);

  return {
    baseGasPriceWei,
    multipliedGasPriceWei,
    baseGasPriceGweiText: formatGweiText(baseGasPriceWei),
    multipliedGasPriceGweiText: formatGweiText(multipliedGasPriceWei),
    multiplierLabel: `${DYNAMIC_GAS_MULTIPLIER[gasPreset] ?? 1}x`,
  };
}
