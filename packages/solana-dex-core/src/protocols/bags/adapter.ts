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

type BagsDbcContext = {
  poolAddress: PublicKey;
  poolState: any;
  poolConfig: any;
};

type TimedPromiseCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

const BAGS_CONTEXT_CACHE_TTL_MS = 10_000;

const bagsContextCache = new Map<string, TimedPromiseCacheEntry<BagsDbcContext>>();

function rememberTimedPromise<T>(
  cache: Map<string, TimedPromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  factory: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

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
    ctx.poolState.baseMint,
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
    const connection = await input.runtime.getConnection();
    const client = DynamicBondingCurveClient.create(connection, 'confirmed');
    const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
    const poolAccount = await client.state.getPoolByBaseMint(baseMint);
    if (!poolAccount) return false;

    const poolState = poolAccount.account.poolState ?? poolAccount.account;
    if (!poolState?.isMigrated) return false;

    const poolConfig = await client.state.getPoolConfig(poolState.config);
    if (!poolConfig) return false;

    return meteoraDammV2TradeAdapter.supportsTrade(toBagsMigratedInput(input, {
      poolAddress: poolAccount.publicKey,
      poolState,
      poolConfig,
    }));
  } catch {
    return false;
  }
}

async function buildMigratedBagsTrade(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
  let migratedInput = toBagsMigratedInput(input);
  if (!migratedInput.tokenInfo?.pool_pair) {
    const connection = await input.runtime.getConnection();
    const client = DynamicBondingCurveClient.create(connection, 'confirmed');
    const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
    const poolAccount = await client.state.getPoolByBaseMint(baseMint);
    if (!poolAccount) {
      throw new Error('Bags migrated DBC pool not found');
    }

    const poolState = poolAccount.account.poolState ?? poolAccount.account;
    if (!poolState?.isMigrated) {
      throw new Error('Bags token has not migrated');
    }

    const poolConfig = await client.state.getPoolConfig(poolState.config);
    if (!poolConfig) {
      throw new Error('Bags migrated DBC pool config not found');
    }

    migratedInput = toBagsMigratedInput(input, {
      poolAddress: poolAccount.publicKey,
      poolState,
      poolConfig,
    });
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
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  return await rememberTimedPromise(bagsContextCache, baseMint.toBase58(), BAGS_CONTEXT_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    const client = DynamicBondingCurveClient.create(connection, 'confirmed');
    const poolAccount = await client.state.getPoolByBaseMint(baseMint);
    if (!poolAccount) throw new Error('Bags DBC pool not found');

    const poolState = poolAccount.account.poolState ?? poolAccount.account;
    if (!poolState) throw new Error('Bags DBC pool state unavailable');
    if (poolState.isMigrated) throw new Error('Bags pool has already migrated');

    const poolConfig = await client.state.getPoolConfig(poolState.config);
    if (!poolConfig) throw new Error('Bags DBC pool config not found');

    return {
      poolAddress: poolAccount.publicKey,
      poolState,
      poolConfig,
    };
  });
}

function validatePoolPair(input: SolanaTradeRequest, ctx: BagsDbcContext): boolean {
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  return (
    inputMint.equals(ctx.poolConfig.quoteMint) && outputMint.equals(ctx.poolState.baseMint)
  ) || (
    inputMint.equals(ctx.poolState.baseMint) && outputMint.equals(ctx.poolConfig.quoteMint)
  );
}

function isEligibleForFirstSwapWithMinFee(ctx: BagsDbcContext): boolean {
  return Boolean(ctx.poolConfig.enableFirstSwapWithMinFee) && ctx.poolState.quoteReserve.isZero();
}

async function buildSwapTransaction(
  input: SolanaTradeRequest,
  ctx: BagsDbcContext,
): Promise<{
  transaction: Transaction;
  tokenMinOutWei: string;
}> {
  const connection = await input.runtime.getConnection();
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  const owner = new PublicKey(input.ownerAddress);
  const currentPoint = await getCurrentPoint(connection, ctx.poolConfig.activationType);
  const swapBaseForQuote = new PublicKey(input.inputMint).equals(ctx.poolState.baseMint);
  const amountIn = new BN(input.amount);
  const quote = client.pool.swapQuote({
    virtualPool: ctx.poolState,
    config: ctx.poolConfig,
    swapBaseForQuote,
    amountIn,
    slippageBps: input.slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: isEligibleForFirstSwapWithMinFee(ctx),
    currentPoint,
  });

  const transaction = await client.pool.swap({
    owner,
    pool: ctx.poolAddress,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    swapBaseForQuote,
    referralTokenAccount: null,
    payer: owner,
  });

  return {
    transaction,
    tokenMinOutWei: quote.minimumAmountOut.toString(),
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
    if (!(isSolanaNativeMint(input.inputMint) || isSolanaNativeMint(input.outputMint))) {
      return false;
    }

    try {
      const ctx = await loadBagsDbcContext(input);
      return validatePoolPair(input, ctx);
    } catch {
      return await supportsMigratedBagsTrade(input);
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    try {
      const ctx = await loadBagsDbcContext(input);
      if (!validatePoolPair(input, ctx)) {
        throw new Error('Bags adapter cannot handle this trade pair');
      }

      const { transaction: legacyTransaction, tokenMinOutWei } = await buildSwapTransaction(input, ctx);
      if (!legacyTransaction.feePayer) {
        legacyTransaction.feePayer = new PublicKey(input.ownerAddress);
      }
      if (!legacyTransaction.recentBlockhash) {
        const latest = await (await input.runtime.getConnection()).getLatestBlockhash('confirmed');
        legacyTransaction.recentBlockhash = latest.blockhash;
      }

      const transaction = toVersionedTransaction(legacyTransaction);
      return {
        source: 'bags',
        transaction,
        tokenMinOutWei,
        blockhash: legacyTransaction.recentBlockhash,
      };
    } catch (error) {
      if (await supportsMigratedBagsTrade(input)) {
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
    const ctx = await loadBagsDbcContext(request);
    if (ctx.poolState?.isMigrated) {
      await prewarmMeteoraTrade({
        ...input,
        tokenInfo: toBagsMigratedInput(request, ctx).tokenInfo,
      });
      return;
    }
  } catch {
    await prewarmMeteoraTrade({
      ...input,
      tokenInfo: toBagsMigratedInput(request).tokenInfo,
    });
  }
}
