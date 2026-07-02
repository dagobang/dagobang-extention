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
import type { RaydiumCpmmPoolInfo } from './types';
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

type RaydiumCpmmStaticPoolInfo = Omit<RaydiumCpmmPoolInfo, 'baseReserve' | 'quoteReserve'>;
type RaydiumCpmmReserveSnapshot = Pick<RaydiumCpmmPoolInfo, 'baseReserve' | 'quoteReserve'>;
type RaydiumCpmmBuildDirection = {
  isToken0In: boolean;
  inputVault: PublicKey;
  outputVault: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
};

const STATIC_POOL_INFO_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const RESERVE_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.dynamicQuote;
const ATA_EXISTS_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const BLOCKHASH_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.blockhash;

const staticPoolInfoCache = new Map<string, WarmCacheEntry<RaydiumCpmmStaticPoolInfo>>();
const reserveCache = new Map<string, WarmCacheEntry<RaydiumCpmmReserveSnapshot>>();
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
  if (!poolPair) throw new Error('Raydium trade requires tokenInfo.pool_pair');
  return new PublicKey(poolPair);
}

async function loadStaticPoolInfo(
  input: SolanaTradeRequest,
  opts?: { forceRefresh?: boolean },
): Promise<RaydiumCpmmStaticPoolInfo> {
  const poolAddress = resolvePoolAddress(input);
  const cacheKey = poolAddress.toBase58();
  const loader = async () => {
    const connection = await input.runtime.getConnection();
    const poolAccountInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
    if (!poolAccountInfo?.data) throw new Error('Raydium pool account not found');
    if (!poolAccountInfo.owner.equals(RAYDIUM_CPMM_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Raydium CPMM pool');
    }

    return parseRaydiumCpmmPoolInfo(poolAccountInfo.data, poolAddress);
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(staticPoolInfoCache, cacheKey, STATIC_POOL_INFO_CACHE_TTL_MS, loader)
    : rememberWarmPromise(staticPoolInfoCache, cacheKey, STATIC_POOL_INFO_CACHE_TTL_MS, loader));
}

async function loadPoolReserves(
  input: SolanaTradeRequest,
  poolInfo: RaydiumCpmmStaticPoolInfo,
  opts?: { forceRefresh?: boolean },
): Promise<RaydiumCpmmReserveSnapshot> {
  const cacheKey = poolInfo.poolState.toBase58();
  const loader = async () => {
    const connection = await input.runtime.getConnection();
    const [vault0Info, vault1Info] = await connection.getMultipleAccountsInfo(
      [poolInfo.tokenVault0, poolInfo.tokenVault1],
      'confirmed',
    );
    if (!vault0Info?.data || !vault1Info?.data) throw new Error('Raydium vault accounts not found');
    return {
      baseReserve: parseRaydiumCpmmTokenAccountBalance(vault0Info.data),
      quoteReserve: parseRaydiumCpmmTokenAccountBalance(vault1Info.data),
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(reserveCache, cacheKey, RESERVE_CACHE_TTL_MS, loader)
    : rememberWarmPromise(reserveCache, cacheKey, RESERVE_CACHE_TTL_MS, loader));
}

async function getStaticPoolInfoForBuild(input: SolanaTradeRequest): Promise<RaydiumCpmmStaticPoolInfo> {
  if (resolveExecutionMode(input) !== 'turbo') return await loadStaticPoolInfo(input);
  const cached = getFreshWarmPromise<RaydiumCpmmStaticPoolInfo>(staticPoolInfoCache, resolvePoolAddress(input).toBase58());
  if (!cached) throw new Error('Raydium pool context not ready');
  return await cached;
}

function buildDirection(
  poolInfo: RaydiumCpmmStaticPoolInfo,
  inputMint: PublicKey,
  outputMint: PublicKey,
): RaydiumCpmmBuildDirection {
  const isToken0In = inputMint.equals(poolInfo.tokenMint0) && outputMint.equals(poolInfo.tokenMint1);
  const isToken1In = inputMint.equals(poolInfo.tokenMint1) && outputMint.equals(poolInfo.tokenMint0);
  if (!isToken0In && !isToken1In) throw new Error('Input/output mint does not match Raydium pool');
  return {
    isToken0In,
    inputVault: isToken0In ? poolInfo.tokenVault0 : poolInfo.tokenVault1,
    outputVault: isToken0In ? poolInfo.tokenVault1 : poolInfo.tokenVault0,
    inputTokenProgram: isToken0In ? poolInfo.tokenProgram0 : poolInfo.tokenProgram1,
    outputTokenProgram: isToken0In ? poolInfo.tokenProgram1 : poolInfo.tokenProgram0,
  };
}

function resolveDirectionReserves(
  direction: RaydiumCpmmBuildDirection,
  reserves: RaydiumCpmmReserveSnapshot,
): { reserveIn: bigint; reserveOut: bigint } {
  return direction.isToken0In
    ? { reserveIn: reserves.baseReserve, reserveOut: reserves.quoteReserve }
    : { reserveIn: reserves.quoteReserve, reserveOut: reserves.baseReserve };
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
  const poolInfo = await getStaticPoolInfoForBuild(input);
  const direction = buildDirection(poolInfo, inputMint, outputMint);
  const amountIn = BigInt(input.amount);
  let minimumAmountOut = 1n;
  let protectionMinOutWei = '1';
  let quotedOutWei: string | null = null;
  if (executionMode !== 'turbo') {
    const reserves = await loadPoolReserves(input, poolInfo);
    const resolvedReserves = resolveDirectionReserves(direction, reserves);
    const quotedAmountOut = computeRaydiumCpmmAmountOut(amountIn, resolvedReserves.reserveIn, resolvedReserves.reserveOut);
    minimumAmountOut = computeRaydiumCpmmMinimumAmountOut(quotedAmountOut, input.slippageBps);
    protectionMinOutWei = minimumAmountOut.toString();
    quotedOutWei = quotedAmountOut.toString();
  }
  const userInputAccount = findAta({ mint: inputMint, owner: user, tokenProgramId: direction.inputTokenProgram });
  const userOutputAccount = findAta({ mint: outputMint, owner: user, tokenProgramId: direction.outputTokenProgram });

  const inputIsNative = isSolanaNativeMint(input.inputMint);
  const outputIsNative = isSolanaNativeMint(input.outputMint);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: inputMint,
    associatedToken: userInputAccount,
    tokenProgramId: direction.inputTokenProgram,
  }));

  preInstructions.push(createAtaIdempotentInstruction({
    payer: user,
    owner: user,
    mint: outputMint,
    associatedToken: userOutputAccount,
    tokenProgramId: direction.outputTokenProgram,
  }));

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
  const poolInfo = await loadStaticPoolInfo(request, { forceRefresh: true });
  if (input.executionMode !== 'turbo') {
    await loadPoolReserves(request, poolInfo, { forceRefresh: true });
  }
  const direction = buildDirection(poolInfo, new PublicKey(request.inputMint), new PublicKey(request.outputMint));
  const tasks: Array<Promise<unknown>> = [
    loadLatestBlockhash(request, false),
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
    return !!input.tokenInfo?.pool_pair;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Raydium adapter cannot handle this trade');
    }
    const { transaction, protectionMinOutWei, quotedOutWei, recentBlockhash } = await buildTransaction(input);
    return {
      source: 'raydium',
      transaction,
      protectionMinOutWei,
      quotedOutWei,
      blockhash: recentBlockhash,
    };
  },
};
