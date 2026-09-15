import { getAddress, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { rhTokens } from '@/constants/tokens/chains/rh';
import { RpcService } from '@/services/rpc';
import { recoverUniswapV4PoolKey } from '@/utils/uniswapV4PoolKey';

import { Address, ZERO_ADDRESS, getWNative } from './tradeTypes';

const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';
const O1_LAUNCH_STATE_TTL_MS = 30_000;

const o1FactoryReadsAbi = parseAbi([
  'function creatorRights(address token) view returns (address originalCreator, address currentCreator, address pendingCreator, address creatorFeeRecipient, bytes32 poolId, bool metadataEditable)',
]);

const erc20SymbolAbi = parseAbi([
  'function symbol() view returns (string)',
]);

export type O1RhSuite = {
  suiteId: string;
  factory: Address;
  hook: Address;
  firstBlock: bigint;
};

// Historical + current RH factories from https://docs.o1.exchange/launchpad/reference/launch-contract-suites.json
export const O1_RH_SUITES: readonly O1RhSuite[] = [
  {
    suiteId: 'robinhood-block-v1',
    factory: '0x8B40fc20c405d47D725c9723D056a1c6f62BBccf',
    hook: '0xe960E6C80C74cFDF03c91E7AF4e1F5f53f096a44',
    firstBlock: 2131131n,
  },
  {
    suiteId: 'robinhood-block-v2',
    factory: '0x76f0923Ac4dF0A079A10F628A7bcE6426CCd344A',
    hook: '0xca4b035a5DBFa2a00fC5dcb08fD1c5A22d0eAA44',
    firstBlock: 4415287n,
  },
  {
    suiteId: 'robinhood-timestamp-v3',
    factory: '0x411F21283D3E492BC395027329e08f9F4F560Ba5',
    hook: '0x441F773B3bb1Ed4c6457D0528624112e43C02acc',
    firstBlock: 6131279n,
  },
  {
    suiteId: 'robinhood-rwa-timestamp-v4',
    factory: '0xe64AC4113848BBC1a6dDE1A6D1da96720A36F297',
    hook: '0x778b0c4EeA7D35D66513B587bA87FC9084b0EaCC',
    firstBlock: 18487505n,
  },
  {
    suiteId: 'robinhood-mainnet-launchpad-v4-minimal',
    factory: '0xcE9C48cFa068947f77738c81Be406B53338E5B0d',
    hook: '0x0310cFEbE1D7A69f2414f6595bBe9d17c5342aCc',
    firstBlock: 48880218n,
  },
];

export type O1LaunchState = {
  suiteId: string;
  factory: Address;
  hook: Address;
  poolId: `0x${string}`;
  quoteToken: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  currency0: Address;
  currency1: Address;
};

type O1LaunchStateOptions = {
  poolId?: string | null;
  force?: boolean;
  /** Extra pool currencies (e.g. hop quote token) when not ETH/USDG. */
  extraCurrencies?: Array<Address | string | null | undefined>;
};

const o1LaunchStateCache = new Map<string, { ts: number; value: O1LaunchState | null }>();
const o1LaunchStateInFlight = new Map<string, Promise<O1LaunchState | null>>();

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

function toQuoteRouterToken(currency: Address): Address {
  if (isZero(currency)) return ZERO_ADDRESS;
  const wNative = getWNative(ChainId.RH);
  if (currency.toLowerCase() === wNative.toLowerCase()) return ZERO_ADDRESS;
  return currency;
}

async function readCreatorPoolId(client: any, factory: Address, token: Address): Promise<`0x${string}` | null> {
  try {
    const rights = await client.readContract({
      address: factory,
      abi: o1FactoryReadsAbi,
      functionName: 'creatorRights',
      args: [token],
    }) as readonly unknown[];
    const poolId = String(rights?.[4] || '').trim().toLowerCase();
    if (!isRhV4PoolId(poolId) || poolId === ZERO32) return null;
    return poolId as `0x${string}`;
  } catch {
    return null;
  }
}

function quoteFromCurrencies(token: Address, currency0: Address, currency1: Address): Address | null {
  const tokenKey = token.toLowerCase();
  const left = currency0.toLowerCase();
  const right = currency1.toLowerCase();
  if (left === tokenKey) return toQuoteRouterToken(currency1);
  if (right === tokenKey) return toQuoteRouterToken(currency0);
  return null;
}

function o1CurrenciesFor(token: Address, extra?: Array<Address | string | null | undefined>): Address[] {
  const out: Address[] = [
    token,
    ZERO_ADDRESS,
    rhTokens.weth.address as Address,
    rhTokens.eth.address as Address,
    rhTokens.usdg.address as Address,
  ];
  const seen = new Set(out.map((item) => item.toLowerCase()));
  for (const item of extra ?? []) {
    const raw = String(item || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/i.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      out.push(getAddress(raw as Address));
    } catch {
      out.push(key as Address);
    }
  }
  return out;
}

function launchStateFromPoolKey(
  token: Address,
  poolId: `0x${string}`,
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  suiteHint?: O1RhSuite | null,
): O1LaunchState | null {
  const quoteToken = quoteFromCurrencies(token, key.currency0, key.currency1);
  if (!quoteToken) return null;
  const matchedSuite = suiteHint
    ?? O1_RH_SUITES.find((item) => item.hook.toLowerCase() === key.hooks.toLowerCase())
    ?? null;
  if (!matchedSuite) return null;
  return {
    suiteId: matchedSuite.suiteId,
    factory: matchedSuite.factory,
    hook: matchedSuite.hook,
    poolId,
    quoteToken,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
    currency0: key.currency0,
    currency1: key.currency1,
  };
}

function recoverO1LaunchState(
  token: Address,
  poolId: `0x${string}`,
  suiteHint?: O1RhSuite | null,
  extraCurrencies?: Array<Address | string | null | undefined>,
): O1LaunchState | null {
  const recovered = recoverUniswapV4PoolKey({
    poolId,
    currencies: o1CurrenciesFor(token, extraCurrencies),
    hooks: O1_RH_SUITES.map((item) => item.hook),
  });
  if (!recovered) return null;
  return launchStateFromPoolKey(token, poolId, recovered, suiteHint);
}

async function resolveO1LaunchState(
  token: Address,
  options?: O1LaunchStateOptions,
): Promise<O1LaunchState | null> {
  const hintedPoolId = isRhV4PoolId(options?.poolId)
    ? String(options?.poolId).trim().toLowerCase() as `0x${string}`
    : null;
  if (hintedPoolId) {
    const fromHint = recoverO1LaunchState(token, hintedPoolId, null, options?.extraCurrencies);
    if (fromHint) return fromHint;
  }

  return await RpcService.withBalancedReadClient({
    chainId: ChainId.RH,
    caller: 'o1.launchState',
    run: async (client) => {
      for (const candidate of [...O1_RH_SUITES].reverse()) {
        const found = await readCreatorPoolId(client, candidate.factory, token);
        if (!found) continue;
        const recovered = recoverO1LaunchState(token, found, candidate, options?.extraCurrencies);
        if (recovered) return recovered;
      }
      return null;
    },
  });
}

export async function getO1LaunchState(
  token: Address,
  options?: O1LaunchStateOptions,
): Promise<O1LaunchState | null> {
  const extraKey = (options?.extraCurrencies ?? [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
  const key = `${token.toLowerCase()}:${String(options?.poolId || '').trim().toLowerCase()}:${extraKey}`;
  const now = Date.now();
  if (!options?.force) {
    const cached = o1LaunchStateCache.get(key);
    if (cached && now - cached.ts < O1_LAUNCH_STATE_TTL_MS) return cached.value;
    const inflight = o1LaunchStateInFlight.get(key);
    if (inflight) return await inflight;
  }
  const task = (async () => {
    const value = await resolveO1LaunchState(token, options).catch(() => null);
    o1LaunchStateCache.set(key, { ts: Date.now(), value });
    return value;
  })().finally(() => {
    o1LaunchStateInFlight.delete(key);
  });
  o1LaunchStateInFlight.set(key, task);
  return await task;
}

export async function readO1QuoteSymbol(quoteToken: Address): Promise<string> {
  if (isZero(quoteToken)) return 'ETH';
  const lower = quoteToken.toLowerCase();
  if (lower === rhTokens.weth.address.toLowerCase() || lower === rhTokens.eth.address.toLowerCase()) return 'ETH';
  if (lower === rhTokens.usdg.address.toLowerCase()) return 'USDG';
  try {
    return await RpcService.withBalancedReadClient({
      chainId: ChainId.RH,
      caller: 'o1.quoteSymbol',
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
