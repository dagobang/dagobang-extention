import quotesFile from '../public/quotes.json';
import { ChainId } from '@/constants/chains/chainId';
import { getNativeSymbol } from '@/constants/chains';
import { EVM_CHAIN_RUNTIME } from '@/constants/chains/evmRuntime';
import { OPENFOUR_4STOCK_QUOTE_FALLBACK } from '@/constants/openfour';
import { FlapQuoteTokensByChain } from '@/constants/flap';
import { allTokens } from '@/constants/tokens/allTokens';
import type { TokenInfo } from '@/types/token';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type QuoteListEntry = {
  ca?: string;
  title?: string;
};

type QuotesFile = {
  config?: {
    configs?: Record<string, QuoteListEntry[]>;
  };
};

const quotesByChain = new Map<number, Map<string, string>>();

function quotesChainKey(chainId: number): string | null {
  if (chainId === ChainId.BNB) return 'bsc';
  if (chainId === ChainId.ETH) return 'eth';
  if (chainId === ChainId.RH) return 'robinhood';
  return null;
}

function getQuoteSymbolMap(chainId: number): Map<string, string> {
  const cached = quotesByChain.get(chainId);
  if (cached) return cached;
  const map = new Map<string, string>();
  for (const token of FlapQuoteTokensByChain[chainId as ChainId] ?? []) {
    const symbol = String(token.symbol || token.label || '').trim();
    if (symbol) map.set(token.address.toLowerCase(), symbol);
  }
  const key = quotesChainKey(chainId);
  const list = ((quotesFile as QuotesFile)?.config?.configs?.[key || ''] ?? []) as QuoteListEntry[];
  for (const item of list) {
    const address = String(item.ca || '').trim().toLowerCase();
    const title = String(item.title || '').trim();
    if (address && title) map.set(address, title);
  }
  if (chainId === ChainId.BNB) {
    map.set(OPENFOUR_4STOCK_QUOTE_FALLBACK.address.toLowerCase(), OPENFOUR_4STOCK_QUOTE_FALLBACK.symbol);
  }
  if (chainId === ChainId.RH) {
    for (const token of Object.values(allTokens[ChainId.RH] ?? {})) {
      const symbol = String(token.symbol || '').trim();
      if (symbol) map.set(token.address.toLowerCase(), symbol);
    }
  }
  quotesByChain.set(chainId, map);
  return map;
}

export function isLikelyTokenAddressLabel(value?: string | null): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

export function getKnownQuoteTokenSymbol(chainId: number, address?: string | null): string | null {
  const key = String(address || '').trim().toLowerCase();
  if (!key) return null;
  return getQuoteSymbolMap(chainId).get(key) ?? null;
}

export function isPlaceholderRouteSymbol(value?: string | null): boolean {
  const symbol = String(value || '').trim();
  if (!symbol) return true;
  const upper = symbol.toUpperCase();
  return upper === 'QUOTE' || upper === 'UNKNOWN' || upper === 'TOKEN';
}

export function preferRouteTokenSymbol(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const symbol = String(candidate || '').trim();
    if (!symbol || isLikelyTokenAddressLabel(symbol) || isPlaceholderRouteSymbol(symbol)) continue;
    if (symbol.endsWith('…') && symbol.startsWith('0x')) continue;
    return symbol;
  }
  return null;
}

export function resolveRouteTokenLabel(input: {
  chainId: number;
  address?: string | null;
  tokenInfo?: TokenInfo | null;
  fallbackSymbol?: string | null;
}): string {
  const address = String(input.address || '').trim();
  if (!address) return input.fallbackSymbol?.trim() || 'TOKEN';
  const lower = address.toLowerCase();
  const wrapped = EVM_CHAIN_RUNTIME[input.chainId]?.wrappedNativeAddress.toLowerCase();
  if (lower === ZERO_ADDRESS || (wrapped && lower === wrapped)) {
    return getNativeSymbol(input.chainId);
  }
  if (input.tokenInfo && lower === String(input.tokenInfo.address || '').toLowerCase()) {
    const traded = preferRouteTokenSymbol(input.tokenInfo.symbol, input.tokenInfo.name, input.fallbackSymbol);
    if (traded) return traded;
  }
  const quoteCatalog = getKnownQuoteTokenSymbol(input.chainId, address);
  if (quoteCatalog) return quoteCatalog;
  const known = Object.values(allTokens[input.chainId as ChainId] ?? {});
  const match = known.find((token) => token.address.toLowerCase() === lower);
  if (match?.symbol) return match.symbol;
  if (
    input.tokenInfo?.quote_token_address
    && lower === input.tokenInfo.quote_token_address.toLowerCase()
  ) {
    const quoteSymbol = preferRouteTokenSymbol(input.tokenInfo.quote_token, input.fallbackSymbol);
    const nativeSymbol = getNativeSymbol(input.chainId);
    if (
      quoteSymbol
      && quoteSymbol.toUpperCase() !== nativeSymbol.toUpperCase()
      && quoteSymbol.toUpperCase() !== `W${nativeSymbol}`.toUpperCase()
    ) {
      return quoteSymbol;
    }
  }
  const fallback = preferRouteTokenSymbol(input.fallbackSymbol);
  if (fallback) return fallback;
  return `${address.slice(0, 6)}…`;
}
