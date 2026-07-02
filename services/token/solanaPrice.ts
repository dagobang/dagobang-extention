import { PublicKey, type GetProgramAccountsFilter, type GetProgramAccountsConfig } from '@solana/web3.js';
import { formatUnits } from 'viem';
import type { TokenInfo } from '@/types/token';
import { SolanaRpcService } from '@/services/chain/solana/rpc';
import {
  SOLANA_NATIVE_MINT,
  SOLANA_RAYDIUM_AMM_V4_SOL_USDC_POOL,
  SOLANA_USDC_MINT,
  SOLANA_USDT_MINT,
  isSolanaNativeMint,
  isSolanaStableMint,
  resolveSolanaTradeSource,
} from '../../packages/solana-dex-core/src/constants';
import type { SolanaTradeSource } from '../../packages/solana-dex-core/src/types';
import {
  computePumpfunSellAmountOut,
  derivePumpfunBondingCurvePda,
  parsePumpfunBondingCurveState,
} from '../../packages/solana-dex-core/src/protocols/pumpfun';
import {
  computePumpSwapSellQuoteAmountOut,
  derivePumpSwapPoolPda,
  derivePumpSwapPoolV2Pda,
  parsePumpSwapPoolState,
  parsePumpSwapTokenAccountBalance,
} from '../../packages/solana-dex-core/src/protocols/pumpswap';
import {
  computeRaydiumCpmmAmountOut,
  parseRaydiumCpmmPoolInfo,
  parseRaydiumCpmmTokenAccountBalance,
  RAYDIUM_CPMM_PROGRAM_ID,
} from '../../packages/solana-dex-core/src/protocols/raydium';

const SOLANA_NATIVE_DECIMALS = 9;
const SOLANA_STABLE_DECIMALS = 6;
const RAYDIUM_AMM_V4_PROGRAM_ID = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_AMM_V4_POOL_LAYOUT_SIZE = 752;
const RAYDIUM_AMM_V4_BASE_DECIMALS_OFFSET = 32;
const RAYDIUM_AMM_V4_QUOTE_DECIMALS_OFFSET = 40;
const RAYDIUM_AMM_V4_SWAP_FEE_NUMERATOR_OFFSET = 176;
const RAYDIUM_AMM_V4_SWAP_FEE_DENOMINATOR_OFFSET = 184;
const RAYDIUM_AMM_V4_BASE_NEED_TAKE_PNL_OFFSET = 192;
const RAYDIUM_AMM_V4_QUOTE_NEED_TAKE_PNL_OFFSET = 200;
const RAYDIUM_AMM_V4_BASE_VAULT_OFFSET = 336;
const RAYDIUM_AMM_V4_QUOTE_VAULT_OFFSET = 368;
const RAYDIUM_AMM_V4_BASE_MINT_OFFSET = 400;
const RAYDIUM_AMM_V4_QUOTE_MINT_OFFSET = 432;
const RAYDIUM_CPMM_TOKEN_MINT0_OFFSET = 168;
const RAYDIUM_CPMM_TOKEN_MINT1_OFFSET = 200;
const SOLANA_STATIC_POOL_CACHE_TTL_MS = 5 * 60_000;

type HydratedRaydiumPool = ReturnType<typeof parseRaydiumCpmmPoolInfo> & {
  reserve0: bigint;
  reserve1: bigint;
};

type HydratedRaydiumAmmV4Pool = {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseReserve: bigint;
  quoteReserve: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  swapFeeNumerator: bigint;
  swapFeeDenominator: bigint;
};

type RaydiumAmmV4PoolMeta = Omit<HydratedRaydiumAmmV4Pool, 'baseReserve' | 'quoteReserve'> & {
  baseNeedTakePnl: bigint;
  quoteNeedTakePnl: bigint;
};

const raydiumPoolSearchCache = new Map<string, { ts: number; value: string[] }>();
const raydiumPoolMetaCache = new Map<string, { ts: number; value: ReturnType<typeof parseRaydiumCpmmPoolInfo> }>();
const raydiumPoolStateCache = new Map<string, { ts: number; value: HydratedRaydiumPool }>();
const raydiumAmmV4PoolMetaCache = new Map<string, { ts: number; value: RaydiumAmmV4PoolMeta }>();
const raydiumAmmV4PoolStateCache = new Map<string, { ts: number; value: HydratedRaydiumAmmV4Pool }>();
const pumpSwapPoolStateCache = new Map<string, { ts: number; value: ReturnType<typeof parsePumpSwapPoolState> }>();
let nativeUsdCache: { ts: number; value: number } | null = null;

function toNumberFromUnits(amount: bigint, decimals: number): number {
  const raw = formatUnits(amount, decimals);
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMint(mint?: string | null): string {
  return String(mint || '').trim();
}

function readUint64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function readPublicKey(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

function resolveSolanaPriceSource(tokenInfo?: TokenInfo | null, tokenAddress?: string | null): SolanaTradeSource | null {
  return resolveSolanaTradeSource({
    tokenInfo: tokenInfo as any,
    tokenAddress,
    fallbackPlatforms: [
      tokenInfo?.tpool_exchange,
      tokenInfo?.dex_type,
    ],
  }).directSource;
}

async function getProgramAccountsAny(
  programId: PublicKey,
  config: GetProgramAccountsConfig,
) {
  const connections = await SolanaRpcService.getConnections();
  const attempts = connections.map(({ connection }) => connection.getProgramAccounts(programId, config));
  return await Promise.any(attempts);
}

async function findRaydiumCpmmPoolAddressesByMints(
  mintA: string,
  mintB: string,
): Promise<string[]> {
  const key = [mintA, mintB].sort().join(':');
  const cached = raydiumPoolSearchCache.get(key);
  if (cached && Date.now() - cached.ts < SOLANA_STATIC_POOL_CACHE_TTL_MS) {
    return cached.value;
  }
  const orderedFilters = (mint0: string, mint1: string): GetProgramAccountsFilter[] => [
    { memcmp: { offset: RAYDIUM_CPMM_TOKEN_MINT0_OFFSET, bytes: mint0 } },
    { memcmp: { offset: RAYDIUM_CPMM_TOKEN_MINT1_OFFSET, bytes: mint1 } },
  ];
  const [direct, reverse] = await Promise.all([
    getProgramAccountsAny(RAYDIUM_CPMM_PROGRAM_ID, { commitment: 'confirmed', filters: orderedFilters(mintA, mintB) }),
    getProgramAccountsAny(RAYDIUM_CPMM_PROGRAM_ID, { commitment: 'confirmed', filters: orderedFilters(mintB, mintA) }),
  ]);
  const unique = [...new Set([...direct, ...reverse].map((item) => item.pubkey.toBase58()))];
  raydiumPoolSearchCache.set(key, { ts: Date.now(), value: unique });
  return unique;
}

async function loadRaydiumCpmmPoolMeta(poolAddress: string) {
  const cached = raydiumPoolMetaCache.get(poolAddress);
  if (cached && Date.now() - cached.ts < SOLANA_STATIC_POOL_CACHE_TTL_MS) {
    return cached.value;
  }
  const connection = await SolanaRpcService.getConnection();
  const poolInfoRaw = await connection.getAccountInfo(new PublicKey(poolAddress), 'confirmed');
  if (!poolInfoRaw?.data) {
    throw new Error(`Raydium CPMM pool not found: ${poolAddress}`);
  }
  const parsed = parseRaydiumCpmmPoolInfo(poolInfoRaw.data, new PublicKey(poolAddress));
  raydiumPoolMetaCache.set(poolAddress, { ts: Date.now(), value: parsed });
  return parsed;
}

async function loadHydratedRaydiumPool(poolAddress: string, liveCacheTtlMs = 0): Promise<HydratedRaydiumPool> {
  const cached = raydiumPoolStateCache.get(poolAddress);
  if (cached && liveCacheTtlMs > 0 && Date.now() - cached.ts < liveCacheTtlMs) {
    return cached.value;
  }
  const connection = await SolanaRpcService.getConnection();
  const parsed = await loadRaydiumCpmmPoolMeta(poolAddress);
  const [vault0Info, vault1Info] = await connection.getMultipleAccountsInfo(
    [parsed.tokenVault0, parsed.tokenVault1],
    'confirmed',
  );
  if (!vault0Info?.data || !vault1Info?.data) {
    throw new Error(`Raydium CPMM vaults missing: ${poolAddress}`);
  }
  const hydrated: HydratedRaydiumPool = {
    ...parsed,
    reserve0: parseRaydiumCpmmTokenAccountBalance(vault0Info.data),
    reserve1: parseRaydiumCpmmTokenAccountBalance(vault1Info.data),
  };
  raydiumPoolStateCache.set(poolAddress, { ts: Date.now(), value: hydrated });
  return hydrated;
}

async function loadRaydiumAmmV4PoolMeta(poolAddress: string) {
  const cached = raydiumAmmV4PoolMetaCache.get(poolAddress);
  if (cached && Date.now() - cached.ts < SOLANA_STATIC_POOL_CACHE_TTL_MS) {
    return cached.value;
  }
  const connection = await SolanaRpcService.getConnection();
  const poolInfoRaw = await connection.getAccountInfo(new PublicKey(poolAddress), 'confirmed');
  if (!poolInfoRaw?.data) {
    throw new Error(`Raydium AMM v4 pool not found: ${poolAddress}`);
  }
  if (!poolInfoRaw.owner.equals(RAYDIUM_AMM_V4_PROGRAM_ID)) {
    throw new Error(`Pool is not a Raydium AMM v4 pool: ${poolAddress}`);
  }
  const poolData = poolInfoRaw.data;
  if (poolData.length < RAYDIUM_AMM_V4_POOL_LAYOUT_SIZE) {
    throw new Error(`Invalid Raydium AMM v4 pool length: ${poolData.length}`);
  }
  const meta = {
    poolAddress: new PublicKey(poolAddress),
    baseMint: readPublicKey(poolData, RAYDIUM_AMM_V4_BASE_MINT_OFFSET),
    quoteMint: readPublicKey(poolData, RAYDIUM_AMM_V4_QUOTE_MINT_OFFSET),
    baseVault: readPublicKey(poolData, RAYDIUM_AMM_V4_BASE_VAULT_OFFSET),
    quoteVault: readPublicKey(poolData, RAYDIUM_AMM_V4_QUOTE_VAULT_OFFSET),
    baseDecimals: Number(readUint64LE(poolData, RAYDIUM_AMM_V4_BASE_DECIMALS_OFFSET)),
    quoteDecimals: Number(readUint64LE(poolData, RAYDIUM_AMM_V4_QUOTE_DECIMALS_OFFSET)),
    swapFeeNumerator: readUint64LE(poolData, RAYDIUM_AMM_V4_SWAP_FEE_NUMERATOR_OFFSET),
    swapFeeDenominator: readUint64LE(poolData, RAYDIUM_AMM_V4_SWAP_FEE_DENOMINATOR_OFFSET),
    baseNeedTakePnl: readUint64LE(poolData, RAYDIUM_AMM_V4_BASE_NEED_TAKE_PNL_OFFSET),
    quoteNeedTakePnl: readUint64LE(poolData, RAYDIUM_AMM_V4_QUOTE_NEED_TAKE_PNL_OFFSET),
  };
  raydiumAmmV4PoolMetaCache.set(poolAddress, { ts: Date.now(), value: meta });
  return meta;
}

async function loadHydratedRaydiumAmmV4Pool(poolAddress: string, liveCacheTtlMs = 0): Promise<HydratedRaydiumAmmV4Pool> {
  const cached = raydiumAmmV4PoolStateCache.get(poolAddress);
  if (cached && liveCacheTtlMs > 0 && Date.now() - cached.ts < liveCacheTtlMs) {
    return cached.value;
  }
  const connection = await SolanaRpcService.getConnection();
  const meta = await loadRaydiumAmmV4PoolMeta(poolAddress);
  const [baseVaultInfo, quoteVaultInfo] = await connection.getMultipleAccountsInfo(
    [meta.baseVault, meta.quoteVault],
    'confirmed',
  );
  if (!baseVaultInfo?.data || !quoteVaultInfo?.data) {
    throw new Error(`Raydium AMM v4 vaults missing: ${poolAddress}`);
  }
  const baseVaultBalance = parseRaydiumCpmmTokenAccountBalance(baseVaultInfo.data);
  const quoteVaultBalance = parseRaydiumCpmmTokenAccountBalance(quoteVaultInfo.data);
  const hydrated: HydratedRaydiumAmmV4Pool = {
    poolAddress: meta.poolAddress,
    baseMint: meta.baseMint,
    quoteMint: meta.quoteMint,
    baseVault: meta.baseVault,
    quoteVault: meta.quoteVault,
    baseReserve: baseVaultBalance > meta.baseNeedTakePnl ? baseVaultBalance - meta.baseNeedTakePnl : 0n,
    quoteReserve: quoteVaultBalance > meta.quoteNeedTakePnl ? quoteVaultBalance - meta.quoteNeedTakePnl : 0n,
    baseDecimals: meta.baseDecimals,
    quoteDecimals: meta.quoteDecimals,
    swapFeeNumerator: meta.swapFeeNumerator,
    swapFeeDenominator: meta.swapFeeDenominator,
  };
  raydiumAmmV4PoolStateCache.set(poolAddress, { ts: Date.now(), value: hydrated });
  return hydrated;
}

function quoteRaydiumPoolExactIn(
  pool: HydratedRaydiumPool,
  inputMint: string,
  outputMint: string,
  amountIn: bigint,
): bigint {
  const token0 = pool.tokenMint0.toBase58();
  const token1 = pool.tokenMint1.toBase58();
  if (token0 === inputMint && token1 === outputMint) {
    return computeRaydiumCpmmAmountOut(amountIn, pool.reserve0, pool.reserve1);
  }
  if (token1 === inputMint && token0 === outputMint) {
    return computeRaydiumCpmmAmountOut(amountIn, pool.reserve1, pool.reserve0);
  }
  throw new Error('Raydium CPMM pool mint mismatch');
}

function computeConstantProductAmountOutWithFee(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNumerator: bigint,
  feeDenominator: bigint,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n || feeDenominator <= 0n) {
    return 0n;
  }
  const amountInAfterFee = amountIn * (feeDenominator - feeNumerator);
  if (amountInAfterFee <= 0n) return 0n;
  return amountInAfterFee * reserveOut / (reserveIn * feeDenominator + amountInAfterFee);
}

function quoteRaydiumAmmV4PoolExactIn(
  pool: HydratedRaydiumAmmV4Pool,
  inputMint: string,
  outputMint: string,
  amountIn: bigint,
): bigint {
  const baseMint = pool.baseMint.toBase58();
  const quoteMint = pool.quoteMint.toBase58();
  if (inputMint === baseMint && outputMint === quoteMint) {
    return computeConstantProductAmountOutWithFee(
      amountIn,
      pool.baseReserve,
      pool.quoteReserve,
      pool.swapFeeNumerator,
      pool.swapFeeDenominator,
    );
  }
  if (inputMint === quoteMint && outputMint === baseMint) {
    return computeConstantProductAmountOutWithFee(
      amountIn,
      pool.quoteReserve,
      pool.baseReserve,
      pool.swapFeeNumerator,
      pool.swapFeeDenominator,
    );
  }
  throw new Error('Raydium AMM v4 pool mint mismatch');
}

async function quoteBestRaydiumCpmmExactIn(
  inputMint: string,
  outputMint: string,
  amountIn: bigint,
  liveCacheTtlMs = 0,
): Promise<bigint> {
  const poolAddresses = await findRaydiumCpmmPoolAddressesByMints(inputMint, outputMint);
  if (!poolAddresses.length) {
    throw new Error(`Raydium CPMM pool not found for ${inputMint}/${outputMint}`);
  }
  let best = 0n;
  for (const poolAddress of poolAddresses) {
    try {
      const pool = await loadHydratedRaydiumPool(poolAddress, liveCacheTtlMs);
      const quoted = quoteRaydiumPoolExactIn(pool, inputMint, outputMint, amountIn);
      if (quoted > best) best = quoted;
    } catch {
    }
  }
  if (best <= 0n) {
    throw new Error(`Raydium CPMM quote unavailable for ${inputMint}/${outputMint}`);
  }
  return best;
}

async function quotePumpfunSellToQuote(tokenAddress: string, amountIn: bigint): Promise<{ quoteMint: string; amountOut: bigint }> {
  const connection = await SolanaRpcService.getConnection();
  const baseMint = new PublicKey(tokenAddress);
  const bondingCurve = derivePumpfunBondingCurvePda(baseMint);
  const info = await connection.getAccountInfo(bondingCurve, 'confirmed');
  if (!info?.data) {
    throw new Error('Pumpfun bonding curve account not found');
  }
  const state = parsePumpfunBondingCurveState(info.data);
  const amountOut = computePumpfunSellAmountOut({
    tokenAmountIn: amountIn,
    virtualTokenReserves: state.virtualTokenReserves,
    virtualSolReserves: state.virtualSolReserves,
    hasCreatorFee: !state.creator.equals(PublicKey.default),
  });
  const quoteMint = state.quoteMint.equals(PublicKey.default) ? SOLANA_NATIVE_MINT : state.quoteMint.toBase58();
  return { quoteMint, amountOut };
}

async function loadPumpSwapPoolStateCached(tokenAddress: string) {
  const connection = await SolanaRpcService.getConnection();
  const baseMint = new PublicKey(tokenAddress);
  const cacheKey = baseMint.toBase58();
  const cached = pumpSwapPoolStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SOLANA_STATIC_POOL_CACHE_TTL_MS) {
    return cached.value;
  }
  const poolV2Address = derivePumpSwapPoolV2Pda(baseMint);
  const canonicalPoolAddress = derivePumpSwapPoolPda(baseMint);
  const [poolV2Info, canonicalPoolInfo] = await connection.getMultipleAccountsInfo(
    [poolV2Address, canonicalPoolAddress],
    'confirmed',
  );
  let poolState: ReturnType<typeof parsePumpSwapPoolState> | null = null;
  for (const candidate of [poolV2Info, canonicalPoolInfo]) {
    if (!candidate?.data) continue;
    try {
      const parsed = parsePumpSwapPoolState(candidate.data);
      if (parsed.baseMint.equals(baseMint)) {
        poolState = parsed;
        break;
      }
    } catch {
    }
  }
  if (!poolState) {
    throw new Error('PumpSwap pool account not found');
  }
  pumpSwapPoolStateCache.set(cacheKey, { ts: Date.now(), value: poolState });
  return poolState;
}

async function quotePumpSwapSellToQuote(tokenAddress: string, amountIn: bigint): Promise<{ quoteMint: string; amountOut: bigint }> {
  const connection = await SolanaRpcService.getConnection();
  const poolState = await loadPumpSwapPoolStateCached(tokenAddress);
  const [baseReserveInfo, quoteReserveInfo] = await connection.getMultipleAccountsInfo(
    [poolState.poolBaseTokenAccount, poolState.poolQuoteTokenAccount],
    'confirmed',
  );
  if (!baseReserveInfo?.data || !quoteReserveInfo?.data) {
    throw new Error('PumpSwap reserve vaults not found');
  }
  const baseReserve = parsePumpSwapTokenAccountBalance(baseReserveInfo.data);
  const quoteReserve = parsePumpSwapTokenAccountBalance(quoteReserveInfo.data);
  const amountOut = computePumpSwapSellQuoteAmountOut({
    baseAmountIn: amountIn,
    baseReserve,
    quoteReserve,
    hasCreatorFee: !poolState.coinCreator.equals(PublicKey.default),
  });
  return {
    quoteMint: poolState.quoteMint.toBase58(),
    amountOut,
  };
}

async function quoteRaydiumSellToQuote(
  tokenAddress: string,
  tokenInfo: TokenInfo,
  amountIn: bigint,
  liveCacheTtlMs = 0,
): Promise<{ quoteMint: string; amountOut: bigint }> {
  const poolPair = normalizeMint(tokenInfo.pool_pair);
  if (!poolPair) {
    throw new Error('Raydium trade requires tokenInfo.pool_pair');
  }
  const pool = await loadHydratedRaydiumPool(poolPair, liveCacheTtlMs);
  const tokenMint = normalizeMint(tokenAddress);
  const token0 = pool.tokenMint0.toBase58();
  const token1 = pool.tokenMint1.toBase58();
  if (tokenMint !== token0 && tokenMint !== token1) {
    throw new Error('Raydium pool does not contain target mint');
  }
  const quoteMint = tokenMint === token0 ? token1 : token0;
  return {
    quoteMint,
    amountOut: quoteRaydiumPoolExactIn(pool, tokenMint, quoteMint, amountIn),
  };
}

async function getNativePriceUsd(liveCacheTtlMs = 0): Promise<number> {
  if (nativeUsdCache && liveCacheTtlMs > 0 && Date.now() - nativeUsdCache.ts < liveCacheTtlMs) {
    return nativeUsdCache.value;
  }
  const oneSolLamports = 10n ** BigInt(SOLANA_NATIVE_DECIMALS);
  try {
    const canonicalPool = await loadHydratedRaydiumAmmV4Pool(SOLANA_RAYDIUM_AMM_V4_SOL_USDC_POOL, liveCacheTtlMs);
    const quoted = quoteRaydiumAmmV4PoolExactIn(
      canonicalPool,
      SOLANA_NATIVE_MINT,
      SOLANA_USDC_MINT,
      oneSolLamports,
    );
    const usd = toNumberFromUnits(quoted, SOLANA_STABLE_DECIMALS);
    if (Number.isFinite(usd) && usd > 0) {
      nativeUsdCache = { ts: Date.now(), value: usd };
      return usd;
    }
  } catch {
  }
  for (const stableMint of [SOLANA_USDC_MINT, SOLANA_USDT_MINT]) {
    try {
      const quoted = await quoteBestRaydiumCpmmExactIn(SOLANA_NATIVE_MINT, stableMint, oneSolLamports, liveCacheTtlMs);
      const usd = toNumberFromUnits(quoted, SOLANA_STABLE_DECIMALS);
      if (Number.isFinite(usd) && usd > 0) {
        nativeUsdCache = { ts: Date.now(), value: usd };
        return usd;
      }
    } catch {
    }
  }
  throw new Error('Solana native USD quote unavailable');
}

async function quoteDirectSourcePriceUsd(
  tokenAddress: string,
  tokenInfo: TokenInfo,
  source: SolanaTradeSource,
  amountIn: bigint,
  liveCacheTtlMs = 0,
): Promise<number> {
  const quoted = source === 'pumpfun'
    ? await quotePumpfunSellToQuote(tokenAddress, amountIn)
    : source === 'pumpswap'
      ? await quotePumpSwapSellToQuote(tokenAddress, amountIn)
      : source === 'raydium'
        ? await quoteRaydiumSellToQuote(tokenAddress, tokenInfo, amountIn, liveCacheTtlMs)
        : null;
  if (!quoted || quoted.amountOut <= 0n) return 0;
  if (isSolanaStableMint(quoted.quoteMint)) {
    const priceUsd = toNumberFromUnits(quoted.amountOut, SOLANA_STABLE_DECIMALS);
    return priceUsd;
  }
  if (isSolanaNativeMint(quoted.quoteMint)) {
    const nativeUsd = await getNativePriceUsd(liveCacheTtlMs);
    const outNative = toNumberFromUnits(quoted.amountOut, SOLANA_NATIVE_DECIMALS);
    const priceUsd = nativeUsd > 0 && outNative > 0 ? nativeUsd * outNative : 0;
    return priceUsd;
  }
  return 0;
}

export async function getSolanaTokenPriceUsdFromQuote(input: {
  tokenAddress: string;
  tokenInfo?: TokenInfo | null;
  cacheTtlMs?: number;
}): Promise<number> {
  const tokenAddress = normalizeMint(input.tokenAddress);
  if (!tokenAddress) return 0;
  if (isSolanaNativeMint(tokenAddress)) {
    return await getNativePriceUsd(typeof input.cacheTtlMs === 'number' ? Math.max(0, input.cacheTtlMs) : 0);
  }
  const tokenInfo = input.tokenInfo ?? null;
  const source = resolveSolanaPriceSource(tokenInfo, tokenAddress);
  if (!source || !tokenInfo) return 0;
  const decimals = Number(tokenInfo.decimals ?? NaN);
  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
    return 0;
  }
  const amountIn = 10n ** BigInt(decimals);
  try {
    return await quoteDirectSourcePriceUsd(
      tokenAddress,
      tokenInfo,
      source,
      amountIn,
      typeof input.cacheTtlMs === 'number' ? Math.max(0, input.cacheTtlMs) : 0,
    );
  } catch {
    return 0;
  }
}
