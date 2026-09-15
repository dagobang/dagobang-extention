import { browser } from 'wxt/browser';

import type { GmgnTokenPoolFeeInfo } from '@/hooks/GmgnAPI';

const GMGN_TAB_URLS = ['*://gmgn.ai/*', '*://*.gmgn.ai/*'] as const;
const PAGE_BRIDGE_TIMEOUT_MS = 900;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gmgn_token_pool_fee_info_timeout')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fetch GMGN token_pool_fee_info via an open gmgn.ai tab (cookies + Cloudflare).
 * Background SW cannot call GMGN directly; this mirrors follow/unfollow page-bridge.
 * Returns [] quickly when no gmgn tab is open (does not burn time on SW/CF failures).
 */
export async function fetchGmgnTokenPoolFeeInfoViaPage(
  chain: string,
  tokenAddress: string,
  options?: { timeoutMs?: number },
): Promise<GmgnTokenPoolFeeInfo[]> {
  const normalizedChain = String(chain || '').trim().toLowerCase();
  const token = String(tokenAddress || '').trim();
  if (!normalizedChain || !token) return [];

  const timeoutMs = Math.max(300, Math.min(options?.timeoutMs ?? PAGE_BRIDGE_TIMEOUT_MS, 2_000));
  try {
    const tabs = await browser.tabs.query({ url: [...GMGN_TAB_URLS] });
    if (!tabs.length) return [];

    const settled = await Promise.all(
      tabs
        .filter((tab) => !!tab.id)
        .map(async (tab) => {
          try {
            const rsp = await withTimeout(
              browser.tabs.sendMessage(tab.id as number, {
                type: 'bg:gmgn:pageTokenPoolFeeInfo',
                chain: normalizedChain,
                tokenAddress: token,
              }),
              timeoutMs,
            );
            if (rsp?.ok && Array.isArray(rsp?.list)) {
              return rsp.list as GmgnTokenPoolFeeInfo[];
            }
          } catch {
          }
          return null;
        }),
    );

    for (const list of settled) {
      if (Array.isArray(list) && list.length > 0) return list;
    }
    for (const list of settled) {
      if (Array.isArray(list)) return list;
    }
    return [];
  } catch {
    return [];
  }
}

export async function fetchGmgnTokenPoolFeeInfoPreferPage(
  chain: string,
  tokenAddress: string,
  options?: { timeoutMs?: number },
): Promise<GmgnTokenPoolFeeInfo[]> {
  return await fetchGmgnTokenPoolFeeInfoViaPage(chain, tokenAddress, options);
}
