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
  createAtaIdempotentInstruction,
  findAta,
  getMintProgramId,
} from '../../utils';
import { parsePumpfunBondingCurveState, type PumpfunBondingCurveState } from './codec';
import {
  BUYBACK_FEE_RECIPIENT,
  MAYHEM_FEE_RECIPIENTS,
  NORMAL_FEE_RECIPIENT,
  PROTOCOL_EXTRA_FEE_RECIPIENTS,
  PUMP_FEES_PROGRAM_ID,
  PUMP_GLOBAL_ACCOUNT,
  PUMP_PROGRAM_ID,
  SHARING_CONFIG_ACCOUNT_DISCRIMINATOR,
  SHARING_CONFIG_STATUS_ACTIVE,
} from './constants';
import {
  derivePumpfunBondingCurvePda,
  derivePumpfunBondingCurveV2Pda,
  derivePumpfunCreatorVaultPda,
  derivePumpfunEventAuthorityPda,
  derivePumpfunFeeConfigPda,
  derivePumpfunGlobalVolumeAccumulatorPda,
  derivePumpfunSharingConfigPda,
  derivePumpfunUserVolumeAccumulatorPda,
} from './pda';
import {
  buildPumpfunBuyExactQuoteInV2InstructionData,
  buildPumpfunInstructionData,
  buildPumpfunLegacyBuyExactInInstructionData,
  buildPumpfunLegacySellInstructionData,
  computePumpfunBuyAmountOut,
  computePumpfunQuoteLimit,
} from './quote';

const BONDING_STATE_CACHE_TTL_MS = 3_000;
const TURBO_BONDING_STATE_CACHE_TTL_MS = 10_000;
// Creator vault and ATA existence change far less often than curve reserves, so keep them warm longer.
const CREATOR_VAULT_CACHE_TTL_MS = 60_000;
const ATA_EXISTS_CACHE_TTL_MS = 60_000;
const BLOCKHASH_CACHE_TTL_MS = 3_000;
const PUMPFUN_COMPUTE_UNIT_LIMIT = 250_000;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
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

const bondingStateCache = new Map<string, TimedPromiseCacheEntry<{ state: PumpfunBondingCurveState; bondingCurve: PublicKey }>>();
const bondingStateTurboCache = new Map<string, TimedPromiseCacheEntry<{ state: PumpfunBondingCurveState; bondingCurve: PublicKey }>>();
const creatorVaultCache = new Map<string, TimedPromiseCacheEntry<PublicKey>>();
const sharingConfigCreatorVaultCache = new Map<string, TimedPromiseCacheEntry<PublicKey | null>>();
const ataExistsCache = new Map<string, TimedPromiseCacheEntry<boolean>>();
const latestBlockhashCache = new Map<string, TimedPromiseCacheEntry<CachedBlockhashValue>>();
let turboMemoNonce = 0;

function pickRandomAddress(addresses: readonly PublicKey[]): PublicKey {
  if (!addresses.length) throw new Error('No address candidates available');
  return addresses[Math.floor(Math.random() * addresses.length)] ?? addresses[0]!;
}
const hasBytePrefix = (data: Uint8Array, prefix: Uint8Array) => (
  data.length >= prefix.length && prefix.every((value, index) => data[index] === value)
);

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
  cache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

function resolvePlatform(input: SolanaTradeRequest): string {
  return normalizeSolanaPlatform(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad);
}

function resolveExecutionMode(input: SolanaTradeRequest): 'default' | 'turbo' {
  return (input.rawInput as any)?.executionModeOverride === 'turbo' ? 'turbo' : 'default';
}

function getTokenInfoWarmFingerprint(input: SolanaTradeRequest): string {
  return [
    String(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad || '').toLowerCase(),
    String(input.tokenInfo?.launchpad_status ?? ''),
    String(input.tokenInfo?.quote_token_address || '').toLowerCase(),
  ].join('|');
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
    // #region debug-point D:pumpfun-priority-fee-none
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-trade-latency',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'pumpfun/adapter.ts:buildPriorityFeeInstructions:none',
        msg: '[DEBUG] pumpfun priority fee skipped',
        data: {
          side: input.side,
          executionMode: resolveExecutionMode(input),
          gasPreset,
          configuredPriorityFeeNative: configured || null,
          fallbackPriorityFeeNative: fallback || null,
          effectivePriorityFeeNative: effectivePriorityFeeNative || null,
        },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    return [];
  }
  let microLamports = (lamports * 1_000_000n) / BigInt(PUMPFUN_COMPUTE_UNIT_LIMIT);
  if (microLamports <= 0n) microLamports = 1n;
  // #region debug-point D:pumpfun-priority-fee-applied
  fetch('http://127.0.0.1:7777/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-trade-latency',
      runId: 'pre-fix',
      hypothesisId: 'D',
      location: 'pumpfun/adapter.ts:buildPriorityFeeInstructions:applied',
      msg: '[DEBUG] pumpfun priority fee applied',
      data: {
        side: input.side,
        executionMode: resolveExecutionMode(input),
        gasPreset,
        configuredPriorityFeeNative: configured || null,
        fallbackPriorityFeeNative: fallback || null,
          effectivePriorityFeeNative: effectivePriorityFeeNative || null,
        lamports: lamports.toString(),
        computeUnitLimit: PUMPFUN_COMPUTE_UNIT_LIMIT,
        microLamports: microLamports.toString(),
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PUMPFUN_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

async function loadBondingCurveState(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
): Promise<{ state: PumpfunBondingCurveState; bondingCurve: PublicKey }> {
  const mint = baseMint.toBase58();
  const isTurbo = resolveExecutionMode(input) === 'turbo';
  const tokenInfoFingerprint = getTokenInfoWarmFingerprint(input);
  const cacheKey = isTurbo
    ? `${mint}:${tokenInfoFingerprint || 'no-token-info'}`
    : mint;
  return await getOrCreateTimedPromise(
    isTurbo ? bondingStateTurboCache : bondingStateCache,
    cacheKey,
    isTurbo ? TURBO_BONDING_STATE_CACHE_TTL_MS : BONDING_STATE_CACHE_TTL_MS,
    async () => {
      const bondingCurve = derivePumpfunBondingCurvePda(baseMint);
      const connection = await input.runtime.getConnection();
      const info = await connection.getAccountInfo(bondingCurve, 'confirmed');
      if (!info?.data) throw new Error('Pumpfun bonding curve account not found');
      return {
        state: parsePumpfunBondingCurveState(info.data),
        bondingCurve,
      };
    },
  );
}

async function resolvePumpfunCreatorVault(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
  creator: PublicKey,
  opts?: { sharingConfigCreatorVaultPromise?: Promise<PublicKey | null> },
): Promise<PublicKey> {
  const key = `${baseMint.toBase58()}:${creator.toBase58()}`;
  return await getOrCreateTimedPromise(
    creatorVaultCache,
    key,
    CREATOR_VAULT_CACHE_TTL_MS,
    async () => {
      const sharingConfigCreatorVault = await (opts?.sharingConfigCreatorVaultPromise ?? loadSharingConfigCreatorVault(input, baseMint));
      return sharingConfigCreatorVault ?? derivePumpfunCreatorVaultPda(creator);
    },
  );
}

async function loadSharingConfigCreatorVault(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
): Promise<PublicKey | null> {
  const key = baseMint.toBase58();
  return await getOrCreateTimedPromise(
    sharingConfigCreatorVaultCache,
    key,
    CREATOR_VAULT_CACHE_TTL_MS,
    async () => {
      const sharingConfig = derivePumpfunSharingConfigPda(baseMint);
      const connection = await input.runtime.getConnection();
      const info = await connection.getAccountInfo(sharingConfig, 'confirmed');
      if (
        info?.owner.equals(PUMP_FEES_PROGRAM_ID)
        && info.data.length >= 43
        && hasBytePrefix(info.data, SHARING_CONFIG_ACCOUNT_DISCRIMINATOR)
        && info.data[10] === SHARING_CONFIG_STATUS_ACTIVE
        && new PublicKey(info.data.subarray(11, 43)).equals(baseMint)
      ) {
        return derivePumpfunCreatorVaultPda(sharingConfig);
      }
      return null;
    },
  );
}

async function loadAccountExists(
  input: SolanaTradeRequest,
  account: PublicKey,
): Promise<boolean> {
  const key = account.toBase58();
  return await getOrCreateTimedPromise(
    ataExistsCache,
    key,
    ATA_EXISTS_CACHE_TTL_MS,
    async () => {
      const connection = await input.runtime.getConnection();
      const info = await connection.getAccountInfo(account, 'confirmed');
      return !!info;
    },
  );
}

async function loadLatestBlockhash(
  input: SolanaTradeRequest,
  opts?: { allowCached?: boolean },
): Promise<CachedBlockhashValue> {
  const requestId = String((input.rawInput as any)?.__debugSubmitGapId || '').trim() || null;
  const blockhashStartedAt = Date.now();
  const allowCached = opts?.allowCached ?? (resolveExecutionMode(input) === 'turbo');
  // #region debug-point G:submit-gap-blockhash-start
  fetch('http://127.0.0.1:7779/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-submit-gap',
      runId: 'pre-fix',
      hypothesisId: 'D',
      location: 'pumpfun/adapter.ts:loadLatestBlockhash:start',
      msg: '[DEBUG] submit gap load latest blockhash start',
      data: {
        requestId,
        side: input.side,
        ownerAddress: input.ownerAddress,
        allowCached,
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  if (!allowCached) {
    const connection = await input.runtime.getConnection();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const result = { blockhash, lastValidBlockHeight, fetchedAt: Date.now() };
    // #region debug-point G:submit-gap-blockhash-done
    fetch('http://127.0.0.1:7779/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-submit-gap',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'pumpfun/adapter.ts:loadLatestBlockhash:done',
        msg: '[DEBUG] submit gap load latest blockhash done',
        data: {
          requestId,
          side: input.side,
          ownerAddress: input.ownerAddress,
          allowCached: false,
          blockhash,
          lastValidBlockHeight,
          elapsedMs: Date.now() - blockhashStartedAt,
        },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    return result;
  }
  const result = await getOrCreateTimedPromise(
    latestBlockhashCache,
    'confirmed',
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
  // #region debug-point G:submit-gap-blockhash-done
  fetch('http://127.0.0.1:7779/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-submit-gap',
      runId: 'pre-fix',
      hypothesisId: 'D',
      location: 'pumpfun/adapter.ts:loadLatestBlockhash:done',
      msg: '[DEBUG] submit gap load latest blockhash done',
      data: {
        requestId,
        side: input.side,
        ownerAddress: input.ownerAddress,
        allowCached: true,
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
        elapsedMs: Date.now() - blockhashStartedAt,
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  return result;
}

function shouldUseLegacyPumpfunLayout(input: SolanaTradeRequest): boolean {
  return input.side === 'buy'
    ? isSolanaNativeMint(input.inputMint)
    : isSolanaNativeMint(input.outputMint);
}

async function buildLegacyInstruction(input: SolanaTradeRequest): Promise<{
  instruction: TransactionInstruction;
  preInstructions: TransactionInstruction[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  tokenMinOutWei: string;
}> {
  const legacyStartedAt = Date.now();
  const blockhashPromise = loadLatestBlockhash(input);
  // #region debug-point D:pumpfun-legacy-start
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildLegacyInstruction:start', msg: '[DEBUG] pumpfun legacy build start', data: { side: input.side, ownerAddress: input.ownerAddress, inputMint: input.inputMint, outputMint: input.outputMint, amount: input.amount }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const user = new PublicKey(input.ownerAddress);
  const sharingConfigCreatorVaultPromise = loadSharingConfigCreatorVault(input, baseMint);
  const stateLoadStartedAt = Date.now();
  const [{ state, bondingCurve }, baseTokenProgram] = await Promise.all([
    loadBondingCurveState(input, baseMint),
    getMintProgramId(input.runtime, baseMint),
  ]);
  // #region debug-point D:pumpfun-legacy-state-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildLegacyInstruction:stateDone', msg: '[DEBUG] pumpfun legacy state loaded', data: { side: input.side, baseMint: baseMint.toBase58(), elapsedMs: Date.now() - stateLoadStartedAt, complete: state.complete }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  if (state.complete) throw new Error('Pumpfun bonding curve is complete; use PumpSwap/AMM route instead');

  const associatedBaseBondingCurve = findAta({
    mint: baseMint,
    owner: bondingCurve,
    allowOwnerOffCurve: true,
    tokenProgramId: baseTokenProgram,
  });
  const associatedBaseUser = findAta({ mint: baseMint, owner: user, tokenProgramId: baseTokenProgram });
  const creatorVaultPromise = resolvePumpfunCreatorVault(input, baseMint, state.creator, {
    sharingConfigCreatorVaultPromise,
  });
  const userBaseAtaExistsPromise = input.side === 'buy'
    ? loadAccountExists(input, associatedBaseUser)
    : Promise.resolve(true);
  const creatorVault = await creatorVaultPromise;
  // #region debug-point D:pumpfun-legacy-creator-vault-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildLegacyInstruction:creatorVaultDone', msg: '[DEBUG] pumpfun legacy creator vault resolved', data: { side: input.side, baseMint: baseMint.toBase58(), creatorVault: creatorVault.toBase58(), elapsedMs: Date.now() - legacyStartedAt }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  const globalVolumeAccumulator = derivePumpfunGlobalVolumeAccumulatorPda();
  const userVolumeAccumulator = derivePumpfunUserVolumeAccumulatorPda(user);
  const feeConfig = derivePumpfunFeeConfigPda();
  const eventAuthority = derivePumpfunEventAuthorityPda();
  const bondingCurveV2 = derivePumpfunBondingCurveV2Pda(baseMint);
  const protocolExtraFeeRecipient = PROTOCOL_EXTRA_FEE_RECIPIENTS[0];
  const feeRecipient = state.isMayhemMode
    ? pickRandomAddress(MAYHEM_FEE_RECIPIENTS)
    : NORMAL_FEE_RECIPIENT;
  const amountIn = BigInt(input.amount);
  const hasCreatorFee = !state.creator.equals(PublicKey.default);
  const tokenAmountOut = computePumpfunBuyAmountOut({
    solAmountIn: amountIn,
    virtualSolReserves: state.virtualSolReserves,
    virtualTokenReserves: state.virtualTokenReserves,
    realTokenReserves: state.realTokenReserves,
    hasCreatorFee,
  });
  if (input.side === 'buy' && tokenAmountOut > state.realTokenReserves) {
    throw new Error('Pumpfun trade exceeds remaining curve liquidity');
  }
  const minTokenAmountOut = applyBps(tokenAmountOut, BigInt(input.slippageBps), 'subtract');
  const minSolAmountOut = computePumpfunQuoteLimit({
    side: input.side,
    inputAmount: amountIn,
    virtualTokenReserves: state.virtualTokenReserves,
    virtualSolReserves: state.virtualSolReserves,
    realTokenReserves: state.realTokenReserves,
    hasCreatorFee,
    slippageBps: input.slippageBps,
  });

  const preInstructions: TransactionInstruction[] = [];
  preInstructions.push(...buildPriorityFeeInstructions(input));
  const memoInstruction = createTurboMemoInstruction(input);
  if (memoInstruction) preInstructions.push(memoInstruction);
  if (input.side === 'buy') {
    const ataCheckStartedAt = Date.now();
    const userBaseAtaExists = await userBaseAtaExistsPromise;
    // #region debug-point D:pumpfun-legacy-user-ata-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildLegacyInstruction:userAtaDone', msg: '[DEBUG] pumpfun legacy user ata checked', data: { side: input.side, associatedBaseUser: associatedBaseUser.toBase58(), exists: userBaseAtaExists, elapsedMs: Date.now() - ataCheckStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    if (!userBaseAtaExists) {
      preInstructions.push(
        createAtaIdempotentInstruction({
          payer: user,
          owner: user,
          mint: baseMint,
          associatedToken: associatedBaseUser,
          tokenProgramId: baseTokenProgram,
        }),
      );
    }
  }

  const keys = input.side === 'buy'
    ? [
      { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBaseBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBaseUser, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: bondingCurveV2, isSigner: false, isWritable: false },
      { pubkey: protocolExtraFeeRecipient, isSigner: false, isWritable: true },
    ]
    : [
      { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBaseBondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBaseUser, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
      ...(state.isCashbackCoin
        ? [{ pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }]
        : []),
      { pubkey: bondingCurveV2, isSigner: false, isWritable: false },
      { pubkey: protocolExtraFeeRecipient, isSigner: false, isWritable: true },
    ];

  const instruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: input.side === 'buy'
      ? buildPumpfunLegacyBuyExactInInstructionData(amountIn, minTokenAmountOut)
      : buildPumpfunLegacySellInstructionData(amountIn, minSolAmountOut),
  });
  const blockhashStartedAt = Date.now();
  const { blockhash, lastValidBlockHeight } = await blockhashPromise;
  // #region debug-point D:pumpfun-legacy-blockhash-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildLegacyInstruction:blockhashDone', msg: '[DEBUG] pumpfun legacy latest blockhash done', data: { side: input.side, blockhash, lastValidBlockHeight, elapsedMs: Date.now() - blockhashStartedAt, totalElapsedMs: Date.now() - legacyStartedAt }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  return {
    instruction,
    preInstructions,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    tokenMinOutWei: input.side === 'buy' ? tokenAmountOut.toString() : minSolAmountOut.toString(),
  };
}

async function buildUnifiedInstruction(input: SolanaTradeRequest): Promise<{
  instruction: TransactionInstruction;
  preInstructions: TransactionInstruction[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  tokenMinOutWei: string;
}> {
  const unifiedStartedAt = Date.now();
  const blockhashPromise = loadLatestBlockhash(input);
  // #region debug-point D:pumpfun-unified-start
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildUnifiedInstruction:start', msg: '[DEBUG] pumpfun unified build start', data: { side: input.side, ownerAddress: input.ownerAddress, inputMint: input.inputMint, outputMint: input.outputMint, amount: input.amount }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const user = new PublicKey(input.ownerAddress);
  const sharingConfigCreatorVaultPromise = loadSharingConfigCreatorVault(input, baseMint);
  const stateLoadStartedAt = Date.now();
  const [{ state, bondingCurve }, baseTokenProgram] = await Promise.all([
    loadBondingCurveState(input, baseMint),
    getMintProgramId(input.runtime, baseMint),
  ]);
  // #region debug-point D:pumpfun-unified-state-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildUnifiedInstruction:stateDone', msg: '[DEBUG] pumpfun unified state loaded', data: { side: input.side, baseMint: baseMint.toBase58(), elapsedMs: Date.now() - stateLoadStartedAt, complete: state.complete }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  const quoteMint = state.quoteMint.equals(PublicKey.default)
    ? new PublicKey(SOLANA_NATIVE_MINT)
    : state.quoteMint;
  if (state.complete) throw new Error('Pumpfun bonding curve is complete; use PumpSwap/AMM route instead');

  const associatedBaseBondingCurve = findAta({
    mint: baseMint,
    owner: bondingCurve,
    allowOwnerOffCurve: true,
    tokenProgramId: baseTokenProgram,
  });
  const associatedQuoteBondingCurve = findAta({
    mint: quoteMint,
    owner: bondingCurve,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const associatedBaseUser = findAta({ mint: baseMint, owner: user, tokenProgramId: baseTokenProgram });
  const associatedQuoteUser = findAta({ mint: quoteMint, owner: user, tokenProgramId: TOKEN_PROGRAM_ID });
  const creatorVaultPromise = resolvePumpfunCreatorVault(input, baseMint, state.creator, {
    sharingConfigCreatorVaultPromise,
  });
  const userBaseAtaExistsPromise = input.side === 'buy'
    ? loadAccountExists(input, associatedBaseUser)
    : Promise.resolve(true);
  const creatorVault = await creatorVaultPromise;
  // #region debug-point D:pumpfun-unified-creator-vault-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildUnifiedInstruction:creatorVaultDone', msg: '[DEBUG] pumpfun unified creator vault resolved', data: { side: input.side, baseMint: baseMint.toBase58(), creatorVault: creatorVault.toBase58(), elapsedMs: Date.now() - unifiedStartedAt }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  const associatedCreatorVault = findAta({
    mint: quoteMint,
    owner: creatorVault,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const sharingConfig = derivePumpfunSharingConfigPda(baseMint);
  const globalVolumeAccumulator = derivePumpfunGlobalVolumeAccumulatorPda();
  const userVolumeAccumulator = derivePumpfunUserVolumeAccumulatorPda(user);
  const associatedUserVolumeAccumulator = findAta({
    mint: quoteMint,
    owner: userVolumeAccumulator,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const feeConfig = derivePumpfunFeeConfigPda();
  const eventAuthority = derivePumpfunEventAuthorityPda();
  const feeRecipient = state.isMayhemMode
    ? pickRandomAddress(MAYHEM_FEE_RECIPIENTS)
    : NORMAL_FEE_RECIPIENT;
  const associatedQuoteFeeRecipient = findAta({
    mint: quoteMint,
    owner: feeRecipient,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const associatedQuoteBuybackFeeRecipient = findAta({
    mint: quoteMint,
    owner: BUYBACK_FEE_RECIPIENT,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });

  const amountIn = BigInt(input.amount);
  const hasCreatorFee = !state.creator.equals(PublicKey.default);
  const quotedTokenAmount = input.side === 'buy'
    ? computePumpfunBuyAmountOut({
      solAmountIn: amountIn,
      virtualSolReserves: state.virtualSolReserves,
      virtualTokenReserves: state.virtualTokenReserves,
      realTokenReserves: state.realTokenReserves,
      hasCreatorFee,
    })
    : amountIn;
  if (input.side === 'buy' && quotedTokenAmount > state.realTokenReserves) {
    throw new Error('Pumpfun trade exceeds remaining curve liquidity');
  }
  const minTokenAmountOut = input.side === 'buy'
    ? applyBps(quotedTokenAmount, BigInt(input.slippageBps), 'subtract')
    : 0n;
  const quoteLimit = computePumpfunQuoteLimit({
    side: input.side,
    inputAmount: amountIn,
    virtualTokenReserves: state.virtualTokenReserves,
    virtualSolReserves: state.virtualSolReserves,
    realTokenReserves: state.realTokenReserves,
    hasCreatorFee,
    slippageBps: input.slippageBps,
  });

  const preInstructions: TransactionInstruction[] = [];
  const memoInstruction = createTurboMemoInstruction(input);
  if (memoInstruction) preInstructions.push(memoInstruction);
  if (input.side === 'buy') {
    const ataCheckStartedAt = Date.now();
    const userBaseAtaExists = await userBaseAtaExistsPromise;
    // #region debug-point D:pumpfun-unified-user-ata-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildUnifiedInstruction:userAtaDone', msg: '[DEBUG] pumpfun unified user ata checked', data: { side: input.side, associatedBaseUser: associatedBaseUser.toBase58(), exists: userBaseAtaExists, elapsedMs: Date.now() - ataCheckStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    if (!userBaseAtaExists) {
      preInstructions.push(
        createAtaIdempotentInstruction({
          payer: user,
          owner: user,
          mint: baseMint,
          associatedToken: associatedBaseUser,
          tokenProgramId: baseTokenProgram,
        }),
      );
    }
  }

  const keys = [
    { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: associatedQuoteFeeRecipient, isSigner: false, isWritable: true },
    { pubkey: BUYBACK_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: associatedQuoteBuybackFeeRecipient, isSigner: false, isWritable: true },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBaseBondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedQuoteBondingCurve, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: associatedBaseUser, isSigner: false, isWritable: true },
    { pubkey: associatedQuoteUser, isSigner: false, isWritable: true },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: associatedCreatorVault, isSigner: false, isWritable: true },
    { pubkey: sharingConfig, isSigner: false, isWritable: false },
    ...(input.side === 'buy'
      ? [{ pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true }]
      : []),
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: associatedUserVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const instruction = new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: input.side === 'buy'
      ? buildPumpfunBuyExactQuoteInV2InstructionData(amountIn, minTokenAmountOut)
      : buildPumpfunInstructionData(input.side, quotedTokenAmount, quoteLimit),
  });
  // #region debug-point P2:pumpfun-build-keys
  fetch('http://127.0.0.1:7778/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'pumpfun-legacy-route',
      runId: 'post-fix',
      hypothesisId: 'P2',
      location: 'pumpfun/adapter.ts:buildInstruction',
      msg: '[DEBUG] pumpfun build instruction keys',
      data: {
        side: input.side,
        ownerAddress: input.ownerAddress,
        baseMint: baseMint.toBase58(),
        quoteMint: quoteMint.toBase58(),
        feeRecipient: feeRecipient.toBase58(),
        buybackFeeRecipient: BUYBACK_FEE_RECIPIENT.toBase58(),
        isMayhemMode: state.isMayhemMode,
        keys: instruction.keys.map((key, index) => ({
          index,
          pubkey: key.pubkey.toBase58(),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  const blockhashStartedAt = Date.now();
  const { blockhash, lastValidBlockHeight } = await blockhashPromise;
  // #region debug-point D:pumpfun-unified-blockhash-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:buildUnifiedInstruction:blockhashDone', msg: '[DEBUG] pumpfun unified latest blockhash done', data: { side: input.side, blockhash, lastValidBlockHeight, elapsedMs: Date.now() - blockhashStartedAt, totalElapsedMs: Date.now() - unifiedStartedAt }, ts: Date.now() }) }).catch(() => { });
  // #endregion
  return {
    instruction,
    preInstructions,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    tokenMinOutWei: input.side === 'buy' ? quotedTokenAmount.toString() : quoteLimit.toString(),
  };
}

async function buildInstruction(input: SolanaTradeRequest): Promise<{
  instruction: TransactionInstruction;
  preInstructions: TransactionInstruction[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  tokenMinOutWei: string;
}> {
  const layout = shouldUseLegacyPumpfunLayout(input) ? 'legacy' : 'unified';
  // #region debug-point H1:pumpfun-layout-select
  fetch('http://127.0.0.1:7778/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'pumpfun-legacy-route',
      runId: 'post-fix',
      hypothesisId: 'H1',
      location: 'pumpfun/adapter.ts:buildInstruction',
      msg: '[DEBUG] pumpfun layout selected',
      data: {
        side: input.side,
        inputMint: input.inputMint,
        outputMint: input.outputMint,
        layout,
      },
      ts: Date.now(),
    }),
  }).catch(() => { });
  // #endregion
  return layout === 'legacy'
    ? buildLegacyInstruction(input)
    : buildUnifiedInstruction(input);
}

export async function prewarmPumpfunTrade(input: {
  tokenAddress: string;
  ownerAddress?: string;
  executionMode?: 'default' | 'turbo';
  tokenInfo?: SolanaTradeRequest['tokenInfo'];
  runtime: SolanaTradeRequest['runtime'];
}): Promise<void> {
  const tokenAddress = String(input.tokenAddress || '').trim();
  if (!tokenAddress) return;
  const ownerAddress = String(input.ownerAddress || '').trim();
  const prewarmStartedAt = Date.now();
  // #region debug-point A:pumpfun-prewarm-start
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'pumpfun/adapter.ts:prewarmPumpfunTrade:start', msg: '[DEBUG] pumpfun prewarm start', data: { tokenAddress, ownerAddress: ownerAddress || null }, ts: Date.now() }) }).catch(() => { });
  // #endregion
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
  const user = new PublicKey(request.ownerAddress);
  const baseTokenProgramPromise = getMintProgramId(request.runtime, baseMint);
  const statePromise = loadBondingCurveState(request, baseMint);
  const blockhashPromise = loadLatestBlockhash(request, { allowCached: true });
  const [{ state }, baseTokenProgram] = await Promise.all([statePromise, baseTokenProgramPromise]);
  const tasks: Array<Promise<unknown>> = [
    resolvePumpfunCreatorVault(request, baseMint, state.creator),
    blockhashPromise,
  ];
  if (ownerAddress) {
    tasks.push(loadAccountExists(request, findAta({ mint: baseMint, owner: user, tokenProgramId: baseTokenProgram })));
  }
  await Promise.all(tasks);
  // #region debug-point A:pumpfun-prewarm-done
  fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'pumpfun/adapter.ts:prewarmPumpfunTrade:done', msg: '[DEBUG] pumpfun prewarm done', data: { tokenAddress, ownerAddress: ownerAddress || null, elapsedMs: Date.now() - prewarmStartedAt }, ts: Date.now() }) }).catch(() => { });
  // #endregion
}

export const pumpfunTradeAdapter: SolanaTradeAdapter = {
  capability: {
    source: 'pumpfun',
    mode: 'direct',
    supportsBuy: true,
    supportsSell: true,
    platforms: ['pump', 'pumpfun', 'pump.fun'],
  },

  async supportsTrade(input: SolanaTradeRequest): Promise<boolean> {
    const platform = resolvePlatform(input);
    if (platform !== 'pump' && platform !== 'pumpfun' && platform !== 'pump.fun') {
      // #region debug-point P2:pumpfun-platform-reject
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pumpfun-legacy-route',
          runId: 'post-fix',
          hypothesisId: 'P2',
          location: 'pumpfun/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpfun platform rejected',
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
      // #region debug-point P2:pumpfun-pair-reject
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pumpfun-legacy-route',
          runId: 'post-fix',
          hypothesisId: 'P2',
          location: 'pumpfun/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpfun pair rejected',
          data: { platform, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return false;
    }
    try {
      const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
      const { state } = await loadBondingCurveState(input, baseMint);
      // #region debug-point P2:pumpfun-curve-state
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pumpfun-legacy-route',
          runId: 'post-fix',
          hypothesisId: 'P2',
          location: 'pumpfun/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpfun curve state',
          data: { platform, side: input.side, baseMint: baseMint.toBase58(), complete: state.complete },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return !state.complete;
    } catch (error: any) {
      // #region debug-point P2:pumpfun-load-failed
      fetch('http://127.0.0.1:7778/event', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'pumpfun-legacy-route',
          runId: 'post-fix',
          hypothesisId: 'P2',
          location: 'pumpfun/adapter.ts:supportsTrade',
          msg: '[DEBUG] pumpfun load curve failed',
          data: { platform, side: input.side, inputMint: input.inputMint, outputMint: input.outputMint, error: String(error?.message || error || '') },
          ts: Date.now(),
        }),
      }).catch(() => { });
      // #endregion
      return false;
    }
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    const buildStartedAt = Date.now();
    const plannedSource = String((input.rawInput as any)?.__plannedSource || '').trim().toLowerCase();
    if (plannedSource !== 'pumpfun' && !(await this.supportsTrade(input))) {
      throw new Error('Pumpfun adapter cannot handle this trade');
    }
    // #region debug-point D:pumpfun-build-supports-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:build:supportsDone', msg: '[DEBUG] pumpfun supportsTrade done', data: { side: input.side, ownerAddress: input.ownerAddress, elapsedMs: Date.now() - buildStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    const buildInstructionStartedAt = Date.now();
    const { instruction, preInstructions, recentBlockhash, lastValidBlockHeight, tokenMinOutWei } = await buildInstruction(input);
    // #region debug-point D:pumpfun-build-instruction-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:build:instructionDone', msg: '[DEBUG] pumpfun build instruction done', data: { side: input.side, ownerAddress: input.ownerAddress, preInstructionCount: preInstructions.length, recentBlockhash, tokenMinOutWei, elapsedMs: Date.now() - buildInstructionStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    const message = new TransactionMessage({
      payerKey: new PublicKey(input.ownerAddress),
      recentBlockhash,
      instructions: [...preInstructions, instruction],
    }).compileToV0Message();
    // #region debug-point P2:pumpfun-message-keys
    fetch('http://127.0.0.1:7778/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'pumpfun-legacy-route',
        runId: 'post-fix',
        hypothesisId: 'P2',
        location: 'pumpfun/adapter.ts:build',
        msg: '[DEBUG] pumpfun compiled message keys',
        data: {
          side: input.side,
          staticAccountKeys: message.staticAccountKeys.map((key, index) => ({
            index,
            pubkey: key.toBase58(),
          })),
          header: {
            numRequiredSignatures: message.header.numRequiredSignatures,
            numReadonlySignedAccounts: message.header.numReadonlySignedAccounts,
            numReadonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts,
          },
          compiledInstructions: message.compiledInstructions.map((compiled, ixIndex) => ({
            ixIndex,
            programIdIndex: compiled.programIdIndex,
            accountKeyIndexes: [...compiled.accountKeyIndexes],
            dataLength: compiled.data.length,
          })),
        },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    // #region debug-point D:pumpfun-build-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'pumpfun/adapter.ts:build:done', msg: '[DEBUG] pumpfun adapter build done', data: { side: input.side, ownerAddress: input.ownerAddress, totalElapsedMs: Date.now() - buildStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    return {
      source: 'pumpfun',
      transaction: new VersionedTransaction(message),
      tokenMinOutWei,
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    };
  },
};
