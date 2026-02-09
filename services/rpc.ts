import { createPublicClient, http, fallback, type PublicClient } from 'viem';
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
      transport: fallback(transports, { rank: { interval: 30_000 } }),
    });

    this.clientCache = {
      chainId: settings.chainId,
      urls: [...settings.chains[settings.chainId].rpcUrls],
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
    const chain = bsc;
    const chainConfig = settings.chains[settings.chainId];

    let targetUrls = chainConfig.rpcUrls;
    if (chainConfig.antiMev && chainConfig.protectedRpcUrls.length > 0) {
      targetUrls = chainConfig.protectedRpcUrls;
    }

    if (targetUrls.length === 0) {
      throw new Error('No RPC URLs configured (check Anti-MEV settings)');
    }

    const promises: Array<Promise<BroadcastTxResult>> = [];

    if (this.bloxroutePrivateTxEnabled) {
      promises.push(
        (async () => {
          const txHash = await BloxRouterAPI.sendBscPrivateTx(signedTx);
          if (!txHash) {
            throw new Error('BloxRoute did not return tx hash');
          }
          return { txHash, via: 'bloxroute' };
        })(),
      );
    }

    for (const url of targetUrls) {
      promises.push(
        (async () => {
          const client = createPublicClient({
            chain,
            transport: http(url),
          });
          const txHash = await client.sendRawTransaction({ serializedTransaction: signedTx });
          return { txHash, via: 'rpc', rpcUrl: url };
        })(),
      );
    }

    try {
      // Return the first successful result
      return await Promise.any(promises);
    } catch (e) {
      // If all fail, throw an error
      throw new Error('Failed to broadcast transaction to any RPC endpoint');
    }
  }
}
