import { formatUnits, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { hyperTokens } from '@/constants/tokens/chains/hyper';
import type { TokenInfo } from '@/types/token';

import { RpcService } from '../rpc';
import { quoteHyperSellToUsdc } from '../trade/tradeHyper';

const erc20MetaAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const hyperBondingAbi = parseAbi([
  'function creatorOf(address token_) view returns (address)',
  'function ltOf(address token_) view returns (address)',
  'function isGraduating(address token_) view returns (bool)',
  'function isGraduated(address token_) view returns (bool)',
  'function graduatedPair(address token_) view returns (address)',
]);

const leveragedTokenAbi = parseAbi([
  'function ltToBaseAmount(uint256 ltAmount) view returns (uint256)',
]);

const pairV2Abi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
type AltfunStaticTokenMeta = {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  creator: `0x${string}`;
  ltAddress: `0x${string}`;
};
type PairStaticMeta = {
  token0: `0x${string}`;
  token1: `0x${string}`;
};

export class TokenAltfunService {
  private static staticMetaCache = new Map<string, AltfunStaticTokenMeta | null>();
  private static staticMetaInFlight = new Map<string, Promise<AltfunStaticTokenMeta | null>>();
  private static pairStaticMetaCache = new Map<string, PairStaticMeta>();
  private static pairStaticMetaInFlight = new Map<string, Promise<PairStaticMeta>>();
  private static async getStaticTokenMeta(
    client: Awaited<ReturnType<typeof RpcService.getClient>>,
    bonding: `0x${string}`,
    tokenAddress: `0x${string}`,
  ): Promise<AltfunStaticTokenMeta | null> {
    const key = tokenAddress.toLowerCase();
    const cached = this.staticMetaCache.get(key);
    if (cached !== undefined) return cached;
    const inflight = this.staticMetaInFlight.get(key);
    if (inflight) return await inflight;
    const p = (async () => {
      const [[name, symbol, decimals, totalSupply], creator, ltAddress] = await Promise.all([
        Promise.all([
          client.readContract({
            address: tokenAddress,
            abi: erc20MetaAbi,
            functionName: 'name',
          }) as Promise<string>,
          client.readContract({
            address: tokenAddress,
            abi: erc20MetaAbi,
            functionName: 'symbol',
          }) as Promise<string>,
          client.readContract({
            address: tokenAddress,
            abi: erc20MetaAbi,
            functionName: 'decimals',
          }) as Promise<number>,
          client.readContract({
            address: tokenAddress,
            abi: erc20MetaAbi,
            functionName: 'totalSupply',
          }) as Promise<bigint>,
        ]),
        client.readContract({
          address: bonding,
          abi: hyperBondingAbi,
          functionName: 'creatorOf',
          args: [tokenAddress],
        }) as Promise<`0x${string}`>,
        client.readContract({
          address: bonding,
          abi: hyperBondingAbi,
          functionName: 'ltOf',
          args: [tokenAddress],
        }) as Promise<`0x${string}`>,
      ]);
      if (!creator || creator.toLowerCase() === ZERO_ADDRESS) return null;
      return {
        name,
        symbol,
        decimals: Number(decimals),
        totalSupply,
        creator,
        ltAddress,
      } satisfies AltfunStaticTokenMeta;
    })().finally(() => {
      this.staticMetaInFlight.delete(key);
    });
    this.staticMetaInFlight.set(key, p);
    const resolved = await p;
    this.staticMetaCache.set(key, resolved);
    return resolved;
  }
  private static async getPairStaticMeta(
    client: Awaited<ReturnType<typeof RpcService.getClient>>,
    pairAddress: `0x${string}`,
  ): Promise<PairStaticMeta> {
    const key = pairAddress.toLowerCase();
    const cached = this.pairStaticMetaCache.get(key);
    if (cached) return cached;
    const inflight = this.pairStaticMetaInFlight.get(key);
    if (inflight) return await inflight;
    const p = (async () => {
      const [token0, token1] = await Promise.all([
        client.readContract({
          address: pairAddress,
          abi: pairV2Abi,
          functionName: 'token0',
        }) as Promise<`0x${string}`>,
        client.readContract({
          address: pairAddress,
          abi: pairV2Abi,
          functionName: 'token1',
        }) as Promise<`0x${string}`>,
      ]);
      return { token0, token1 } satisfies PairStaticMeta;
    })().finally(() => {
      this.pairStaticMetaInFlight.delete(key);
    });
    this.pairStaticMetaInFlight.set(key, p);
    const resolved = await p;
    this.pairStaticMetaCache.set(key, resolved);
    return resolved;
  }
  static async getTokenInfo(chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> {
    if (chainId !== ChainId.HYPER) return null;

    const bonding = DeployAddress[ChainId.HYPER]?.[ContractNames.HyperBonding]?.address;
    if (!bonding || !/^0x[a-fA-F0-9]{40}$/.test(bonding)) return null;

    const startedAt = Date.now();
    console.log('[altfun.tokenInfo.rpc.start]', {
      chainId,
      tokenAddress: tokenAddress.toLowerCase(),
    });
    return await RpcService.withBalancedReadClient({
      chainId: ChainId.HYPER,
      caller: 'altfun.tokenInfo',
      run: async (client) => {
        const staticMeta = await this.getStaticTokenMeta(client, bonding as `0x${string}`, tokenAddress);
        if (!staticMeta) return null;
        const { name, symbol, decimals, totalSupply, creator, ltAddress } = staticMeta;
        const graduatedPair = await (client.readContract({
          address: bonding as `0x${string}`,
          abi: hyperBondingAbi,
          functionName: 'graduatedPair',
          args: [tokenAddress],
        }) as Promise<`0x${string}`>);
        const isGraduated = graduatedPair.toLowerCase() !== ZERO_ADDRESS;
        const normalizedDecimals = Number(decimals);
        const oneToken = 10n ** BigInt(normalizedDecimals || 18);
        const quotedUsdc = await quoteHyperSellToUsdc(tokenAddress, oneToken).catch(() => 0n);
        const priceUsd = quotedUsdc > 0n ? Number(formatUnits(quotedUsdc, hyperTokens.usdc.decimals)) : 0;
        const supply = Number(formatUnits(totalSupply, normalizedDecimals || 18));
        const marketCapUsd = priceUsd > 0 && Number.isFinite(supply) && supply > 0 ? priceUsd * supply : 0;

        let liquidityUsd = 0;
        if (isGraduated && graduatedPair.toLowerCase() !== ZERO_ADDRESS && ltAddress.toLowerCase() !== ZERO_ADDRESS) {
          try {
            const [{ token0, token1 }, reserves] = await Promise.all([
              this.getPairStaticMeta(client, graduatedPair),
              client.readContract({
                address: graduatedPair,
                abi: pairV2Abi,
                functionName: 'getReserves',
              }) as Promise<[bigint, bigint, number]>,
            ]);
            const reserveLt =
              token0.toLowerCase() === ltAddress.toLowerCase()
                ? BigInt(reserves[0])
                : token1.toLowerCase() === ltAddress.toLowerCase()
                  ? BigInt(reserves[1])
                  : 0n;
            if (reserveLt > 0n) {
              const reserveUsdc = await (client.readContract({
                address: ltAddress,
                abi: leveragedTokenAbi,
                functionName: 'ltToBaseAmount',
                args: [reserveLt],
              }) as Promise<bigint>);
              liquidityUsd = Number(formatUnits(reserveUsdc, hyperTokens.usdc.decimals)) * 2;
            }
          } catch {
          }
        }

        const result = {
          chain: 'hyper',
          address: tokenAddress,
          name,
          symbol,
          decimals: normalizedDecimals,
          logo: '',
          launchpad: 'altfun',
          launchpad_progress: isGraduated ? 100 : 0,
          launchpad_platform: 'altfun',
          launchpad_status: isGraduated ? 1 : 0,
          quote_token: 'USDC',
          quote_token_address: hyperTokens.usdc.address,
          pool_pair: isGraduated && graduatedPair.toLowerCase() !== ZERO_ADDRESS ? graduatedPair : undefined,
          totalSupply: totalSupply.toString(),
          tokenPrice: priceUsd > 0
            ? {
              price: String(priceUsd),
              marketCap: marketCapUsd > 0 ? String(marketCapUsd) : '',
              liquidity: liquidityUsd > 0 ? String(liquidityUsd) : '',
              timestamp: Date.now(),
            }
            : undefined,
          aiCreator: false,
          ltAddress,
          creator,
        } as TokenInfo & { ltAddress: `0x${string}`; creator: `0x${string}` };
        console.log('[altfun.tokenInfo.rpc.done]', {
          chainId,
          tokenAddress: tokenAddress.toLowerCase(),
          elapsedMs: Date.now() - startedAt,
          graduated: isGraduated,
          hasPrice: priceUsd > 0,
          hasLiquidity: liquidityUsd > 0,
        });
        return result;
      },
    });
  }
}
