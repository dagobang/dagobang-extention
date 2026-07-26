import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { isSolanaNativeMint, normalizeSolanaPlatform, SOLANA_NATIVE_MINT } from '../../constants';
import type { SolanaBuiltTransaction, SolanaTradeAdapter, SolanaTradeRequest } from '../../types';
import {
  buildCloseTokenAccountInstruction,
  buildWrapNativeInstructions,
  concatBytes,
  createAtaIdempotentInstruction,
  encodeU64LE,
  findAta,
  getMintProgramId,
} from '../../utils';
import { parseBonkPoolState, type BonkPoolState } from './codec';
import {
  BONK_AUTHORITY,
  BONK_BUY_EXACT_IN_DISCRIMINATOR,
  BONK_EVENT_AUTHORITY,
  BONK_PROGRAM_ID,
  BONK_SELL_EXACT_IN_DISCRIMINATOR,
  deriveBonkPoolPda,
} from './constants';
import { computeBonkBuyMinimumAmountOut, computeBonkSellMinimumAmountOut } from './quote';
import {
  getFreshWarmPromise,
  refreshWarmPromise,
  rememberWarmPromise,
  SOLANA_WARM_CACHE_TTL_MS,
  type WarmCacheEntry,
} from '../../prewarm';

type BonkPoolContext = {
  poolState: BonkStaticPoolState;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
};

type BonkStaticPoolState = Omit<BonkPoolState, 'virtualBase' | 'virtualQuote' | 'realBase' | 'realQuote'>;
type BonkPoolReserveSnapshot = Pick<BonkPoolState, 'virtualBase' | 'virtualQuote' | 'realBase' | 'realQuote'>;

type CachedBlockhashValue = {
  blockhash: string;
};

const POOL_CONTEXT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const POOL_RESERVE_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.dynamicQuote;
const BLOCKHASH_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.blockhash;

const poolContextCache = new Map<string, WarmCacheEntry<BonkPoolContext>>();
const poolReserveCache = new Map<string, WarmCacheEntry<BonkPoolReserveSnapshot>>();
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
  const hintedPool = String(input.tokenInfo?.pool_pair || '').trim();
  if (hintedPool) return new PublicKey(hintedPool);
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const quoteMint = new PublicKey(input.side === 'buy' ? input.inputMint : input.outputMint);
  return deriveBonkPoolPda(baseMint, quoteMint);
}

function toBonkStaticPoolState(poolState: BonkPoolState): BonkStaticPoolState {
  const {
    virtualBase: _virtualBase,
    virtualQuote: _virtualQuote,
    realBase: _realBase,
    realQuote: _realQuote,
    ...staticState
  } = poolState;
  return staticState;
}

function toBonkReserveSnapshot(poolState: BonkPoolState): BonkPoolReserveSnapshot {
  return {
    virtualBase: poolState.virtualBase,
    virtualQuote: poolState.virtualQuote,
    realBase: poolState.realBase,
    realQuote: poolState.realQuote,
  };
}

async function loadPoolContext(input: SolanaTradeRequest, opts?: { forceRefresh?: boolean }): Promise<BonkPoolContext> {
  const poolAddress = resolvePoolAddress(input);
  const loader = async () => {
    const poolAccountInfo = input.runtime.getAccountInfo
      ? await input.runtime.getAccountInfo(poolAddress, 'confirmed', 'static')
      : await (async () => {
        const connection = await input.runtime.getConnection();
        return await connection.getAccountInfo(poolAddress, 'confirmed');
      })();
    if (!poolAccountInfo?.data) throw new Error('Bonk pool account not found');
    if (!poolAccountInfo.owner.equals(BONK_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Bonk pool');
    }
    const poolState = parseBonkPoolState(poolAccountInfo.data, poolAddress);
    poolReserveCache.set(poolAddress.toBase58(), {
      promise: Promise.resolve(toBonkReserveSnapshot(poolState)),
      expiresAt: Date.now() + POOL_RESERVE_CACHE_TTL_MS,
    });
    const [baseTokenProgram, quoteTokenProgram] = await Promise.all([
      getMintProgramId(input.runtime, poolState.baseMint),
      getMintProgramId(input.runtime, poolState.quoteMint),
    ]);
    return {
      poolState: toBonkStaticPoolState(poolState),
      baseTokenProgram,
      quoteTokenProgram,
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(poolContextCache, poolAddress.toBase58(), POOL_CONTEXT_CACHE_TTL_MS, loader)
    : rememberWarmPromise(poolContextCache, poolAddress.toBase58(), POOL_CONTEXT_CACHE_TTL_MS, loader));
}

async function getPoolContextForBuild(input: SolanaTradeRequest): Promise<BonkPoolContext> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadPoolContext(input);
  const cached = getFreshWarmPromise<BonkPoolContext>(poolContextCache, resolvePoolAddress(input).toBase58());
  if (!cached) return await loadPoolContext(input);
  return await cached;
}

async function loadPoolReserveSnapshot(
  input: SolanaTradeRequest,
  opts?: { forceRefresh?: boolean },
): Promise<BonkPoolReserveSnapshot> {
  const poolAddress = resolvePoolAddress(input);
  const cacheKey = poolAddress.toBase58();
  const loader = async () => {
    const poolAccountInfo = input.runtime.getAccountInfo
      ? await input.runtime.getAccountInfo(poolAddress, 'confirmed', 'dynamic')
      : await (async () => {
        const connection = await input.runtime.getConnection();
        return await connection.getAccountInfo(poolAddress, 'confirmed');
      })();
    if (!poolAccountInfo?.data) throw new Error('Bonk pool account not found');
    const poolState = parseBonkPoolState(poolAccountInfo.data, poolAddress);
    return toBonkReserveSnapshot(poolState);
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(poolReserveCache, cacheKey, POOL_RESERVE_CACHE_TTL_MS, loader)
    : rememberWarmPromise(poolReserveCache, cacheKey, POOL_RESERVE_CACHE_TTL_MS, loader));
}

function validateTradePair(input: SolanaTradeRequest, poolState: Pick<BonkPoolState, 'baseMint' | 'quoteMint'>): void {
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const isBuyPair = inputMint.equals(poolState.quoteMint) && outputMint.equals(poolState.baseMint);
  const isSellPair = inputMint.equals(poolState.baseMint) && outputMint.equals(poolState.quoteMint);
  if (!isBuyPair && !isSellPair) {
    throw new Error('Input/output mint does not match Bonk pool');
  }
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

function buildInstructionData(side: 'buy' | 'sell', amountIn: bigint, minimumAmountOut: bigint): Buffer {
  return Buffer.from(concatBytes([
    side === 'buy' ? BONK_BUY_EXACT_IN_DISCRIMINATOR : BONK_SELL_EXACT_IN_DISCRIMINATOR,
    encodeU64LE(amountIn),
    encodeU64LE(minimumAmountOut),
    encodeU64LE(0n),
  ]));
}

async function buildTransaction(input: SolanaTradeRequest): Promise<{
  transaction: VersionedTransaction;
  protectionMinOutWei: string;
  quotedOutWei?: string | null;
  recentBlockhash: string;
}> {
  const executionMode = resolveExecutionMode(input);
  const user = new PublicKey(input.ownerAddress);
  const { poolState, baseTokenProgram, quoteTokenProgram } = await getPoolContextForBuild(input);
  validateTradePair(input, poolState);

  const amountIn = BigInt(input.amount);
  const isBuy = input.side === 'buy';
  const inputMint = isBuy ? poolState.quoteMint : poolState.baseMint;
  const outputMint = isBuy ? poolState.baseMint : poolState.quoteMint;
  const inputTokenProgram = isBuy ? quoteTokenProgram : baseTokenProgram;
  const outputTokenProgram = isBuy ? baseTokenProgram : quoteTokenProgram;
  const userBaseTokenAccount = findAta({ mint: poolState.baseMint, owner: user, tokenProgramId: baseTokenProgram });
  const userQuoteTokenAccount = findAta({ mint: poolState.quoteMint, owner: user, tokenProgramId: quoteTokenProgram });
  const userInputAccount = isBuy ? userQuoteTokenAccount : userBaseTokenAccount;
  const userOutputAccount = isBuy ? userBaseTokenAccount : userQuoteTokenAccount;
  const inputIsNative = isSolanaNativeMint(inputMint.toBase58());
  const outputIsNative = isSolanaNativeMint(outputMint.toBase58());
  let minimumAmountOut = 1n;
  let protectionMinOutWei = '1';
  if (executionMode !== 'turbo') {
    const reserves = await loadPoolReserveSnapshot(input);
    minimumAmountOut = isBuy
      ? computeBonkBuyMinimumAmountOut({
        amountIn,
        virtualBase: reserves.virtualBase,
        virtualQuote: reserves.virtualQuote,
        realBase: reserves.realBase,
        realQuote: reserves.realQuote,
        slippageBps: input.slippageBps,
      })
      : computeBonkSellMinimumAmountOut({
        amountIn,
        virtualBase: reserves.virtualBase,
        virtualQuote: reserves.virtualQuote,
        realBase: reserves.realBase,
        realQuote: reserves.realQuote,
        slippageBps: input.slippageBps,
      });
    protectionMinOutWei = minimumAmountOut.toString();
  }

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: inputMint,
    associatedToken: userInputAccount,
    tokenProgramId: inputTokenProgram,
  }));
  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: outputMint,
    associatedToken: userOutputAccount,
    tokenProgramId: outputTokenProgram,
  }));
  if (inputIsNative) {
    preInstructions.push(...buildWrapNativeInstructions({
      payer: user,
      nativeAta: userInputAccount,
      lamports: amountIn,
      tokenProgramId: inputTokenProgram,
    }));
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: userInputAccount,
      destination: user,
      owner: user,
      tokenProgramId: inputTokenProgram,
    }));
  }
  if (outputIsNative) {
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: userOutputAccount,
      destination: user,
      owner: user,
      tokenProgramId: outputTokenProgram,
    }));
  }

  const swapInstruction = new TransactionInstruction({
    programId: BONK_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: BONK_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: poolState.globalConfig, isSigner: false, isWritable: false },
      { pubkey: poolState.platformConfig, isSigner: false, isWritable: false },
      { pubkey: poolState.poolAddress, isSigner: false, isWritable: true },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: poolState.baseVault, isSigner: false, isWritable: true },
      { pubkey: poolState.quoteVault, isSigner: false, isWritable: true },
      { pubkey: poolState.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolState.quoteMint, isSigner: false, isWritable: false },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: quoteTokenProgram ?? TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: BONK_EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: BONK_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: buildInstructionData(input.side, amountIn, minimumAmountOut),
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

export async function prewarmBonkTrade(input: {
  tokenAddress: string;
  ownerAddress?: string;
  executionMode?: 'default' | 'turbo';
  tokenInfo?: SolanaTradeRequest['tokenInfo'];
  runtime: SolanaTradeRequest['runtime'];
}): Promise<void> {
  const tokenAddress = String(input.tokenAddress || '').trim();
  if (!tokenAddress) return;
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
    await loadPoolReserveSnapshot(request, { forceRefresh: true });
  }
}

export const bonkTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'bonk',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['bonk'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    const dexType = normalizeDexType(input);
    const hinted = platform === 'bonk' || dexType.includes('bonk');
    return hinted;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Bonk adapter cannot handle this trade');
    }
    const { transaction, protectionMinOutWei, quotedOutWei, recentBlockhash } = await buildTransaction(input);
    return {
      source: 'bonk',
      transaction,
      protectionMinOutWei,
      quotedOutWei,
      blockhash: recentBlockhash,
    };
  },
};
