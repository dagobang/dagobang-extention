import type { LimitOrderCreateInput } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import type { ChainAddress } from '@/types/chain/address';
import { createLimitOrder } from '@/services/limitOrders/store';

export const COOKING_DEFAULT_TOKEN_SUPPLY = 1_000_000_000;

export type CookingAutoSellRule = {
  marketCapUsd: number;
  sellPercent: number;
};

export type CookingAutoSellInput = {
  enabled?: boolean;
  rules?: Array<{ marketCapUsd?: number | string; sellPercent?: number | string }>;
};

export type CookingAutoSellResult = {
  okCount: number;
  total: number;
  errors: string[];
};

export function normalizeCookingAutoSellRules(
  rules: Array<{ marketCapUsd?: number | string; sellPercent?: number | string }> | undefined,
): CookingAutoSellRule[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => ({
      marketCapUsd: Number(String(rule?.marketCapUsd ?? '').trim()),
      sellPercent: Number(String(rule?.sellPercent ?? '').trim()),
    }))
    .filter((rule) =>
      Number.isFinite(rule.marketCapUsd)
      && rule.marketCapUsd > 0
      && Number.isFinite(rule.sellPercent)
      && rule.sellPercent > 0
      && rule.sellPercent <= 100
    );
}

export async function createCookingLaunchAutoSellOrders(input: {
  tokenAddress: string;
  fromAddress: string;
  name: string;
  symbol: string;
  imgUrl?: string;
  launchpad: string;
  quoteToken?: string;
  rules?: Array<{ marketCapUsd?: number | string; sellPercent?: number | string }>;
}): Promise<CookingAutoSellResult> {
  const tokenAddress = String(input.tokenAddress || '').trim();
  const fromAddress = String(input.fromAddress || '').trim();
  const rules = normalizeCookingAutoSellRules(input.rules);
  if (!tokenAddress || !fromAddress) {
    return { okCount: 0, total: rules.length, errors: ['缺少代币地址或发币钱包'] };
  }
  if (rules.length <= 0) {
    return { okCount: 0, total: 0, errors: ['没有有效的市值目标配置'] };
  }

  const tokenInfo: TokenInfo = {
    chain: 'bsc',
    address: tokenAddress,
    name: input.name,
    symbol: input.symbol,
    decimals: 18,
    logo: input.imgUrl || '',
    launchpad: input.launchpad,
    launchpad_progress: 0,
    launchpad_platform: input.launchpad,
    launchpad_status: 0,
    quote_token: input.quoteToken || 'BNB',
    tokenPrice: {
      price: '0',
      marketCap: '0',
      timestamp: Date.now(),
    },
  };

  const errors: string[] = [];
  let okCount = 0;
  for (const rule of rules) {
    const orderInput: LimitOrderCreateInput = {
      chainId: 56,
      tokenAddress: tokenAddress as ChainAddress,
      fromAddress: fromAddress as ChainAddress,
      tokenSymbol: input.symbol,
      side: 'sell',
      orderType: 'take_profit_sell',
      triggerPriceUsd: rule.marketCapUsd / COOKING_DEFAULT_TOKEN_SUPPLY,
      targetChangePercent: 0,
      sellPercentBps: Math.round(rule.sellPercent * 100),
      tokenInfo,
    };
    try {
      await createLimitOrder(orderInput);
      okCount += 1;
    } catch (error: any) {
      errors.push(String(error?.message || error || '创建挂单失败'));
    }
  }
  return { okCount, total: rules.length, errors };
}
