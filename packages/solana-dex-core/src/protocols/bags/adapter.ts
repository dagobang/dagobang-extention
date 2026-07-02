import BN from 'bn.js';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  deriveDammV2PoolAddress,
  getCurrentPoint,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  isSolanaNativeMint,
  normalizeSolanaPlatform,
  SOLANA_NATIVE_MINT,
} from '../../constants';
import type {
  SolanaBuiltTransaction,
  SolanaTradeRequest,
  SolanaTradeAdapter,
} from '../../types';
import { toVersionedTransaction } from '../../utils';
import { meteoraDammV2TradeAdapter, prewarmMeteoraTrade } from '../meteora';
import {
  getFreshWarmPromise,
  refreshWarmPromise,
  rememberWarmPromise,
  SOLANA_WARM_CACHE_TTL_MS,
  type WarmCacheEntry,
} from '../../prewarm';

type BagsDbcContext = {
  poolAddress: PublicKey;
  poolAccountState: any;
  poolState: any;
  poolConfig: any;
};

type CachedBlockhashValue = {
  blockhash: string;
};

type BagsCurrentPointCacheValue = any;

function reportBagsSellDebug(_location: string, _msg: string, _data: Record<string, unknown>): void {
}


function resolveBagsVirtualPoolState(ctx: BagsDbcContext): any {
  return ctx.poolAccountState?.virtualPool ?? ctx.poolState?.virtualPool ?? ctx.poolState;
}

function resolveBagsBaseMint(ctx: BagsDbcContext): PublicKey | null {
  return resolveBagsVirtualPoolState(ctx)?.baseMint ?? ctx.poolState?.baseMint ?? null;
}

function resolveBagsQuoteReserve(ctx: BagsDbcContext): any {
  return resolveBagsVirtualPoolState(ctx)?.quoteReserve ?? ctx.poolState?.quoteReserve ?? null;
}

function resolveExecutionMode(input: SolanaTradeRequest): 'default' | 'turbo' {
  return (input.rawInput as any)?.executionModeOverride === 'turbo' ? 'turbo' : 'default';
}

const BAGS_CONTEXT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.mediumContext;
const BAGS_CURRENT_POINT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.dynamicQuote;
const BAGS_BLOCKHASH_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.blockhash;

const bagsContextCache = new Map<string, WarmCacheEntry<BagsDbcContext>>();
const bagsCurrentPointCache = new Map<string, WarmCacheEntry<BagsCurrentPointCacheValue>>();
const bagsLatestBlockhashCache = new Map<string, WarmCacheEntry<CachedBlockhashValue>>();

function resolveBagsMigratedPoolAddress(ctx: BagsDbcContext): PublicKey | null {
  const migrationOption = Number(ctx.poolConfig?.migrationOption ?? -1);
  if (migrationOption !== 1) {
    return null;
  }

  const migrationFeeOption = Number(ctx.poolConfig?.migrationFeeOption ?? -1);
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!dammConfig) {
    return null;
  }

  return deriveDammV2PoolAddress(
    dammConfig,
    resolveBagsBaseMint(ctx) ?? ctx.poolState.baseMint,
    ctx.poolConfig.quoteMint,
  );
}

function toBagsMigratedInput(input: SolanaTradeRequest, ctx?: BagsDbcContext): SolanaTradeRequest {
  const derivedMigratedPool = ctx ? resolveBagsMigratedPoolAddress(ctx) : null;
  return {
    ...input,
    tokenInfo: {
      ...input.tokenInfo,
      launchpad_platform: 'meteora',
      dex_type: input.tokenInfo?.dex_type || 'damm_v2',
      pool_pair: input.tokenInfo?.pool_pair || derivedMigratedPool?.toBase58(),
    },
  };
}

async function supportsMigratedBagsTrade(input: SolanaTradeRequest): Promise<boolean> {
  if (input.tokenInfo?.pool_pair) {
    return meteoraDammV2TradeAdapter.supportsTrade(toBagsMigratedInput(input));
  }

  try {
    const startedAt = Date.now();
    const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
    reportBagsSellDebug('bags.adapter.ts:supportsMigrated:start', '[DEBUG] bags supportsMigrated start', {
      side: input.side,
      tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
      baseMint: baseMint.toBase58(),
    });
    const ctx = await loadBagsDbcPoolContext(input);
    const poolState = ctx.poolState;
    if (!poolState?.isMigrated) return false;

    reportBagsSellDebug('bags.adapter.ts:supportsMigrated:done', '[DEBUG] bags supportsMigrated done', {
      side: input.side,
      tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
      elapsedMs: Date.now() - startedAt,
      isMigrated: !!poolState?.isMigrated,
    });

    return meteoraDammV2TradeAdapter.supportsTrade(toBagsMigratedInput(input, ctx));
  } catch {
    return false;
  }
}

async function buildMigratedBagsTrade(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
  let migratedInput = toBagsMigratedInput(input);
  if (!migratedInput.tokenInfo?.pool_pair) {
    const ctx = await loadBagsDbcPoolContext(input);
    const poolState = ctx.poolState;
    if (!poolState?.isMigrated) {
      throw new Error('Bags token has not migrated');
    }
    migratedInput = toBagsMigratedInput(input, ctx);
  }

  const built = await meteoraDammV2TradeAdapter.build(migratedInput);
  return {
    ...built,
    source: 'bags',
  };
}


function resolvePlatform(input: SolanaTradeRequest): string {
  return normalizeSolanaPlatform(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad);
}

async function loadBagsDbcContext(input: SolanaTradeRequest): Promise<BagsDbcContext> {
  const ctx = await loadBagsDbcPoolContext(input);
  if (ctx.poolState?.isMigrated) throw new Error('Bags pool has already migrated');
  return ctx;
}

async function getBagsDbcContextForBuild(input: SolanaTradeRequest): Promise<BagsDbcContext> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadBagsDbcContext(input);
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const cached = getFreshWarmPromise<BagsDbcContext>(bagsContextCache, baseMint.toBase58());
  if (!cached) throw new Error('Bags pool context not ready');
  const ctx = await cached;
  if (ctx.poolState?.isMigrated) throw new Error('Bags pool has already migrated');
  return ctx;
}

async function loadBagsDbcPoolContext(input: SolanaTradeRequest, opts?: { forceRefresh?: boolean }): Promise<BagsDbcContext> {
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const loader = async () => {
    const startedAt = Date.now();
    reportBagsSellDebug('bags.adapter.ts:loadContext:start', '[DEBUG] bags load context start', {
      side: input.side,
      tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
      baseMint: baseMint.toBase58(),
    });
    const connection = await input.runtime.getConnection();
    const client = DynamicBondingCurveClient.create(connection, 'confirmed');
    const poolAccount = await client.state.getPoolByBaseMint(baseMint);
    if (!poolAccount) throw new Error('Bags DBC pool not found');

    const poolState = poolAccount.account.poolState ?? poolAccount.account;
    if (!poolState) throw new Error('Bags DBC pool state unavailable');

    const poolConfig = await client.state.getPoolConfig(poolState.config);
    if (!poolConfig) throw new Error('Bags DBC pool config not found');

    reportBagsSellDebug('bags.adapter.ts:loadContext:done', '[DEBUG] bags load context done', {
      side: input.side,
      tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
      baseMint: baseMint.toBase58(),
      elapsedMs: Date.now() - startedAt,
      poolAddress: poolAccount.publicKey.toBase58(),
      isMigrated: !!poolState?.isMigrated,
    });

    return {
      poolAddress: poolAccount.publicKey,
      poolAccountState: poolAccount.account,
      poolState,
      poolConfig,
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(bagsContextCache, baseMint.toBase58(), BAGS_CONTEXT_CACHE_TTL_MS, loader)
    : rememberWarmPromise(bagsContextCache, baseMint.toBase58(), BAGS_CONTEXT_CACHE_TTL_MS, loader));
}

async function loadBagsCurrentPoint(input: SolanaTradeRequest, ctx: BagsDbcContext, opts?: { forceRefresh?: boolean }): Promise<BagsCurrentPointCacheValue> {
  const connection = await input.runtime.getConnection();
  const cacheKey = String(ctx.poolConfig?.activationType ?? '');
  const cached = opts?.forceRefresh ? null : getFreshWarmPromise<BagsCurrentPointCacheValue>(bagsCurrentPointCache, cacheKey);
  if (cached) return await cached;
  const loader = async () => {
    const startedAt = Date.now();
    const currentPoint = await getCurrentPoint(connection, ctx.poolConfig.activationType);
    reportBagsSellDebug('bags.adapter.ts:currentPoint:done', '[DEBUG] bags currentPoint loaded', {
      side: input.side,
      tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
      elapsedMs: Date.now() - startedAt,
    });
    return currentPoint;
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(bagsCurrentPointCache, cacheKey, BAGS_CURRENT_POINT_CACHE_TTL_MS, loader)
    : rememberWarmPromise(bagsCurrentPointCache, cacheKey, BAGS_CURRENT_POINT_CACHE_TTL_MS, loader));
}

async function getBagsCurrentPointForBuild(input: SolanaTradeRequest, ctx: BagsDbcContext): Promise<BagsCurrentPointCacheValue> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadBagsCurrentPoint(input, ctx);
  const cacheKey = String(ctx.poolConfig?.activationType ?? '');
  const cached = getFreshWarmPromise<BagsCurrentPointCacheValue>(bagsCurrentPointCache, cacheKey);
  if (!cached) throw new Error('Bags current point not ready');
  return await cached;
}

async function loadLatestBlockhash(input: SolanaTradeRequest, allowCached = false, forceRefresh = false): Promise<CachedBlockhashValue> {
  const connection = await input.runtime.getConnection();
  const cacheKey = 'confirmed';
  if (allowCached && !forceRefresh) {
    const cached = getFreshWarmPromise<CachedBlockhashValue>(bagsLatestBlockhashCache, cacheKey);
    if (cached) return await cached;
  }
  const loader = async () => {
    const latest = await connection.getLatestBlockhash('confirmed');
    return { blockhash: latest.blockhash };
  };
  return await (forceRefresh
    ? refreshWarmPromise(bagsLatestBlockhashCache, cacheKey, BAGS_BLOCKHASH_CACHE_TTL_MS, loader)
    : rememberWarmPromise(bagsLatestBlockhashCache, cacheKey, BAGS_BLOCKHASH_CACHE_TTL_MS, loader));
}

function validatePoolPair(input: SolanaTradeRequest, ctx: BagsDbcContext): boolean {
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const baseMint = resolveBagsBaseMint(ctx);
  if (!baseMint) return false;
  return (
    inputMint.equals(ctx.poolConfig.quoteMint) && outputMint.equals(baseMint)
  ) || (
    inputMint.equals(baseMint) && outputMint.equals(ctx.poolConfig.quoteMint)
  );
}

function isEligibleForFirstSwapWithMinFee(ctx: BagsDbcContext): boolean {
  const quoteReserve = resolveBagsQuoteReserve(ctx);
  return Boolean(ctx.poolConfig.enableFirstSwapWithMinFee)
    && typeof quoteReserve?.isZero === 'function'
    && quoteReserve.isZero();
}

async function buildSwapTransaction(
  input: SolanaTradeRequest,
  ctx: BagsDbcContext,
): Promise<{
  transaction: Transaction;
  protectionMinOutWei: string;
  quotedOutWei?: string | null;
}> {
  const startedAt = Date.now();
  const connection = await input.runtime.getConnection();
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  const owner = new PublicKey(input.ownerAddress);
  reportBagsSellDebug('bags.adapter.ts:buildSwap:start', '[DEBUG] bags build swap start', {
    side: input.side,
    ownerAddress: input.ownerAddress,
    tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
    amount: input.amount,
  });
  const currentPointStartedAt = Date.now();
  const currentPoint = await getBagsCurrentPointForBuild(input, ctx);
  reportBagsSellDebug('bags.adapter.ts:buildSwap:currentPointDone', '[DEBUG] bags build swap currentPoint done', {
    side: input.side,
    tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
    elapsedMs: Date.now() - currentPointStartedAt,
  });
  const virtualPool = resolveBagsVirtualPoolState(ctx);
  const baseMint = resolveBagsBaseMint(ctx);
  if (!virtualPool || !baseMint) {
    throw new Error('Bags virtual pool state unavailable');
  }
  const swapBaseForQuote = new PublicKey(input.inputMint).equals(baseMint);
  const amountIn = new BN(input.amount);
  const swapQuoteStartedAt = Date.now();
  const quote = client.pool.swapQuote({
    virtualPool,
    config: ctx.poolConfig,
    swapBaseForQuote,
    amountIn,
    slippageBps: input.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: isEligibleForFirstSwapWithMinFee(ctx),
    currentPoint,
  });
  reportBagsSellDebug('bags.adapter.ts:buildSwap:quoteDone', '[DEBUG] bags build swap quote done', {
    side: input.side,
    tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
    elapsedMs: Date.now() - swapQuoteStartedAt,
    minimumAmountOut: quote.minimumAmountOut.toString(),
  });

  const swapStartedAt = Date.now();
  const transaction = await client.pool.swap({
    owner,
    pool: ctx.poolAddress,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote,
    referralTokenAccount: null,
    payer: owner,
  });
  reportBagsSellDebug('bags.adapter.ts:buildSwap:swapDone', '[DEBUG] bags build swap tx done', {
    side: input.side,
    tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
    elapsedMs: Date.now() - swapStartedAt,
    totalElapsedMs: Date.now() - startedAt,
  });

  return {
    transaction,
    protectionMinOutWei: quote.minimumAmountOut.toString(),
    quotedOutWei: null,
  };
}

export const bagsTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'bags',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['bags'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    if (platform && platform !== 'bags') return false;
    return isSolanaNativeMint(input.inputMint) || isSolanaNativeMint(input.outputMint);
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    try {
      reportBagsSellDebug('bags.adapter.ts:build:start', '[DEBUG] bags adapter build start', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
        amount: input.amount,
      });
      const ctx = await getBagsDbcContextForBuild(input);
      if (!validatePoolPair(input, ctx)) {
        throw new Error('Bags adapter cannot handle this trade pair');
      }

      const { transaction: legacyTransaction, protectionMinOutWei, quotedOutWei } = await buildSwapTransaction(input, ctx);
      if (!legacyTransaction.feePayer) {
        legacyTransaction.feePayer = new PublicKey(input.ownerAddress);
      }
      if (!legacyTransaction.recentBlockhash) {
        const blockhashStartedAt = Date.now();
        const latest = await loadLatestBlockhash(input, true);
        legacyTransaction.recentBlockhash = latest.blockhash;
        reportBagsSellDebug('bags.adapter.ts:build:blockhashDone', '[DEBUG] bags adapter blockhash done', {
          side: input.side,
          tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
          elapsedMs: Date.now() - blockhashStartedAt,
        });
      }

      const transaction = toVersionedTransaction(legacyTransaction);
      reportBagsSellDebug('bags.adapter.ts:build:done', '[DEBUG] bags adapter build done', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
        protectionMinOutWei,
        quotedOutWei,
      });
      return {
        source: 'bags',
        transaction,
        protectionMinOutWei,
        quotedOutWei,
        blockhash: legacyTransaction.recentBlockhash,
      };
    } catch (error) {
      reportBagsSellDebug('bags.adapter.ts:build:catch', '[DEBUG] bags adapter build catch', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        tokenAddress: input.side === 'buy' ? input.outputMint : input.inputMint,
        errorMessage: String((error as any)?.message || error || ''),
      });
      if (resolveExecutionMode(input) !== 'turbo' && await supportsMigratedBagsTrade(input)) {
        return await buildMigratedBagsTrade(input);
      }
      throw error;
    }
  },
};

export async function prewarmBagsTrade(input: {
  tokenAddress: string;
  ownerAddress?: string;
  executionMode?: 'default' | 'turbo';
  tokenInfo?: SolanaTradeRequest['tokenInfo'];
  runtime: SolanaTradeRequest['runtime'];
}): Promise<void> {
  const tokenAddress = String(input.tokenAddress || '').trim();
  if (!tokenAddress) return;
  const request: SolanaTradeRequest = {
    side: 'buy',
    chainId: 501,
    ownerAddress: String(input.ownerAddress || '').trim() || PublicKey.default.toBase58(),
    inputMint: SOLANA_NATIVE_MINT,
    outputMint: tokenAddress,
    amount: '1',
    slippageBps: 100,
    tokenInfo: input.tokenInfo,
    rawInput: { executionModeOverride: input.executionMode === 'turbo' ? 'turbo' : 'default' } as any,
    runtime: input.runtime,
  };
  try {
    const ctx = await loadBagsDbcPoolContext(request, { forceRefresh: true });
    if (ctx.poolState?.isMigrated) {
      await prewarmMeteoraTrade({
        ...input,
        tokenInfo: toBagsMigratedInput(request, ctx).tokenInfo,
      });
      return;
    }
    await Promise.all([
      loadBagsCurrentPoint(request, ctx, { forceRefresh: true }),
      loadLatestBlockhash(request, true, true),
    ]);
  } catch {
    await prewarmMeteoraTrade({
      ...input,
      tokenInfo: toBagsMigratedInput(request).tokenInfo,
    });
  }
}
