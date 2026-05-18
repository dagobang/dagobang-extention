import { encodeAbiParameters, getAddress, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { hyperTokens } from '@/constants/tokens/chains/hyper';
import { RpcService } from '@/services/rpc';

import type { Address, Hex } from './tradeTypes';

async function withHyperRead<T>(caller: string, run: (client: any) => Promise<T>): Promise<T> {
  return await RpcService.withBalancedReadClient({
    chainId: ChainId.HYPER,
    caller,
    run,
  });
}

const hyperBondingAbi = parseAbi([
  'function creatorOf(address token_) view returns (address)',
  'function ltOf(address token_) view returns (address)',
  'function graduatedPair(address token_) view returns (address)',
  'function previewLtUntilGraduation(address token_) view returns (uint256)',
  'function router() view returns (address)',
]);

const hyperZapViewAbi = parseAbi([
  'function buyFeeBps() view returns (uint256)',
  'function sellFeeBps() view returns (uint256)',
]);

const leveragedTokenAbi = parseAbi([
  'function baseToLtAmount(uint256 baseAmount) view returns (uint256)',
  'function ltToBaseAmount(uint256 ltAmount) view returns (uint256)',
]);

const hyperCurveRouterAbi = parseAbi([
  'function previewBuy(address token, uint256 amountIn) view returns (uint256 amountInUsed, uint256 tokensOut)',
  'function getAmountOut(address token, bool isBuy, uint256 amountIn) view returns (uint256)',
]);

const pairV2Abi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

const BPS_DENOM = 10_000n;
const PROTOCOL_MIN_NET_USDC_AMOUNT = 10_000_000n;
const UI_MIN_GROSS_USDC_AMOUNT = 11_000_000n;

export type HyperTradeState = {
  creator: Address;
  ltAddress: Address;
  pairAddress: Address;
  isGraduated: boolean;
  isInner: boolean;
  isOuter: boolean;
};

type HyperTradeStaticState = {
  creator: Address;
  ltAddress: Address;
};

type HyperTradeDynamicState = {
  pairAddress: Address;
  isGraduated: boolean;
};

type HyperTradeStateOptions = {
  force?: boolean;
};

type HyperQuoteOptions = {
  force?: boolean;
};

type PairStaticMeta = {
  token0: Address;
  token1: Address;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const HYPER_TRADE_STATE_UNGRADUATED_TTL_MS = 5000;
const HYPER_TRADE_STATE_GRADUATED_TTL_MS = 30000;
const HYPER_PAIR_RESERVES_TTL_MS = 1500;
const HYPER_QUOTE_TTL_MS = 2000;
const hyperTradeStaticStateCache = new Map<string, HyperTradeStaticState>();
const hyperTradeStaticStateInFlight = new Map<string, Promise<HyperTradeStaticState>>();
const hyperTradeDynamicStateCache = new Map<string, { ts: number; value: HyperTradeDynamicState }>();
const hyperTradeDynamicStateInFlight = new Map<string, Promise<HyperTradeDynamicState>>();
const hyperPairStaticMetaCache = new Map<string, PairStaticMeta>();
const hyperPairStaticMetaInFlight = new Map<string, Promise<PairStaticMeta>>();
const hyperPairReservesCache = new Map<string, { ts: number; value: [bigint, bigint, number] }>();
const hyperPairReservesInFlight = new Map<string, Promise<[bigint, bigint, number]>>();
const hyperBuyQuoteCache = new Map<string, { ts: number; value: bigint }>();
const hyperBuyQuoteInFlight = new Map<string, Promise<bigint>>();
const hyperSellQuoteCache = new Map<string, { ts: number; value: bigint }>();
const hyperSellQuoteInFlight = new Map<string, Promise<bigint>>();

function expectAddress(value: string | undefined, label: string): Address {
  const trimmed = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    throw new Error(`${label} address not set`);
  }
  return getAddress(trimmed as Address);
}

export function isHyperAltfunPlatform(platform: string | null | undefined): boolean {
  const value = String(platform || '').trim().toLowerCase();
  return value === 'altfun' || value === 'alt.fun';
}

export function getHyperUsdcAddress(): Address {
  return hyperTokens.usdc.address as Address;
}

export function getConfiguredHyperZapAddress(): Address {
  return expectAddress(DeployAddress[ChainId.HYPER]?.[ContractNames.HyperZap]?.address, 'Hyper Zap');
}

export function getConfiguredHyperBondingAddress(): Address {
  return expectAddress(DeployAddress[ChainId.HYPER]?.[ContractNames.HyperBonding]?.address, 'Hyper Bonding');
}

async function getHyperTradeStaticState(tokenAddress: Address): Promise<HyperTradeStaticState> {
  const key = tokenAddress.toLowerCase();
  const cached = hyperTradeStaticStateCache.get(key);
  if (cached) return cached;
  const inflight = hyperTradeStaticStateInFlight.get(key);
  if (inflight) return await inflight;
  const bonding = getConfiguredHyperBondingAddress();
  const p = withHyperRead('hyper.tradeState.static', async (client) => {
    const [creator, ltAddress] = await Promise.all([
      client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'creatorOf', args: [tokenAddress] }) as Promise<Address>,
      client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'ltOf', args: [tokenAddress] }) as Promise<Address>,
    ]);
    return { creator, ltAddress };
  }).finally(() => {
    hyperTradeStaticStateInFlight.delete(key);
  });
  hyperTradeStaticStateInFlight.set(key, p);
  const resolved = await p;
  hyperTradeStaticStateCache.set(key, resolved);
  return resolved;
}

async function getHyperTradeDynamicState(tokenAddress: Address, opts?: HyperTradeStateOptions): Promise<HyperTradeDynamicState> {
  const key = tokenAddress.toLowerCase();
  const force = opts?.force === true;
  const cached = hyperTradeDynamicStateCache.get(key);
  if (!force && cached) {
    const ttlMs = cached.value.isGraduated ? HYPER_TRADE_STATE_GRADUATED_TTL_MS : HYPER_TRADE_STATE_UNGRADUATED_TTL_MS;
    if (Date.now() - cached.ts < ttlMs) return cached.value;
  }
  const inflight = hyperTradeDynamicStateInFlight.get(key);
  if (!force && inflight) return await inflight;
  const bonding = getConfiguredHyperBondingAddress();
  const p = withHyperRead('hyper.tradeState.dynamic', async (client) => {
    const pairAddress = await (client.readContract({
      address: bonding,
      abi: hyperBondingAbi,
      functionName: 'graduatedPair',
      args: [tokenAddress],
    }) as Promise<Address>);
    return {
      pairAddress,
      isGraduated: pairAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase(),
    };
  }).finally(() => {
    hyperTradeDynamicStateInFlight.delete(key);
  });
  hyperTradeDynamicStateInFlight.set(key, p);
  const resolved = await p;
  hyperTradeDynamicStateCache.set(key, { ts: Date.now(), value: resolved });
  return resolved;
}

export async function getHyperTradeState(tokenAddress: Address, opts?: HyperTradeStateOptions): Promise<HyperTradeState> {
  const [{ creator, ltAddress }, { pairAddress, isGraduated }] = await Promise.all([
    getHyperTradeStaticState(tokenAddress),
    getHyperTradeDynamicState(tokenAddress, opts),
  ]);
  const hasCreator = creator.toLowerCase() !== ZERO_ADDRESS.toLowerCase();

  return {
    creator,
    ltAddress,
    pairAddress,
    isGraduated,
    isInner: hasCreator && !isGraduated,
    isOuter: hasCreator && isGraduated,
  };
}

async function getPairStaticMeta(pairAddress: Address): Promise<PairStaticMeta> {
  const key = pairAddress.toLowerCase();
  const cached = hyperPairStaticMetaCache.get(key);
  if (cached) return cached;
  const inflight = hyperPairStaticMetaInFlight.get(key);
  if (inflight) return await inflight;
  const p = withHyperRead('hyper.quotePair.static', async (client) => {
    const [token0, token1] = await Promise.all([
      client.readContract({ address: pairAddress, abi: pairV2Abi, functionName: 'token0' }) as Promise<Address>,
      client.readContract({ address: pairAddress, abi: pairV2Abi, functionName: 'token1' }) as Promise<Address>,
    ]);
    return { token0, token1 };
  }).finally(() => {
    hyperPairStaticMetaInFlight.delete(key);
  });
  hyperPairStaticMetaInFlight.set(key, p);
  const resolved = await p;
  hyperPairStaticMetaCache.set(key, resolved);
  return resolved;
}

async function getPairReserves(pairAddress: Address, opts?: HyperQuoteOptions): Promise<[bigint, bigint, number]> {
  const key = pairAddress.toLowerCase();
  const force = opts?.force === true;
  const cached = hyperPairReservesCache.get(key);
  if (!force && cached && Date.now() - cached.ts < HYPER_PAIR_RESERVES_TTL_MS) return cached.value;
  const inflight = hyperPairReservesInFlight.get(key);
  if (!force && inflight) return await inflight;
  const p = withHyperRead('hyper.quotePair.reserves', async (client) => await (
    client.readContract({ address: pairAddress, abi: pairV2Abi, functionName: 'getReserves' }) as Promise<[bigint, bigint, number]>
  )).finally(() => {
    hyperPairReservesInFlight.delete(key);
  });
  hyperPairReservesInFlight.set(key, p);
  const resolved = await p;
  hyperPairReservesCache.set(key, { ts: Date.now(), value: resolved });
  return resolved;
}

function quoteV2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 25n): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (BPS_DENOM - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS_DENOM + amountInWithFee;
  return denominator > 0n ? numerator / denominator : 0n;
}

async function quotePairAmountOut(pairAddress: Address, tokenIn: Address, amountIn: bigint, opts?: HyperQuoteOptions): Promise<bigint> {
  const [{ token0, token1 }, reserves] = await Promise.all([
    getPairStaticMeta(pairAddress),
    getPairReserves(pairAddress, opts),
  ]);

  const normalizedIn = tokenIn.toLowerCase();
  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  if (token0.toLowerCase() === normalizedIn) return quoteV2AmountOut(amountIn, reserve0, reserve1);
  if (token1.toLowerCase() === normalizedIn) return quoteV2AmountOut(amountIn, reserve1, reserve0);
  return 0n;
}

export async function quoteHyperBuyFromUsdc(tokenAddress: Address, usdcAmount: bigint, opts?: HyperQuoteOptions): Promise<bigint> {
  if (usdcAmount <= 0n) return 0n;
  const force = opts?.force === true;
  const cacheKey = `${tokenAddress.toLowerCase()}:${usdcAmount.toString()}`;
  const cached = hyperBuyQuoteCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < HYPER_QUOTE_TTL_MS) return cached.value;
  const inflight = hyperBuyQuoteInFlight.get(cacheKey);
  if (!force && inflight) return await inflight;

  const p = (async () => {
    const bonding = getConfiguredHyperBondingAddress();
    const zap = getConfiguredHyperZapAddress();
    const state = await getHyperTradeState(tokenAddress, { force });
    if (state.creator.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error('Hyper token not supported by Bonding');
    }

    const [buyFeeBps, bondingRouter] = await withHyperRead('hyper.quoteBuy', async (client) => await Promise.all([
      client.readContract({ address: zap, abi: hyperZapViewAbi, functionName: 'buyFeeBps' }) as Promise<bigint>,
      client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'router' }) as Promise<Address>,
    ]));

    const netUsdc = (usdcAmount * (BPS_DENOM - buyFeeBps)) / BPS_DENOM;
    if (usdcAmount < UI_MIN_GROSS_USDC_AMOUNT) return 0n;
    if (netUsdc < PROTOCOL_MIN_NET_USDC_AMOUNT) return 0n;

    if (state.isOuter) {
      const ltIn = await withHyperRead('hyper.quoteBuy', async (client) => await (client.readContract({
        address: state.ltAddress,
        abi: leveragedTokenAbi,
        functionName: 'baseToLtAmount',
        args: [netUsdc],
      }) as Promise<bigint>));
      return await quotePairAmountOut(state.pairAddress, state.ltAddress, ltIn, opts);
    }

    const [ltIfFull, ltUntilGraduation] = await withHyperRead('hyper.quoteBuy', async (client) => await Promise.all([
      client.readContract({
        address: state.ltAddress,
        abi: leveragedTokenAbi,
        functionName: 'baseToLtAmount',
        args: [netUsdc],
      }) as Promise<bigint>,
      client.readContract({
        address: bonding,
        abi: hyperBondingAbi,
        functionName: 'previewLtUntilGraduation',
        args: [tokenAddress],
      }) as Promise<bigint>,
    ]));

    let baseToConvert = netUsdc;
    if (ltUntilGraduation < ltIfFull) {
      baseToConvert = 0n;
      if (ltUntilGraduation > 0n) {
        baseToConvert = await withHyperRead('hyper.quoteBuy', async (client) => await (client.readContract({
          address: state.ltAddress,
          abi: leveragedTokenAbi,
          functionName: 'ltToBaseAmount',
          args: [ltUntilGraduation],
        }) as Promise<bigint>));
        const reminted = await withHyperRead('hyper.quoteBuy', async (client) => await (client.readContract({
          address: state.ltAddress,
          abi: leveragedTokenAbi,
          functionName: 'baseToLtAmount',
          args: [baseToConvert],
        }) as Promise<bigint>));
        if (reminted < ltUntilGraduation) baseToConvert += 1n;
      }
      if (baseToConvert > netUsdc) baseToConvert = netUsdc;
      if (baseToConvert < PROTOCOL_MIN_NET_USDC_AMOUNT) {
        if (netUsdc < PROTOCOL_MIN_NET_USDC_AMOUNT) return 0n;
        baseToConvert = PROTOCOL_MIN_NET_USDC_AMOUNT;
      }
    }

    const ltMinted = await withHyperRead('hyper.quoteBuy', async (client) => await (client.readContract({
      address: state.ltAddress,
      abi: leveragedTokenAbi,
      functionName: 'baseToLtAmount',
      args: [baseToConvert],
    }) as Promise<bigint>));

    const result = await withHyperRead('hyper.quoteBuy', async (client) => await (client.readContract({
      address: bondingRouter,
      abi: hyperCurveRouterAbi,
      functionName: 'previewBuy',
      args: [tokenAddress, ltMinted],
    }) as Promise<[bigint, bigint]>));

    return BigInt(result[1]);
  })().finally(() => {
    hyperBuyQuoteInFlight.delete(cacheKey);
  });
  hyperBuyQuoteInFlight.set(cacheKey, p);
  const resolved = await p;
  hyperBuyQuoteCache.set(cacheKey, { ts: Date.now(), value: resolved });
  return resolved;
}

export async function quoteHyperSellToUsdc(tokenAddress: Address, tokenAmount: bigint, opts?: HyperQuoteOptions): Promise<bigint> {
  if (tokenAmount <= 0n) return 0n;
  const force = opts?.force === true;
  const cacheKey = `${tokenAddress.toLowerCase()}:${tokenAmount.toString()}`;
  const cached = hyperSellQuoteCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < HYPER_QUOTE_TTL_MS) return cached.value;
  const inflight = hyperSellQuoteInFlight.get(cacheKey);
  if (!force && inflight) return await inflight;

  const p = (async () => {
    const bonding = getConfiguredHyperBondingAddress();
    const zap = getConfiguredHyperZapAddress();
    const state = await getHyperTradeState(tokenAddress, { force });
    if (state.creator.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      throw new Error('Hyper token not supported by Bonding');
    }

    const sellFeeBps = await withHyperRead('hyper.quoteSell', async (client) => await (client.readContract({
      address: zap,
      abi: hyperZapViewAbi,
      functionName: 'sellFeeBps',
    }) as Promise<bigint>));

    let ltOut: bigint;
    if (state.isOuter) {
      ltOut = await quotePairAmountOut(state.pairAddress, tokenAddress, tokenAmount, opts);
    } else {
      const bondingRouter = await withHyperRead('hyper.quoteSell', async (client) => await (client.readContract({
        address: bonding,
        abi: hyperBondingAbi,
        functionName: 'router',
      }) as Promise<Address>));
      ltOut = await withHyperRead('hyper.quoteSell', async (client) => await (client.readContract({
        address: bondingRouter,
        abi: hyperCurveRouterAbi,
        functionName: 'getAmountOut',
        args: [tokenAddress, false, tokenAmount],
      }) as Promise<bigint>));
    }

    const grossUsdc = await withHyperRead('hyper.quoteSell', async (client) => await (client.readContract({
      address: state.ltAddress,
      abi: leveragedTokenAbi,
      functionName: 'ltToBaseAmount',
      args: [ltOut],
    }) as Promise<bigint>));
    if (grossUsdc <= 0n) return 0n;
    return (grossUsdc * (BPS_DENOM - sellFeeBps)) / BPS_DENOM;
  })().finally(() => {
    hyperSellQuoteInFlight.delete(cacheKey);
  });
  hyperSellQuoteInFlight.set(cacheKey, p);
  const resolved = await p;
  hyperSellQuoteCache.set(cacheKey, { ts: Date.now(), value: resolved });
  return resolved;
}

export async function getHyperZapBuyGrossMinUsdc(): Promise<{ minGrossUsdc: bigint; buyFeeBps: bigint }> {
  const zap = getConfiguredHyperZapAddress();
  const buyFeeBps = await withHyperRead('hyper.quoteSell', async (client) => await (client.readContract({
    address: zap,
    abi: hyperZapViewAbi,
    functionName: 'buyFeeBps',
  }) as Promise<bigint>));
  const denominator = BPS_DENOM - buyFeeBps;
  if (denominator <= 0n) {
    throw new Error('Hyper Zap buy fee invalid');
  }
  const protocolMinGrossUsdc = (PROTOCOL_MIN_NET_USDC_AMOUNT * BPS_DENOM + denominator - 1n) / denominator;
  const minGrossUsdc = protocolMinGrossUsdc > UI_MIN_GROSS_USDC_AMOUNT ? protocolMinGrossUsdc : UI_MIN_GROSS_USDC_AMOUNT;
  return { minGrossUsdc, buyFeeBps };
}

export function encodeHyperZapBuyData(minTokensOut: bigint, referrer?: Address): Hex {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }],
    [minTokensOut, referrer ?? ('0x0000000000000000000000000000000000000000' as Address)],
  ) as Hex;
}

export function encodeHyperZapSellData(minUsdcOut: bigint): Hex {
  return encodeAbiParameters([{ type: 'uint256' }], [minUsdcOut]) as Hex;
}
