export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
export const QUOTER_V2_BSC = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
export const WBNB_BSC = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

export enum SwapType {
  V2_EXACT_IN = 0,
  V3_EXACT_IN = 1,
  V4_EXACT_IN = 2,
  PANCAKE_INFINITY_EXACT_IN = 3,
  LUNA_LAUNCHPAD_V2 = 4,
  FOUR_MEME_BUY_AMAP = 5,
  FOUR_MEME_SELL = 6,
  FLAP_EXACT_INPUT = 7,
}

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export type SwapDescLike = {
  swapType: number;
  tokenIn: Address;
  tokenOut: Address;
  poolAddress: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hookData: Hex;
  poolManager: Address;
  parameters: Hex;
  data: Hex;
};

export type DexExactInQuote = {
  amountOut: bigint;
  swapType: SwapType;
  fee?: number;
  poolAddress: Address;
};

export type DexExactInOpts = { v3Fee?: number; v2HintPair?: string; prefer?: 'v2' | 'v3' };

export function getWNative(chainId: number): Address {
  return WBNB_BSC as Address;
}

export function toQuoteToken(chainId: number, routerToken: Address): Address {
  return routerToken === ZERO_ADDRESS ? getWNative(chainId) : routerToken;
}

export function getRouterSwapDesc(params: { swapType: SwapType; tokenIn: Address; tokenOut: Address; poolAddress: Address; fee: number; data?: Hex }): SwapDescLike {
  return {
    swapType: params.swapType,
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    poolAddress: params.poolAddress,
    fee: params.fee,
    tickSpacing: 0,
    hooks: ZERO_ADDRESS,
    hookData: '0x',
    poolManager: ZERO_ADDRESS,
    parameters: ZERO32,
    data: params.data ?? '0x',
  };
}

export function getDeadline(settings: any, chainId: number, deadlineSeconds?: number) {
  const seconds = deadlineSeconds ?? settings.chains[chainId].deadlineSeconds ?? 600;
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

export function getSlippageBps(settings: any, chainId: number, slippageBps?: number) {
  const s = slippageBps ?? settings.chains[chainId].slippageBps ?? 4000;
  return BigInt(s);
}

export function applySlippage(amountOut: bigint, slippageBps: bigint) {
  return amountOut * (10000n - slippageBps) / 10000n;
}

export function getV3FeeForDesc(q: DexExactInQuote, fallbackFee: number) {
  return q.swapType === SwapType.V3_EXACT_IN ? ((q.fee ?? fallbackFee) as number) : 0;
}
