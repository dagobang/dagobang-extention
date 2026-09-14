import { encodeAbiParameters, formatUnits, getAddress, parseAbi, parseAbiParameters } from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { RpcService } from '@/services/rpc';

import { getQuote } from './tradeDex';
import {
  Address,
  Hex,
  RhSwapType,
  ZERO_ADDRESS,
  getRouterSwapDesc,
  getWNative,
  toQuoteToken,
  type SwapDescLike,
} from './tradeTypes';

const BPS_DENOM = 10_000n;
const PONS_V1_POOL_FEE = 10_000;
const PONS_TRADE_STATE_INNER_TTL_MS = 5000;
const PONS_TRADE_STATE_OUTER_TTL_MS = 30_000;

const ponsV2FactoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
]);

const ponsCurveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
]);

const ponsV1TokenAbi = parseAbi([
  'function liquidityPool() view returns (address)',
]);

const erc20MetaAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const ponsTokenInfoAbi = parseAbi([
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, (string twitter, string telegram, string discord, string website, string farcaster) tokenSocials)',
]);

const abiParamsUint256 = parseAbiParameters('uint256');

export const PONS_V2_PHASE = {
  NotGraduated: 0,
  Swept: 1,
  PoolCreated: 2,
  Rescued: 3,
} as const;

export type PonsTradeState = {
  version: 1 | 2;
  phase: number;
  isInner: boolean;
  isOuter: boolean;
  tradeable: boolean;
  curve: Address;
  v3Pool: Address;
  pairToken: Address;
  quoteRouterToken: Address;
  isNativeQuote: boolean;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  graduationThreshold: bigint;
  memeHook: Address;
  v4PoolManager: Address;
};

type PonsTradeStateOptions = {
  force?: boolean;
};

const ponsTradeStateCache = new Map<string, { ts: number; value: PonsTradeState | null }>();
const ponsTradeStateInFlight = new Map<string, Promise<PonsTradeState | null>>();

async function withRhRead<T>(caller: string, run: (client: any) => Promise<T>): Promise<T> {
  return await RpcService.withBalancedReadClient({
    chainId: ChainId.RH,
    caller,
    run,
  });
}

function expectAddress(value: string | undefined, label: string): Address {
  const trimmed = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(`${label} address not set`);
  }
  return getAddress(trimmed as Address);
}

function asAddress(value: unknown): Address {
  const raw = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/i.test(raw)) return ZERO_ADDRESS;
  try {
    return getAddress(raw as Address);
  } catch {
    return ZERO_ADDRESS;
  }
}

function isZero(addr: Address): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}

export function isPonsPlatform(platform: string | null | undefined): boolean {
  const value = String(platform || '').trim().toLowerCase();
  return value === 'pons' || value === 'pons_v1' || value === 'pons_v2' || value === 'ponsfamily' || value === 'pons.fun';
}

export function getConfiguredPonsV2Factory(): Address {
  return expectAddress(DeployAddress[ChainId.RH]?.[ContractNames.PonsV2Factory]?.address, 'Pons v2 factory');
}

export function getConfiguredPonsMemeHook(): Address {
  return expectAddress(DeployAddress[ChainId.RH]?.[ContractNames.PonsMemeHook]?.address, 'Pons meme hook');
}

export function getConfiguredPonsV4PoolManager(): Address {
  return expectAddress(DeployAddress[ChainId.RH]?.[ContractNames.PoolManager]?.address, 'RH PoolManager');
}

export function encodePonsMinOut(minOut: bigint): Hex {
  return encodeAbiParameters(abiParamsUint256, [minOut]) as Hex;
}

function toQuoteRouterToken(pairToken: Address, isNativeQuote: boolean): Address {
  if (isNativeQuote || isZero(pairToken)) return ZERO_ADDRESS;
  const wNative = getWNative(ChainId.RH);
  if (pairToken.toLowerCase() === wNative.toLowerCase()) return ZERO_ADDRESS;
  return pairToken;
}

function parseV2Launch(raw: any): {
  token: Address;
  curve: Address;
  pairToken: Address;
  poolFee: number;
  tickSpacing: number;
  creatorTaxBps: number;
  graduationThreshold: bigint;
  phase: number;
  exists: boolean;
} | null {
  const row = Array.isArray(raw) ? raw : (raw ?? {});
  const exists = Boolean(Array.isArray(row) ? row[14] : row.exists);
  const curve = asAddress(Array.isArray(row) ? row[1] : row.curve);
  if (!exists && isZero(curve)) return null;
  return {
    token: asAddress(Array.isArray(row) ? row[0] : row.token),
    curve,
    pairToken: asAddress(Array.isArray(row) ? row[4] : row.pairToken),
    poolFee: Number(Array.isArray(row) ? row[6] : row.poolFee) || 0,
    tickSpacing: Number(Array.isArray(row) ? row[7] : row.tickSpacing) || 0,
    creatorTaxBps: Number(Array.isArray(row) ? row[8] : row.creatorTaxBps) || 0,
    graduationThreshold: BigInt(Array.isArray(row) ? (row[5] ?? 0) : (row.graduationThreshold ?? 0)),
    phase: Number(Array.isArray(row) ? row[10] : row.phase) || 0,
    exists,
  };
}

async function readV2Launch(client: any, tokenAddress: Address) {
  const factory = getConfiguredPonsV2Factory();
  const raw = await client.readContract({
    address: factory,
    abi: ponsV2FactoryAbi,
    functionName: 'getLaunchedToken',
    args: [tokenAddress],
  });
  return parseV2Launch(raw);
}

async function readV1Pool(client: any, tokenAddress: Address): Promise<Address | null> {
  try {
    const pool = asAddress(await client.readContract({
      address: tokenAddress,
      abi: ponsV1TokenAbi,
      functionName: 'liquidityPool',
    }));
    return isZero(pool) ? null : pool;
  } catch {
    return null;
  }
}

async function loadPonsTradeState(tokenAddress: Address): Promise<PonsTradeState | null> {
  return await withRhRead('pons.tradeState', async (client) => {
    const v2 = await readV2Launch(client, tokenAddress).catch(() => null);
    if (v2?.exists && !isZero(v2.curve)) {
      let isNativeQuote = isZero(v2.pairToken);
      try {
        isNativeQuote = Boolean(await client.readContract({
          address: v2.curve,
          abi: ponsCurveAbi,
          functionName: 'isNativeQuote',
        }));
      } catch {
      }
      const phase = v2.phase;
      const isInner = phase === PONS_V2_PHASE.NotGraduated;
      const isOuter = phase === PONS_V2_PHASE.PoolCreated;
      return {
        version: 2,
        phase,
        isInner,
        isOuter,
        tradeable: isInner || isOuter,
        curve: v2.curve,
        v3Pool: ZERO_ADDRESS,
        pairToken: v2.pairToken,
        quoteRouterToken: toQuoteRouterToken(v2.pairToken, isNativeQuote),
        isNativeQuote,
        poolFee: v2.poolFee,
        tickSpacing: v2.tickSpacing,
        creatorTaxBps: v2.creatorTaxBps,
        graduationThreshold: v2.graduationThreshold,
        memeHook: getConfiguredPonsMemeHook(),
        v4PoolManager: getConfiguredPonsV4PoolManager(),
      } satisfies PonsTradeState;
    }

    const v3Pool = await readV1Pool(client, tokenAddress);
    if (!v3Pool) return null;
    return {
      version: 1,
      phase: PONS_V2_PHASE.PoolCreated,
      isInner: false,
      isOuter: true,
      tradeable: true,
      curve: ZERO_ADDRESS,
      v3Pool,
      pairToken: ZERO_ADDRESS,
      quoteRouterToken: ZERO_ADDRESS,
      isNativeQuote: true,
      poolFee: PONS_V1_POOL_FEE,
      tickSpacing: 0,
      creatorTaxBps: 0,
      graduationThreshold: 0n,
      memeHook: ZERO_ADDRESS,
      v4PoolManager: ZERO_ADDRESS,
    } satisfies PonsTradeState;
  });
}

export async function getPonsTradeState(tokenAddress: Address, opts?: PonsTradeStateOptions): Promise<PonsTradeState | null> {
  const key = tokenAddress.toLowerCase();
  const force = opts?.force === true;
  const cached = ponsTradeStateCache.get(key);
  if (!force && cached) {
    const ttlMs = cached.value?.isInner ? PONS_TRADE_STATE_INNER_TTL_MS : PONS_TRADE_STATE_OUTER_TTL_MS;
    if (Date.now() - cached.ts < ttlMs) return cached.value;
  }
  const inflight = ponsTradeStateInFlight.get(key);
  if (!force && inflight) return await inflight;
  const p = loadPonsTradeState(tokenAddress).finally(() => {
    ponsTradeStateInFlight.delete(key);
  });
  ponsTradeStateInFlight.set(key, p);
  const resolved = await p;
  ponsTradeStateCache.set(key, { ts: Date.now(), value: resolved });
  return resolved;
}

async function quoteV2Buy(curve: Address, quoteIn: bigint): Promise<bigint> {
  if (quoteIn <= 0n) return 0n;
  return await withRhRead('pons.quote.buy', async (client) => {
    const [reserves, sellable, feeBps, creatorTaxBps] = await Promise.all([
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'getReserves' }) as Promise<[bigint, bigint]>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'sellableTokens' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'feeBps' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' }).catch(() => 0n) as Promise<bigint>,
    ]);
    const quoteReserve = BigInt(reserves[0] ?? 0n);
    const tokenReserve = BigInt(reserves[1] ?? 0n);
    if (quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
    const totalFeeBps = BigInt(feeBps) + BigInt(creatorTaxBps);
    const fee = totalFeeBps > BPS_DENOM ? BPS_DENOM : totalFeeBps;
    const netQuoteIn = quoteIn * (BPS_DENOM - fee) / BPS_DENOM;
    if (netQuoteIn <= 0n) return 0n;
    const tokensOut = tokenReserve * netQuoteIn / (quoteReserve + netQuoteIn);
    const cap = BigInt(sellable);
    if (cap > 0n && tokensOut > cap) return cap;
    return tokensOut;
  });
}

async function quoteV2Sell(curve: Address, tokensIn: bigint): Promise<bigint> {
  if (tokensIn <= 0n) return 0n;
  return await withRhRead('pons.quote.sell', async (client) => {
    const [reserves, feeBps, creatorTaxBps] = await Promise.all([
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'getReserves' }) as Promise<[bigint, bigint]>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'feeBps' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' }).catch(() => 0n) as Promise<bigint>,
    ]);
    const quoteReserve = BigInt(reserves[0] ?? 0n);
    const tokenReserve = BigInt(reserves[1] ?? 0n);
    if (quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
    const quoteOutGross = quoteReserve * tokensIn / (tokenReserve + tokensIn);
    const totalFeeBps = BigInt(feeBps) + BigInt(creatorTaxBps);
    const fee = totalFeeBps > BPS_DENOM ? BPS_DENOM : totalFeeBps;
    return quoteOutGross * (BPS_DENOM - fee) / BPS_DENOM;
  });
}

async function quoteV1ExactIn(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number): Promise<bigint> {
  const wrappedIn = toQuoteToken(ChainId.RH, tokenIn);
  const wrappedOut = toQuoteToken(ChainId.RH, tokenOut);
  return await getQuote(ChainId.RH, wrappedIn, wrappedOut, amountIn, fee);
}

export async function quotePonsBuy(tokenAddress: Address, quoteIn: bigint, opts?: PonsTradeStateOptions): Promise<bigint> {
  const state = await getPonsTradeState(tokenAddress, opts);
  if (!state?.tradeable || quoteIn <= 0n) return 0n;
  if (state.version === 2 && state.isInner) return await quoteV2Buy(state.curve, quoteIn);
  if (state.version === 1) return await quoteV1ExactIn(state.quoteRouterToken, tokenAddress, quoteIn, state.poolFee || PONS_V1_POOL_FEE);
  return 0n;
}

export async function quotePonsSell(tokenAddress: Address, tokensIn: bigint, opts?: PonsTradeStateOptions): Promise<bigint> {
  const state = await getPonsTradeState(tokenAddress, opts);
  if (!state?.tradeable || tokensIn <= 0n) return 0n;
  if (state.version === 2 && state.isInner) return await quoteV2Sell(state.curve, tokensIn);
  if (state.version === 1) return await quoteV1ExactIn(tokenAddress, state.quoteRouterToken, tokensIn, state.poolFee || PONS_V1_POOL_FEE);
  return 0n;
}

export function buildPonsBuyDesc(input: {
  state: PonsTradeState;
  tokenOut: Address;
  minOut: bigint;
}): SwapDescLike {
  const { state, tokenOut, minOut } = input;
  const tokenIn = state.quoteRouterToken;
  if (state.version === 2 && state.isInner) {
    return getRouterSwapDesc({
      swapType: RhSwapType.PONS_V2_BUY,
      tokenIn,
      tokenOut,
      poolAddress: state.curve,
      fee: 0,
      data: minOut > 0n ? encodePonsMinOut(minOut) : '0x',
    });
  }
  if (state.version === 2 && state.isOuter) {
    return getRouterSwapDesc({
      swapType: RhSwapType.V4_EXACT_IN,
      tokenIn,
      tokenOut,
      poolAddress: ZERO_ADDRESS,
      fee: state.poolFee,
      tickSpacing: state.tickSpacing,
      hooks: state.memeHook,
      poolManager: state.v4PoolManager,
    });
  }
  return getRouterSwapDesc({
    swapType: RhSwapType.PONS_V1_EXACT_IN,
    tokenIn,
    tokenOut,
    poolAddress: state.v3Pool,
    fee: state.poolFee || PONS_V1_POOL_FEE,
  });
}

export function buildPonsSellDesc(input: {
  state: PonsTradeState;
  tokenIn: Address;
  minOut: bigint;
}): SwapDescLike {
  const { state, tokenIn, minOut } = input;
  const tokenOut = state.quoteRouterToken;
  if (state.version === 2 && state.isInner) {
    return getRouterSwapDesc({
      swapType: RhSwapType.PONS_V2_SELL,
      tokenIn,
      tokenOut,
      poolAddress: state.curve,
      fee: 0,
      data: minOut > 0n ? encodePonsMinOut(minOut) : '0x',
    });
  }
  if (state.version === 2 && state.isOuter) {
    return getRouterSwapDesc({
      swapType: RhSwapType.V4_EXACT_IN,
      tokenIn,
      tokenOut,
      poolAddress: ZERO_ADDRESS,
      fee: state.poolFee,
      tickSpacing: state.tickSpacing,
      hooks: state.memeHook,
      poolManager: state.v4PoolManager,
    });
  }
  return getRouterSwapDesc({
    swapType: RhSwapType.PONS_V1_EXACT_IN,
    tokenIn,
    tokenOut,
    poolAddress: state.v3Pool,
    fee: state.poolFee || PONS_V1_POOL_FEE,
  });
}

export async function readPonsTokenMeta(tokenAddress: Address): Promise<{
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  logo: string;
  description: string;
  creator: Address;
  twitterUrl: string;
  telegramUrl: string;
  website: string;
} | null> {
  return await withRhRead('pons.tokenMeta', async (client) => {
    try {
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'name' }) as Promise<string>,
        client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'symbol' }) as Promise<string>,
        client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'decimals' }) as Promise<number>,
        client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'totalSupply' }) as Promise<bigint>,
      ]);
      let logo = '';
      let description = '';
      let creator = ZERO_ADDRESS;
      let twitterUrl = '';
      let telegramUrl = '';
      let website = '';
      try {
        const info = await client.readContract({
          address: tokenAddress,
          abi: ponsTokenInfoAbi,
          functionName: 'getTokenInfo',
        }) as any;
        const deployer = asAddress(Array.isArray(info) ? info[0] : info?.tokenDeployer);
        creator = deployer;
        logo = String(Array.isArray(info) ? info[1] : info?.tokenLogo || '');
        description = String(Array.isArray(info) ? info[2] : info?.tokenDescription || '');
        const socials = Array.isArray(info) ? info[3] : info?.tokenSocials;
        twitterUrl = String(Array.isArray(socials) ? socials[0] : socials?.twitter || '');
        telegramUrl = String(Array.isArray(socials) ? socials[1] : socials?.telegram || '');
        website = String(Array.isArray(socials) ? socials[3] : socials?.website || '');
      } catch {
      }
      return {
        name: String(name || ''),
        symbol: String(symbol || ''),
        decimals: Number(decimals) || 18,
        totalSupply: BigInt(totalSupply || 0n),
        logo,
        description,
        creator,
        twitterUrl,
        telegramUrl,
        website,
      };
    } catch {
      return null;
    }
  });
}

export async function readPonsCurveProgress(curve: Address): Promise<{ progress: number; priceQuote: number }> {
  return await withRhRead('pons.curveProgress', async (client) => {
    const [reserves, raised, threshold] = await Promise.all([
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'getReserves' }).catch(() => [0n, 0n]) as Promise<[bigint, bigint]>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'realQuoteReserve' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'graduationThreshold' }).catch(() => 0n) as Promise<bigint>,
    ]);
    const quoteReserve = BigInt(reserves?.[0] ?? 0n);
    const tokenReserve = BigInt(reserves?.[1] ?? 0n);
    const priceQuote = quoteReserve > 0n && tokenReserve > 0n
      ? Number(formatUnits(quoteReserve, 18)) / Number(formatUnits(tokenReserve, 18))
      : 0;
    const raisedN = Number(formatUnits(BigInt(raised || 0n), 18));
    const thresholdN = Number(formatUnits(BigInt(threshold || 0n), 18));
    const progress = thresholdN > 0 && Number.isFinite(raisedN) && Number.isFinite(thresholdN)
      ? Math.max(0, Math.min(100, (raisedN / thresholdN) * 100))
      : 0;
    return { progress, priceQuote: Number.isFinite(priceQuote) ? priceQuote : 0 };
  });
}
