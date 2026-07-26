import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { isSolanaNativeMint, normalizeSolanaPlatform, SOLANA_NATIVE_MINT } from '../../../constants';
import type { SolanaBuiltTransaction, SolanaTradeAdapter, SolanaTradeRequest } from '../../../types';
import {
  buildCloseTokenAccountInstruction,
  buildWrapNativeInstructions,
  createAtaIdempotentInstruction,
  findAta,
  getMintProgramId,
} from '../../../utils';
import { buildMeteoraDammV2SwapInstructionData, parseMeteoraDammV2PoolInfo } from './codec';
import {
  METEORA_DAMM_V2_POOL_AUTHORITY,
  METEORA_DAMM_V2_PROGRAM_ID,
} from './constants';
import { deriveMeteoraDammV2EventAuthorityPda, deriveMeteoraDammV2PoolAuthorityPda } from './pda';
import {
  calculateMeteoraDammV2MinimumAmountOut,
  resolveMeteoraDammV2TradeDirection,
  validateMeteoraDammV2Pool,
} from './quote';
import type { MeteoraDammV2PoolInfo } from './types';
import {
  getFreshWarmPromise,
  refreshWarmPromise,
  rememberWarmPromise,
  SOLANA_WARM_CACHE_TTL_MS,
  type WarmCacheEntry,
} from '../../../prewarm';

type CachedBlockhashValue = {
  blockhash: string;
};

type MeteoraDammV2StaticPoolInfo = Omit<
  MeteoraDammV2PoolInfo,
  'liquidity' | 'sqrtPrice' | 'sqrtMinPrice' | 'sqrtMaxPrice'
>;
type MeteoraDammV2QuoteSnapshot = Pick<
  MeteoraDammV2PoolInfo,
  'liquidity' | 'sqrtPrice' | 'sqrtMinPrice' | 'sqrtMaxPrice'
>;
type MeteoraDammV2StaticPoolContext = {
  poolInfo: MeteoraDammV2StaticPoolInfo;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
};

const POOL_CONTEXT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const POOL_QUOTE_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.dynamicQuote;
const BLOCKHASH_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.blockhash;

const poolContextCache = new Map<string, WarmCacheEntry<MeteoraDammV2StaticPoolContext>>();
const poolQuoteCache = new Map<string, WarmCacheEntry<MeteoraDammV2QuoteSnapshot>>();
const latestBlockhashCache = new Map<string, WarmCacheEntry<CachedBlockhashValue>>();

function resolvePlatform(input: SolanaTradeRequest): string {
  return normalizeSolanaPlatform(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad);
}

function normalizeDexType(input: SolanaTradeRequest): string {
  return String(input.tokenInfo?.dex_type || '').trim().toLowerCase();
}

function resolveExecutionMode(input: SolanaTradeRequest): 'default' | 'turbo' {
  return (input.rawInput as any)?.executionModeOverride === 'turbo' ? 'turbo' : 'default';
}

function resolvePoolAddress(input: SolanaTradeRequest): PublicKey {
  const poolPair = String(input.tokenInfo?.pool_pair || '').trim();
  if (!poolPair) throw new Error('Meteora DAMM v2 trade requires tokenInfo.pool_pair');
  return new PublicKey(poolPair);
}

function toMeteoraDammV2StaticPoolInfo(poolInfo: MeteoraDammV2PoolInfo): MeteoraDammV2StaticPoolInfo {
  const {
    liquidity: _liquidity,
    sqrtPrice: _sqrtPrice,
    sqrtMinPrice: _sqrtMinPrice,
    sqrtMaxPrice: _sqrtMaxPrice,
    ...staticInfo
  } = poolInfo;
  return staticInfo;
}

function toMeteoraDammV2QuoteSnapshot(poolInfo: MeteoraDammV2PoolInfo): MeteoraDammV2QuoteSnapshot {
  return {
    liquidity: poolInfo.liquidity,
    sqrtPrice: poolInfo.sqrtPrice,
    sqrtMinPrice: poolInfo.sqrtMinPrice,
    sqrtMaxPrice: poolInfo.sqrtMaxPrice,
  };
}

function mergeMeteoraDammV2PoolInfo(
  staticInfo: MeteoraDammV2StaticPoolInfo,
  quoteSnapshot: MeteoraDammV2QuoteSnapshot,
): MeteoraDammV2PoolInfo {
  return {
    ...staticInfo,
    ...quoteSnapshot,
  };
}

async function loadPoolContext(
  input: SolanaTradeRequest,
  opts?: { forceRefresh?: boolean },
): Promise<MeteoraDammV2StaticPoolContext> {
  const poolAddress = resolvePoolAddress(input);
  const cacheKey = poolAddress.toBase58();
  const loader = async () => {
    const poolAccountInfo = input.runtime.getAccountInfo
      ? await input.runtime.getAccountInfo(poolAddress, 'confirmed', 'static')
      : await (async () => {
        const connection = await input.runtime.getConnection();
        return await connection.getAccountInfo(poolAddress, 'confirmed');
      })();
    if (!poolAccountInfo?.data) throw new Error('Meteora DAMM v2 pool account not found');
    if (!poolAccountInfo.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Meteora DAMM v2 pool');
    }

    const poolInfo = parseMeteoraDammV2PoolInfo(poolAccountInfo.data, poolAddress);
    poolQuoteCache.set(cacheKey, {
      promise: Promise.resolve(toMeteoraDammV2QuoteSnapshot(poolInfo)),
      expiresAt: Date.now() + POOL_QUOTE_CACHE_TTL_MS,
    });
    validateMeteoraDammV2Pool(poolInfo);
    const [tokenAProgram, tokenBProgram] = await Promise.all([
      getMintProgramId(input.runtime, poolInfo.tokenAMint),
      getMintProgramId(input.runtime, poolInfo.tokenBMint),
    ]);

    return {
      poolInfo: toMeteoraDammV2StaticPoolInfo(poolInfo),
      tokenAProgram,
      tokenBProgram,
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(poolContextCache, cacheKey, POOL_CONTEXT_CACHE_TTL_MS, loader)
    : rememberWarmPromise(poolContextCache, cacheKey, POOL_CONTEXT_CACHE_TTL_MS, loader));
}

async function getPoolContextForBuild(input: SolanaTradeRequest): Promise<MeteoraDammV2StaticPoolContext> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadPoolContext(input);
  const cached = getFreshWarmPromise<MeteoraDammV2StaticPoolContext>(poolContextCache, resolvePoolAddress(input).toBase58());
  if (!cached) return await loadPoolContext(input);
  return await cached;
}

async function loadPoolQuoteSnapshot(
  input: SolanaTradeRequest,
  opts?: { forceRefresh?: boolean },
): Promise<MeteoraDammV2QuoteSnapshot> {
  const poolAddress = resolvePoolAddress(input);
  const cacheKey = poolAddress.toBase58();
  const loader = async () => {
    const poolAccountInfo = input.runtime.getAccountInfo
      ? await input.runtime.getAccountInfo(poolAddress, 'confirmed', 'dynamic')
      : await (async () => {
        const connection = await input.runtime.getConnection();
        return await connection.getAccountInfo(poolAddress, 'confirmed');
      })();
    if (!poolAccountInfo?.data) throw new Error('Meteora DAMM v2 pool account not found');
    return toMeteoraDammV2QuoteSnapshot(parseMeteoraDammV2PoolInfo(poolAccountInfo.data, poolAddress));
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(poolQuoteCache, cacheKey, POOL_QUOTE_CACHE_TTL_MS, loader)
    : rememberWarmPromise(poolQuoteCache, cacheKey, POOL_QUOTE_CACHE_TTL_MS, loader));
}

async function loadLatestBlockhash(input: SolanaTradeRequest, allowCached: boolean): Promise<CachedBlockhashValue> {
  const key = 'confirmed';
  if (allowCached) {
    const cached = getFreshWarmPromise<CachedBlockhashValue>(latestBlockhashCache, key);
    if (cached) return await cached;
  }
  const loader = async () => {
    const latest = input.runtime.getLatestBlockhash
      ? await input.runtime.getLatestBlockhash('confirmed')
      : await (async () => {
        const connection = await input.runtime.getConnection();
        return await connection.getLatestBlockhash('confirmed');
      })();
    const { blockhash } = latest;
    return { blockhash };
  };
  return await (allowCached
    ? rememberWarmPromise(latestBlockhashCache, key, BLOCKHASH_CACHE_TTL_MS, loader)
    : refreshWarmPromise(latestBlockhashCache, key, BLOCKHASH_CACHE_TTL_MS, loader));
}

async function buildTransaction(input: SolanaTradeRequest): Promise<{
  transaction: VersionedTransaction;
  protectionMinOutWei: string;
  quotedOutWei?: string | null;
  recentBlockhash: string;
}> {
  const executionMode = resolveExecutionMode(input);
  const user = new PublicKey(input.ownerAddress);
  const { poolInfo, tokenAProgram, tokenBProgram } = await getPoolContextForBuild(input);
  const direction = resolveMeteoraDammV2TradeDirection(poolInfo, input.inputMint, input.outputMint);
  const amountIn = BigInt(input.amount);
  let minimumAmountOut = 1n;
  let protectionMinOutWei = '1';
  if (executionMode !== 'turbo') {
    const quoteSnapshot = await loadPoolQuoteSnapshot(input);
    const quotedPoolInfo = mergeMeteoraDammV2PoolInfo(poolInfo, quoteSnapshot);
    minimumAmountOut = calculateMeteoraDammV2MinimumAmountOut(amountIn, quotedPoolInfo, direction, input.slippageBps);
    protectionMinOutWei = minimumAmountOut.toString();
  }

  const inputMint = direction === 'a_to_b' ? poolInfo.tokenAMint : poolInfo.tokenBMint;
  const outputMint = direction === 'a_to_b' ? poolInfo.tokenBMint : poolInfo.tokenAMint;
  const inputTokenProgram = direction === 'a_to_b' ? tokenAProgram : tokenBProgram;
  const outputTokenProgram = direction === 'a_to_b' ? tokenBProgram : tokenAProgram;
  const inputTokenAccount = findAta({ mint: inputMint, owner: user, tokenProgramId: inputTokenProgram });
  const outputTokenAccount = findAta({ mint: outputMint, owner: user, tokenProgramId: outputTokenProgram });

  const inputIsNative = isSolanaNativeMint(input.inputMint);
  const outputIsNative = isSolanaNativeMint(input.outputMint);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: inputMint,
    associatedToken: inputTokenAccount,
    tokenProgramId: inputTokenProgram,
  }));

  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: outputMint,
    associatedToken: outputTokenAccount,
    tokenProgramId: outputTokenProgram,
  }));

  if (inputIsNative) {
    preInstructions.push(...buildWrapNativeInstructions({
      payer: user,
      nativeAta: inputTokenAccount,
      lamports: amountIn,
      tokenProgramId: inputTokenProgram,
    }));
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: inputTokenAccount,
      destination: user,
      owner: user,
      tokenProgramId: inputTokenProgram,
    }));
  }

  if (outputIsNative) {
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: outputTokenAccount,
      destination: user,
      owner: user,
      tokenProgramId: outputTokenProgram,
    }));
  }

  const poolAuthority = deriveMeteoraDammV2PoolAuthorityPda();
  const eventAuthority = deriveMeteoraDammV2EventAuthorityPda();
  if (!poolAuthority.equals(METEORA_DAMM_V2_POOL_AUTHORITY)) {
    throw new Error('Meteora DAMM v2 pool authority PDA mismatch');
  }

  const swapInstruction = new TransactionInstruction({
    programId: METEORA_DAMM_V2_PROGRAM_ID,
    keys: [
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: poolInfo.poolAddress, isSigner: false, isWritable: true },
      { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolInfo.tokenAVault, isSigner: false, isWritable: true },
      { pubkey: poolInfo.tokenBVault, isSigner: false, isWritable: true },
      { pubkey: poolInfo.tokenAMint, isSigner: false, isWritable: false },
      { pubkey: poolInfo.tokenBMint, isSigner: false, isWritable: false },
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: tokenAProgram, isSigner: false, isWritable: false },
      { pubkey: tokenBProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: METEORA_DAMM_V2_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: buildMeteoraDammV2SwapInstructionData(amountIn, minimumAmountOut),
  });

  const { blockhash } = await loadLatestBlockhash(input, true);
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [...preInstructions, swapInstruction, ...postInstructions],
  }).compileToV0Message();

  return {
    transaction: new VersionedTransaction(message),
    protectionMinOutWei,
    quotedOutWei: null,
    recentBlockhash: blockhash,
  };
}

export async function prewarmMeteoraDammV2Trade(input: {
  tokenAddress: string;
  ownerAddress?: string;
  executionMode?: 'default' | 'turbo';
  tokenInfo?: SolanaTradeRequest['tokenInfo'];
  runtime: SolanaTradeRequest['runtime'];
}): Promise<void> {
  const tokenAddress = String(input.tokenAddress || '').trim();
  const poolPair = String(input.tokenInfo?.pool_pair || '').trim();
  if (!tokenAddress || !poolPair) return;
  const ownerAddress = String(input.ownerAddress || '').trim();
  const request: SolanaTradeRequest = {
    side: 'buy',
    chainId: 501,
    ownerAddress: ownerAddress || PublicKey.default.toBase58(),
    inputMint: SOLANA_NATIVE_MINT,
    outputMint: tokenAddress,
    amount: '1',
    slippageBps: 100,
    tokenInfo: input.tokenInfo,
    rawInput: { executionModeOverride: input.executionMode === 'turbo' ? 'turbo' : 'default' } as any,
    runtime: input.runtime,
  };
  await loadPoolContext(request, { forceRefresh: true });
  if (input.executionMode !== 'turbo') {
    await loadPoolQuoteSnapshot(request, { forceRefresh: true });
  }
}

export const meteoraDammV2TradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'meteora',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['meteora', 'damm', 'damm_v2'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    const dexType = normalizeDexType(input);
    const hinted = ['meteora', 'damm', 'damm_v2'].includes(platform)
      || dexType.includes('meteora')
      || dexType.includes('damm');
    if (!hinted) return false;
    return !!input.tokenInfo?.pool_pair;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Meteora DAMM v2 adapter cannot handle this trade');
    }
    const { transaction, protectionMinOutWei, quotedOutWei, recentBlockhash } = await buildTransaction(input);
    return {
      source: 'meteora',
      transaction,
      protectionMinOutWei,
      quotedOutWei,
      blockhash: recentBlockhash,
    };
  },
};
