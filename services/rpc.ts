import { createPublicClient, http, fallback, keccak256, parseEther, type PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { SettingsService } from './settings';
import BloxRouterAPI from '@/services/api/bloxRouter';

export type BroadcastTxVia = 'bloxroute' | 'rpc';
export type BroadcastTxResult = {
  txHash: `0x${string}`;
  via: BroadcastTxVia;
  rpcUrl?: string;
  isBundle?: boolean;
};

export type BroadcastTxSide = 'buy' | 'sell';

export type BroadcastTxOptions = {
  txSide?: BroadcastTxSide;
  priorityFeeBnbOverride?: string;
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
  private static readonly bloxrouteDynamicFeeReceiver = '0x6374Ca2da5646C73Eb444aB99780495d61035f9b' as const;
  private static readonly bloxrouteDynamicFeeTxGas = 100000n;
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

  private static getPriorityFeeBnbValue(chainConfig: any, side: BroadcastTxSide): string {
    const value = side === 'buy' ? chainConfig?.buyPriorityFeeBnb : chainConfig?.sellPriorityFeeBnb;
    if (typeof value !== 'string') return '0';
    const normalized = value.trim();
    return normalized || '0';
  }

  private static isPriorityFeeEnabled(chainConfig: any): boolean {
    if (typeof chainConfig?.priorityFeeEnabled === 'boolean') return chainConfig.priorityFeeEnabled;
    return false;
  }

  private static getBundleTipReceiver(url: string): `0x${string}` | null {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
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
    } catch (e: any) {
      const msg = String(e?.shortMessage || e?.message || e || '').toLowerCase();
      const isMethodUnsupported =
        msg.includes('method not found') ||
        msg.includes('does not exist') ||
        msg.includes('unsupported') ||
        msg.includes('not supported');
      if (!isMethodUnsupported) {
        throw e;
      }
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
    const priorityFeeEnabled = txSide ? this.isPriorityFeeEnabled(chainConfig as any) : false;
    const priorityFeeBnb =
      txSide
        ? (typeof opts?.priorityFeeBnbOverride === 'string' && opts.priorityFeeBnbOverride.trim()
          ? opts.priorityFeeBnbOverride.trim()
          : this.getPriorityFeeBnbValue(chainConfig as any, txSide))
        : '0';
    let priorityFeeWei = 0n;
    try {
      priorityFeeWei = parseEther(priorityFeeBnb);
    } catch {
      priorityFeeWei = 0n;
    }
    const bundlePriorityMode = !!txSide && priorityFeeEnabled && priorityFeeWei > 0n;

    const baseUrls = this.normalizeUrls(chainConfig.protectedRpcUrls ?? []);
    const buyUrls = this.normalizeUrls((chainConfig as any).protectedRpcUrlsBuy ?? []);
    const sellUrls = this.normalizeUrls((chainConfig as any).protectedRpcUrlsSell ?? []);
    const sideUrls = txSide === 'buy' ? buyUrls : txSide === 'sell' ? sellUrls : [];
    const protectedUrls = sideUrls.length > 0 ? sideUrls : baseUrls;
    if (protectedUrls.length === 0 && !settings.bloxrouteAuthHeader) {
      throw new Error('No protected RPC URLs configured (required for broadcasting transactions)');
    }

    const tryBroadcast = async (urls: string[], includeBloxroute: boolean) => {
      const bundleFailures: string[] = [];
      const rawFailures: string[] = [];
      const bloxHeader = (settings.bloxrouteAuthHeader ?? '').trim();
      const bloxEnabledBySide =
        txSide === 'buy'
          ? ((chainConfig as any)?.bloxrouteBuyEnabled ?? true)
          : txSide === 'sell'
            ? ((chainConfig as any)?.bloxrouteSellEnabled ?? true)
            : true;
      const willUseBloxroute = includeBloxroute && this.bloxroutePrivateTxEnabled && bloxHeader && bloxEnabledBySide;
      if (bundlePriorityMode && bundleSignerContext) {
        const bundlePromises: Array<Promise<BroadcastTxResult>> = [];
        if (willUseBloxroute) {
          bundlePromises.push(
            (async () => {
              try {
                const tipTx = await bundleSignerContext.account.signTransaction({
                  to: this.bloxrouteDynamicFeeReceiver,
                  value: priorityFeeWei,
                  gas: this.bloxrouteDynamicFeeTxGas,
                  gasPrice: bundleSignerContext.gasPrice,
                  chain: bsc,
                  chainId: bundleSignerContext.chainId,
                  nonce: bundleSignerContext.nonce + 1,
                  data: '0x',
                });
                await BloxRouterAPI.sendBscBundle([signedTx, tipTx]);
                return { txHash: keccak256(signedTx) as `0x${string}`, via: 'bloxroute', isBundle: true };
              } catch (e: any) {
                bundleFailures.push(`bloxroute: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
                console.error('Error broadcasting tx via BloxRoute bundle:', e);
                throw e;
              }
            })(),
          );
        }
        for (const url of urls) {
          const tipReceiver = this.getBundleTipReceiver(url);
          if (!tipReceiver) continue;
          bundlePromises.push(
            (async () => {
              const client = this.getClientForUrl(url);
              try {
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
                const txHash = await this.sendBundleViaRpc(client, signedTx, tipTx);
                return { txHash, via: 'rpc', rpcUrl: url, isBundle: true };
              } catch (e: any) {
                bundleFailures.push(`${url}: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
                console.error(`Error broadcasting tx bundle to ${url}:`, e);
                throw e;
              }
            })(),
          );
        }
        if (bundlePromises.length === 0) {
          throw new Error('Priority fee enabled but no bundle-capable route available. Configure blockrazor/bloxroute bundle route or disable priority fee.');
        }
        try {
          return await Promise.any(bundlePromises);
        } catch {
          const detail = bundleFailures.length ? ` Details: ${bundleFailures.join(' | ')}` : '';
          throw new Error(`Failed to broadcast transaction via bundle routes.${detail}`);
        }
      }

      const rawPromises: Array<Promise<BroadcastTxResult>> = [];
      if (willUseBloxroute) {
        rawPromises.push(
          (async () => {
            try {
              const txHash = await BloxRouterAPI.sendBscPrivateTx(signedTx);
              if (!txHash) throw new Error('BloxRoute did not return tx hash');
              return { txHash, via: 'bloxroute' };
            } catch (e: any) {
              rawFailures.push(`bloxroute: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
              console.error('Error broadcasting tx via BloxRoute:', e);
              throw e;
            }
          })(),
        );
      }

      for (const url of urls) {
        rawPromises.push(
          (async () => {
            const client = this.getClientForUrl(url);
            try {
              const txHash = await client.sendRawTransaction({ serializedTransaction: signedTx });
              return { txHash, via: 'rpc', rpcUrl: url, isBundle: false };
            } catch (e: any) {
              rawFailures.push(`${url}: ${String(e?.shortMessage || e?.message || e || 'unknown error')}`);
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
        return await Promise.any(rawPromises);
      } catch {
        const detail = rawFailures.length ? ` Details: ${rawFailures.join(' | ')}` : '';
        throw new Error(`Failed to broadcast transaction to any raw route.${detail}`);
      }
    };

    return await tryBroadcast(protectedUrls, true);
  }
}
