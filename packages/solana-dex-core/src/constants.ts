import type { SolanaDexTokenInfo, SolanaTradeSource } from './types';

export const SOLANA_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const SOLANA_NATIVE_MINT = 'So11111111111111111111111111111111111111112' as const;
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as const;
export const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KxuxMxDPZWS9Vyuk3F8F' as const;
export const SOLANA_RAYDIUM_AMM_V4_SOL_USDC_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2' as const;

export const SOLANA_PLATFORM_SOURCE_ALIASES: Record<string, SolanaTradeSource> = {
  bonk: 'bonk',
  pump: 'pumpfun',
  pumpfun: 'pumpfun',
  'pump.fun': 'pumpfun',
  pump_swap: 'pumpswap',
  pumpswap: 'pumpswap',
  pumpamm: 'pumpswap',
  'pump amm': 'pumpswap',
  raydium: 'raydium',
  meteora: 'meteora',
  dlmm: 'meteora',
  believe: 'believe',
  bags: 'bags',
  orca: 'orca',
};

export const SOLANA_ROUTE_LABELS: Record<SolanaTradeSource, string> = {
  bonk: 'Bonk',
  pumpfun: 'Pump',
  pumpswap: 'PumpSwap',
  raydium: 'Raydium',
  meteora: 'Meteora',
  believe: 'Believe',
  bags: 'Bags',
  orca: 'Orca',
  jupiter: 'Jup',
};

export function normalizeSolanaPlatform(platform?: string | null): string {
  return String(platform || '').trim().toLowerCase();
}

export function resolveSolanaSourceAlias(platform?: string | null): SolanaTradeSource | null {
  const normalized = normalizeSolanaPlatform(platform);
  return normalized ? (SOLANA_PLATFORM_SOURCE_ALIASES[normalized] ?? null) : null;
}

export function getSolanaTokenInfoRouteFingerprint(tokenInfo?: SolanaDexTokenInfo | null): string {
  if (!tokenInfo) return '';
  return [
    normalizeSolanaPlatform(tokenInfo.launchpad_platform || tokenInfo.launchpad),
    String(tokenInfo.launchpad_status ?? ''),
    String(tokenInfo.quote_token_address || '').trim().toLowerCase(),
  ].join('|');
}

function isPumpfunPlatform(platform: string): boolean {
  return platform === 'pump' || platform === 'pumpfun' || platform === 'pump.fun';
}

function isPumpSwapPlatform(platform: string): boolean {
  return platform === 'pumpswap'
    || platform === 'pump_swap'
    || platform === 'pumpamm'
    || platform === 'pump amm';
}

export function resolveKnownSolanaDirectSource(
  tokenInfo?: SolanaDexTokenInfo | null,
  tokenAddress?: string | null,
): SolanaTradeSource | null {
  const platform = normalizeSolanaPlatform(tokenInfo?.launchpad_platform || tokenInfo?.launchpad);
  const launchpadStatus = Number(tokenInfo?.launchpad_status ?? NaN);
  const looksLikePumpfunMint = String(tokenAddress || '').trim().toLowerCase().endsWith('pump');
  const isPumpLike = isPumpfunPlatform(platform) || isPumpSwapPlatform(platform) || looksLikePumpfunMint;

  // For pump-family tokens, route selection should be driven by launchpad_status.
  // Only an explicit migrated status may enter PumpSwap; otherwise keep inner route.
  if (isPumpLike && launchpadStatus === 1) return 'pumpswap';
  if (isPumpLike && launchpadStatus === 0) return 'pumpfun';
  if (looksLikePumpfunMint) return 'pumpfun';
  if (isPumpfunPlatform(platform)) return 'pumpfun';
  if (isPumpSwapPlatform(platform)) return 'pumpswap';
  return null;
}

export function isSolanaNativeMint(mint?: string | null): boolean {
  return String(mint || '').trim() === SOLANA_NATIVE_MINT;
}

export function isSolanaStableMint(mint?: string | null): boolean {
  const normalized = String(mint || '').trim();
  return normalized === SOLANA_USDC_MINT || normalized === SOLANA_USDT_MINT;
}
