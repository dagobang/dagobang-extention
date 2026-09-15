import { getAddress, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { rhTokens } from '@/constants/tokens/chains/rh';
import { RpcService } from '@/services/rpc';
import { hashUniswapV4PoolId, recoverUniswapV4PoolKey } from '@/utils/uniswapV4PoolKey';

import { Address, ZERO_ADDRESS, getWNative } from './tradeTypes';

/** Doppler Airlock used by long.xyz on Robinhood Chain. */
export const LONG_RH_AIRLOCK = '0xeb7C034704ef8dCd2d32324c1545f62Fb4aD0862' as Address;
/** LongLauncher factory (LaunchCreated). */
export const LONG_RH_FACTORY = '0x22e99278308b393Ea1260859b181AD7e78F5EeED' as Address;
/** DopplerHookInitializer — present on sampled long.xyz pools. */
export const LONG_RH_DOPPLER_HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' as Address;
/** RehypeDopplerHookInitializer — related fee schedule hook. */
export const LONG_RH_REHYPE_HOOK = '0x6f02324d20CC679d0E585290CAa6b16baCbC0F77' as Address;

/** Uniswap V4 dynamic-fee flag; long.xyz PoolKey.fee is this value (not a static bps fee). */
export const LONG_RH_POOL_FEE = 0x800000;
export const LONG_RH_TICK_SPACING = 8;

const LONG_LAUNCH_STATE_TTL_MS = 30_000;
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

const airlockReadsAbi = parseAbi([
  'function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool)',
]);

const erc20OwnerAbi = parseAbi([
  'function owner() view returns (address)',
]);

const erc20SymbolAbi = parseAbi([
  'function symbol() view returns (string)',
]);

export type LongLaunchState = {
  airlock: Address;
  factory: Address;
  poolId: `0x${string}`;
  quoteToken: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  currency0: Address;
  currency1: Address;
  numeraire: Address;
  poolInitializer: Address;
};

type LongLaunchStateOptions = {
  poolId?: string | null;
  force?: boolean;
  extraCurrencies?: Array<Address | string | null | undefined>;
};

const longLaunchStateCache = new Map<string, { ts: number; value: LongLaunchState | null }>();
const longLaunchStateInFlight = new Map<string, Promise<LongLaunchState | null>>();

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

export function isRhV4PoolId(value?: string | null): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
}

/** long.xyz tokens commonly end with 1e18 (not authoritative alone). */
export function looksLikeLongSuffixAddress(address?: string | null): boolean {
  return String(address || '').trim().toLowerCase().endsWith('1e18');
}

function toQuoteRouterToken(currency: Address): Address {
  if (isZero(currency)) return ZERO_ADDRESS;
  const wNative = getWNative(ChainId.RH);
  if (currency.toLowerCase() === wNative.toLowerCase()) return ZERO_ADDRESS;
  return currency;
}

function quoteFromCurrencies(token: Address, currency0: Address, currency1: Address): Address | null {
  const tokenKey = token.toLowerCase();
  const left = currency0.toLowerCase();
  const right = currency1.toLowerCase();
  if (left === tokenKey) return toQuoteRouterToken(currency1);
  if (right === tokenKey) return toQuoteRouterToken(currency0);
  return null;
}

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function longCurrenciesFor(token: Address, extra?: Array<Address | string | null | undefined>): Address[] {
  const out: Address[] = [
    token,
    ZERO_ADDRESS,
    rhTokens.weth.address as Address,
    rhTokens.eth.address as Address,
    rhTokens.usdg.address as Address,
  ];
  const seen = new Set(out.map((item) => item.toLowerCase()));
  for (const item of extra ?? []) {
    const addr = asAddress(item);
    if (isZero(addr) && String(item || '').trim() !== ZERO_ADDRESS) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function buildStateFromKey(
  token: Address,
  poolId: `0x${string}`,
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  meta?: { numeraire?: Address; poolInitializer?: Address },
): LongLaunchState | null {
  const quoteToken = quoteFromCurrencies(token, key.currency0, key.currency1);
  if (quoteToken == null) return null;
  return {
    airlock: LONG_RH_AIRLOCK,
    factory: LONG_RH_FACTORY,
    poolId,
    quoteToken,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
    currency0: key.currency0,
    currency1: key.currency1,
    numeraire: meta?.numeraire ?? (isZero(quoteToken) ? ZERO_ADDRESS : quoteToken),
    poolInitializer: meta?.poolInitializer ?? key.hooks,
  };
}

function recoverLongPoolKey(
  token: Address,
  poolId: `0x${string}`,
  extraCurrencies?: Array<Address | string | null | undefined>,
): LongLaunchState | null {
  const recovered = recoverUniswapV4PoolKey({
    poolId,
    currencies: longCurrenciesFor(token, extraCurrencies),
    hooks: [LONG_RH_DOPPLER_HOOK, LONG_RH_REHYPE_HOOK],
    fees: [LONG_RH_POOL_FEE],
    tickSpacings: [LONG_RH_TICK_SPACING, 1, 8, 10, 60, 200],
    strictFees: true,
  });
  if (!recovered || recovered.tickSpacing <= 0) return null;
  return buildStateFromKey(token, poolId, recovered);
}

function poolIdFromAssetData(
  token: Address,
  numeraire: Address,
  hooks: Address,
): `0x${string}` | null {
  if (isZero(hooks)) return null;
  const quoteCurrency = isZero(numeraire) ? ZERO_ADDRESS : numeraire;
  const [currency0, currency1] = sortCurrencies(token, quoteCurrency);
  return hashUniswapV4PoolId({
    currency0,
    currency1,
    fee: LONG_RH_POOL_FEE,
    tickSpacing: LONG_RH_TICK_SPACING,
    hooks,
  });
}

async function readAirlockAssetData(
  client: any,
  token: Address,
): Promise<{ numeraire: Address; poolInitializer: Address; pool: Address } | null> {
  try {
    const raw = await client.readContract({
      address: LONG_RH_AIRLOCK,
      abi: airlockReadsAbi,
      functionName: 'getAssetData',
      args: [token],
    }) as readonly unknown[];
    const numeraire = asAddress(raw?.[0]);
    const poolInitializer = asAddress(raw?.[4]);
    const pool = asAddress(raw?.[5]);
    if (isZero(poolInitializer)) return null;
    return { numeraire, poolInitializer, pool };
  } catch {
    return null;
  }
}

async function isOwnedByAirlock(client: any, token: Address): Promise<boolean> {
  try {
    const owner = asAddress(await client.readContract({
      address: token,
      abi: erc20OwnerAbi,
      functionName: 'owner',
    }));
    return owner.toLowerCase() === LONG_RH_AIRLOCK.toLowerCase();
  } catch {
    return false;
  }
}

async function resolveLongLaunchState(
  token: Address,
  options?: LongLaunchStateOptions,
): Promise<LongLaunchState | null> {
  const hintedPoolId = isRhV4PoolId(options?.poolId)
    ? String(options?.poolId).trim().toLowerCase() as `0x${string}`
    : null;
  if (hintedPoolId) {
    const fromHint = recoverLongPoolKey(token, hintedPoolId, options?.extraCurrencies);
    if (fromHint) return fromHint;
  }

  return await RpcService.withBalancedReadClient({
    chainId: ChainId.RH,
    caller: 'long.launchState',
    run: async (client) => {
      const asset = await readAirlockAssetData(client, token);
      if (!asset) return null;
      // Prefer Airlock ownership when available; some assets may still trade if getAssetData hits.
      const owned = await isOwnedByAirlock(client, token);
      if (!owned && !looksLikeLongSuffixAddress(token)) {
        // Soft accept when getAssetData returns a known Doppler/Rehype initializer.
        const hookLower = asset.poolInitializer.toLowerCase();
        if (
          hookLower !== LONG_RH_DOPPLER_HOOK.toLowerCase()
          && hookLower !== LONG_RH_REHYPE_HOOK.toLowerCase()
        ) {
          return null;
        }
      }

      const hookCandidates = [...new Set([
        asset.poolInitializer,
        LONG_RH_DOPPLER_HOOK,
        LONG_RH_REHYPE_HOOK,
      ].map((item) => asAddress(item)).filter((item) => !isZero(item)))];

      for (const hooks of hookCandidates) {
        const poolId = poolIdFromAssetData(token, asset.numeraire, hooks);
        if (!poolId || poolId === ZERO32) continue;
        const [currency0, currency1] = sortCurrencies(
          token,
          isZero(asset.numeraire) ? ZERO_ADDRESS : asset.numeraire,
        );
        const state = buildStateFromKey(token, poolId, {
          currency0,
          currency1,
          fee: LONG_RH_POOL_FEE,
          tickSpacing: LONG_RH_TICK_SPACING,
          hooks,
        }, {
          numeraire: asset.numeraire,
          poolInitializer: asset.poolInitializer,
        });
        if (state) return state;
      }

      if (hintedPoolId) {
        return recoverLongPoolKey(token, hintedPoolId, [
          ...(options?.extraCurrencies ?? []),
          asset.numeraire,
        ]);
      }
      return null;
    },
  });
}

export async function getLongLaunchState(
  token: Address,
  options?: LongLaunchStateOptions,
): Promise<LongLaunchState | null> {
  const extraKey = (options?.extraCurrencies ?? [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  const key = `${token.toLowerCase()}:${String(options?.poolId || '').trim().toLowerCase()}:${extraKey}`;
  const now = Date.now();
  if (!options?.force) {
    const cached = longLaunchStateCache.get(key);
    if (cached && now - cached.ts < LONG_LAUNCH_STATE_TTL_MS) return cached.value;
    const inflight = longLaunchStateInFlight.get(key);
    if (inflight) return await inflight;
  }
  const task = (async () => {
    const value = await resolveLongLaunchState(token, options).catch(() => null);
    longLaunchStateCache.set(key, { ts: Date.now(), value });
    return value;
  })().finally(() => {
    longLaunchStateInFlight.delete(key);
  });
  longLaunchStateInFlight.set(key, task);
  return await task;
}

export async function readLongQuoteSymbol(quoteToken: Address): Promise<string> {
  if (isZero(quoteToken)) return 'ETH';
  const lower = quoteToken.toLowerCase();
  if (lower === rhTokens.weth.address.toLowerCase() || lower === rhTokens.eth.address.toLowerCase()) return 'ETH';
  if (lower === rhTokens.usdg.address.toLowerCase()) return 'USDG';
  try {
    return await RpcService.withBalancedReadClient({
      chainId: ChainId.RH,
      caller: 'long.quoteSymbol',
      run: async (client) => await client.readContract({
        address: quoteToken,
        abi: erc20SymbolAbi,
        functionName: 'symbol',
      }) as string,
    });
  } catch {
    return `${quoteToken.slice(0, 6)}…`;
  }
}
