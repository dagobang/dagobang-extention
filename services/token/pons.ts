import { formatUnits } from 'viem';

import { ChainId } from '@/constants/chains';
import { rhTokens } from '@/constants/tokens/chains/rh';
import type { TokenInfo } from '@/types/token';
import { SettingsService } from '../settings';
import {
  getPonsTradeState,
  quotePonsSell,
  readPonsCurveProgress,
  readPonsTokenMeta,
} from '../trade/tradePons';
import { ZERO_ADDRESS, type Address } from '../trade/tradeTypes';

export class TokenPonsService {
  static async getTokenInfo(chainId: number, tokenAddress: `0x${string}`): Promise<TokenInfo | null> {
    if (chainId !== ChainId.RH) return null;

    const startedAt = Date.now();
    const consoleLogsEnabled = (await SettingsService.get()).ui?.consoleLogsEnabled === true;
    if (consoleLogsEnabled) {
      console.log('[pons.tokenInfo.rpc.start]', {
        chainId,
        tokenAddress: tokenAddress.toLowerCase(),
      });
    }

    const state = await getPonsTradeState(tokenAddress as Address);
    if (!state) return null;
    const meta = await readPonsTokenMeta(tokenAddress as Address);
    if (!meta) return null;

    const oneToken = 10n ** BigInt(meta.decimals || 18);
    const quoted = await quotePonsSell(tokenAddress as Address, oneToken).catch(() => 0n);
    let progress = state.isOuter ? 100 : 0;
    let priceInQuote = 0;
    if (state.version === 2 && state.isInner) {
      const curve = await readPonsCurveProgress(state.curve).catch(() => ({ progress: 0, priceQuote: 0 }));
      progress = curve.progress;
      priceInQuote = curve.priceQuote;
    } else if (quoted > 0n) {
      priceInQuote = Number(formatUnits(quoted, 18));
    }

    const supplyText = formatUnits(meta.totalSupply, meta.decimals || 18);
    const launchpad = state.version === 1 ? 'pons_v1' : 'pons_v2';
    const quoteAddress = String(state.quoteRouterToken || '').toLowerCase();
    const quoteToken = state.isNativeQuote || quoteAddress === rhTokens.weth.address.toLowerCase() || quoteAddress === rhTokens.eth.address.toLowerCase()
      ? 'ETH'
      : quoteAddress === rhTokens.usdg.address.toLowerCase()
        ? 'USDG'
        : undefined;
    const result = {
      chain: 'rh',
      address: tokenAddress,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      logo: meta.logo,
      description: meta.description || undefined,
      website: meta.website || undefined,
      twitterUrl: meta.twitterUrl || undefined,
      telegramUrl: meta.telegramUrl || undefined,
      launchpad,
      launchpad_progress: progress,
      launchpad_platform: launchpad,
      launchpad_status: state.isOuter ? 1 : 0,
      quote_token: quoteToken,
      quote_token_address: state.quoteRouterToken,
      pool_pair: state.version === 1
        ? state.v3Pool
        : (state.isInner ? state.curve : undefined),
      dex_type: state.version === 1 ? 'UNISWAP_V3' : (state.isOuter ? 'UNISWAP_V4' : ''),
      totalSupply: supplyText,
      tokenPrice: undefined,
      creator: meta.creator !== ZERO_ADDRESS ? meta.creator : undefined,
    } as TokenInfo & { creator?: `0x${string}` };

    if (consoleLogsEnabled) {
      console.log('[pons.tokenInfo.rpc.done]', {
        chainId,
        tokenAddress: tokenAddress.toLowerCase(),
        elapsedMs: Date.now() - startedAt,
        version: state.version,
        phase: state.phase,
        inner: state.isInner,
        hasPrice: priceInQuote > 0,
      });
    }
    return result;
  }
}
