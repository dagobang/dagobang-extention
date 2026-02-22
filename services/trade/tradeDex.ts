import { getAddress } from 'viem';
import { RpcService } from '../rpc';
import { ChainId } from '../../constants/chains/chainId';
import { getBnbToBridgeTokenPoolConfig, getBridgeTokenAddresses } from '../../constants/tokens/allTokens';
import { DeployAddress } from '../../constants/contracts/address';
import { ContractNames } from '../../constants/contracts/names';
import { factoryV2Abi, factoryV3Abi, pairV2Abi, poolV3Abi, quoterV2Abi } from '@/constants/contracts/abi';
import { Address, DexExactInOpts, DexExactInQuote, QUOTER_V2_BSC, SwapType, toQuoteToken, ZERO_ADDRESS } from './tradeTypes';

const V3_POOL_CACHE_MS = 5 * 60_000;
const v3PoolCache = new Map<string, { ts: number; pool: Address }>();
const V2_PAIR_CACHE_MS = 5 * 60_000;
const v2PairCache = new Map<string, { ts: number; pair: Address }>();
const V3_POOL_FEE_CACHE_MS = 30 * 60_000;
const v3PoolFeeCache = new Map<string, { ts: number; fee: number }>();

function seedV2PairCache(chainId: number, tokenIn: Address, tokenOut: Address, pair: Address) {
  const now = Date.now();
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  v2PairCache.set(`${chainId}:${a}:${b}`, { ts: now, pair });
  v2PairCache.set(`${chainId}:${b}:${a}`, { ts: now, pair });
}

function seedV3PoolCache(chainId: number, tokenIn: Address, tokenOut: Address, fee: number, pool: Address) {
  const now = Date.now();
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  v3PoolCache.set(`${chainId}:${a}:${b}:${fee}`, { ts: now, pool });
  v3PoolCache.set(`${chainId}:${b}:${a}:${fee}`, { ts: now, pool });
}

export function getBridgeToken(chainId: number, quoteTokenAddress?: string): Address | null {
  if (!quoteTokenAddress) return null;
  const trimmed = quoteTokenAddress.trim();
  if (!/^(0x|0X)[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  let addr: Address;
  try {
    addr = getAddress(trimmed as Address);
  } catch {
    return null;
  }

  if (addr.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return null;
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

async function getV3PoolFeeCached(pool: Address): Promise<number | null> {
  const key = pool.toLowerCase();
  const now = Date.now();
  const cached = v3PoolFeeCache.get(key);
  if (cached && now - cached.ts < V3_POOL_FEE_CACHE_MS) return cached.fee;

  const client = await RpcService.getClient();
  try {
    const fee = await (client.readContract({
      address: pool,
      abi: poolV3Abi,
      functionName: 'fee',
    }) as Promise<number>);
    if (!isValidV3Fee(fee)) return null;
    v3PoolFeeCache.set(key, { ts: now, fee });
    return fee;
  } catch {
    return null;
  }
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
  const v2Promise = getBestV2Quote(chainId, tokenIn, tokenOut, amountIn, opts?.poolPair);
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

async function getFirstV2PairCached(chainId: number, tokenIn: Address, tokenOut: Address): Promise<Address | null> {
  const key = `${chainId}:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
  const now = Date.now();
  const cached = v2PairCache.get(key);
  if (cached && now - cached.ts < V2_PAIR_CACHE_MS) return cached.pair;
  const pair = await getFirstV2Pair(chainId, tokenIn, tokenOut);
  if (pair && pair !== ZERO_ADDRESS) {
    v2PairCache.set(key, { ts: now, pair });
  }
  return pair;
}

async function resolveDexExactInTurbo(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  opts?: DexExactInOpts,
  needAmountOut?: boolean
) {
  void amountIn;
  void needAmountOut;

  const prefer = opts?.prefer === 'v2' ? 'v2' : opts?.prefer === 'v3' ? 'v3' : null;

  const hintPool = (() => {
    const v = opts?.poolPair
    if (!v || v === ZERO_ADDRESS) return null;
    try {
      return getAddress(v as Address) as Address;
    } catch {
      return null;
    }
  })();

  if (prefer === 'v2' && hintPool) {
    seedV2PairCache(chainId, tokenIn, tokenOut, hintPool);
    return { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: hintPool };
  }

  if (prefer === 'v3' && hintPool) {
    const explicitFee = isValidV3Fee(opts?.v3Fee) ? (opts!.v3Fee as number) : null;
    const fee = explicitFee ?? await getV3PoolFeeCached(hintPool);
    if (fee !== null) {
      seedV3PoolCache(chainId, tokenIn, tokenOut, fee, hintPool);
      return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee, poolAddress: hintPool };
    }
  }

  const wNative = toQuoteToken(chainId, ZERO_ADDRESS);
  if (tokenIn.toLowerCase() === wNative.toLowerCase()) {
    const cfg = getBnbToBridgeTokenPoolConfig(chainId as ChainId, tokenOut);
    if (cfg?.kind === 'v2') {
      seedV2PairCache(chainId, tokenIn, tokenOut, cfg.poolAddress);
      return { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: cfg.poolAddress };
    }
    if (cfg?.kind === 'v3') {
      seedV3PoolCache(chainId, tokenIn, tokenOut, cfg.fee, cfg.poolAddress);
      return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: cfg.fee, poolAddress: cfg.poolAddress };
    }
  }

  const tryV2 = async (): Promise<DexExactInQuote | null> => {
    const pair = await getFirstV2PairCached(chainId, tokenIn, tokenOut);
    if (pair) seedV2PairCache(chainId, tokenIn, tokenOut, pair);
    return pair ? { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: pair } : null;
  };

  const allowlist = getBridgeTokenAddresses(chainId as ChainId);
  const isBridgeHop =
    tokenIn.toLowerCase() === wNative.toLowerCase() ||
    tokenOut.toLowerCase() === wNative.toLowerCase() ||
    allowlist.some((x) => x.toLowerCase() === tokenIn.toLowerCase()) ||
    allowlist.some((x) => x.toLowerCase() === tokenOut.toLowerCase());

  const buildV3Fees = (): number[] => {
    const explicit = isValidV3Fee(opts?.v3Fee) ? (opts!.v3Fee as number) : null;
    const base = (prefer === 'v3' || isBridgeHop) ? [500, 2500, 100, 10000] : [2500, 500, 100, 10000];
    const out: number[] = [];
    const seen = new Set<number>();
    if (explicit !== null && !seen.has(explicit)) {
      seen.add(explicit);
      out.push(explicit);
    }
    for (const f of base) {
      if (!seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
    return out;
  };

  const tryV3 = async (): Promise<DexExactInQuote | null> => {
    const fees = buildV3Fees();
    for (const fee of fees) {
      const pool = await getFirstV3PoolCached(chainId, tokenIn, tokenOut, fee);
      if (pool && pool !== ZERO_ADDRESS) {
        seedV3PoolCache(chainId, tokenIn, tokenOut, fee, pool);
        return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee, poolAddress: pool };
      }
    }
    return null;
  };

  if (prefer === 'v2') {
    const v2 = await tryV2();
    if (v2) return v2;
    const v3 = await tryV3();
    if (v3) return v3;
    return { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: ZERO_ADDRESS as Address };
  }

  if (prefer === 'v3') {
    const v3 = await tryV3();
    if (v3) return v3;
    const v2 = await tryV2();
    if (v2) return v2;
    const fallbackFee = isValidV3Fee(opts?.v3Fee) ? (opts!.v3Fee as number) : 500;
    return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: fallbackFee, poolAddress: ZERO_ADDRESS as Address };
  }

  const v2 = await tryV2();
  if (v2) return v2;
  const v3 = await tryV3();
  if (v3) return v3;
  return { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: ZERO_ADDRESS as Address };
}

export async function resolveBridgeHopExactIn(
  chainId: number,
  routerTokenIn: Address,
  routerTokenOut: Address,
  amountIn: bigint,
  prefer: 'v2' | 'v3' | null,
  isTurbo: boolean,
  needAmountOut: boolean
): Promise<DexExactInQuote> {
  const tokenIn = toQuoteToken(chainId, routerTokenIn);
  const tokenOut = toQuoteToken(chainId, routerTokenOut);

  const wNative = toQuoteToken(chainId, ZERO_ADDRESS);
  const hardcoded = (() => {
    const inLower = tokenIn.toLowerCase();
    const outLower = tokenOut.toLowerCase();
    const wLower = wNative.toLowerCase();
    if (inLower === wLower) return getBnbToBridgeTokenPoolConfig(chainId as ChainId, tokenOut);
    if (outLower === wLower) return getBnbToBridgeTokenPoolConfig(chainId as ChainId, tokenIn);
    return null;
  })();

  if (hardcoded) {
    if (hardcoded.kind === 'v2') {
      const amountOut = needAmountOut ? await quoteV2ExactInByPair(hardcoded.poolAddress, tokenIn, tokenOut, amountIn, 25) : 0n;
      if (!needAmountOut || amountOut > 0n) {
        return { amountOut, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: hardcoded.poolAddress };
      }
    } else {
      const amountOut = needAmountOut ? await getQuote(chainId, tokenIn, tokenOut, amountIn, hardcoded.fee) : 0n;
      if (!needAmountOut || amountOut > 0n) {
        return { amountOut, swapType: SwapType.V3_EXACT_IN, fee: hardcoded.fee, poolAddress: hardcoded.poolAddress };
      }
    }
  }

  if (isTurbo) {
    const opts: DexExactInOpts =
      prefer === 'v2'
        ? { prefer: 'v2' }
        : prefer === 'v3'
          ? { prefer: 'v3', v3Fee: 500 }
          : { v3Fee: 500 };
    return await resolveDexExactInTurbo(chainId, tokenIn, tokenOut, amountIn, opts, needAmountOut);
  }

  if (prefer === 'v2') {
    const pair = await getFirstV2PairCached(chainId, tokenIn, tokenOut);
    if (!pair) {
      return { amountOut: 0n, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: ZERO_ADDRESS as Address };
    }
    const amountOut = await quoteV2ExactInByPair(pair, tokenIn, tokenOut, amountIn, 25);
    return { amountOut, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: pair };
  }

  const fees = prefer === 'v3' ? [500, 2500] : [2500, 500];
  for (const fee of fees) {
    const pool = await getFirstV3PoolCached(chainId, tokenIn, tokenOut, fee);
    if (!pool || pool === ZERO_ADDRESS) continue;
    const usable = await isV3PoolUsable(pool);
    if (!usable) continue;
    const amountOut = needAmountOut ? await getQuote(chainId, tokenIn, tokenOut, amountIn, fee) : 0n;
    if (!needAmountOut || amountOut > 0n) {
      return { amountOut, swapType: SwapType.V3_EXACT_IN, fee, poolAddress: pool };
    }
  }

  const q = await getBestDexExactIn(chainId, tokenIn, tokenOut, amountIn, { v3Fee: 500 });
  return { amountOut: q.amountOut, swapType: q.swapType, fee: q.fee, poolAddress: q.poolAddress };
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
