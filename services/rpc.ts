import { createPublicClient, http, fallback, keccak256, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { SettingsService } from './settings';
import BloxRouterAPI from '@/services/api/bloxRouter';

export type BroadcastTxVia = 'bloxroute' | 'rpc';
export type BroadcastTxResult = {
  txHash: `0x${string}`;
  via: BroadcastTxVia;
  rpcUrl?: string;
};

export class RpcService {
  private static clientCache: { chainId: number; urls: string[]; client: PublicClient } | null = null;
  private static readonly bloxroutePrivateTxEnabled = true;
  private static readonly clientByUrl = new Map<string, PublicClient>();

  private static normalizeUrls(urls: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of urls) {
      const url = (raw ?? '').trim();
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
    return out;
  }

  private static getClientForUrl(url: string): PublicClient {
    const existing = this.clientByUrl.get(url);
    if (existing) return existing;
    const chain = bsc;
    const client = createPublicClient({
      chain,
      transport: http(url),
    });
    this.clientByUrl.set(url, client);
    return client;
  }

  static async getClient(): Promise<PublicClient> {
    const settings = await SettingsService.get();
    const urls = this.normalizeUrls(settings.chains[settings.chainId].rpcUrls);

    // Check cache
    if (
      this.clientCache &&
      this.clientCache.chainId === settings.chainId &&
      this.clientCache.urls.join(',') === urls.join(',')
    ) {
      return this.clientCache.client;
    }

    const chain = bsc;
    // Use fallback transport with ranking to optimize for latency
    const transports = urls.map((url) => http(url));

    const client = createPublicClient({
      chain,
      transport: fallback(transports, { rank: { interval: 30_000 } }),
    });

    this.clientCache = {
      chainId: settings.chainId,
      urls,
      client,
    };

    return client;
  }

  static async measureLatency(url: string): Promise<number> {
    const chain = bsc;
    const client = createPublicClient({
      chain,
      transport: http(url),
    });
    const start = performance.now();
    await client.getBlockNumber();
    const end = performance.now();
    return end - start;
  }

  static async broadcastTx(signedTx: `0x${string}`): Promise<`0x${string}`> {
    const { txHash } = await this.broadcastTxDetailed(signedTx);
    return txHash;
  }

  static async broadcastTxDetailed(signedTx: `0x${string}`): Promise<BroadcastTxResult> {
    const settings = await SettingsService.get();
    const chainConfig = settings.chains[settings.chainId];

    let targetUrls: string[] = [];
    if (chainConfig.antiMev && chainConfig.protectedRpcUrls.length > 0) {
      targetUrls = chainConfig.protectedRpcUrls;
    }

    targetUrls = this.normalizeUrls(targetUrls);
    if (targetUrls.length === 0) {
      throw new Error('No RPC URLs configured (check Anti-MEV settings)');
    }

    const promises: Array<Promise<BroadcastTxResult>> = [];
    const failures: string[] = [];

    const bloxHeader = (settings.bloxrouteAuthHeader ?? '').trim();
    if (this.bloxroutePrivateTxEnabled && bloxHeader) {
      promises.push(
        (async () => {
          try {
            const txHash = await BloxRouterAPI.sendBscPrivateTx(signedTx);
            if (!txHash) {
              throw new Error('BloxRoute did not return tx hash');
            }
            
            return { txHash, via: 'bloxroute' };
          } catch (e: any) {
            failures.push(`bloxroute: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
            console.error('Error broadcasting tx via BloxRoute:', e);
            throw e;
          }
        })(),
      );
    }

    for (const url of targetUrls) {
      promises.push(
        (async () => {
          const client = this.getClientForUrl(url);
          try {
            const txHash = await client.sendRawTransaction({ serializedTransaction: signedTx });
            return { txHash, via: 'rpc', rpcUrl: url };
          } catch (e: any) {
            failures.push(`${url}: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
            console.error(`Error broadcasting tx to ${url}:`, e);
            const msg = String(e?.shortMessage || e?.message || '').toLowerCase();
            const isAlreadyKnown =
              msg.includes('already known') ||
              msg.includes('known transaction') ||
              msg.includes('already imported') ||
              msg.includes('already exists') ||
              msg.includes('already in mempool');
            if (isAlreadyKnown) {
              const txHash = keccak256(signedTx) as `0x${string}`;
              return { txHash, via: 'rpc', rpcUrl: url };
            }

            throw e;
          }
        })(),
      );
    }

    try {
      // Return the first successful result
      return await Promise.any(promises);
    } catch (e) {
      // If all fail, throw an error
      const detail = failures.length ? ` Details: ${failures.join(' | ')}` : '';
      throw new Error(`Failed to broadcast transaction to any RPC endpoint.${detail}`);
    }
  }
}
