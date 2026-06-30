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
import type { MeteoraDammV2PoolContext } from './types';

type TimedPromiseCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

type CachedBlockhashValue = {
  blockhash: string;
};

const POOL_CONTEXT_CACHE_TTL_MS = 10_000;
const ATA_EXISTS_CACHE_TTL_MS = 15_000;
const BLOCKHASH_CACHE_TTL_MS = 3_000;

const poolContextCache = new Map<string, TimedPromiseCacheEntry<MeteoraDammV2PoolContext>>();
const ataExistsCache = new Map<string, TimedPromiseCacheEntry<boolean>>();
const latestBlockhashCache = new Map<string, TimedPromiseCacheEntry<CachedBlockhashValue>>();

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

function getFreshTimedPromise<T>(
  cache: Map<string, TimedPromiseCacheEntry<T>>,
  key: string,
  now = Date.now(),
): Promise<T> | null {
  const cached = cache.get(key);
  if (!cached || cached.expiresAt <= now) return null;
  return cached.promise;
}

function resolvePlatform(input: SolanaTradeRequest): string {
  return normalizeSolanaPlatform(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad);
}

function normalizeDexType(input: SolanaTradeRequest): string {
  return String(input.tokenInfo?.dex_type || '').trim().toLowerCase();
}

function resolvePoolAddress(input: SolanaTradeRequest): PublicKey {
  const poolPair = String(input.tokenInfo?.pool_pair || '').trim();
  if (!poolPair) throw new Error('Meteora DAMM v2 trade requires tokenInfo.pool_pair');
  return new PublicKey(poolPair);
}

async function loadPoolContext(input: SolanaTradeRequest): Promise<MeteoraDammV2PoolContext> {
  const poolAddress = resolvePoolAddress(input);
  const cacheKey = poolAddress.toBase58();
  return await rememberTimedPromise(poolContextCache, cacheKey, POOL_CONTEXT_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    const poolAccountInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
    if (!poolAccountInfo?.data) throw new Error('Meteora DAMM v2 pool account not found');
    if (!poolAccountInfo.owner.equals(METEORA_DAMM_V2_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Meteora DAMM v2 pool');
    }

    const poolInfo = parseMeteoraDammV2PoolInfo(poolAccountInfo.data, poolAddress);
    validateMeteoraDammV2Pool(poolInfo);
    const [tokenAProgram, tokenBProgram] = await Promise.all([
      getMintProgramId(input.runtime, poolInfo.tokenAMint),
      getMintProgramId(input.runtime, poolInfo.tokenBMint),
    ]);

    return {
      poolInfo,
      tokenAProgram,
      tokenBProgram,
    };
  });
}

async function loadAccountExists(input: SolanaTradeRequest, account: PublicKey): Promise<boolean> {
  const key = account.toBase58();
  return await rememberTimedPromise(ataExistsCache, key, ATA_EXISTS_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    return (await connection.getAccountInfo(account, 'confirmed')) != null;
  });
}

async function prewarmAtaExistence(input: SolanaTradeRequest, accounts: PublicKey[]): Promise<void> {
  if (!accounts.length) return;
  const now = Date.now();
  const connection = await input.runtime.getConnection();
  const missingAccounts: PublicKey[] = [];
  const missingKeys: string[] = [];
  for (const account of accounts) {
    const key = account.toBase58();
    if (getFreshTimedPromise(ataExistsCache, key, now)) continue;
    missingAccounts.push(account);
    missingKeys.push(key);
  }
  if (!missingAccounts.length) return;
  const infos = await connection.getMultipleAccountsInfo(missingAccounts, 'confirmed');
  missingKeys.forEach((key, index) => {
    ataExistsCache.set(key, {
      promise: Promise.resolve(Boolean(infos[index])),
      expiresAt: now + ATA_EXISTS_CACHE_TTL_MS,
    });
  });
}

async function loadLatestBlockhash(input: SolanaTradeRequest, allowCached: boolean): Promise<CachedBlockhashValue> {
  const key = allowCached ? 'confirmed:warm' : `confirmed:fresh:${Date.now()}`;
  return await rememberTimedPromise(latestBlockhashCache, key, BLOCKHASH_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    return { blockhash };
  });
}

async function buildTransaction(input: SolanaTradeRequest): Promise<{
  transaction: VersionedTransaction;
  tokenMinOutWei: string;
  recentBlockhash: string;
}> {
  const user = new PublicKey(input.ownerAddress);
  const { poolInfo, tokenAProgram, tokenBProgram } = await loadPoolContext(input);
  const direction = resolveMeteoraDammV2TradeDirection(poolInfo, input.inputMint, input.outputMint);
  const amountIn = BigInt(input.amount);
  const minimumAmountOut = calculateMeteoraDammV2MinimumAmountOut(amountIn, poolInfo, direction, input.slippageBps);

  const inputMint = direction === 'a_to_b' ? poolInfo.tokenAMint : poolInfo.tokenBMint;
  const outputMint = direction === 'a_to_b' ? poolInfo.tokenBMint : poolInfo.tokenAMint;
  const inputTokenProgram = direction === 'a_to_b' ? tokenAProgram : tokenBProgram;
  const outputTokenProgram = direction === 'a_to_b' ? tokenBProgram : tokenAProgram;
  const inputTokenAccount = findAta({ mint: inputMint, owner: user, tokenProgramId: inputTokenProgram });
  const outputTokenAccount = findAta({ mint: outputMint, owner: user, tokenProgramId: outputTokenProgram });
  const [inputAtaExists, outputAtaExists] = await Promise.all([
    loadAccountExists(input, inputTokenAccount),
    loadAccountExists(input, outputTokenAccount),
  ]);

  const inputIsNative = isSolanaNativeMint(input.inputMint);
  const outputIsNative = isSolanaNativeMint(input.outputMint);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  if (!inputAtaExists) {
    if (!inputIsNative) throw new Error('Meteora DAMM v2 input token account not found');
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: inputMint,
      associatedToken: inputTokenAccount,
      tokenProgramId: inputTokenProgram,
    }));
  }

  if (!outputAtaExists) {
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: outputMint,
      associatedToken: outputTokenAccount,
      tokenProgramId: outputTokenProgram,
    }));
  }

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

  const allowCachedBlockhash = (input.rawInput as any)?.executionModeOverride === 'turbo';
  const { blockhash } = await loadLatestBlockhash(input, allowCachedBlockhash);
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [...preInstructions, swapInstruction, ...postInstructions],
  }).compileToV0Message();

  return {
    transaction: new VersionedTransaction(message),
    tokenMinOutWei: minimumAmountOut.toString(),
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
  const { poolInfo, tokenAProgram, tokenBProgram } = await loadPoolContext(request);
  const direction = resolveMeteoraDammV2TradeDirection(poolInfo, request.inputMint, request.outputMint);
  const tasks: Array<Promise<unknown>> = [
    loadLatestBlockhash(request, true),
  ];
  if (ownerAddress) {
    const user = new PublicKey(ownerAddress);
    const inputMint = direction === 'a_to_b' ? poolInfo.tokenAMint : poolInfo.tokenBMint;
    const outputMint = direction === 'a_to_b' ? poolInfo.tokenBMint : poolInfo.tokenAMint;
    const inputTokenProgram = direction === 'a_to_b' ? tokenAProgram : tokenBProgram;
    const outputTokenProgram = direction === 'a_to_b' ? tokenBProgram : tokenAProgram;
    tasks.push(prewarmAtaExistence(request, [
      findAta({ mint: inputMint, owner: user, tokenProgramId: inputTokenProgram }),
      findAta({ mint: outputMint, owner: user, tokenProgramId: outputTokenProgram }),
    ]));
  }
  await Promise.all(tasks);
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
    if (!input.tokenInfo?.pool_pair) return false;

    try {
      const { poolInfo } = await loadPoolContext(input);
      resolveMeteoraDammV2TradeDirection(poolInfo, input.inputMint, input.outputMint);
      return true;
    } catch {
      return false;
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Meteora DAMM v2 adapter cannot handle this trade');
    }
    const { transaction, tokenMinOutWei, recentBlockhash } = await buildTransaction(input);
    return {
      source: 'meteora',
      transaction,
      tokenMinOutWei,
      blockhash: recentBlockhash,
    };
  },
};
