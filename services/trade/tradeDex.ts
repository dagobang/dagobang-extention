import { getAddress } from 'viem';
import { RpcService } from '../rpc';
import { ChainId } from '../../constants/chains/chainId';
import { getBridgeTokenAddresses } from '../../constants/tokens/allTokens';
import { DeployAddress } from '../../constants/contracts/address';
import { ContractNames } from '../../constants/contracts/names';
import { factoryV2Abi, factoryV3Abi, pairV2Abi, poolV3Abi, quoterV2Abi } from '@/constants/contracts/abi';
import { Address, DexExactInOpts, DexExactInQuote, QUOTER_V2_BSC, SwapType, toQuoteToken, ZERO_ADDRESS } from './tradeTypes';

const V3_POOL_CACHE_MS = 5 * 60_000;
const v3PoolCache = new Map<string, { ts: number; pool: Address }>();

export function getBridgeToken(chainId: number, quoteTokenAddress?: string): Address | null {
  if (!quoteTokenAddress) return null;
  const trimmed = quoteTokenAddress.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  let addr: Address;
  try {
    addr = getAddress(trimmed as Address);
  } catch {
    return null;
  }

  const wNative = toQuoteToken(chainId, ZERO_ADDRESS);
  if (addr.toLowerCase() === wNative.toLowerCase()) return null;

  const allowlist = getBridgeTokenAddresses(chainId as ChainId);
  return allowlist.some((x) => x.toLowerCase() === addr.toLowerCase()) ? addr : null;
}

function getQuoter(chainId: number) {
  return chainId === 56 ? (QUOTER_V2_BSC as Address) : (ZERO_ADDRESS as Address);
}

export async function getQuote(chainId: number, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee: number) {
  const client = await RpcService.getClient();
  const quoter = getQuoter(chainId);

  if (quoter === ZERO_ADDRESS) return 0n;

  try {
    const { result } = await client.simulateContract({
      address: quoter,
      abi: quoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      }],
    });

    return result[0];
  } catch (e: any) {
    const s = typeof e?.shortMessage === 'string' ? e.shortMessage : '';
    const m = typeof e?.message === 'string' ? e.message : '';
    const raw = (s || m).trim();
    const low = raw.toLowerCase();
    if (raw && !low.includes('execution reverted') && !low.includes('revert')) {
      console.warn('Quote failed', raw);
    }
    return 0n;
  }
}

function isValidV3Fee(v: number | undefined): v is number {
  return v === 100 || v === 500 || v === 2500 || v === 10000;
}

async function getBestV3Quote(chainId: number, tokenIn: Address, tokenOut: Address, amountIn: bigint, explicitFee?: number) {
  const fees = explicitFee !== undefined
    ? (isValidV3Fee(explicitFee) ? [explicitFee, 2500, 500, 100, 10000] : [2500, 500, 100, 10000])
    : [2500, 500, 100, 10000];
  const results = await Promise.allSettled(
    fees.map(async (fee) => {
      const amountOut = await getQuote(chainId, tokenIn, tokenOut, amountIn, fee);
      return { amountOut, fee };
    })
  );

  let best: { amountOut: bigint; fee?: number } = { amountOut: 0n, fee: undefined as number | undefined };
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { amountOut, fee } = r.value;
    if (amountOut > best.amountOut) best = { amountOut, fee };
  }

  return best;
}

function getV2Factories(chainId: number) {
  const deploys = DeployAddress[chainId as ChainId] ?? {};
  const factories = [
    deploys[ContractNames.PancakeFactoryV2]?.address,
    deploys[ContractNames.UniswapFactoryV2]?.address,
  ].filter(Boolean) as string[];
  return factories;
}

function getV3Factories(chainId: number) {
  const deploys = DeployAddress[chainId as ChainId] ?? {};
  const factories = [
    deploys[ContractNames.PancakeFactoryV3]?.address,
    deploys[ContractNames.UniswapFactoryV3]?.address,
  ].filter(Boolean) as string[];
  return factories;
}

async function getFirstV3Pool(chainId: number, tokenIn: Address, tokenOut: Address, fee: number): Promise<Address | null> {
  if (!isValidV3Fee(fee)) return null;
  const client = await RpcService.getClient();
  const factories = getV3Factories(chainId);
  const poolResults = await Promise.allSettled(
    factories.map((factory) =>
      client.readContract({
        address: factory as Address,
        abi: factoryV3Abi,
        functionName: 'getPool',
        args: [tokenIn, tokenOut, fee],
      }) as Promise<Address>
    )
  );
  for (const r of poolResults) {
    if (r.status !== 'fulfilled') continue;
    if (r.value !== ZERO_ADDRESS) return r.value;
  }
  return null;
}

async function getFirstV3PoolCached(chainId: number, tokenIn: Address, tokenOut: Address, fee: number): Promise<Address | null> {
  const key = `${chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}:${fee}`;
  const now = Date.now();
  const cached = v3PoolCache.get(key);
  if (cached && now - cached.ts < V3_POOL_CACHE_MS) return cached.pool;
  const pool = await getFirstV3Pool(chainId, tokenIn, tokenOut, fee);
  if (pool && pool !== ZERO_ADDRESS) {
    v3PoolCache.set(key, { ts: now, pool });
  }
  return pool;
}

async function isV3PoolUsable(pool: Address): Promise<boolean> {
  const client = await RpcService.getClient();
  try {
    const liquidity = await (client.readContract({
      address: pool,
      abi: poolV3Abi,
      functionName: 'liquidity',
    }) as Promise<bigint>);
    return BigInt(liquidity) > 0n;
  } catch {
    return false;
  }
}

async function tryResolveV3WithoutQuote(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  fee: number
): Promise<{ ok: true; pool: Address } | { ok: false }> {
  const pool = await getFirstV3Pool(chainId, tokenIn, tokenOut, fee);
  if (!pool || pool === ZERO_ADDRESS) return { ok: false };
  const usable = await isV3PoolUsable(pool);
  return usable ? { ok: true, pool } : { ok: false };
}

async function quoteV2ExactInByPair(pair: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, feeBps: number) {
  const client = await RpcService.getClient();
  const tokenInAddr = getAddress(tokenIn);
  const tokenOutAddr = getAddress(tokenOut);

  const [token0, token1, reserves] = await Promise.all([
    client.readContract({
      address: pair,
      abi: pairV2Abi,
      functionName: 'token0',
    }) as Promise<Address>,
    client.readContract({
      address: pair,
      abi: pairV2Abi,
      functionName: 'token1',
    }) as Promise<Address>,
    client.readContract({
      address: pair,
      abi: pairV2Abi,
      functionName: 'getReserves',
    }) as Promise<[bigint, bigint, number]>,
  ]);

  if (
    (token0.toLowerCase() !== tokenInAddr.toLowerCase() && token0.toLowerCase() !== tokenOutAddr.toLowerCase()) ||
    (token1.toLowerCase() !== tokenInAddr.toLowerCase() && token1.toLowerCase() !== tokenOutAddr.toLowerCase())
  ) {
    return 0n;
  }

  const reserve0 = BigInt(reserves[0]);
  const reserve1 = BigInt(reserves[1]);
  const isToken0In = token0.toLowerCase() === tokenInAddr.toLowerCase();
  const reserveIn = isToken0In ? reserve0 : reserve1;
  const reserveOut = isToken0In ? reserve1 : reserve0;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const fee = BigInt(feeBps);
  const amountInWithFee = amountIn * (10000n - fee);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

async function getBestV2Quote(chainId: number, tokenIn: Address, tokenOut: Address, amountIn: bigint, hintPair?: string) {
  const client = await RpcService.getClient();
  const feeBps = 25;

  const pairs: Address[] = [];
  if (hintPair && hintPair !== ZERO_ADDRESS) {
    pairs.push(hintPair as Address);
  }

  const factories = getV2Factories(chainId);
  const pairResults = await Promise.allSettled(
    factories.map((factory) =>
      client.readContract({
        address: factory as Address,
        abi: factoryV2Abi,
        functionName: 'getPair',
        args: [tokenIn, tokenOut],
      }) as Promise<Address>
    )
  );
  for (const r of pairResults) {
    if (r.status !== 'fulfilled') continue;
    if (r.value !== ZERO_ADDRESS) pairs.push(r.value);
  }

  let best: { amountOut: bigint; pair?: Address } = { amountOut: 0n };
  const outResults = await Promise.allSettled(
    pairs.map((pair) => quoteV2ExactInByPair(pair, tokenIn, tokenOut, amountIn, feeBps).then((amountOut) => ({ pair, amountOut })))
  );
  for (const r of outResults) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.amountOut > best.amountOut) best = { amountOut: r.value.amountOut, pair: r.value.pair };
  }

  return best.amountOut > 0n ? { amountOut: best.amountOut, pair: best.pair } : { amountOut: 0n, pair: undefined as Address | undefined };
}

async function getBestDexExactIn(chainId: number, tokenIn: Address, tokenOut: Address, amountIn: bigint, opts?: DexExactInOpts) {
  const v2Promise = getBestV2Quote(chainId, tokenIn, tokenOut, amountIn, opts?.v2HintPair);
  const v3Promise = getBestV3Quote(chainId, tokenIn, tokenOut, amountIn, opts?.v3Fee);

  const [{ amountOut: v3Out, fee }, v2] = await Promise.all([v3Promise, v2Promise]);
  const v2Out = v2.amountOut ?? 0n;

  if (v3Out > 0n && v3Out >= v2Out) {
    const usedFee = fee ?? opts?.v3Fee;
    const pool = usedFee !== undefined ? await getFirstV3Pool(chainId, tokenIn, tokenOut, usedFee) : null;
    return { amountOut: v3Out, swapType: SwapType.V3_EXACT_IN, fee: usedFee, poolAddress: (pool ?? (ZERO_ADDRESS as Address)) };
  }
  if (v2Out > 0n && v2.pair) {
    return { amountOut: v2Out, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: v2.pair as Address };
  }
  if (v3Out > 0n) {
    const usedFee = fee ?? opts?.v3Fee;
    const pool = usedFee !== undefined ? await getFirstV3Pool(chainId, tokenIn, tokenOut, usedFee) : null;
    return { amountOut: v3Out, swapType: SwapType.V3_EXACT_IN, fee: usedFee, poolAddress: (pool ?? (ZERO_ADDRESS as Address)) };
  }

  return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: undefined as number | undefined, poolAddress: ZERO_ADDRESS as Address };
}

async function getFirstV2Pair(chainId: number, tokenIn: Address, tokenOut: Address): Promise<Address | null> {
  const client = await RpcService.getClient();
  const factories = getV2Factories(chainId);
  const pairResults = await Promise.allSettled(
    factories.map((factory) =>
      client.readContract({
        address: factory as Address,
        abi: factoryV2Abi,
        functionName: 'getPair',
        args: [tokenIn, tokenOut],
      }) as Promise<Address>
    )
  );
  for (const r of pairResults) {
    if (r.status !== 'fulfilled') continue;
    if (r.value !== ZERO_ADDRESS) return r.value;
  }
  return null;
}

async function isV2PairMatchTokens(pair: Address, tokenIn: Address, tokenOut: Address): Promise<boolean> {
  const client = await RpcService.getClient();
  try {
    const [token0, token1] = await Promise.all([
      client.readContract({
        address: pair,
        abi: pairV2Abi,
        functionName: 'token0',
      }) as Promise<Address>,
      client.readContract({
        address: pair,
        abi: pairV2Abi,
        functionName: 'token1',
      }) as Promise<Address>,
    ]);
    const a = tokenIn.toLowerCase();
    const b = tokenOut.toLowerCase();
    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    return (t0 === a && t1 === b) || (t0 === b && t1 === a);
  } catch {
    return false;
  }
}

async function resolveDexExactInTurbo(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  opts?: DexExactInOpts,
  needAmountOut?: boolean
) {
  const hintPair = opts?.v2HintPair && opts.v2HintPair !== ZERO_ADDRESS ? (opts.v2HintPair as Address) : null;
  const prefer = opts?.prefer;

  if (prefer === 'v2') {
    const hintOk = hintPair ? await isV2PairMatchTokens(hintPair, tokenIn, tokenOut) : false;
    const pair = hintOk ? hintPair : await getFirstV2Pair(chainId, tokenIn, tokenOut);
    if (pair) {
      const amountOut = needAmountOut ? await quoteV2ExactInByPair(pair, tokenIn, tokenOut, amountIn, 25) : 0n;
      if (!needAmountOut || amountOut > 0n) {
        return { amountOut, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: pair };
      }
    }
  }

  if (!needAmountOut && prefer !== 'v3' && !isValidV3Fee(opts?.v3Fee) && hintPair) {
    const ok = await isV2PairMatchTokens(hintPair, tokenIn, tokenOut);
    if (ok) {
      return { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: hintPair };
    }
  }

  const candidates: number[] = [];
  if (isValidV3Fee(opts?.v3Fee)) {
    candidates.push(opts!.v3Fee as number);
  } else {
    candidates.push(2500, 500, 100, 10000);
  }

  if (!needAmountOut) {
    const wNative = toQuoteToken(chainId, ZERO_ADDRESS);
    const allowlist = getBridgeTokenAddresses(chainId as ChainId);
    const isBridgeHop =
      tokenIn.toLowerCase() === wNative.toLowerCase() ||
      tokenOut.toLowerCase() === wNative.toLowerCase() ||
      allowlist.some((x) => x.toLowerCase() === tokenIn.toLowerCase()) ||
      allowlist.some((x) => x.toLowerCase() === tokenOut.toLowerCase());

    const feeOrder = (() => {
      const uniq = Array.from(new Set(candidates));
      if (prefer === 'v3' || isBridgeHop) {
        const head = uniq.filter((x) => x === 500 || x === 2500);
        const tail = uniq.filter((x) => x !== 500 && x !== 2500);
        return [...head, ...tail];
      }
      return uniq;
    })();

    const tryFees = async (fees: number[]) => {
      if (fees.length <= 0) return null;
      const r = await Promise.any(
        fees.map(async (fee) => {
          const pool = await getFirstV3PoolCached(chainId, tokenIn, tokenOut, fee);
          if (!pool || pool === ZERO_ADDRESS) throw new Error('no pool');
          const usable = await isV3PoolUsable(pool);
          if (!usable) throw new Error('unusable');
          return { fee, pool };
        })
      ).catch(() => null);
      return r;
    };

    const primary = (prefer === 'v3' || isBridgeHop) ? feeOrder.filter((x) => x === 500 || x === 2500) : [];
    const secondary = (prefer === 'v3' || isBridgeHop) ? feeOrder.filter((x) => x !== 500 && x !== 2500) : feeOrder;

    const first = await tryFees(primary.length > 0 ? primary : secondary.slice(0, 2));
    if (first) return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: first.fee, poolAddress: first.pool };

    const rest = primary.length > 0 ? secondary : secondary.slice(2);
    const second = await tryFees(rest);
    if (second) return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: second.fee, poolAddress: second.pool };
  }

  if (candidates.length === 1) {
    const fee = candidates[0];
    const [amountOut, pool] = await Promise.all([
      getQuote(chainId, tokenIn, tokenOut, amountIn, fee),
      getFirstV3Pool(chainId, tokenIn, tokenOut, fee),
    ]);
    if (amountOut > 0n && pool && pool !== ZERO_ADDRESS) {
      return { amountOut, swapType: SwapType.V3_EXACT_IN, fee, poolAddress: pool };
    }
  }

  const v3Results = await Promise.allSettled(
    candidates.map(async (fee) => ({ fee, amountOut: await getQuote(chainId, tokenIn, tokenOut, amountIn, fee) }))
  );
  let bestV3: { fee?: number; amountOut: bigint } = { fee: undefined as number | undefined, amountOut: 0n };
  for (const r of v3Results) {
    if (r.status !== 'fulfilled') continue;
    if (r.value.amountOut > bestV3.amountOut) bestV3 = r.value;
  }
  if (bestV3.amountOut > 0n) {
    const usedFee = bestV3.fee;
    const pool = usedFee !== undefined ? await getFirstV3Pool(chainId, tokenIn, tokenOut, usedFee) : null;
    return { amountOut: bestV3.amountOut, swapType: SwapType.V3_EXACT_IN, fee: usedFee, poolAddress: (pool ?? (ZERO_ADDRESS as Address)) };
  }

  let pair: Address | null = null;
  const hintOk = hintPair ? await isV2PairMatchTokens(hintPair, tokenIn, tokenOut) : false;
  pair = hintOk ? hintPair : await getFirstV2Pair(chainId, tokenIn, tokenOut);
  if (!pair) {
    return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: undefined as number | undefined, poolAddress: ZERO_ADDRESS as Address };
  }
  const amountOut = needAmountOut ? await quoteV2ExactInByPair(pair, tokenIn, tokenOut, amountIn, 25) : 0n;
  return { amountOut, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: pair };
}

export async function resolveDexExactIn(
  chainId: number,
  routerTokenIn: Address,
  routerTokenOut: Address,
  amountIn: bigint,
  opts: DexExactInOpts | undefined,
  isTurbo: boolean,
  needAmountOut?: boolean
): Promise<DexExactInQuote> {
  const quoteTokenIn = toQuoteToken(chainId, routerTokenIn);
  const quoteTokenOut = toQuoteToken(chainId, routerTokenOut);
  if (isTurbo) {
    return await resolveDexExactInTurbo(chainId, quoteTokenIn, quoteTokenOut, amountIn, opts, needAmountOut);
  }
  const q = await getBestDexExactIn(chainId, quoteTokenIn, quoteTokenOut, amountIn, opts);
  return { amountOut: q.amountOut, swapType: q.swapType, fee: q.fee, poolAddress: q.poolAddress };
}

export function assertDexQuoteOk(q: DexExactInQuote) {
  if (q.swapType === SwapType.V2_EXACT_IN) {
    if (!q.poolAddress || q.poolAddress === ZERO_ADDRESS) throw new Error('Invalid V2 pool');
    return;
  }
  if (q.amountOut <= 0n) throw new Error('Invalid V3 quote');
}

export async function quoteBestExactIn(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  opts?: DexExactInOpts
): Promise<{ amountOut: bigint; swapType: number; fee?: number; poolAddress: string }> {
  const q = await getBestDexExactIn(chainId, tokenIn, tokenOut, amountIn, opts);
  return { amountOut: q.amountOut, swapType: q.swapType, fee: q.fee, poolAddress: q.poolAddress };
}
