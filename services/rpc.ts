import { createPublicClient, http, fallback, keccak256, parseEther, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { SettingsService } from './settings';
import BloxRouterAPI from '@/services/api/bloxRouter';

export type BroadcastTxVia = 'bloxroute' | 'rpc';
export type BroadcastTxResult = {
  txHash: `0x${string}`;
  via: BroadcastTxVia;
  rpcUrl?: string;
};

export type BroadcastTxSide = 'buy' | 'sell';

export type BroadcastTxOptions = {
  txSide?: BroadcastTxSide;
  signerContext?: {
    account: any;
    chainId: number;
    nonce: number;
    gas: bigint;
    gasPrice: bigint;
  };
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

  private static getPriorityFeeBnbValue(settings: any, chainConfig: any, side: BroadcastTxSide): string {
    const candidates = side === 'buy'
      ? [
        chainConfig?.buyPriorityFeeBnb,
        chainConfig?.buyPriorityFee,
        chainConfig?.priorityFeeBuyBnb,
        settings?.buyPriorityFeeBnb,
        settings?.buyPriorityFee,
        settings?.priorityFeeBuyBnb,
        settings?.priorityFee?.buyBnb,
      ]
      : [
        chainConfig?.sellPriorityFeeBnb,
        chainConfig?.sellPriorityFee,
        chainConfig?.priorityFeeSellBnb,
        settings?.sellPriorityFeeBnb,
        settings?.sellPriorityFee,
        settings?.priorityFeeSellBnb,
        settings?.priorityFee?.sellBnb,
      ];
    for (const item of candidates) {
      if (typeof item !== 'string') continue;
      const v = item.trim();
      if (v) return v;
    }
    return '0';
  }

  private static isPriorityFeeEnabled(settings: any, chainConfig: any): boolean {
    const candidates = [
      chainConfig?.priorityFeeEnabled,
      chainConfig?.enablePriorityFee,
      chainConfig?.usePriorityFee,
      settings?.priorityFeeEnabled,
      settings?.enablePriorityFee,
      settings?.usePriorityFee,
      settings?.priorityFee?.enabled,
    ];
    for (const item of candidates) {
      if (typeof item === 'boolean') return item;
    }
    return false;
  }

  private static getBundleTipReceiver(url: string): `0x${string}` | null {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (host.endsWith('48.club') || host.includes('48.club')) {
      return '0x4848489f0b2BEdd788c696e2D79b6b69D7484848';
    }
    if (host.includes('blockrazor')) {
      return '0x1266C6bE60392A8Ff346E8d5ECCd3E69dD9c5F20';
    }
    return null;
  }

  private static async sendBundleViaRpc(
    client: PublicClient,
    signedTx: `0x${string}`,
    tipTx: `0x${string}`,
  ): Promise<`0x${string}`> {
    const currentBlock = await client.getBlockNumber();
    const maxBlockNumber = Number(currentBlock) + 100;
    try {
      await (client as any).request({
        method: 'eth_sendBundle',
        params: [{ txs: [signedTx, tipTx], maxBlockNumber }],
      });
    } catch {
      await (client as any).request({
        method: 'eth_sendMevBundle',
        params: [{ Txs: [signedTx, tipTx], maxBlockNumber }],
      });
    }
    return keccak256(signedTx) as `0x${string}`;
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

  static async broadcastTx(signedTx: `0x${string}`, opts?: BroadcastTxOptions): Promise<`0x${string}`> {
    const { txHash } = await this.broadcastTxDetailed(signedTx, opts);
    return txHash;
  }

  static async broadcastTxDetailed(signedTx: `0x${string}`, opts?: BroadcastTxOptions): Promise<BroadcastTxResult> {
    if (typeof signedTx !== 'string' || !signedTx.startsWith('0x') || signedTx.length <= 2) {
      throw new Error('Invalid signed transaction');
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signedTx)) {
      throw new Error('Invalid signed transaction');
    }

    const settings = await SettingsService.get();
    const chainConfig = settings.chains[settings.chainId];
    const txSide = opts?.txSide;
    const bundleSignerContext = opts?.signerContext;
    const priorityFeeEnabled = txSide ? this.isPriorityFeeEnabled(settings as any, chainConfig as any) : false;
    const priorityFeeBnb = txSide ? this.getPriorityFeeBnbValue(settings as any, chainConfig as any, txSide) : '0';
    let priorityFeeWei = 0n;
    try {
      priorityFeeWei = parseEther(priorityFeeBnb);
    } catch {
      priorityFeeWei = 0n;
    }

    const protectedUrls = this.normalizeUrls(chainConfig.protectedRpcUrls ?? []);
    if (protectedUrls.length === 0 && !settings.bloxrouteAuthHeader) {
      throw new Error('No protected RPC URLs configured (required for broadcasting transactions)');
    }

    const tryBroadcast = async (urls: string[], includeBloxroute: boolean) => {
      const promises: Array<Promise<BroadcastTxResult>> = [];
      const failures: string[] = [];

      const bloxHeader = (settings.bloxrouteAuthHeader ?? '').trim();
      if (includeBloxroute && this.bloxroutePrivateTxEnabled && bloxHeader) {
        promises.push(
          (async () => {
            try {
              const txHash = await BloxRouterAPI.sendBscPrivateTx(signedTx);
              if (!txHash) throw new Error('BloxRoute did not return tx hash');
              return { txHash, via: 'bloxroute' };
            } catch (e: any) {
              failures.push(`bloxroute: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
              console.error('Error broadcasting tx via BloxRoute:', e);
              throw e;
            }
          })(),
        );
      }

      for (const url of urls) {
        promises.push(
          (async () => {
            const client = this.getClientForUrl(url);
            try {
              const tipReceiver = this.getBundleTipReceiver(url);
              const shouldUseBundle =
                !!tipReceiver &&
                !!bundleSignerContext &&
                !!txSide &&
                priorityFeeEnabled &&
                priorityFeeWei > 0n;

              const txHash = shouldUseBundle
                ? await (async () => {
                  const tipTx = await bundleSignerContext.account.signTransaction({
                    to: tipReceiver,
                    value: priorityFeeWei,
                    gas: 21000n,
                    gasPrice: bundleSignerContext.gasPrice,
                    chain: bsc,
                    chainId: bundleSignerContext.chainId,
                    nonce: bundleSignerContext.nonce + 1,
                    data: '0x',
                  });
                  return await this.sendBundleViaRpc(client, signedTx, tipTx);
                })()
                : await client.sendRawTransaction({ serializedTransaction: signedTx });
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
        return await Promise.any(promises);
      } catch {
        const detail = failures.length ? ` Details: ${failures.join(' | ')}` : '';
        throw new Error(`Failed to broadcast transaction to any RPC endpoint.${detail}`);
      }
    };

    return await tryBroadcast(protectedUrls, true);
  }
}
