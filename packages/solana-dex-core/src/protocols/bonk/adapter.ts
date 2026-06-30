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

type TimedPromiseCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

type BonkPoolContext = {
  poolState: BonkPoolState;
  baseTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
};

type CachedBlockhashValue = {
  blockhash: string;
};

const POOL_CONTEXT_CACHE_TTL_MS = 10_000;
const ATA_EXISTS_CACHE_TTL_MS = 15_000;
const BLOCKHASH_CACHE_TTL_MS = 3_000;

const poolContextCache = new Map<string, TimedPromiseCacheEntry<BonkPoolContext>>();
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
  const hintedPool = String(input.tokenInfo?.pool_pair || '').trim();
  if (hintedPool) return new PublicKey(hintedPool);
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const quoteMint = new PublicKey(input.side === 'buy' ? input.inputMint : input.outputMint);
  return deriveBonkPoolPda(baseMint, quoteMint);
}

async function loadPoolContext(input: SolanaTradeRequest): Promise<BonkPoolContext> {
  const poolAddress = resolvePoolAddress(input);
  return await rememberTimedPromise(poolContextCache, poolAddress.toBase58(), POOL_CONTEXT_CACHE_TTL_MS, async () => {
    const connection = await input.runtime.getConnection();
    const poolAccountInfo = await connection.getAccountInfo(poolAddress, 'confirmed');
    if (!poolAccountInfo?.data) throw new Error('Bonk pool account not found');
    if (!poolAccountInfo.owner.equals(BONK_PROGRAM_ID)) {
      throw new Error('tokenInfo.pool_pair is not a Bonk pool');
    }
    const poolState = parseBonkPoolState(poolAccountInfo.data, poolAddress);
    const [baseTokenProgram, quoteTokenProgram] = await Promise.all([
      getMintProgramId(input.runtime, poolState.baseMint),
      getMintProgramId(input.runtime, poolState.quoteMint),
    ]);
    return { poolState, baseTokenProgram, quoteTokenProgram };
  });
}

function validateTradePair(input: SolanaTradeRequest, poolState: BonkPoolState): void {
  const inputMint = new PublicKey(input.inputMint);
  const outputMint = new PublicKey(input.outputMint);
  const isBuyPair = inputMint.equals(poolState.quoteMint) && outputMint.equals(poolState.baseMint);
  const isSellPair = inputMint.equals(poolState.baseMint) && outputMint.equals(poolState.quoteMint);
  if (!isBuyPair && !isSellPair) {
    throw new Error('Input/output mint does not match Bonk pool');
  }
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
  tokenMinOutWei: string;
  recentBlockhash: string;
}> {
  const user = new PublicKey(input.ownerAddress);
  const { poolState, baseTokenProgram, quoteTokenProgram } = await loadPoolContext(input);
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
  const [inputAtaExists, outputAtaExists] = await Promise.all([
    loadAccountExists(input, userInputAccount),
    loadAccountExists(input, userOutputAccount),
  ]);
  const inputIsNative = isSolanaNativeMint(inputMint.toBase58());
  const outputIsNative = isSolanaNativeMint(outputMint.toBase58());
  const minimumAmountOut = isBuy
    ? computeBonkBuyMinimumAmountOut({
      amountIn,
      virtualBase: poolState.virtualBase,
      virtualQuote: poolState.virtualQuote,
      realBase: poolState.realBase,
      realQuote: poolState.realQuote,
      slippageBps: input.slippageBps,
    })
    : computeBonkSellMinimumAmountOut({
      amountIn,
      virtualBase: poolState.virtualBase,
      virtualQuote: poolState.virtualQuote,
      realBase: poolState.realBase,
      realQuote: poolState.realQuote,
      slippageBps: input.slippageBps,
    });

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  if (!inputAtaExists) {
    if (!inputIsNative) throw new Error('Bonk input token account not found');
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: inputMint,
      associatedToken: userInputAccount,
      tokenProgramId: inputTokenProgram,
    }));
  }
  if (!outputAtaExists) {
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: outputMint,
      associatedToken: userOutputAccount,
      tokenProgramId: outputTokenProgram,
    }));
  }
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
  const { poolState, baseTokenProgram, quoteTokenProgram } = await loadPoolContext(request);
  const tasks: Array<Promise<unknown>> = [loadLatestBlockhash(request, true)];
  if (ownerAddress) {
    const user = new PublicKey(ownerAddress);
    tasks.push(prewarmAtaExistence(request, [
      findAta({ mint: poolState.baseMint, owner: user, tokenProgramId: baseTokenProgram }),
      findAta({ mint: poolState.quoteMint, owner: user, tokenProgramId: quoteTokenProgram }),
    ]));
  }
  await Promise.all(tasks);
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
    if (!hinted) return false;
    try {
      const { poolState } = await loadPoolContext(input);
      validateTradePair(input, poolState);
      return true;
    } catch {
      return false;
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    if (!(await this.supportsTrade(input))) {
      throw new Error('Bonk adapter cannot handle this trade');
    }
    const { transaction, tokenMinOutWei, recentBlockhash } = await buildTransaction(input);
    return {
      source: 'bonk',
      transaction,
      tokenMinOutWei,
      blockhash: recentBlockhash,
    };
  },
};
