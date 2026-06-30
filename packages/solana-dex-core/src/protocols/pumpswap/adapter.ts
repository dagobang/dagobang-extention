import type { Buffer } from 'buffer';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { isSolanaNativeMint, normalizeSolanaPlatform, SOLANA_NATIVE_MINT } from '../../constants';
import type { SolanaBuiltTransaction, SolanaTradeAdapter, SolanaTradeRequest } from '../../types';
import {
  applyBps,
  buildCloseTokenAccountInstruction,
  buildWrapNativeInstructions,
  createAtaIdempotentInstruction,
  findAta,
  getMintProgramId,
} from '../../utils';
import {
  parsePumpSwapGlobalState,
  parsePumpSwapPoolState,
  parsePumpSwapTokenAccountBalance,
} from './codec';
import {
  PUMPSWAP_EVENT_AUTHORITY,
  PUMPSWAP_EXTRA_FEE_RECIPIENTS,
  PUMPSWAP_FEE_CONFIG,
  PUMPSWAP_FEE_PROGRAM,
  PUMPSWAP_GLOBAL_ACCOUNT,
  PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMPSWAP_MAYHEM_FEE_RECIPIENTS,
  PUMPSWAP_PROGRAM_ID,
  PUMPSWAP_PROTOCOL_FEE_RECIPIENT,
} from './constants';
import {
  derivePumpSwapCreatorVaultPda,
  derivePumpSwapPoolPda,
  derivePumpSwapPoolV2Pda,
  derivePumpSwapUserVolumeAccumulatorPda,
} from './pda';
import {
  buildPumpSwapInstructionData,
  computePumpSwapBuyBaseAmountOut,
  computePumpSwapSolAmount,
} from './quote';
import type { PumpSwapPoolContext } from './types';

const STATIC_POOL_CONTEXT_CACHE_TTL_MS = 60_000;
const RESERVE_CACHE_TTL_MS = 1_500;
const TURBO_RESERVE_CACHE_TTL_MS = 5_000;
const ATA_EXISTS_CACHE_TTL_MS = 15_000;
const ATA_EXISTS_FALSE_CACHE_TTL_MS = 1_000;
const BLOCKHASH_CACHE_TTL_MS = 3_000;
const PUMPSWAP_COMPUTE_UNIT_LIMIT = 300_000;
const SOLANA_VERSIONED_TX_MAX_BYTES = 1232;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PUMPSWAP_DEBUG_SERVER_URL = 'http://127.0.0.1:7777/event';
const PUMPSWAP_DEBUG_SESSION_ID = 'pumpswap-offcurve';
const TURBO_PRIORITY_FEE_SOL_BY_PRESET: Record<string, string> = {
  slow: '0.000025',
  standard: '0.00004',
  fast: '0.0001',
  turbo: '0.00015',
};

type TimedPromiseCacheEntry<T> = {
  promise: Promise<T>;
  expiresAt: number;
};

type CachedBlockhashValue = {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
};

type AccountExistsBatchOptions = {
  forceFresh?: boolean;
  commitment?: 'processed' | 'confirmed';
  cacheTrueTtlMs?: number;
  cacheFalseTtlMs?: number;
};

type PumpSwapStaticContext = Pick<PumpSwapPoolContext, 'poolAddress' | 'poolState' | 'globalState'>;
type PumpSwapReserveSnapshot = Pick<PumpSwapPoolContext, 'baseReserve' | 'quoteReserve'>;

const staticPoolContextCache = new Map<string, TimedPromiseCacheEntry<PumpSwapStaticContext>>();
const reserveCache = new Map<string, TimedPromiseCacheEntry<PumpSwapReserveSnapshot>>();
const reserveTurboCache = new Map<string, TimedPromiseCacheEntry<PumpSwapReserveSnapshot>>();
const ataExistsCache = new Map<string, TimedPromiseCacheEntry<boolean>>();
const latestBlockhashCache = new Map<string, TimedPromiseCacheEntry<CachedBlockhashValue>>();
let turboMemoNonce = 0;

function pickFirstConfiguredAddress(addresses: readonly PublicKey[]): PublicKey | null {
  for (const address of addresses) {
    if (!address.equals(PublicKey.default)) return address;
  }
  return null;
}

function pickRandomAddress(addresses: readonly PublicKey[]): PublicKey | null {
  const candidates = addresses.filter((address) => !address.equals(PublicKey.default));
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0]!;
}

function getOrCreateTimedPromise<T>(
  cache: Map<string, TimedPromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  const promise = loader().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, {
    promise,
    expiresAt: now + ttlMs,
  });
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

function resolveExecutionMode(input: SolanaTradeRequest): 'default' | 'turbo' {
  return (input.rawInput as any)?.executionModeOverride === 'turbo' ? 'turbo' : 'default';
}

function createTurboMemoInstruction(input: SolanaTradeRequest): TransactionInstruction | null {
  if (resolveExecutionMode(input) !== 'turbo') return null;
  turboMemoNonce = (turboMemoNonce + 1) % Number.MAX_SAFE_INTEGER;
  const requestId = String((input.rawInput as any)?.__debugSubmitGapId || '').trim() || 'na';
  const memo = `dagobang:${input.side}:${Date.now().toString(36)}:${turboMemoNonce.toString(36)}:${requestId}`;
  const data = new TextEncoder().encode(memo) as unknown as Buffer;
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data,
  });
}

function parseSolToLamports(raw: string): bigint | null {
  const value = String(raw || '').trim();
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [wholePart, fractionPart = ''] = value.split('.');
  const whole = BigInt(wholePart || '0');
  const fraction = BigInt((fractionPart.padEnd(9, '0')).slice(0, 9) || '0');
  return (whole * 1_000_000_000n) + fraction;
}

function buildPriorityFeeInstructions(input: SolanaTradeRequest): TransactionInstruction[] {
  const rawInput = (input.rawInput ?? {}) as Record<string, unknown>;
  const configured = typeof rawInput.priorityFeeNative === 'string' ? rawInput.priorityFeeNative.trim() : '';
  const gasPreset = typeof rawInput.gasPreset === 'string' ? rawInput.gasPreset.trim().toLowerCase() : 'standard';
  const fallback = resolveExecutionMode(input) === 'turbo'
    ? (TURBO_PRIORITY_FEE_SOL_BY_PRESET[gasPreset] ?? TURBO_PRIORITY_FEE_SOL_BY_PRESET.standard)
    : '';
  const configuredLamports = configured ? parseSolToLamports(configured) : null;
  const effectivePriorityFeeNative = configuredLamports && configuredLamports > 0n
    ? configured
    : fallback;
  const lamports = parseSolToLamports(effectivePriorityFeeNative);
  if (!lamports || lamports <= 0n) {
    // #region debug-point D:pumpswap-priority-fee-none
    reportPumpSwapDebug('D', 'pumpswap/adapter.ts:buildPriorityFeeInstructions:none', '[DEBUG] pumpswap priority fee skipped', {
      side: input.side,
      executionMode: resolveExecutionMode(input),
      gasPreset,
      configuredPriorityFeeNative: configured || null,
      fallbackPriorityFeeNative: fallback || null,
      effectivePriorityFeeNative: effectivePriorityFeeNative || null,
    });
    // #endregion
    return [];
  }
  let microLamports = (lamports * 1_000_000n) / BigInt(PUMPSWAP_COMPUTE_UNIT_LIMIT);
  if (microLamports <= 0n) microLamports = 1n;
  // #region debug-point D:pumpswap-priority-fee-applied
  reportPumpSwapDebug('D', 'pumpswap/adapter.ts:buildPriorityFeeInstructions:applied', '[DEBUG] pumpswap priority fee applied', {
    side: input.side,
    executionMode: resolveExecutionMode(input),
    gasPreset,
    configuredPriorityFeeNative: configured || null,
    fallbackPriorityFeeNative: fallback || null,
    effectivePriorityFeeNative: effectivePriorityFeeNative || null,
    lamports: lamports.toString(),
    computeUnitLimit: PUMPSWAP_COMPUTE_UNIT_LIMIT,
    microLamports: microLamports.toString(),
  });
  // #endregion
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PUMPSWAP_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

function isPumpSwapCompatiblePlatform(platform: string): boolean {
  return [
    'pump',
    'pumpswap',
    'pump_swap',
    'pumpamm',
    'pump amm',
    'pumpfun',
    'pump.fun',
  ].includes(platform);
}

// #region debug-point A:report
function reportPumpSwapDebug(hypothesisId: string, location: string, msg: string, data: Record<string, unknown>): void {
  fetch(PUMPSWAP_DEBUG_SERVER_URL, {
    method: 'POST',
    body: JSON.stringify({
      sessionId: PUMPSWAP_DEBUG_SESSION_ID,
      runId: 'post-fix',
      hypothesisId,
      location,
      msg,
      data,
      ts: Date.now(),
    }),
  }).catch(() => { });
}

function tracedFindAta(label: string, params: {
  mint: PublicKey;
  owner: PublicKey;
  tokenProgramId?: PublicKey;
  allowOwnerOffCurve?: boolean;
}): PublicKey {
  reportPumpSwapDebug('A', 'pumpswap/adapter.ts:tracedFindAta:start', '[DEBUG] pumpswap ata derivation start', {
    label,
    mint: params.mint.toBase58(),
    owner: params.owner.toBase58(),
    tokenProgramId: params.tokenProgramId?.toBase58() || TOKEN_PROGRAM_ID.toBase58(),
    allowOwnerOffCurve: params.allowOwnerOffCurve ?? false,
  });
  try {
    const ata = findAta(params);
    reportPumpSwapDebug('A', 'pumpswap/adapter.ts:tracedFindAta:done', '[DEBUG] pumpswap ata derivation done', {
      label,
      ata: ata.toBase58(),
    });
    return ata;
  } catch (error: any) {
    reportPumpSwapDebug('A', 'pumpswap/adapter.ts:tracedFindAta:error', '[DEBUG] pumpswap ata derivation failed', {
      label,
      mint: params.mint.toBase58(),
      owner: params.owner.toBase58(),
      tokenProgramId: params.tokenProgramId?.toBase58() || TOKEN_PROGRAM_ID.toBase58(),
      allowOwnerOffCurve: params.allowOwnerOffCurve ?? false,
      errorName: String(error?.name || ''),
      errorMessage: String(error?.message || ''),
    });
    throw error;
  }
}
// #endregion

async function loadPoolContext(input: SolanaTradeRequest): Promise<PumpSwapPoolContext> {
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const key = baseMint.toBase58();
  const staticContext = await getOrCreateTimedPromise(
    staticPoolContextCache,
    key,
    STATIC_POOL_CONTEXT_CACHE_TTL_MS,
    async () => {
      const poolV2Address = derivePumpSwapPoolV2Pda(baseMint);
      const canonicalPoolAddress = derivePumpSwapPoolPda(baseMint);
      const quoteMint = new PublicKey(SOLANA_NATIVE_MINT);
      // #region debug-point B:pool-candidates
      reportPumpSwapDebug('B', 'pumpswap/adapter.ts:loadPoolContext:start', '[DEBUG] pumpswap pool lookup start', {
        side: input.side,
        baseMint: baseMint.toBase58(),
        quoteMint: quoteMint.toBase58(),
        platform: resolvePlatform(input),
        tokenInfoPoolPair: String((input.tokenInfo as any)?.pool_pair || ''),
        tokenInfoBiggestPoolAddress: String((input.tokenInfo as any)?.biggest_pool_address || ''),
        tokenInfoTpoolPoolAddress: String((input.tokenInfo as any)?.tpool_pool_address || ''),
        poolV2Address: poolV2Address.toBase58(),
        canonicalPoolAddress: canonicalPoolAddress.toBase58(),
      });
      // #endregion
      const connection = await input.runtime.getConnection();
      const [globalInfo, poolV2Info, canonicalPoolInfo] = await connection.getMultipleAccountsInfo(
        [PUMPSWAP_GLOBAL_ACCOUNT, poolV2Address, canonicalPoolAddress],
        'confirmed',
      );
      if (!globalInfo?.data) throw new Error('PumpSwap global account not found');

      const globalState = parsePumpSwapGlobalState(globalInfo.data);
      let poolAddress: PublicKey | null = null;
      let poolState = null;
      for (const candidate of [
        { address: poolV2Address, info: poolV2Info },
        { address: canonicalPoolAddress, info: canonicalPoolInfo },
      ]) {
        if (!candidate.info?.data) continue;
        try {
          const parsed = parsePumpSwapPoolState(candidate.info.data);
          // #region debug-point B:pool-candidate
          reportPumpSwapDebug('B', 'pumpswap/adapter.ts:loadPoolContext:candidate', '[DEBUG] pumpswap pool candidate parsed', {
            address: candidate.address.toBase58(),
            parsedBaseMint: parsed.baseMint.toBase58(),
            parsedQuoteMint: parsed.quoteMint.toBase58(),
            poolBaseTokenAccount: parsed.poolBaseTokenAccount.toBase58(),
            poolQuoteTokenAccount: parsed.poolQuoteTokenAccount.toBase58(),
            coinCreator: parsed.coinCreator.toBase58(),
          });
          // #endregion
          if (parsed.baseMint.equals(baseMint) && parsed.quoteMint.equals(quoteMint)) {
            poolAddress = candidate.address;
            poolState = parsed;
            break;
          }
        } catch {
        }
      }
      if (!poolAddress || !poolState) throw new Error('PumpSwap pool account not found');
      // #region debug-point B:pool-selected
      reportPumpSwapDebug('B', 'pumpswap/adapter.ts:loadPoolContext:selected', '[DEBUG] pumpswap pool selected', {
        poolAddress: poolAddress.toBase58(),
        poolBaseTokenAccount: poolState.poolBaseTokenAccount.toBase58(),
        poolQuoteTokenAccount: poolState.poolQuoteTokenAccount.toBase58(),
        coinCreator: poolState.coinCreator.toBase58(),
      });
      // #endregion
      return {
        poolAddress,
        poolState,
        globalState,
      };
    },
  );
  const reserves = await getOrCreateTimedPromise(
    resolveExecutionMode(input) === 'turbo' ? reserveTurboCache : reserveCache,
    staticContext.poolAddress.toBase58(),
    resolveExecutionMode(input) === 'turbo' ? TURBO_RESERVE_CACHE_TTL_MS : RESERVE_CACHE_TTL_MS,
    async () => {
      const connection = await input.runtime.getConnection();
      const reserveInfos = await connection.getMultipleAccountsInfo(
        [staticContext.poolState.poolBaseTokenAccount, staticContext.poolState.poolQuoteTokenAccount],
        'confirmed',
      );
      const [baseReserveInfo, quoteReserveInfo] = reserveInfos;
      if (!baseReserveInfo?.data || !quoteReserveInfo?.data) {
        throw new Error('PumpSwap reserve vaults not found');
      }
      const snapshot = {
        baseReserve: parsePumpSwapTokenAccountBalance(baseReserveInfo.data),
        quoteReserve: parsePumpSwapTokenAccountBalance(quoteReserveInfo.data),
      };
      reportPumpSwapDebug('B', 'pumpswap/adapter.ts:loadPoolContext:reserves', '[DEBUG] pumpswap reserve snapshot loaded', {
        poolAddress: staticContext.poolAddress.toBase58(),
        baseReserve: snapshot.baseReserve.toString(),
        quoteReserve: snapshot.quoteReserve.toString(),
        executionMode: resolveExecutionMode(input),
      });
      return snapshot;
    },
  );
  return {
    ...staticContext,
    ...reserves,
  };
}

async function loadAccountExistsBatch(
  input: SolanaTradeRequest,
  accounts: PublicKey[],
  options: AccountExistsBatchOptions = {},
): Promise<Map<string, boolean>> {
  const uniqueAccounts = Array.from(new Map(accounts.map((account) => [account.toBase58(), account])).values());
  const now = Date.now();
  const commitment = options.commitment ?? 'confirmed';
  const cacheTrueTtlMs = options.cacheTrueTtlMs ?? ATA_EXISTS_CACHE_TTL_MS;
  const cacheFalseTtlMs = options.cacheFalseTtlMs ?? ATA_EXISTS_FALSE_CACHE_TTL_MS;
  const promises = new Map<string, Promise<boolean>>();
  const missingAccounts: PublicKey[] = [];
  for (const account of uniqueAccounts) {
    const key = account.toBase58();
    const cached = !options.forceFresh ? getFreshTimedPromise(ataExistsCache, key, now) : null;
    if (cached) {
      // #region debug-point E:ata-cache-hit
      reportPumpSwapDebug('E', 'pumpswap/adapter.ts:loadAccountExistsBatch:cacheHit', '[DEBUG] pumpswap ata existence cache hit', {
        side: input.side,
        account: key,
        ownerAddress: input.ownerAddress,
        commitment,
      });
      // #endregion
      promises.set(key, cached);
      continue;
    }
    missingAccounts.push(account);
  }

  if (missingAccounts.length > 0) {
    const missingKeys = missingAccounts.map((account) => account.toBase58());
    const batchPromise = (async () => {
      const connection = await input.runtime.getConnection();
      // #region debug-point E:ata-batch-fetch-start
      reportPumpSwapDebug('E', 'pumpswap/adapter.ts:loadAccountExistsBatch:fetchStart', '[DEBUG] pumpswap ata existence batch fetch start', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        commitment,
        forceFresh: !!options.forceFresh,
        accounts: missingKeys,
      });
      // #endregion
      const infos = await connection.getMultipleAccountsInfo(missingAccounts, commitment);
      // #region debug-point E:ata-batch-fetch-done
      reportPumpSwapDebug('E', 'pumpswap/adapter.ts:loadAccountExistsBatch:fetchDone', '[DEBUG] pumpswap ata existence batch fetch done', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        commitment,
        forceFresh: !!options.forceFresh,
        results: missingKeys.map((key, index) => ({
          account: key,
          exists: !!infos[index],
        })),
      });
      // #endregion
      return infos.map((info) => !!info);
    })().catch((error) => {
      for (const key of missingKeys) ataExistsCache.delete(key);
      throw error;
    });
    for (const [index, account] of missingAccounts.entries()) {
      const key = account.toBase58();
      const promise = batchPromise.then((results) => results[index] ?? false);
      promise.then((exists) => {
        ataExistsCache.set(key, {
          promise: Promise.resolve(exists),
          expiresAt: Date.now() + (exists ? cacheTrueTtlMs : cacheFalseTtlMs),
        });
      }).catch(() => {
        ataExistsCache.delete(key);
      });
      ataExistsCache.set(key, {
        promise,
        expiresAt: now + Math.max(cacheTrueTtlMs, cacheFalseTtlMs),
      });
      promises.set(key, promise);
    }
  }

  const entries = await Promise.all(
    uniqueAccounts.map(async (account) => {
      const key = account.toBase58();
      return [key, await (promises.get(key) ?? Promise.resolve(false))] as const;
    }),
  );
  return new Map(entries);
}

async function prewarmBuildAccounts(input: SolanaTradeRequest, params: {
  ownerAddress?: string;
  baseMint: PublicKey;
  baseTokenProgram: PublicKey;
}): Promise<void> {
  const ownerAddress = String(params.ownerAddress || '').trim();
  if (!ownerAddress) return;
  const user = new PublicKey(ownerAddress);
  const quoteMint = new PublicKey(SOLANA_NATIVE_MINT);
  await loadAccountExistsBatch(input, [
    findAta({ mint: params.baseMint, owner: user, tokenProgramId: params.baseTokenProgram }),
    findAta({ mint: quoteMint, owner: user, tokenProgramId: TOKEN_PROGRAM_ID }),
  ], {
    commitment: 'processed',
    cacheFalseTtlMs: ATA_EXISTS_FALSE_CACHE_TTL_MS,
  });
}

async function prewarmLatestBlockhash(input: SolanaTradeRequest): Promise<CachedBlockhashValue> {
  const requestId = String((input.rawInput as any)?.__debugSubmitGapId || '').trim() || null;
  if (requestId) {
    fetch('http://127.0.0.1:7779/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-submit-gap',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'pumpswap/adapter.ts:loadLatestBlockhash:start',
        msg: '[DEBUG] submit gap load latest blockhash start',
        data: { requestId, side: input.side, ownerAddress: input.ownerAddress },
        ts: Date.now(),
      }),
    }).catch(() => { });
  }
  const startedAt = Date.now();
  const key = 'confirmed';
  const result = await getOrCreateTimedPromise(
    latestBlockhashCache,
    key,
    BLOCKHASH_CACHE_TTL_MS,
    async () => {
      const connection = await input.runtime.getConnection();
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      return {
        blockhash,
        lastValidBlockHeight,
        fetchedAt: Date.now(),
      };
    },
  );
  if (requestId) {
    fetch('http://127.0.0.1:7779/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-submit-gap',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'pumpswap/adapter.ts:loadLatestBlockhash:done',
        msg: '[DEBUG] submit gap load latest blockhash done',
        data: { requestId, side: input.side, ownerAddress: input.ownerAddress, elapsedMs: Date.now() - startedAt, blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight },
        ts: Date.now(),
      }),
    }).catch(() => { });
  }
  return result;
}

async function loadFreshLatestBlockhash(input: SolanaTradeRequest): Promise<CachedBlockhashValue> {
  const requestId = String((input.rawInput as any)?.__debugSubmitGapId || '').trim() || null;
  if (requestId) {
    fetch('http://127.0.0.1:7779/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-submit-gap',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'pumpswap/adapter.ts:loadLatestBlockhash:start',
        msg: '[DEBUG] submit gap load latest blockhash start',
        data: { requestId, side: input.side, ownerAddress: input.ownerAddress, fresh: true },
        ts: Date.now(),
      }),
    }).catch(() => { });
  }
  const startedAt = Date.now();
  const connection = await input.runtime.getConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const result = {
    blockhash,
    lastValidBlockHeight,
    fetchedAt: Date.now(),
  };
  if (requestId) {
    fetch('http://127.0.0.1:7779/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-submit-gap',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'pumpswap/adapter.ts:loadLatestBlockhash:done',
        msg: '[DEBUG] submit gap load latest blockhash done',
        data: { requestId, side: input.side, ownerAddress: input.ownerAddress, elapsedMs: Date.now() - startedAt, blockhash, lastValidBlockHeight, fresh: true },
        ts: Date.now(),
      }),
    }).catch(() => { });
  }
  return result;
}

async function buildTransaction(input: SolanaTradeRequest): Promise<{
  transaction: VersionedTransaction;
  tokenMinOutWei: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}> {
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const quoteMint = new PublicKey(SOLANA_NATIVE_MINT);
  const user = new PublicKey(input.ownerAddress);
  const blockhashPromise = resolveExecutionMode(input) === 'turbo'
    ? prewarmLatestBlockhash(input)
    : loadFreshLatestBlockhash(input);
  const [ctx, baseTokenProgram] = await Promise.all([
    loadPoolContext(input),
    getMintProgramId(input.runtime, baseMint),
  ]);
  if (!ctx.poolState.quoteMint.equals(quoteMint)) {
    throw new Error('PumpSwap pool quote mint is not WSOL');
  }
  if (!ctx.poolState.baseMint.equals(baseMint)) {
    throw new Error('PumpSwap pool base mint mismatch');
  }

  // #region debug-point C:build-start
  reportPumpSwapDebug('C', 'pumpswap/adapter.ts:buildTransaction:start', '[DEBUG] pumpswap build transaction start', {
    side: input.side,
    ownerAddress: input.ownerAddress,
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    poolAddress: ctx.poolAddress.toBase58(),
    coinCreator: ctx.poolState.coinCreator.toBase58(),
    amount: input.amount,
    tokenInfoPoolPair: String((input.tokenInfo as any)?.pool_pair || ''),
    tokenInfoTpoolPoolAddress: String((input.tokenInfo as any)?.tpool_pool_address || ''),
  });
  // #endregion
  const creatorVault = derivePumpSwapCreatorVaultPda(ctx.poolState.coinCreator);
  const creatorVaultAta = tracedFindAta('creatorVaultAta', {
    mint: quoteMint,
    owner: creatorVault,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const feeRecipient = ctx.poolState.isMayhemMode
    ? pickRandomAddress(PUMPSWAP_MAYHEM_FEE_RECIPIENTS)
    : pickFirstConfiguredAddress(ctx.globalState.protocolFeeRecipients) ?? PUMPSWAP_PROTOCOL_FEE_RECIPIENT;
  if (!feeRecipient) throw new Error('PumpSwap fee recipient unavailable');
  const feeRecipientAta = tracedFindAta('feeRecipientAta', {
    mint: quoteMint,
    owner: feeRecipient,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const buybackFeeRecipient = pickFirstConfiguredAddress(ctx.globalState.buybackFeeRecipients)
    ?? pickFirstConfiguredAddress(PUMPSWAP_EXTRA_FEE_RECIPIENTS)
    ?? null;
  const buybackFeeRecipientAta = buybackFeeRecipient
    ? tracedFindAta('buybackFeeRecipientAta', {
      mint: quoteMint,
      owner: buybackFeeRecipient,
      allowOwnerOffCurve: true,
      tokenProgramId: TOKEN_PROGRAM_ID,
    })
    : null;
  const userBaseAta = tracedFindAta('userBaseAta', { mint: baseMint, owner: user, tokenProgramId: baseTokenProgram });
  const userQuoteAta = tracedFindAta('userQuoteAta', { mint: quoteMint, owner: user, tokenProgramId: TOKEN_PROGRAM_ID });
  const userVolumeAccumulator = derivePumpSwapUserVolumeAccumulatorPda(user);
  const userVolumeAccumulatorQuoteAta = ctx.poolState.isCashbackCoin
    ? tracedFindAta('userVolumeAccumulatorQuoteAta', {
      mint: quoteMint,
      owner: userVolumeAccumulator,
      allowOwnerOffCurve: true,
      tokenProgramId: TOKEN_PROGRAM_ID,
    })
    : null;
  const poolV2Address = !ctx.poolState.coinCreator.equals(PublicKey.default)
    ? derivePumpSwapPoolV2Pda(baseMint)
    : null;
  // #region debug-point D:pda-summary
  reportPumpSwapDebug('D', 'pumpswap/adapter.ts:buildTransaction:pdas', '[DEBUG] pumpswap pda summary', {
    creatorVault: creatorVault.toBase58(),
    creatorVaultAta: creatorVaultAta.toBase58(),
    feeRecipient: feeRecipient.toBase58(),
    feeRecipientAta: feeRecipientAta.toBase58(),
    buybackFeeRecipient: buybackFeeRecipient?.toBase58() || null,
    buybackFeeRecipientAta: buybackFeeRecipientAta?.toBase58() || null,
    userBaseAta: userBaseAta.toBase58(),
    userQuoteAta: userQuoteAta.toBase58(),
    userVolumeAccumulator: userVolumeAccumulator.toBase58(),
    userVolumeAccumulatorQuoteAta: userVolumeAccumulatorQuoteAta?.toBase58() || null,
    poolV2Address: poolV2Address?.toBase58() || null,
  });
  // #endregion

  const amountIn = BigInt(input.amount);
  const isBuy = input.side === 'buy';
  const hasCreatorFee = !ctx.poolState.coinCreator.equals(PublicKey.default);
  const quotedTokenAmount = isBuy
    ? computePumpSwapBuyBaseAmountOut({
      quoteAmountIn: amountIn,
      baseReserve: ctx.baseReserve,
      quoteReserve: ctx.quoteReserve,
      hasCreatorFee,
    })
    : 0n;
  const minBaseAmountOut = isBuy
    ? applyBps(quotedTokenAmount, BigInt(input.slippageBps), 'subtract')
    : 0n;
  const quoteLimitAmount = computePumpSwapSolAmount({
    side: input.side,
    amountIn,
    baseReserve: ctx.baseReserve,
    quoteReserve: ctx.quoteReserve,
    slippageBps: input.slippageBps,
    hasCreatorFee,
  });
  // Live PumpSwap on this migrated route rejects buy_exact_quote_in (Custom 101 / 0x65).
  // Keep buy on the legacy discriminator until runtime evidence proves otherwise.
  const useExactQuoteIn = false;
  const tokenAmount = isBuy
    ? (useExactQuoteIn ? minBaseAmountOut : quotedTokenAmount)
    : amountIn;
  const solAmount = isBuy
    ? (useExactQuoteIn ? amountIn : quoteLimitAmount)
    : quoteLimitAmount;
  const wrapAmount = isBuy ? solAmount : 0n;
  // #region debug-point D:amount-summary
  reportPumpSwapDebug('D', 'pumpswap/adapter.ts:buildTransaction:amounts', '[DEBUG] pumpswap amount summary', {
    side: input.side,
    amountIn: amountIn.toString(),
    quotedTokenAmount: quotedTokenAmount.toString(),
    minBaseAmountOut: minBaseAmountOut.toString(),
    tokenAmount: tokenAmount.toString(),
    solAmount: solAmount.toString(),
    wrapAmount: wrapAmount.toString(),
    quoteLimitAmount: quoteLimitAmount.toString(),
    baseReserve: ctx.baseReserve.toString(),
    quoteReserve: ctx.quoteReserve.toString(),
    slippageBps: input.slippageBps,
    hasCreatorFee,
    isCashbackCoin: ctx.poolState.isCashbackCoin,
    useExactQuoteIn,
  });
  // #endregion

  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];
  preInstructions.push(...buildPriorityFeeInstructions(input));
  const memoInstruction = createTurboMemoInstruction(input);
  if (memoInstruction) preInstructions.push(memoInstruction);
  const accountExists = await loadAccountExistsBatch(input, [userBaseAta, userQuoteAta], {
    commitment: isBuy ? 'confirmed' : 'processed',
    cacheFalseTtlMs: isBuy ? ATA_EXISTS_FALSE_CACHE_TTL_MS : 250,
  });
  let userBaseAtaExists = accountExists.get(userBaseAta.toBase58()) ?? false;
  const userQuoteAtaExists = accountExists.get(userQuoteAta.toBase58()) ?? false;
  // #region debug-point E:sell-ata-check
  reportPumpSwapDebug('E', 'pumpswap/adapter.ts:buildTransaction:ataCheck', '[DEBUG] pumpswap user ata existence checked', {
    side: input.side,
    ownerAddress: input.ownerAddress,
    userBaseAta: userBaseAta.toBase58(),
    userBaseAtaExists,
    userQuoteAta: userQuoteAta.toBase58(),
    userQuoteAtaExists,
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseTokenProgram: baseTokenProgram.toBase58(),
    quoteTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
  });
  // #endregion

  if (!userBaseAtaExists) {
    if (isBuy) {
      preInstructions.push(createAtaIdempotentInstruction({
        payer: user,
        owner: user,
        mint: baseMint,
        associatedToken: userBaseAta,
        tokenProgramId: baseTokenProgram,
      }));
    } else {
      // #region debug-point E:sell-missing-token-account
      reportPumpSwapDebug('E', 'pumpswap/adapter.ts:buildTransaction:sellMissingTokenAccount', '[DEBUG] pumpswap sell missing token account before submit', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        userBaseAta: userBaseAta.toBase58(),
        baseMint: baseMint.toBase58(),
        baseTokenProgram: baseTokenProgram.toBase58(),
        tokenInfoPoolPair: String((input.tokenInfo as any)?.pool_pair || ''),
        tokenInfoTpoolPoolAddress: String((input.tokenInfo as any)?.tpool_pool_address || ''),
      });
      // #endregion
      const freshSellAccountExists = await loadAccountExistsBatch(input, [userBaseAta], {
        forceFresh: true,
        commitment: 'processed',
        cacheFalseTtlMs: 250,
      });
      userBaseAtaExists = freshSellAccountExists.get(userBaseAta.toBase58()) ?? false;
      // #region debug-point E:sell-fresh-recheck
      reportPumpSwapDebug('E', 'pumpswap/adapter.ts:buildTransaction:sellFreshRecheck', '[DEBUG] pumpswap sell missing token account fresh recheck', {
        side: input.side,
        ownerAddress: input.ownerAddress,
        userBaseAta: userBaseAta.toBase58(),
        userBaseAtaExistsAfterFreshRecheck: userBaseAtaExists,
        commitment: 'processed',
      });
      // #endregion
      if (!userBaseAtaExists) {
        throw new Error('PumpSwap sell requires existing token account');
      }
    }
  }

  if (!userQuoteAtaExists) {
    preInstructions.push(createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: quoteMint,
      associatedToken: userQuoteAta,
      tokenProgramId: TOKEN_PROGRAM_ID,
    }));
  }

  if (isBuy) {
    preInstructions.push(...buildWrapNativeInstructions({
      payer: user,
      nativeAta: userQuoteAta,
      lamports: wrapAmount,
      tokenProgramId: TOKEN_PROGRAM_ID,
    }));
  }

  const keys = [
    { pubkey: ctx.poolAddress, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: PUMPSWAP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: userBaseAta, isSigner: false, isWritable: true },
    { pubkey: userQuoteAta, isSigner: false, isWritable: true },
    { pubkey: ctx.poolState.poolBaseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: ctx.poolState.poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: false },
    { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
    { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: creatorVault, isSigner: false, isWritable: false },
    ...(isBuy
      ? [
        { pubkey: PUMPSWAP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      ]
      : []),
    { pubkey: PUMPSWAP_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_FEE_PROGRAM, isSigner: false, isWritable: false },
    ...(userVolumeAccumulatorQuoteAta
      ? isBuy
        ? [{ pubkey: userVolumeAccumulatorQuoteAta, isSigner: false, isWritable: true }]
        : [
          { pubkey: userVolumeAccumulatorQuoteAta, isSigner: false, isWritable: true },
          { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        ]
      : []),
    ...(poolV2Address
      ? [{ pubkey: poolV2Address, isSigner: false, isWritable: false }]
      : []),
    ...(buybackFeeRecipient && buybackFeeRecipientAta
      ? [
        { pubkey: buybackFeeRecipient, isSigner: false, isWritable: false },
        { pubkey: buybackFeeRecipientAta, isSigner: false, isWritable: true },
      ]
      : []),
  ];

  const swapInstruction = new TransactionInstruction({
    programId: PUMPSWAP_PROGRAM_ID,
    keys,
    data: buildPumpSwapInstructionData({
      side: input.side,
      tokenAmount,
      solAmount,
      trackVolume: isBuy ? ctx.poolState.isCashbackCoin : undefined,
      useExactQuoteIn,
    }),
  });

  postInstructions.push(buildCloseTokenAccountInstruction({
    account: userQuoteAta,
    destination: user,
    owner: user,
    tokenProgramId: TOKEN_PROGRAM_ID,
  }));

  const { blockhash, lastValidBlockHeight } = await blockhashPromise;
  const buildCompiledTransaction = (includeMemo: boolean) => {
    const activePreInstructions = memoInstruction && !includeMemo
      ? preInstructions.filter((instruction) => instruction !== memoInstruction)
      : preInstructions;
    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [...activePreInstructions, swapInstruction, ...postInstructions],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    return {
      activePreInstructions,
      transaction,
      serializedBytes: transaction.serialize().length,
    };
  };
  let compiled = buildCompiledTransaction(true);
  // #region debug-point D:tx-size
  reportPumpSwapDebug('D', 'pumpswap/adapter.ts:buildTransaction:txSize', '[DEBUG] pumpswap tx size built', {
    side: input.side,
    hasMemo: !!memoInstruction,
    preInstructionCount: compiled.activePreInstructions.length,
    postInstructionCount: postInstructions.length,
    serializedBytes: compiled.serializedBytes,
    maxBytes: SOLANA_VERSIONED_TX_MAX_BYTES,
  });
  // #endregion
  if (memoInstruction && compiled.serializedBytes > SOLANA_VERSIONED_TX_MAX_BYTES) {
    const withoutMemo = buildCompiledTransaction(false);
    // #region debug-point D:tx-size-memo-dropped
    reportPumpSwapDebug('D', 'pumpswap/adapter.ts:buildTransaction:memoDroppedForSize', '[DEBUG] pumpswap memo dropped for tx size', {
      side: input.side,
      beforeBytes: compiled.serializedBytes,
      afterBytes: withoutMemo.serializedBytes,
      maxBytes: SOLANA_VERSIONED_TX_MAX_BYTES,
      preInstructionCountBefore: compiled.activePreInstructions.length,
      preInstructionCountAfter: withoutMemo.activePreInstructions.length,
    });
    // #endregion
    compiled = withoutMemo;
  }
  return {
    transaction: compiled.transaction,
    tokenMinOutWei: isBuy ? minBaseAmountOut.toString() : solAmount.toString(),
    recentBlockhash: blockhash,
    lastValidBlockHeight,
  };
}

export const pumpswapTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'pumpswap',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['pumpswap', 'pump_swap', 'pumpamm', 'pump amm'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    if (platform && !isPumpSwapCompatiblePlatform(platform)) {
      // #region debug-point P3:pumpswap-platform-reject
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pump-direct-adapter',
          runId: 'pre-fix',
          hypothesisId: 'P3',
          location: 'pumpswap/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpswap platform rejected',
          data: { platform, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return false;
    }
    const isSupportedPair = input.side === 'buy'
      ? isSolanaNativeMint(input.inputMint) && !isSolanaNativeMint(input.outputMint)
      : !isSolanaNativeMint(input.inputMint) && isSolanaNativeMint(input.outputMint);
    if (!isSupportedPair) {
      // #region debug-point P3:pumpswap-pair-reject
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pump-direct-adapter',
          runId: 'pre-fix',
          hypothesisId: 'P3',
          location: 'pumpswap/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpswap pair rejected',
          data: { platform, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return false;
    }
    try {
      const ctx = await loadPoolContext(input);
      // #region debug-point P3:pumpswap-pool-ok
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pump-direct-adapter',
          runId: 'pre-fix',
          hypothesisId: 'P3',
          location: 'pumpswap/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpswap pool context loaded',
          data: {
            platform,
            side: input.side,
            baseMint: ctx.poolState.baseMint.toBase58(),
            quoteMint: ctx.poolState.quoteMint.toBase58(),
            poolAddress: ctx.poolAddress.toBase58(),
          },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return true;
    } catch (error: any) {
      // #region debug-point P3:pumpswap-load-failed
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pump-direct-adapter',
          runId: 'pre-fix',
          hypothesisId: 'P3',
          location: 'pumpswap/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpswap load pool failed',
          data: { platform, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint, error: String(error?.message || error || '') },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return false;
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    const plannedSource = String((input.rawInput as any)?.__plannedSource || '').trim().toLowerCase();
    if (plannedSource !== 'pumpswap' && !(await this.supportsTrade(input))) {
      throw new Error('PumpSwap adapter cannot handle this trade');
    }
    const { transaction, tokenMinOutWei, recentBlockhash, lastValidBlockHeight } = await buildTransaction(input);
    return {
      source: 'pumpswap',
      transaction,
      tokenMinOutWei,
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    };
  },
};

export async function prewarmPumpSwapTrade(input: {
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
  const baseMint = new PublicKey(tokenAddress);
  const baseTokenProgramPromise = getMintProgramId(request.runtime, baseMint);
  const ctxPromise = loadPoolContext(request);
  const [ctx, baseTokenProgram] = await Promise.all([ctxPromise, baseTokenProgramPromise]);
  const tasks: Array<Promise<unknown>> = [
    prewarmLatestBlockhash(request),
    Promise.resolve(derivePumpSwapCreatorVaultPda(ctx.poolState.coinCreator)),
  ];
  tasks.push(prewarmBuildAccounts(request, { ownerAddress, baseMint, baseTokenProgram }));
  await Promise.all(tasks);
}
