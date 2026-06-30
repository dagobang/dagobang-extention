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
} from '../../../utils';
import {
  buildRaydiumCpmmSwapInstructionData,
  parseRaydiumCpmmPoolInfo,
  parseRaydiumCpmmTokenAccountBalance,
} from './codec';
import { RAYDIUM_CPMM_PROGRAM_ID } from './constants';
import { deriveRaydiumCpmmAuthorityPda } from './pda';
import {
  computeRaydiumCpmmAmountOut,
  computeRaydiumCpmmMinimumAmountOut,
} from './quote';
import type { RaydiumCpmmDirection, RaydiumCpmmPoolInfo } from './types';

type TimedPromiseCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

type CachedBlockhashValue = {
  blockhash: string;
};

const POOL_INFO_CACHE_TTL_MS = 10_000;
const ATA_EXISTS_CACHE_TTL_MS = 15_000;
const BLOCKHASH_CACHE_TTL_MS = 3_000;

const poolInfoCache = new Map<string, TimedPromiseCacheEntry<RaydiumCpmmPoolInfo>>();
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
  if (!poolPair) throw new Error('Raydium trade requires tokenInfo.pool_pair');
  return new PublicKey(poolPair);
}

async function loadPoolInfo(input: SolanaTradeRequest): Promise<RaydiumCpmmPoolInfo> {
  const poolAddress = resolvePoolAddress(input);
  const cacheKey = poolAddress.toBase58();
  return await rememberTimedPromise(poolInfoCache, cacheKey, POOL_INFO_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    const poolAccountInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
    if (!poolAccountInfo?.data) throw new Error('Raydium pool account not found');
    if (!poolAccountInfo.owner.equals(RAYDIUM_CPMM_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Raydium CPMM pool');
    }

    const poolInfo = parseRaydiumCpmmPoolInfo(poolAccountInfo.data, poolAddress);
    const [vault0Info, vault1Info] = await connection.getMultipleAccountsInfo(
      [poolInfo.tokenVault0, poolInfo.tokenVault1],
      'confirmed',
    );
    if (!vault0Info?.data || !vault1Info?.data) throw new Error('Raydium vault accounts not found');
    poolInfo.baseReserve = parseRaydiumCpmmTokenAccountBalance(vault0Info.data);
    poolInfo.quoteReserve = parseRaydiumCpmmTokenAccountBalance(vault1Info.data);
    return poolInfo;
  });
}

function buildDirection(
  poolInfo: RaydiumCpmmPoolInfo,
  inputMint: PublicKey,
  outputMint: PublicKey,
): RaydiumCpmmDirection {
  const isToken0In = inputMint.equals(poolInfo.tokenMint0) && outputMint.equals(poolInfo.tokenMint1);
  const isToken1In = inputMint.equals(poolInfo.tokenMint1) && outputMint.equals(poolInfo.tokenMint0);
  if (!isToken0In && !isToken1In) throw new Error('Input/output mint does not match Raydium pool');
  return {
    isToken0In,
    inputVault: isToken0In ? poolInfo.tokenVault0 : poolInfo.tokenVault1,
    outputVault: isToken0In ? poolInfo.tokenVault1 : poolInfo.tokenVault0,
    inputTokenProgram: isToken0In ? poolInfo.tokenProgram0 : poolInfo.tokenProgram1,
    outputTokenProgram: isToken0In ? poolInfo.tokenProgram1 : poolInfo.tokenProgram0,
    reserveIn: isToken0In ? poolInfo.baseReserve : poolInfo.quoteReserve,
    reserveOut: isToken0In ? poolInfo.quoteReserve : poolInfo.baseReserve,
  };
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
  const poolInfo = await loadPoolInfo(input);
  const direction = buildDirection(poolInfo, inputMint, outputMint);
  const amountIn = BigInt(input.amount);
  const quotedAmountOut = computeRaydiumCpmmAmountOut(amountIn, direction.reserveIn, direction.reserveOut);
  const minimumAmountOut = computeRaydiumCpmmMinimumAmountOut(quotedAmountOut, input.slippageBps);
  const userInputAccount = findAta({ mint: inputMint, owner: user, tokenProgramId: direction.inputTokenProgram });
  const userOutputAccount = findAta({ mint: outputMint, owner: user, tokenProgramId: direction.outputTokenProgram });
  const [inputAtaExists, outputAtaExists] = await Promise.all([
    loadAccountExists(input, userInputAccount),
    loadAccountExists(input, userOutputAccount),
  ]);

  const inputIsNative = isSolanaNativeMint(input.inputMint);
  const outputIsNative = isSolanaNativeMint(input.outputMint);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  if (!inputAtaExists) {
    if (!inputIsNative) throw new Error('Raydium input token account not found');
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: inputMint,
      associatedToken: userInputAccount,
      tokenProgramId: direction.inputTokenProgram,
    }));
  }

  if (!outputAtaExists) {
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: outputMint,
      associatedToken: userOutputAccount,
      tokenProgramId: direction.outputTokenProgram,
    }));
  }

  if (inputIsNative) {
    preInstructions.push(...buildWrapNativeInstructions({
      payer: user,
      nativeAta: userInputAccount,
      lamports: amountIn,
      tokenProgramId: direction.inputTokenProgram,
    }));
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: userInputAccount,
      destination: user,
      owner: user,
      tokenProgramId: direction.inputTokenProgram,
    }));
  }

  if (outputIsNative) {
    postInstructions.push(buildCloseTokenAccountInstruction({
      account: userOutputAccount,
      destination: user,
      owner: user,
      tokenProgramId: direction.outputTokenProgram,
    }));
  }

  const swapInstruction = new TransactionInstruction({
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: deriveRaydiumCpmmAuthorityPda(), isSigner: false, isWritable: false },
      { pubkey: poolInfo.ammConfig, isSigner: false, isWritable: true },
      { pubkey: poolInfo.poolState, isSigner: false, isWritable: true },
      { pubkey: userInputAccount, isSigner: false, isWritable: true },
      { pubkey: userOutputAccount, isSigner: false, isWritable: true },
      { pubkey: direction.inputVault, isSigner: false, isWritable: true },
      { pubkey: direction.outputVault, isSigner: false, isWritable: true },
      { pubkey: direction.inputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: direction.outputTokenProgram, isSigner: false, isWritable: false },
      { pubkey: inputMint, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: poolInfo.observationState, isSigner: false, isWritable: true },
    ],
    data: buildRaydiumCpmmSwapInstructionData(amountIn, minimumAmountOut),
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

export async function prewarmRaydiumTrade(input: {
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
  const poolInfo = await loadPoolInfo(request);
  const direction = buildDirection(poolInfo, new PublicKey(request.inputMint), new PublicKey(request.outputMint));
  const tasks: Array<Promise<unknown>> = [
    loadLatestBlockhash(request, true),
  ];
  if (ownerAddress) {
    const user = new PublicKey(ownerAddress);
    tasks.push(prewarmAtaExistence(request, [
      findAta({ mint: new PublicKey(request.inputMint), owner: user, tokenProgramId: direction.inputTokenProgram }),
      findAta({ mint: new PublicKey(request.outputMint), owner: user, tokenProgramId: direction.outputTokenProgram }),
    ]));
  }
  await Promise.all(tasks);
}

export const raydiumTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'raydium',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['raydium'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    const dexType = normalizeDexType(input);
    const hinted = platform === 'raydium' || dexType.includes('raydium');
    if (!hinted) return false;
    if (!input.tokenInfo?.pool_pair) return false;
    try {
      const poolInfo = await loadPoolInfo(input);
      buildDirection(poolInfo, new PublicKey(input.inputMint), new PublicKey(input.outputMint));
      return true;
    } catch {
      return false;
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Raydium adapter cannot handle this trade');
    }
    const { transaction, tokenMinOutWei, recentBlockhash } = await buildTransaction(input);
    return {
      source: 'raydium',
      transaction,
      tokenMinOutWei,
      blockhash: recentBlockhash,
    };
  },
};
