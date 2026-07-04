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
import { buildSolanaTipTransferInstructions } from '../../utils/solanaTip';
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
import {
  getFreshWarmPromise,
  refreshWarmPromise,
  rememberWarmPromise,
  SOLANA_WARM_CACHE_TTL_MS,
  type WarmCacheEntry,
} from '../../prewarm';

const BONDING_CONTEXT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const BONDING_STATE_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.dynamicQuote;
// Creator vault and ATA existence change far less often than curve reserves, so keep them warm longer.
const CREATOR_VAULT_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const ATA_EXISTS_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.staticAccount;
const BLOCKHASH_CACHE_TTL_MS = SOLANA_WARM_CACHE_TTL_MS.blockhash;
const PUMPFUN_COMPUTE_UNIT_LIMIT = 250_000;
const SOLANA_VERSIONED_TX_MAX_BYTES = 1232;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TURBO_PRIORITY_FEE_SOL_BY_PRESET: Record<string, string> = {
  slow: '0.000025',
  standard: '0.00004',
  fast: '0.0001',
  turbo: '0.00015',
};

type CachedBlockhashValue = {
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAt: number;
};

type PumpfunBondingCurveContext = {
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
  bondingCurve: PublicKey;
};

const bondingContextCache = new Map<string, WarmCacheEntry<PumpfunBondingCurveContext>>();
const bondingStateCache = new Map<string, WarmCacheEntry<{ state: PumpfunBondingCurveState; bondingCurve: PublicKey }>>();
const creatorVaultCache = new Map<string, WarmCacheEntry<PublicKey>>();
const sharingConfigCreatorVaultCache = new Map<string, WarmCacheEntry<PublicKey | null>>();
const ataExistsCache = new Map<string, WarmCacheEntry<boolean>>();
const latestBlockhashCache = new Map<string, WarmCacheEntry<CachedBlockhashValue>>();
let turboMemoNonce = 0;

function pickRandomAddress(addresses: readonly PublicKey[]): PublicKey {
  if (!addresses.length) throw new Error('No address candidates available');
  return addresses[Math.floor(Math.random() * addresses.length)] ?? addresses[0]!;
}
const hasBytePrefix = (data: Uint8Array, prefix: Uint8Array) => (
  data.length >= prefix.length && prefix.every((value, index) => data[index] === value)
);

function resolvePlatform(input: SolanaTradeRequest): string {
  return normalizeSolanaPlatform(input.tokenInfo?.launchpad_platform || input.tokenInfo?.launchpad);
}

function resolveExecutionMode(input: SolanaTradeRequest): 'default' | 'turbo' {
  return (input.rawInput as any)?.executionModeOverride === 'turbo' ? 'turbo' : 'default';
}

function toBondingCurveContext(
  state: PumpfunBondingCurveState,
  bondingCurve: PublicKey,
): PumpfunBondingCurveContext {
  return {
    complete: state.complete,
    creator: state.creator,
    isMayhemMode: state.isMayhemMode,
    isCashbackCoin: state.isCashbackCoin,
    quoteMint: state.quoteMint,
    bondingCurve,
  };
}

function cacheBondingCurveContext(mint: string, context: PumpfunBondingCurveContext): void {
  bondingContextCache.set(mint, {
    promise: Promise.resolve(context),
    expiresAt: Date.now() + BONDING_CONTEXT_CACHE_TTL_MS,
  });
}

function isPumpfunRouteComplete(input: SolanaTradeRequest, fallback: boolean): boolean {
  const launchpadStatus = input.tokenInfo?.launchpad_status;
  if (typeof launchpadStatus === 'number') return launchpadStatus === 1;
  return fallback;
}

function createTurboMemoInstruction(input: SolanaTradeRequest): TransactionInstruction | null {
  if (resolveExecutionMode(input) !== 'turbo') return null;
  turboMemoNonce = (turboMemoNonce + 1) % Number.MAX_SAFE_INTEGER;
  const memo = `dg:${input.side === 'buy' ? 'b' : 's'}:${Date.now().toString(36)}:${turboMemoNonce.toString(36)}`;
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
    return [];
  }
  let microLamports = (lamports * 1_000_000n) / BigInt(PUMPFUN_COMPUTE_UNIT_LIMIT);
  if (microLamports <= 0n) microLamports = 1n;
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: PUMPFUN_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

async function loadBondingCurveState(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
  opts?: { forceRefresh?: boolean },
): Promise<{ state: PumpfunBondingCurveState; bondingCurve: PublicKey }> {
  const mint = baseMint.toBase58();
  const loader = async () => {
    const bondingCurve = derivePumpfunBondingCurvePda(baseMint);
    const connection = await input.runtime.getConnection();
    const info = await connection.getAccountInfo(bondingCurve, 'confirmed');
    if (!info?.data) throw new Error('Pumpfun bonding curve account not found');
    const state = parsePumpfunBondingCurveState(info.data);
    cacheBondingCurveContext(mint, toBondingCurveContext(state, bondingCurve));
    return {
      state,
      bondingCurve,
    };
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(bondingStateCache, mint, BONDING_STATE_CACHE_TTL_MS, loader)
    : rememberWarmPromise(bondingStateCache, mint, BONDING_STATE_CACHE_TTL_MS, loader));
}

async function loadBondingCurveContext(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
  opts?: { forceRefresh?: boolean },
): Promise<PumpfunBondingCurveContext> {
  const mint = baseMint.toBase58();
  const loader = async () => {
    const bondingCurve = derivePumpfunBondingCurvePda(baseMint);
    const connection = await input.runtime.getConnection();
    const info = await connection.getAccountInfo(bondingCurve, 'confirmed');
    if (!info?.data) throw new Error('Pumpfun bonding curve account not found');
    return toBondingCurveContext(parsePumpfunBondingCurveState(info.data), bondingCurve);
  };
  return await (opts?.forceRefresh
    ? refreshWarmPromise(bondingContextCache, mint, BONDING_CONTEXT_CACHE_TTL_MS, loader)
    : rememberWarmPromise(bondingContextCache, mint, BONDING_CONTEXT_CACHE_TTL_MS, loader));
}

async function getBondingCurveStateForBuild(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
): Promise<{ state: PumpfunBondingCurveState; bondingCurve: PublicKey }> {
  return await loadBondingCurveState(input, baseMint);
}

async function getBondingCurveContextForBuild(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
): Promise<PumpfunBondingCurveContext> {
  if (resolveExecutionMode(input) !== 'turbo') {
    const { state, bondingCurve } = await loadBondingCurveState(input, baseMint);
    return toBondingCurveContext(state, bondingCurve);
  }
  const cached = getFreshWarmPromise<PumpfunBondingCurveContext>(bondingContextCache, baseMint.toBase58());
  if (!cached) throw new Error('Pumpfun bonding curve context not ready');
  return await cached;
}

async function resolvePumpfunCreatorVault(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
  creator: PublicKey,
  opts?: { sharingConfigCreatorVaultPromise?: Promise<PublicKey | null> },
): Promise<PublicKey> {
  const key = `${baseMint.toBase58()}:${creator.toBase58()}`;
  return await rememberWarmPromise(
    creatorVaultCache,
    key,
    CREATOR_VAULT_CACHE_TTL_MS,
    async () => {
      const sharingConfigCreatorVault = await (opts?.sharingConfigCreatorVaultPromise ?? loadSharingConfigCreatorVault(input, baseMint));
      return sharingConfigCreatorVault ?? derivePumpfunCreatorVaultPda(creator);
    },
  );
}

async function getCreatorVaultForBuild(
  baseMint: PublicKey,
  creator: PublicKey,
): Promise<PublicKey> {
  const creatorKey = `${baseMint.toBase58()}:${creator.toBase58()}`;
  const cachedCreatorVault = getFreshWarmPromise<PublicKey>(creatorVaultCache, creatorKey);
  if (cachedCreatorVault) return await cachedCreatorVault;
  const cachedSharingConfig = getFreshWarmPromise<PublicKey | null>(sharingConfigCreatorVaultCache, baseMint.toBase58());
  if (!cachedSharingConfig) throw new Error('Pumpfun creator vault cache not ready');
  const sharingConfigCreatorVault = await cachedSharingConfig;
  return sharingConfigCreatorVault ?? derivePumpfunCreatorVaultPda(creator);
}

async function loadSharingConfigCreatorVault(
  input: SolanaTradeRequest,
  baseMint: PublicKey,
): Promise<PublicKey | null> {
  const key = baseMint.toBase58();
  return await rememberWarmPromise(
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
  return await rememberWarmPromise(
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
  opts?: { allowCached?: boolean; forceRefresh?: boolean },
): Promise<CachedBlockhashValue> {
  void opts;
  const loader = async () => {
    const connection = await input.runtime.getConnection();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    return {
      blockhash,
      lastValidBlockHeight,
      fetchedAt: Date.now(),
    };
  };
  const result = await (opts?.forceRefresh
    ? refreshWarmPromise(latestBlockhashCache, 'confirmed', BLOCKHASH_CACHE_TTL_MS, loader)
    : rememberWarmPromise(latestBlockhashCache, 'confirmed', BLOCKHASH_CACHE_TTL_MS, loader));
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
  protectionMinOutWei: string;
  quotedOutWei?: string | null;
}> {
  const executionMode = resolveExecutionMode(input);
  const blockhashPromise = loadLatestBlockhash(input);
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const user = new PublicKey(input.ownerAddress);
  const [curveContext, baseTokenProgram] = await Promise.all([
    getBondingCurveContextForBuild(input, baseMint),
    getMintProgramId(input.runtime, baseMint, { cacheOnly: true }),
  ]);
  if (isPumpfunRouteComplete(input, curveContext.complete)) {
    throw new Error('Pumpfun bonding curve is complete; use PumpSwap/AMM route instead');
  }

  const associatedBaseBondingCurve = findAta({
    mint: baseMint,
    owner: curveContext.bondingCurve,
    allowOwnerOffCurve: true,
    tokenProgramId: baseTokenProgram,
  });
  const associatedBaseUser = findAta({ mint: baseMint, owner: user, tokenProgramId: baseTokenProgram });
  const creatorVault = await getCreatorVaultForBuild(baseMint, curveContext.creator);
  const globalVolumeAccumulator = derivePumpfunGlobalVolumeAccumulatorPda();
  const userVolumeAccumulator = derivePumpfunUserVolumeAccumulatorPda(user);
  const feeConfig = derivePumpfunFeeConfigPda();
  const eventAuthority = derivePumpfunEventAuthorityPda();
  const bondingCurveV2 = derivePumpfunBondingCurveV2Pda(baseMint);
  const protocolExtraFeeRecipient = PROTOCOL_EXTRA_FEE_RECIPIENTS[0];
  const feeRecipient = curveContext.isMayhemMode
    ? pickRandomAddress(MAYHEM_FEE_RECIPIENTS)
    : NORMAL_FEE_RECIPIENT;
  const amountIn = BigInt(input.amount);
  let protectionMinOutWei = '1';
  let quotedOutWei: string | null = null;
  let minTokenAmountOut = 1n;
  let minSolAmountOut = 1n;
  if (executionMode !== 'turbo') {
    const { state } = await getBondingCurveStateForBuild(input, baseMint);
    const hasCreatorFee = !curveContext.creator.equals(PublicKey.default);
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
    minTokenAmountOut = applyBps(tokenAmountOut, BigInt(input.slippageBps), 'subtract');
    minSolAmountOut = computePumpfunQuoteLimit({
      side: input.side,
      inputAmount: amountIn,
      virtualTokenReserves: state.virtualTokenReserves,
      virtualSolReserves: state.virtualSolReserves,
      realTokenReserves: state.realTokenReserves,
      hasCreatorFee,
      slippageBps: input.slippageBps,
    });
    protectionMinOutWei = input.side === 'buy' ? minTokenAmountOut.toString() : minSolAmountOut.toString();
    quotedOutWei = input.side === 'buy' ? tokenAmountOut.toString() : null;
  }

  const preInstructions: TransactionInstruction[] = [];
  preInstructions.push(...buildPriorityFeeInstructions(input));
  preInstructions.push(...buildSolanaTipTransferInstructions(input));
  const memoInstruction = createTurboMemoInstruction(input);
  if (memoInstruction) preInstructions.push(memoInstruction);
  preInstructions.push(
    createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: baseMint,
      associatedToken: associatedBaseUser,
      tokenProgramId: baseTokenProgram,
    }),
  );

  const keys = input.side === 'buy'
    ? [
      { pubkey: PUMP_GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: baseMint, isSigner: false, isWritable: false },
      { pubkey: curveContext.bondingCurve, isSigner: false, isWritable: true },
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
      { pubkey: curveContext.bondingCurve, isSigner: false, isWritable: true },
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
      ...(curveContext.isCashbackCoin
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
  const { blockhash, lastValidBlockHeight } = await blockhashPromise;
  return {
    instruction,
    preInstructions,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    protectionMinOutWei,
    quotedOutWei,
  };
}

async function buildUnifiedInstruction(input: SolanaTradeRequest): Promise<{
  instruction: TransactionInstruction;
  preInstructions: TransactionInstruction[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  protectionMinOutWei: string;
  quotedOutWei?: string | null;
}> {
  const executionMode = resolveExecutionMode(input);
  const blockhashPromise = loadLatestBlockhash(input);
  const baseMint = new PublicKey(input.side === 'buy' ? input.outputMint : input.inputMint);
  const user = new PublicKey(input.ownerAddress);
  const [curveContext, baseTokenProgram] = await Promise.all([
    getBondingCurveContextForBuild(input, baseMint),
    getMintProgramId(input.runtime, baseMint, { cacheOnly: true }),
  ]);
  const quoteMint = curveContext.quoteMint.equals(PublicKey.default)
    ? new PublicKey(SOLANA_NATIVE_MINT)
    : curveContext.quoteMint;
  if (isPumpfunRouteComplete(input, curveContext.complete)) {
    throw new Error('Pumpfun bonding curve is complete; use PumpSwap/AMM route instead');
  }

  const associatedBaseBondingCurve = findAta({
    mint: baseMint,
    owner: curveContext.bondingCurve,
    allowOwnerOffCurve: true,
    tokenProgramId: baseTokenProgram,
  });
  const associatedQuoteBondingCurve = findAta({
    mint: quoteMint,
    owner: curveContext.bondingCurve,
    allowOwnerOffCurve: true,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
  const associatedBaseUser = findAta({ mint: baseMint, owner: user, tokenProgramId: baseTokenProgram });
  const associatedQuoteUser = findAta({ mint: quoteMint, owner: user, tokenProgramId: TOKEN_PROGRAM_ID });
  const creatorVault = await getCreatorVaultForBuild(baseMint, curveContext.creator);
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
  const feeRecipient = curveContext.isMayhemMode
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
  let quotedTokenAmount = input.side === 'buy' ? 0n : amountIn;
  let minTokenAmountOut = 1n;
  let quoteLimit = 1n;
  let protectionMinOutWei = '1';
  let quotedOutWei: string | null = null;
  if (executionMode !== 'turbo') {
    const { state } = await getBondingCurveStateForBuild(input, baseMint);
    const hasCreatorFee = !curveContext.creator.equals(PublicKey.default);
    quotedTokenAmount = input.side === 'buy'
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
    minTokenAmountOut = input.side === 'buy'
      ? applyBps(quotedTokenAmount, BigInt(input.slippageBps), 'subtract')
      : 0n;
    quoteLimit = computePumpfunQuoteLimit({
      side: input.side,
      inputAmount: amountIn,
      virtualTokenReserves: state.virtualTokenReserves,
      virtualSolReserves: state.virtualSolReserves,
      realTokenReserves: state.realTokenReserves,
      hasCreatorFee,
      slippageBps: input.slippageBps,
    });
    protectionMinOutWei = input.side === 'buy' ? minTokenAmountOut.toString() : quoteLimit.toString();
    quotedOutWei = input.side === 'buy' ? quotedTokenAmount.toString() : null;
  }

  const preInstructions: TransactionInstruction[] = [];
  const memoInstruction = createTurboMemoInstruction(input);
  if (memoInstruction) preInstructions.push(memoInstruction);
  preInstructions.push(
    createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: baseMint,
      associatedToken: associatedBaseUser,
      tokenProgramId: baseTokenProgram,
    }),
  );
  preInstructions.push(
    createAtaIdempotentInstruction({
      payer: user,
      owner: user,
      mint: quoteMint,
      associatedToken: associatedQuoteUser,
      tokenProgramId: TOKEN_PROGRAM_ID,
    }),
  );

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
    { pubkey: curveContext.bondingCurve, isSigner: false, isWritable: true },
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
  const { blockhash, lastValidBlockHeight } = await blockhashPromise;
  return {
    instruction,
    preInstructions,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    protectionMinOutWei,
    quotedOutWei,
  };
}

async function buildInstruction(input: SolanaTradeRequest): Promise<{
  instruction: TransactionInstruction;
  preInstructions: TransactionInstruction[];
  recentBlockhash: string;
  lastValidBlockHeight: number;
  protectionMinOutWei: string;
  quotedOutWei?: string | null;
}> {
  const layout = shouldUseLegacyPumpfunLayout(input) ? 'legacy' : 'unified';
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
  const blockhashPromise = loadLatestBlockhash(request, { allowCached: true, forceRefresh: true });
  const curveContext = input.executionMode === 'turbo'
    ? await loadBondingCurveContext(request, baseMint)
    : await (async () => {
      const { state, bondingCurve } = await loadBondingCurveState(request, baseMint, { forceRefresh: true });
      return toBondingCurveContext(state, bondingCurve);
    })();
  const baseTokenProgram = await baseTokenProgramPromise;
  const tasks: Array<Promise<unknown>> = [
    resolvePumpfunCreatorVault(request, baseMint, curveContext.creator),
    blockhashPromise,
  ];
  if (ownerAddress) {
    tasks.push(loadAccountExists(request, findAta({ mint: baseMint, owner: user, tokenProgramId: baseTokenProgram })));
  }
  await Promise.all(tasks);
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
      return false;
    }
    const isSupportedPair = input.side === 'buy'
      ? isSolanaNativeMint(input.inputMint) && !isSolanaNativeMint(input.outputMint)
      : !isSolanaNativeMint(input.inputMint) && isSolanaNativeMint(input.outputMint);
    if (!isSupportedPair) {
      return false;
    }
    return true;
  },

  async build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction> {
    const plannedSource = String((input.rawInput as any)?.__plannedSource || '').trim().toLowerCase();
    if (plannedSource !== 'pumpfun' && !(await this.supportsTrade(input))) {
      throw new Error('Pumpfun adapter cannot handle this trade');
    }
    const {
      instruction,
      preInstructions,
      recentBlockhash,
      lastValidBlockHeight,
      protectionMinOutWei,
      quotedOutWei,
    } = await buildInstruction(input);
    const payerKey = new PublicKey(input.ownerAddress);
    const memoInstruction = preInstructions.find((item) => item.programId.equals(MEMO_PROGRAM_ID));
    const buildCompiledTransaction = (includeMemo: boolean) => {
      const activePreInstructions = memoInstruction && !includeMemo
        ? preInstructions.filter((item) => item !== memoInstruction)
        : preInstructions;
      const message = new TransactionMessage({
        payerKey,
        recentBlockhash,
        instructions: [...activePreInstructions, instruction],
      }).compileToV0Message();
      const transaction = new VersionedTransaction(message);
      return {
        transaction,
        serializedBytes: transaction.serialize().length,
      };
    };
    let compiled = buildCompiledTransaction(true);
    if (memoInstruction && compiled.serializedBytes > SOLANA_VERSIONED_TX_MAX_BYTES) {
      compiled = buildCompiledTransaction(false);
    }
    if (compiled.serializedBytes > SOLANA_VERSIONED_TX_MAX_BYTES) {
      throw new Error(`Pumpfun transaction too large: ${compiled.serializedBytes} bytes`);
    }
    return {
      source: 'pumpfun',
      transaction: compiled.transaction,
      protectionMinOutWei,
      quotedOutWei,
      blockhash: recentBlockhash,
      lastValidBlockHeight,
    };
  },
};
