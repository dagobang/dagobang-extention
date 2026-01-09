import { createPublicClient, http, fallback, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { SettingsService } from './settings';

export class RpcService {
  private static clientCache: { chainId: number; urls: string[]; client: PublicClient } | null = null;

  static async getClient(): Promise<PublicClient> {
    const settings = await SettingsService.get();
    
    // Check cache
    if (
      this.clientCache &&
      this.clientCache.chainId === settings.chainId &&
      this.clientCache.urls.join(',') === settings.chains[settings.chainId].rpcUrls.join(',')
    ) {
      return this.clientCache.client;
    }

    const chain = bsc;
    // Use fallback transport with ranking to optimize for latency
    const transports = settings.chains[settings.chainId].rpcUrls.map((url) => http(url));
    
    const client = createPublicClient({
      chain,
      transport: fallback(transports, { rank: true }),
    });

    this.clientCache = {
      chainId: settings.chainId,
      urls: [...settings.chains[settings.chainId].rpcUrls],
      client,
    };

    return client;
  }

  /**
   * Broadcasts a signed transaction to ALL configured RPCs simultaneously (Race).
   * Returns the hash from the first one to succeed.
   * Respects Anti-MEV settings by using protected RPCs if enabled.
   */
  static async broadcastTx(signedTx: `0x${string}`): Promise<`0x${string}`> {
    const settings = await SettingsService.get();
    const chain = bsc;
    const chainConfig = settings.chains[settings.chainId];

    let targetUrls = chainConfig.rpcUrls;
    if (chainConfig.antiMev && chainConfig.protectedRpcUrls.length > 0) {
      targetUrls = chainConfig.protectedRpcUrls;
    }

    if (targetUrls.length === 0) {
      throw new Error('No RPC URLs configured (check Anti-MEV settings)');
    }

    // Create a promise for each RPC endpoint
    const promises = targetUrls.map(async (url) => {
      try {
        // Create a temporary single-transport client for this specific URL
        const client = createPublicClient({
          chain,
          transport: http(url),
        });
        return await client.sendRawTransaction({ serializedTransaction: signedTx });
      } catch (e) {
        // Log but don't throw yet, Promise.any will throw if ALL fail
        // console.warn(`Broadcast failed for ${url}`, e);
        throw e;
      }
    });

    try {
      // Return the first successful result
      return await Promise.any(promises);
    } catch (e) {
      // If all fail, throw an error
      throw new Error('Failed to broadcast transaction to any RPC endpoint');
    }
  }
}
