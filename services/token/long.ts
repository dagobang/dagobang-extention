import { formatUnits, parseAbi } from 'viem';

import { ChainId } from '@/constants/chains';
import { isLongLaunchpadPlatform, normalizeLaunchpadPlatform } from '@/constants/launchpad';
import type { TokenInfo } from '@/types/token';
import { RpcService } from '../rpc';
import { SettingsService } from '../settings';
import {
  getLongLaunchState,
  isRhV4PoolId,
  looksLikeLongSuffixAddress,
  readLongQuoteSymbol,
} from '../trade/tradeLong';
import { type Address } from '../trade/tradeTypes';

const erc20MetaAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

function pickPoolId(seed?: TokenInfo | null): string | null {
  const candidates = [
    seed?.biggest_pool_address,
    seed?.tpool_pool_address,
    seed?.pool_pair,
  ];
  for (const candidate of candidates) {
    if (isRhV4PoolId(candidate)) return String(candidate).trim();
  }
  return null;
}

export class TokenLongService {
  static async getTokenInfo(
    chainId: number,
    tokenAddress: `0x${string}`,
    seed?: TokenInfo | null,
  ): Promise<TokenInfo | null> {
    if (chainId !== ChainId.RH) return null;

    const startedAt = Date.now();
    const consoleLogsEnabled = (await SettingsService.get()).ui?.consoleLogsEnabled === true;
    if (consoleLogsEnabled) {
      console.log('[long.tokenInfo.rpc.start]', {
        chainId,
        tokenAddress: tokenAddress.toLowerCase(),
        seedPoolId: pickPoolId(seed),
      });
    }

    const state = await getLongLaunchState(tokenAddress as Address, {
      poolId: pickPoolId(seed),
      extraCurrencies: [seed?.quote_token_address],
    });
    if (!state) return null;

    const quoteSymbol = await readLongQuoteSymbol(state.quoteToken);
    const seedPlatform = normalizeLaunchpadPlatform(seed?.launchpad_platform || seed?.launchpad);
    const launchpad = seedPlatform && isLongLaunchpadPlatform(seedPlatform)
      ? seedPlatform
      : 'long';

    let name = seed?.name || '';
    let symbol = seed?.symbol || '';
    let decimals = seed?.decimals || 18;
    let totalSupply = seed?.totalSupply;
    if (!name || !symbol) {
      try {
        const meta = await RpcService.withBalancedReadClient({
          chainId: ChainId.RH,
          caller: 'long.tokenMeta',
          run: async (client) => {
            const [onchainName, onchainSymbol, onchainDecimals, onchainSupply] = await Promise.all([
              client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'name' }),
              client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'symbol' }),
              client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'decimals' }),
              client.readContract({ address: tokenAddress, abi: erc20MetaAbi, functionName: 'totalSupply' }),
            ]);
            return {
              name: String(onchainName || ''),
              symbol: String(onchainSymbol || ''),
              decimals: Number(onchainDecimals || 18),
              totalSupply: formatUnits(onchainSupply as bigint, Number(onchainDecimals || 18)),
            };
          },
        });
        name = name || meta.name;
        symbol = symbol || meta.symbol;
        decimals = seed?.decimals || meta.decimals;
        totalSupply = totalSupply || meta.totalSupply;
      } catch {
      }
    }

    const result: TokenInfo = {
      chain: seed?.chain || 'rh',
      address: tokenAddress,
      name,
      symbol,
      decimals,
      logo: seed?.logo || '',
      description: seed?.description,
      website: seed?.website || 'https://app.long.xyz',
      twitterUrl: seed?.twitterUrl,
      telegramUrl: seed?.telegramUrl,
      launchpad,
      // Epoch progress is time-based; trading is always Uniswap V4 (no separate curve ABI).
      launchpad_progress: Number(seed?.launchpad_progress ?? 0),
      launchpad_platform: launchpad,
      launchpad_status: Number(seed?.launchpad_status ?? 0),
      quote_token: quoteSymbol,
      quote_token_address: state.quoteToken,
      pool_pair: state.poolId,
      biggest_pool_address: state.poolId,
      tpool_pool_address: state.poolId,
      tpool_launch_type: seed?.tpool_launch_type || 'migrated',
      dex_type: 'UNISWAP_V4',
      tokenPrice: seed?.tokenPrice,
      totalSupply,
    };

    if (consoleLogsEnabled) {
      console.log('[long.tokenInfo.rpc.done]', {
        chainId,
        tokenAddress: tokenAddress.toLowerCase(),
        elapsedMs: Date.now() - startedAt,
        poolId: state.poolId,
        quoteToken: state.quoteToken,
        fee: state.fee,
        tickSpacing: state.tickSpacing,
        hooks: state.hooks,
        suffixHint: looksLikeLongSuffixAddress(tokenAddress),
      });
    }
    return result;
  }
}
