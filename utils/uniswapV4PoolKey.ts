import { encodeAbiParameters, keccak256, type Address } from 'viem';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DYNAMIC_FEE_FLAG = 0x800000;

const DEFAULT_V4_FEES = [0, 100, 200, 300, 400, 500, 700, 1000, 1500, 2000, 2500, 3000, 5000, 7000, 10000];
const DEFAULT_V4_TICKS = [1, 2, 5, 10, 20, 30, 50, 60, 70, 100, 140, 200, 500, 2000];

export type UniswapV4PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

function asAddress(value?: string | null): Address | null {
  const raw = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
  return raw.toLowerCase() as Address;
}

export function hashUniswapV4PoolId(key: UniswapV4PoolKey): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'address' },
      { type: 'uint24' },
      { type: 'int24' },
      { type: 'address' },
    ],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

export function recoverUniswapV4PoolKey(input: {
  poolId: string;
  currencies: Array<string | null | undefined>;
  hooks: Array<string | null | undefined>;
  fees?: number[];
  tickSpacings?: number[];
  /** When true and `fees` is non-empty, do not merge DEFAULT_V4_FEES (fee already known). */
  strictFees?: boolean;
}): UniswapV4PoolKey | null {
  const want = String(input.poolId || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(want)) return null;

  const tokens: Address[] = [];
  const seenToken = new Set<string>();
  for (const item of input.currencies) {
    const address = asAddress(item) ?? (String(item || '').trim() === ZERO_ADDRESS ? ZERO_ADDRESS as Address : null);
    if (!address) continue;
    const key = address.toLowerCase();
    if (seenToken.has(key)) continue;
    seenToken.add(key);
    tokens.push(address);
  }
  if (tokens.length < 2) return null;

  const hooks: Address[] = [];
  const seenHook = new Set<string>();
  for (const item of [...input.hooks, ZERO_ADDRESS]) {
    const address = asAddress(item) ?? (String(item || '').trim().toLowerCase() === ZERO_ADDRESS ? ZERO_ADDRESS as Address : null);
    if (!address) continue;
    const key = address.toLowerCase();
    if (seenHook.has(key)) continue;
    seenHook.add(key);
    hooks.push(address);
  }

  const providedFees = [...new Set((input.fees ?? []).filter((fee) => Number.isFinite(fee) && fee >= 0))];
  const fees = input.strictFees && providedFees.length > 0
    ? providedFees
    : [...new Set([...providedFees, ...DEFAULT_V4_FEES])];
  const ticks = [...new Set([...(input.tickSpacings ?? []), ...DEFAULT_V4_TICKS])];
  const feeCandidates = [...new Set([
    ...fees,
    // Dynamic-fee PoolKey often stores flag alone or flag|static.
    ...fees.map((fee) => fee | DYNAMIC_FEE_FLAG),
    ...(input.strictFees ? [DYNAMIC_FEE_FLAG] : []),
  ])];

  const pairs: Array<[Address, Address]> = [];
  const seenPair = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const left = tokens[i];
      const right = tokens[j];
      const [currency0, currency1] = left.toLowerCase() < right.toLowerCase()
        ? [left, right]
        : [right, left];
      const pairKey = `${currency0.toLowerCase()}:${currency1.toLowerCase()}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      pairs.push([currency0, currency1]);
    }
  }

  for (const [currency0, currency1] of pairs) {
    for (const hooksAddress of hooks) {
      for (const fee of feeCandidates) {
        for (const tickSpacing of ticks) {
          const key = {
            currency0,
            currency1,
            fee,
            tickSpacing,
            hooks: hooksAddress,
          };
          if (hashUniswapV4PoolId(key).toLowerCase() === want) return key;
        }
      }
    }
  }
  return null;
}
