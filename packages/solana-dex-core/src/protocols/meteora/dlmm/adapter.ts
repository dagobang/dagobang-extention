import { Buffer } from 'buffer';
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
  concatBytes,
  createAtaIdempotentInstruction,
  encodeI32LE,
  encodeU64LE,
  findAta,
} from '../../../utils';
import { parseMeteoraDlmmBinArray, parseMeteoraDlmmPoolState } from './codec';
import {
  BASIS_POINT_MAX,
  MEMO_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  METEORA_DLMM_SWAP2_DISCRIMINATOR,
} from './constants';
import {
  buildMeteoraDlmmBinArrayIndices,
  deriveMeteoraDlmmBinArrayPda,
  deriveMeteoraDlmmBitmapExtensionPda,
  deriveMeteoraDlmmEventAuthorityPda,
} from './pda';
import { calculateMeteoraDlmmQuote } from './quote';
import type { MeteoraBinArrayAccount, MeteoraPoolState } from './types';

type TimedPromiseCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

type MeteoraDlmmPoolContext = {
  lbPair: PublicKey;
  poolState: MeteoraPoolState;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
  binArrays: MeteoraBinArrayAccount[];
};

type CachedBlockhashValue = {
  blockhash: string;
};

const POOL_CONTEXT_CACHE_TTL_MS = 10_000;
const ATA_EXISTS_CACHE_TTL_MS = 15_000;
const BLOCKHASH_CACHE_TTL_MS = 3_000;

const poolContextCache = new Map<string, TimedPromiseCacheEntry<MeteoraDlmmPoolContext>>();
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
  if (!poolPair) throw new Error('Meteora trade requires tokenInfo.pool_pair');
  return new PublicKey(poolPair);
}

function buildSwapInstructionData(amountIn: bigint, minimumAmountOut: bigint): Buffer {
  return Buffer.from(concatBytes([
    METEORA_DLMM_SWAP2_DISCRIMINATOR,
    encodeU64LE(amountIn),
    encodeU64LE(minimumAmountOut),
    encodeI32LE(0),
  ]));
}

async function loadPoolContext(input: SolanaTradeRequest): Promise<MeteoraDlmmPoolContext> {
  const lbPair = resolvePoolAddress(input);
  const cacheKey = `${lbPair.toBase58()}:${input.inputMint}:${input.outputMint}`;
  return await rememberTimedPromise(poolContextCache, cacheKey, POOL_CONTEXT_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    const poolInfo = await connection.getAccountInfo(lbPair, 'confirmed');
    if (!poolInfo?.data) throw new Error('Meteora DLMM pool account not found');
    if (!poolInfo.owner.equals(METEORA_DLMM_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Meteora DLMM pool');
    }

    const poolState = parseMeteoraDlmmPoolState(poolInfo.data);
    const swapForY = new PublicKey(input.inputMint).equals(poolState.tokenXMint);
    const binArrayKeys = buildMeteoraDlmmBinArrayIndices(poolState.activeId, swapForY)
      .map((index) => deriveMeteoraDlmmBinArrayPda(lbPair, index));

    const [tokenXProgram, tokenYProgram, ...binArrayInfos] = await connection.getMultipleAccountsInfo(
      [poolState.tokenXMint, poolState.tokenYMint, ...binArrayKeys],
      'confirmed',
    );
    if (!tokenXProgram?.owner || !tokenYProgram?.owner) {
      throw new Error('Meteora DLMM mint accounts not found');
    }

    const binArrays: MeteoraBinArrayAccount[] = [];
    for (let i = 0; i < binArrayInfos.length; i += 1) {
      const info = binArrayInfos[i];
      if (!info?.data) continue;
      binArrays.push(parseMeteoraDlmmBinArray(info.data, binArrayKeys[i]!));
    }
    if (!binArrays.length) throw new Error('No Meteora DLMM bin arrays found for swap');

    return {
      lbPair,
      poolState,
      tokenXProgram: tokenXProgram.owner,
      tokenYProgram: tokenYProgram.owner,
      binArrays,
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
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const user = new PublicKey(input.ownerAddress);
  const { lbPair, poolState, tokenXProgram, tokenYProgram, binArrays } = await loadPoolContext(input);

  const swapForY = inputMint.equals(poolState.tokenXMint) && outputMint.equals(poolState.tokenYMint);
  const swapForX = inputMint.equals(poolState.tokenYMint) && outputMint.equals(poolState.tokenXMint);
  if (!swapForY && !swapForX) throw new Error('Input/output mint does not match Meteora DLMM pool');

  const amountIn = BigInt(input.amount);
  const quote = calculateMeteoraDlmmQuote(amountIn, poolState, binArrays, swapForY);
  const minimumAmountOut = quote.amountOut * BigInt(BASIS_POINT_MAX - input.slippageBps) / BigInt(BASIS_POINT_MAX);
  if (minimumAmountOut <= 0n) throw new Error('Invalid Meteora DLMM minimum amount out');

  const inputTokenProgram = swapForY ? tokenXProgram : tokenYProgram;
  const outputTokenProgram = swapForY ? tokenYProgram : tokenXProgram;
  const userTokenIn = findAta({ mint: inputMint, owner: user, tokenProgramId: inputTokenProgram });
  const userTokenOut = findAta({ mint: outputMint, owner: user, tokenProgramId: outputTokenProgram });
  const [inputAtaExists, outputAtaExists] = await Promise.all([
    loadAccountExists(input, userTokenIn),
    loadAccountExists(input, userTokenOut),
  ]);
  const inputIsNative = isSolanaNativeMint(input.inputMint);
  const outputIsNative = isSolanaNativeMint(input.outputMint);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  if (!inputAtaExists) {
    if (!inputIsNative) throw new Error('Meteora input token account not found');
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: inputMint,
      associatedToken: userTokenIn,
      tokenProgramId: inputTokenProgram,
    }));
  }

  if (!outputAtaExists) {
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: outputMint,
      associatedToken: userTokenOut,
      tokenProgramId: outputTokenProgram,
    }));
  }

  if (inputIsNative) {
    preInstructions.push(...buildWrapNativeInstructions({
      payer: user,
      nativeAta: userTokenIn,
      lamports: amountIn,
      tokenProgramId: inputTokenProgram,
    }));
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: userTokenIn,
      destination: user,
      owner: user,
      tokenProgramId: inputTokenProgram,
    }));
  }

  if (outputIsNative) {
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: userTokenOut,
      destination: user,
      owner: user,
      tokenProgramId: outputTokenProgram,
    }));
  }

  const bitmapExtension = deriveMeteoraDlmmBitmapExtensionPda(lbPair);
  const eventAuthority = deriveMeteoraDlmmEventAuthorityPda();
  const swapInstruction = new TransactionInstruction({
    programId: METEORA_DLMM_PROGRAM_ID,
    keys: [
      { pubkey: lbPair, isSigner: false, isWritable: true },
      { pubkey: bitmapExtension, isSigner: false, isWritable: false },
      { pubkey: poolState.reserveX, isSigner: false, isWritable: true },
      { pubkey: poolState.reserveY, isSigner: false, isWritable: true },
      { pubkey: userTokenIn, isSigner: false, isWritable: true },
      { pubkey: userTokenOut, isSigner: false, isWritable: true },
      { pubkey: poolState.tokenXMint, isSigner: false, isWritable: false },
      { pubkey: poolState.tokenYMint, isSigner: false, isWritable: false },
      { pubkey: poolState.oracle, isSigner: false, isWritable: true },
      { pubkey: userTokenIn, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: false },
      { pubkey: tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: METEORA_DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ...quote.usedBinArrays.map((item) => ({ pubkey: item.publicKey, isSigner: false, isWritable: true })),
    ],
    data: buildSwapInstructionData(quote.amountIn, minimumAmountOut),
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

export async function prewarmMeteoraDlmmTrade(input: {
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
  const { poolState, tokenXProgram, tokenYProgram } = await loadPoolContext(request);
  const tasks: Array<Promise<unknown>> = [
    loadLatestBlockhash(request, true),
  ];
  if (ownerAddress) {
    const user = new PublicKey(ownerAddress);
    tasks.push(prewarmAtaExistence(request, [
      findAta({ mint: new PublicKey(request.inputMint), owner: user, tokenProgramId: tokenXProgram }),
      findAta({ mint: new PublicKey(request.outputMint), owner: user, tokenProgramId: tokenYProgram }),
    ]));
    if (!new PublicKey(request.inputMint).equals(poolState.tokenXMint)) {
      tasks.push(prewarmAtaExistence(request, [
        findAta({ mint: new PublicKey(request.inputMint), owner: user, tokenProgramId: tokenYProgram }),
        findAta({ mint: new PublicKey(request.outputMint), owner: user, tokenProgramId: tokenXProgram }),
      ]));
    }
  }
  await Promise.all(tasks);
}

export const meteoraDlmmTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'meteora',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['meteora', 'dlmm'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    const dexType = normalizeDexType(input);
    const hinted = ['meteora', 'dlmm'].includes(platform) || dexType.includes('meteora') || dexType.includes('dlmm');
    if (!hinted) return false;
    if (!input.tokenInfo?.pool_pair) return false;
    try {
      const { poolState } = await loadPoolContext(input);
      const inputMint = new PublicKey(input.inputMint);
      const outputMint = new PublicKey(input.outputMint);
      return (
        (inputMint.equals(poolState.tokenXMint) && outputMint.equals(poolState.tokenYMint)) ||
        (inputMint.equals(poolState.tokenYMint) && outputMint.equals(poolState.tokenXMint))
      );
    } catch {
      return false;
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Meteora adapter cannot handle this trade');
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
