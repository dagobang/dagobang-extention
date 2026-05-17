import { encodeAbiParameters, getAddress, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { hyperTokens } from '@/constants/tokens/chains/hyper';
import { RpcService } from '@/services/rpc';

import type { Address, Hex } from './tradeTypes';

async function withHyperRead<T>(run: (client: any) => Promise<T>): Promise<T> {
  return await RpcService.withBalancedReadClient({
    chainId: ChainId.HYPER,
    run,
  });
}

const hyperBondingAbi = parseAbi([
  'function creatorOf(address token_) view returns (address)',
  'function ltOf(address token_) view returns (address)',
  'function isGraduating(address token_) view returns (bool)',
  'function isGraduated(address token_) view returns (bool)',
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
  isGraduating: boolean;
  isGraduated: boolean;
  isInner: boolean;
  isOuter: boolean;
};

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

export async function getHyperTradeState(tokenAddress: Address): Promise<HyperTradeState> {
  const bonding = getConfiguredHyperBondingAddress();
  const [creator, ltAddress, pairAddress, isGraduating, isGraduated] = await withHyperRead(async (client) => await Promise.all([
    client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'creatorOf', args: [tokenAddress] }) as Promise<Address>,
    client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'ltOf', args: [tokenAddress] }) as Promise<Address>,
    client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'graduatedPair', args: [tokenAddress] }) as Promise<Address>,
    client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'isGraduating', args: [tokenAddress] }) as Promise<boolean>,
    client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'isGraduated', args: [tokenAddress] }) as Promise<boolean>,
  ]));

  return {
    creator,
    ltAddress,
    pairAddress,
    isGraduating,
    isGraduated,
    isInner: creator.toLowerCase() !== '0x0000000000000000000000000000000000000000' && !isGraduating && !isGraduated,
    isOuter: creator.toLowerCase() !== '0x0000000000000000000000000000000000000000' && !isGraduating && isGraduated,
  };
}

function quoteV2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feeBps = 25n): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * (BPS_DENOM - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS_DENOM + amountInWithFee;
  return denominator > 0n ? numerator / denominator : 0n;
}

async function quotePairAmountOut(pairAddress: Address, tokenIn: Address, amountIn: bigint): Promise<bigint> {
  const [token0, token1, reserves] = await withHyperRead(async (client) => await Promise.all([
    client.readContract({ address: pairAddress, abi: pairV2Abi, functionName: 'token0' }) as Promise<Address>,
    client.readContract({ address: pairAddress, abi: pairV2Abi, functionName: 'token1' }) as Promise<Address>,
    client.readContract({ address: pairAddress, abi: pairV2Abi, functionName: 'getReserves' }) as Promise<[bigint, bigint, number]>,
  ]));

  const normalizedIn = tokenIn.toLowerCase();
  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  if (token0.toLowerCase() === normalizedIn) return quoteV2AmountOut(amountIn, reserve0, reserve1);
  if (token1.toLowerCase() === normalizedIn) return quoteV2AmountOut(amountIn, reserve1, reserve0);
  return 0n;
}

export async function quoteHyperBuyFromUsdc(tokenAddress: Address, usdcAmount: bigint): Promise<bigint> {
  if (usdcAmount <= 0n) return 0n;

  const bonding = getConfiguredHyperBondingAddress();
  const zap = getConfiguredHyperZapAddress();
  const state = await getHyperTradeState(tokenAddress);
  if (state.creator.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new Error('Hyper token not supported by Bonding');
  }
  if (state.isGraduating) {
    throw new Error('Token is graduating');
  }

  const [buyFeeBps, bondingRouter] = await withHyperRead(async (client) => await Promise.all([
    client.readContract({ address: zap, abi: hyperZapViewAbi, functionName: 'buyFeeBps' }) as Promise<bigint>,
    client.readContract({ address: bonding, abi: hyperBondingAbi, functionName: 'router' }) as Promise<Address>,
  ]));

  const netUsdc = (usdcAmount * (BPS_DENOM - buyFeeBps)) / BPS_DENOM;
  if (usdcAmount < UI_MIN_GROSS_USDC_AMOUNT) return 0n;
  if (netUsdc < PROTOCOL_MIN_NET_USDC_AMOUNT) return 0n;

  if (state.isOuter) {
    const ltIn = await withHyperRead(async (client) => await (client.readContract({
      address: state.ltAddress,
      abi: leveragedTokenAbi,
      functionName: 'baseToLtAmount',
      args: [netUsdc],
    }) as Promise<bigint>));
    return await quotePairAmountOut(state.pairAddress, state.ltAddress, ltIn);
  }

  const [ltIfFull, ltUntilGraduation] = await withHyperRead(async (client) => await Promise.all([
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
      baseToConvert = await withHyperRead(async (client) => await (client.readContract({
        address: state.ltAddress,
        abi: leveragedTokenAbi,
        functionName: 'ltToBaseAmount',
        args: [ltUntilGraduation],
      }) as Promise<bigint>));
      const reminted = await withHyperRead(async (client) => await (client.readContract({
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

  const ltMinted = await withHyperRead(async (client) => await (client.readContract({
    address: state.ltAddress,
    abi: leveragedTokenAbi,
    functionName: 'baseToLtAmount',
    args: [baseToConvert],
  }) as Promise<bigint>));

  const result = await withHyperRead(async (client) => await (client.readContract({
    address: bondingRouter,
    abi: hyperCurveRouterAbi,
    functionName: 'previewBuy',
    args: [tokenAddress, ltMinted],
  }) as Promise<[bigint, bigint]>));

  return BigInt(result[1]);
}

export async function quoteHyperSellToUsdc(tokenAddress: Address, tokenAmount: bigint): Promise<bigint> {
  if (tokenAmount <= 0n) return 0n;

  const bonding = getConfiguredHyperBondingAddress();
  const zap = getConfiguredHyperZapAddress();
  const state = await getHyperTradeState(tokenAddress);
  if (state.creator.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new Error('Hyper token not supported by Bonding');
  }
  if (state.isGraduating) {
    throw new Error('Token is graduating');
  }

  const sellFeeBps = await withHyperRead(async (client) => await (client.readContract({
    address: zap,
    abi: hyperZapViewAbi,
    functionName: 'sellFeeBps',
  }) as Promise<bigint>));

  let ltOut: bigint;
  if (state.isOuter) {
    ltOut = await quotePairAmountOut(state.pairAddress, tokenAddress, tokenAmount);
  } else {
    const bondingRouter = await withHyperRead(async (client) => await (client.readContract({
      address: bonding,
      abi: hyperBondingAbi,
      functionName: 'router',
    }) as Promise<Address>));
    ltOut = await withHyperRead(async (client) => await (client.readContract({
      address: bondingRouter,
      abi: hyperCurveRouterAbi,
      functionName: 'getAmountOut',
      args: [tokenAddress, false, tokenAmount],
    }) as Promise<bigint>));
  }

  const grossUsdc = await withHyperRead(async (client) => await (client.readContract({
    address: state.ltAddress,
    abi: leveragedTokenAbi,
    functionName: 'ltToBaseAmount',
    args: [ltOut],
  }) as Promise<bigint>));
  if (grossUsdc <= 0n) return 0n;
  return (grossUsdc * (BPS_DENOM - sellFeeBps)) / BPS_DENOM;
}

export async function getHyperZapBuyGrossMinUsdc(): Promise<{ minGrossUsdc: bigint; buyFeeBps: bigint }> {
  const zap = getConfiguredHyperZapAddress();
  const buyFeeBps = await withHyperRead(async (client) => await (client.readContract({
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
