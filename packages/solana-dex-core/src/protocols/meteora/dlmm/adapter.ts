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
import type {
  MeteoraBinArrayAccount,
  MeteoraPoolState,
  MeteoraStaticParameters,
  MeteoraVariableParameters,
} from './types';
import {
  getFreshWarmPromise,
  refreshWarmPromise,
  rememberWarmPromise,
  SOLANA_WARM_CACHE_TTL_MS,
  type WarmCacheEntry,
} from '../../../prewarm';

type MeteoraDlmmStaticPoolState = {
  parameters: MeteoraStaticParameters;
  binStep: number;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
};

type MeteoraDlmmStaticPoolContext = {
  lbPair: PublicKey;
  poolState: MeteoraDlmmStaticPoolState;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
};

type MeteoraDlmmQuoteContext = {
  activeId: number;
  vParameters: MeteoraVariableParameters;
  binArrays: MeteoraBinArrayAccount[];
};

type CachedBlockhashValue = {
  blockhash: string;
};

const POOL_CONTEXT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const POOL_QUOTE_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.dynamicQuote;
const ATA_EXISTS_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const BLOCKHASH_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.blockhash;

const poolContextCache = new Map<string, WarmCacheEntry<MeteoraDlmmStaticPoolContext>>();
const poolQuoteCache = new Map<string, WarmCacheEntry<MeteoraDlmmQuoteContext>>();
const ataExistsCache = new Map<string, WarmCacheEntry<boolean>>();
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

function toMeteoraDlmmStaticPoolState(poolState: MeteoraPoolState): MeteoraDlmmStaticPoolState {
  return {
    parameters: poolState.parameters,
    binStep: poolState.binStep,
    tokenXMint: poolState.tokenXMint,
    tokenYMint: poolState.tokenYMint,
    reserveX: poolState.reserveX,
    reserveY: poolState.reserveY,
    oracle: poolState.oracle,
  };
}

function mergeMeteoraDlmmPoolState(
  staticPoolState: MeteoraDlmmStaticPoolState,
  quoteContext: MeteoraDlmmQuoteContext,
): MeteoraPoolState {
  return {
    ...staticPoolState,
    activeId: quoteContext.activeId,
    vParameters: quoteContext.vParameters,
  };
}

function resolveDlmmSwapDirection(
  poolState: Pick<MeteoraPoolState, 'tokenXMint' | 'tokenYMint'>,
  inputMint: PublicKey,
  outputMint: PublicKey,
): { swapForY: boolean } {
  const swapForY = inputMint.equals(poolState.tokenXMint) && outputMint.equals(poolState.tokenYMint);
  const swapForX = inputMint.equals(poolState.tokenYMint) && outputMint.equals(poolState.tokenXMint);
  if (!swapForY && !swapForX) throw new Error('Input/output mint does not match Meteora DLMM pool');
  return { swapForY };
}

function getDlmmQuoteCacheKey(lbPair: PublicKey, swapForY: boolean): string {
  return `${lbPair.toBase58()}:${swapForY ? 'x_to_y' : 'y_to_x'}`;
}

async function loadPoolContext(
  input: SolanaTradeRequest,
  opts?: { forceRefresh?: boolean },
): Promise<MeteoraDlmmStaticPoolContext> {
  const lbPair = resolvePoolAddress(input);
  const cacheKey = lbPair.toBase58();
  const loader = async () => {
    const connection = await input.runtime.getConnection();
    const poolInfo = await connection.getAccountInfo(lbPair, 'confirmed');
    if (!poolInfo?.data) throw new Error('Meteora DLMM pool account not found');
    if (!poolInfo.owner.equals(METEORA_DLMM_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Meteora DLMM pool');
    }

    const poolState = parseMeteoraDlmmPoolState(poolInfo.data);
    const [tokenXProgram, tokenYProgram] = await connection.getMultipleAccountsInfo(
      [poolState.tokenXMint, poolState.tokenYMint],
      'confirmed',
    );
    if (!tokenXProgram?.owner || !tokenYProgram?.owner) {
      throw new Error('Meteora DLMM mint accounts not found');
    }

    return {
      lbPair,
      poolState: toMeteoraDlmmStaticPoolState(poolState),
      tokenXProgram: tokenXProgram.owner,
      tokenYProgram: tokenYProgram.owner,
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(poolContextCache, cacheKey, POOL_CONTEXT_CACHE_TTL_MS, loader)
    : rememberWarmPromise(poolContextCache, cacheKey, POOL_CONTEXT_CACHE_TTL_MS, loader));
}

async function getPoolContextForBuild(input: SolanaTradeRequest): Promise<MeteoraDlmmStaticPoolContext> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadPoolContext(input);
  const cached = getFreshWarmPromise<MeteoraDlmmStaticPoolContext>(poolContextCache, resolvePoolAddress(input).toBase58());
  if (!cached) throw new Error('Meteora DLMM context not ready');
  return await cached;
}

async function loadPoolQuoteContext(
  input: SolanaTradeRequest,
  staticContext: MeteoraDlmmStaticPoolContext,
  opts?: { forceRefresh?: boolean },
): Promise<MeteoraDlmmQuoteContext> {
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const { swapForY } = resolveDlmmSwapDirection(staticContext.poolState, inputMint, outputMint);
  const cacheKey = getDlmmQuoteCacheKey(staticContext.lbPair, swapForY);
  const loader = async () => {
    const connection = await input.runtime.getConnection();
    const poolInfo = await connection.getAccountInfo(staticContext.lbPair, 'confirmed');
    if (!poolInfo?.data) throw new Error('Meteora DLMM pool account not found');
    const poolState = parseMeteoraDlmmPoolState(poolInfo.data);
    const binArrayKeys = buildMeteoraDlmmBinArrayIndices(poolState.activeId, swapForY)
      .map((index) => deriveMeteoraDlmmBinArrayPda(staticContext.lbPair, index));
    const binArrayInfos = await connection.getMultipleAccountsInfo(binArrayKeys, 'confirmed');
    const binArrays: MeteoraBinArrayAccount[] = [];
    for (let i = 0; i < binArrayInfos.length; i += 1) {
      const info = binArrayInfos[i];
      if (!info?.data) continue;
      binArrays.push(parseMeteoraDlmmBinArray(info.data, binArrayKeys[i]!));
    }
    if (!binArrays.length) throw new Error('No Meteora DLMM bin arrays found for swap');
    return {
      activeId: poolState.activeId,
      vParameters: poolState.vParameters,
      binArrays,
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(poolQuoteCache, cacheKey, POOL_QUOTE_CACHE_TTL_MS, loader)
    : rememberWarmPromise(poolQuoteCache, cacheKey, POOL_QUOTE_CACHE_TTL_MS, loader));
}

async function getPoolQuoteContextForBuild(
  input: SolanaTradeRequest,
  staticContext: MeteoraDlmmStaticPoolContext,
): Promise<MeteoraDlmmQuoteContext> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadPoolQuoteContext(input, staticContext);
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const { swapForY } = resolveDlmmSwapDirection(staticContext.poolState, inputMint, outputMint);
  const cached = getFreshWarmPromise<MeteoraDlmmQuoteContext>(
    poolQuoteCache,
    getDlmmQuoteCacheKey(staticContext.lbPair, swapForY),
  );
  if (!cached) throw new Error('Meteora DLMM build context not ready');
  return await cached;
}

async function prewarmAtaExistence(input: SolanaTradeRequest, accounts: PublicKey[]): Promise<void> {
  if (!accounts.length) return;
  const now = Date.now();
  const connection = await input.runtime.getConnection();
  const missingAccounts: PublicKey[] = [];
  const missingKeys: string[] = [];
  for (const account of accounts) {
    const key = account.toBase58();
    if (getFreshWarmPromise<boolean>(ataExistsCache, key, now)) continue;
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
  const key = 'confirmed';
  if (allowCached) {
    const cached = getFreshWarmPromise<CachedBlockhashValue>(latestBlockhashCache, key);
    if (cached) return await cached;
  }
  const loader = async () => {
    const connection = await input.runtime.getConnection();
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
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
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const user = new PublicKey(input.ownerAddress);
  const staticContext = await getPoolContextForBuild(input);
  const quoteContext = await getPoolQuoteContextForBuild(input, staticContext);
  const { lbPair, tokenXProgram, tokenYProgram } = staticContext;
  const poolState = mergeMeteoraDlmmPoolState(staticContext.poolState, quoteContext);
  const { swapForY } = resolveDlmmSwapDirection(poolState, inputMint, outputMint);

  const amountIn = BigInt(input.amount);
  const quote = calculateMeteoraDlmmQuote(amountIn, poolState, quoteContext.binArrays, swapForY);
  let minimumAmountOut = 1n;
  let protectionMinOutWei = '1';
  let quotedOutWei: string | null = null;
  if (executionMode !== 'turbo') {
    minimumAmountOut = quote.amountOut * BigInt(BASIS_POINT_MAX - input.slippageBps) / BigInt(BASIS_POINT_MAX);
    if (minimumAmountOut <= 0n) throw new Error('Invalid Meteora DLMM minimum amount out');
    protectionMinOutWei = minimumAmountOut.toString();
    quotedOutWei = quote.amountOut.toString();
  }

  const inputTokenProgram = swapForY ? tokenXProgram : tokenYProgram;
  const outputTokenProgram = swapForY ? tokenYProgram : tokenXProgram;
  const userTokenIn = findAta({ mint: inputMint, owner: user, tokenProgramId: inputTokenProgram });
  const userTokenOut = findAta({ mint: outputMint, owner: user, tokenProgramId: outputTokenProgram });
  const inputIsNative = isSolanaNativeMint(input.inputMint);
  const outputIsNative = isSolanaNativeMint(input.outputMint);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: inputMint,
    associatedToken: userTokenIn,
    tokenProgramId: inputTokenProgram,
  }));

  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: outputMint,
    associatedToken: userTokenOut,
    tokenProgramId: outputTokenProgram,
  }));

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

  const { blockhash } = await loadLatestBlockhash(input, true);
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [...preInstructions, swapInstruction, ...postInstructions],
  }).compileToV0Message();

  return {
    transaction: new VersionedTransaction(message),
    protectionMinOutWei,
    quotedOutWei,
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
  const staticContext = await loadPoolContext(request, { forceRefresh: true });
  await Promise.all([
    loadPoolQuoteContext(request, staticContext, { forceRefresh: true }),
    loadPoolQuoteContext({
      ...request,
      inputMint: request.outputMint,
      outputMint: request.inputMint,
    }, staticContext, { forceRefresh: true }),
  ]);
  const { poolState, tokenXProgram, tokenYProgram } = staticContext;
  const tasks: Array<Promise<unknown>> = [
    loadLatestBlockhash(request, false),
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
    return !!input.tokenInfo?.pool_pair;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Meteora adapter cannot handle this trade');
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
