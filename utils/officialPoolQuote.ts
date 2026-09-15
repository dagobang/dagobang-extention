import DexScreenerAPI, { type DexScreenerPair } from '@/hooks/DexScreenerAPI';

function isTokenAddress(value?: string | null): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function mapDexScreenerPairDexType(pair: DexScreenerPair | null | undefined): string | undefined {
  if (!pair) return undefined;
  const dex = String(pair.dexId || '').toLowerCase();
  const raw = [
    dex,
    Array.isArray(pair.labels) ? pair.labels.join(' ') : '',
    String(pair.url || ''),
  ].join(' ').toLowerCase();
  const isV4 = raw.includes('v4');
  const isV3 = !isV4 && (raw.includes('v3') || raw.includes('clmm') || /(^|[^a-z])cl([^a-z]|$)/.test(raw));
  if (dex.includes('uniswap')) return isV4 ? 'UNISWAP_V4' : isV3 ? 'UNISWAP_V3' : 'UNISWAP';
  if (isV4) return 'UNISWAP_V4';
  if (isV3) return 'PANCAKE_SWAP_V3';
  return 'PANCAKE_SWAP';
}

export async function resolveQuoteFromDexScreenerPool(input: {
  chain: string;
  tokenAddress: string;
  poolAddress: string;
}): Promise<{ quoteTokenAddress: `0x${string}`; quoteSymbol?: string; dexType?: string } | null> {
  const pool = String(input.poolAddress || '').trim();
  if (!isTokenAddress(pool)) return null;
  const pair = await DexScreenerAPI.getPair(input.chain, pool).catch(() => null);
  if (!pair) return null;
  const token = String(input.tokenAddress || '').trim().toLowerCase();
  const base = pair.baseToken;
  const quote = pair.quoteToken;
  const counterparty = (
    isTokenAddress(base?.address) && base.address.toLowerCase() !== token
      ? base
      : isTokenAddress(quote?.address) && quote.address.toLowerCase() !== token
        ? quote
        : null
  );
  if (!counterparty?.address || !isTokenAddress(counterparty.address)) return null;
  if (counterparty.address.toLowerCase() === token) return null;
  return {
    quoteTokenAddress: counterparty.address,
    quoteSymbol: counterparty.symbol,
    dexType: mapDexScreenerPairDexType(pair),
  };
}
