import { createPublicClient, http, fallback, keccak256, parseEther, type PublicClient } from 'viem';
import { SettingsService } from './settings';
import BloxRouterAPI from '@/services/api/bloxRouter';
import { classifyBroadcastError } from '@/utils/txErrorClassify';
import { isAllowanceLikeText } from '@/utils/txErrorClassify';
import { getChainRuntime } from '@/constants/chains';

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
  private static readonly prewarmWindowMs = 45_000;
  private static readonly prewarmedAtByUrl = new Map<string, number>();
  private static prewarmedAtBloxroute = 0;
  private static readonly defaultPriorityFeePresets = {
    none: '0',
    slow: '0.000025',
    standard: '0.00004',
    fast: '0.0001',
  } as const;

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

  private static getClientForUrl(url: string, chainId?: number): PublicClient {
    const resolvedChainId = chainId ?? this.clientCache?.chainId ?? 56;
    const cacheKey = `${resolvedChainId}:${url}`;
    const existing = this.clientByUrl.get(cacheKey);
    if (existing) return existing;
    const chain = getChainRuntime(resolvedChainId).viemChain;
    const client = createPublicClient({
      chain,
      transport: http(url),
    });
    this.clientByUrl.set(cacheKey, client);
    return client;
  }

  private static resolvePriorityFeeBnb(chainConfig: any, side: BroadcastTxSide, override?: string): string {
    if (typeof override === 'string' && override.trim()) return override.trim();
    const rawPreset = side === 'buy' ? chainConfig?.buyPriorityFeePreset : chainConfig?.sellPriorityFeePreset;
    const preset = (rawPreset === 'none' || rawPreset === 'slow' || rawPreset === 'standard' || rawPreset === 'fast'
      ? rawPreset
      : 'standard') as 'none' | 'slow' | 'standard' | 'fast';
    const rawPresets = side === 'buy' ? chainConfig?.buyPriorityFeePresets : chainConfig?.sellPriorityFeePresets;
    const presets = {
      none: typeof rawPresets?.none === 'string' ? rawPresets.none.trim() : this.defaultPriorityFeePresets.none,
      slow: typeof rawPresets?.slow === 'string' ? rawPresets.slow.trim() : this.defaultPriorityFeePresets.slow,
      standard: typeof rawPresets?.standard === 'string' ? rawPresets.standard.trim() : this.defaultPriorityFeePresets.standard,
      fast: typeof rawPresets?.fast === 'string' ? rawPresets.fast.trim() : this.defaultPriorityFeePresets.fast,
    };
    return presets[preset as keyof typeof presets] || '0';
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

  private static getProtectedUrlsForSide(chainConfig: any, txSide?: BroadcastTxSide): string[] {
    const groups = this.getRpcUrlGroups(chainConfig);
    const sideUrls = txSide === 'buy' ? groups.protectedBuy : txSide === 'sell' ? groups.protectedSell : [];
    return sideUrls.length > 0 ? sideUrls : groups.protectedBase;
  }

  private static getRpcUrlGroups(chainConfig: any): {
    public: string[];
    protectedBase: string[];
    protectedBuy: string[];
    protectedSell: string[];
  } {
    return {
      public: this.normalizeUrls(chainConfig?.rpcUrls ?? []),
      protectedBase: this.normalizeUrls(chainConfig?.protectedRpcUrls ?? []),
      protectedBuy: this.normalizeUrls((chainConfig as any)?.protectedRpcUrlsBuy ?? []),
      protectedSell: this.normalizeUrls((chainConfig as any)?.protectedRpcUrlsSell ?? []),
    };
  }

  private static getUrlsByScope(
    chainConfig: any,
    txSide: BroadcastTxSide | undefined,
    scope: 'protected' | 'public' | 'both',
    opts?: { includeAllProtectedWhenNoSide?: boolean }
  ): string[] {
    const groups = this.getRpcUrlGroups(chainConfig);
    const includeAllProtectedWhenNoSide = !!opts?.includeAllProtectedWhenNoSide;
    const protectedUrls = txSide
      ? this.getProtectedUrlsForSide(chainConfig, txSide)
      : includeAllProtectedWhenNoSide
        ? this.normalizeUrls([...groups.protectedBase, ...groups.protectedBuy, ...groups.protectedSell])
        : groups.protectedBase;
    if (scope === 'protected') return protectedUrls;
    if (scope === 'public') return groups.public;
    return this.normalizeUrls([...protectedUrls, ...groups.public]);
  }

  private static mergeRpcUrlsForReceipt(chainConfig: any, txSide?: BroadcastTxSide): string[] {
    // Receipt polling should never miss tx hashes sent via side-specific protected routes.
    // When txSide is unknown, include all protected pools to maximize observability.
    return this.getUrlsByScope(chainConfig, txSide, 'both', { includeAllProtectedWhenNoSide: true });
  }

  static async getObservedPendingNonce(input: {
    chainId: number;
    address: `0x${string}`;
    txSide?: BroadcastTxSide;
    prefer?: 'min' | 'max';
    scope?: 'protected' | 'public' | 'both';
  }): Promise<number | null> {
    const settings = await SettingsService.get();
    const chainConfig = settings.chains[input.chainId];
    if (!chainConfig) return null;
    const urls = this.getUrlsByScope(chainConfig, input.txSide, input.scope ?? 'both', { includeAllProtectedWhenNoSide: true });
    if (urls.length === 0) return null;
    const values = await Promise.allSettled(
      urls.map(async (url) => {
        const client = this.getClientForUrl(url, input.chainId);
        return await client.getTransactionCount({ address: input.address, blockTag: 'pending' });
      }),
    );
    const nonces: number[] = [];
    for (const v of values) {
      if (v.status !== 'fulfilled') continue;
      const nonce = Number(v.value);
      if (!Number.isFinite(nonce) || nonce < 0) continue;
      nonces.push(Math.floor(nonce));
    }
    if (!nonces.length) return null;
    if (input.prefer === 'min') return Math.min(...nonces);
    return Math.max(...nonces);
  }

  static async waitForTransactionReceiptAny(
    hash: `0x${string}`,
    opts?: { chainId?: number; txSide?: BroadcastTxSide; timeoutMs?: number }
  ): Promise<any> {
    const timeoutMs = Math.max(5_000, Number(opts?.timeoutMs ?? 20_000));
    const settings = await SettingsService.get();
    const chainId = opts?.chainId ?? settings.chainId;
    const chainConfig = settings.chains[chainId];
    const urls = this.mergeRpcUrlsForReceipt(chainConfig, opts?.txSide);
    if (urls.length === 0) {
      const client = await this.getClient();
      return await (client as any).waitForTransactionReceipt({ hash, timeout: timeoutMs });
    }

    const tasks = urls.map(async (url) => {
      const client = this.getClientForUrl(url, chainId) as any;
      return await client.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    });

    try {
      return await Promise.any(tasks);
    } catch {
      // One last direct receipt probe across all routes in case polling timeout was hit right before inclusion.
      const probes = await Promise.allSettled(
        urls.map(async (url) => {
          const client = this.getClientForUrl(url, chainId) as any;
          return await client.getTransactionReceipt({ hash });
        }),
      );
      for (const item of probes) {
        if (item.status === 'fulfilled' && item.value) return item.value;
      }
      throw new Error(`Transaction receipt wait timeout after ${timeoutMs}ms`);
    }
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

    const chain = getChainRuntime(settings.chainId).viemChain;
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
    const settings = await SettingsService.get();
    const chain = getChainRuntime(settings.chainId).viemChain;
    const client = createPublicClient({
      chain,
      transport: http(url),
    });
    const start = performance.now();
    await client.getBlockNumber();
    const end = performance.now();
    return end - start;
  }

  static async prewarm(opts?: { urls?: string[]; force?: boolean; timeoutMs?: number }): Promise<void> {
    const timeoutMs = Math.max(200, Number(opts?.timeoutMs ?? 1500));
    const force = !!opts?.force;
    const settings = await SettingsService.get();
    const urls = (() => {
      if (opts?.urls?.length) return this.normalizeUrls(opts.urls);
      return [];
    })();
    const finalUrls = urls.length > 0
      ? urls
      : (() => {
        const chain = settings.chains[settings.chainId];
        const merged = [
          ...(chain?.rpcUrls ?? []),
          ...(chain?.protectedRpcUrls ?? []),
          ...(((chain as any)?.protectedRpcUrlsBuy ?? []) as string[]),
          ...(((chain as any)?.protectedRpcUrlsSell ?? []) as string[]),
        ];
        return this.normalizeUrls(merged);
      })();
    const now = Date.now();
    if (force || now - this.prewarmedAtBloxroute >= this.prewarmWindowMs) {
      this.prewarmedAtBloxroute = now;
      await BloxRouterAPI.prewarm({ timeoutMs }).catch(() => null);
    }
    await this.getClient().catch(() => null);
    const tasks = finalUrls.map(async (url) => {
      const lastAt = this.prewarmedAtByUrl.get(url) ?? 0;
      if (!force && now - lastAt < this.prewarmWindowMs) return;
      this.prewarmedAtByUrl.set(url, now);
      const client = this.getClientForUrl(url, settings.chainId);
      try {
        await Promise.race([
          client.getBlockNumber(),
          new Promise((_, reject) => {
            const id = setTimeout(() => {
              clearTimeout(id);
              reject(new Error('rpc prewarm timeout'));
            }, timeoutMs);
          }),
        ]);
      } catch {
      }
    });
    await Promise.allSettled(tasks);
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
    const targetChainId = opts?.signerContext?.chainId ?? settings.chainId;
    const chainConfig = settings.chains[targetChainId];
    const runtime = getChainRuntime(targetChainId);
    const txSide = opts?.txSide;
    const bundleSignerContext = opts?.signerContext;
    const priorityFeeBnb =
      txSide
        ? this.resolvePriorityFeeBnb(chainConfig as any, txSide, opts?.priorityFeeBnbOverride)
        : '0';
    let priorityFeeWei = 0n;
    try {
      priorityFeeWei = parseEther(priorityFeeBnb);
    } catch {
      priorityFeeWei = 0n;
    }
    const bundlePriorityMode = !!txSide && priorityFeeWei > 0n;

    const protectedUrls = this.getProtectedUrlsForSide(chainConfig, txSide);
    if (protectedUrls.length === 0 && !settings.bloxrouteAuthHeader) {
      throw new Error('No protected RPC URLs configured (required for broadcasting transactions)');
    }

    const tryBroadcast = async (urls: string[], includeBloxroute: boolean) => {
      const bundleFailures: string[] = [];
      const rawFailures: string[] = [];
      const isDeterministicSellAllowanceFailure = (detail: string) => txSide === 'sell' && isAllowanceLikeText(detail);
      const extractErrText = (e: any) => {
        const texts: string[] = [];
        const push = (v: any) => {
          if (typeof v !== 'string') return;
          const t = v.trim();
          if (t) texts.push(t);
        };
        push(e?.shortMessage);
        push(e?.message);
        push(e?.details);
        push(e?.cause?.message);
        push(e?.cause?.details);
        if (Array.isArray(e?.metaMessages)) {
          for (const x of e.metaMessages) push(x);
        }
        return texts.join(' | ') || String(e || 'unknown error');
      };
      const bloxHeader = (settings.bloxrouteAuthHeader ?? '').trim();
      const bloxEnabledBySide =
        txSide === 'buy'
          ? ((chainConfig as any)?.bloxrouteBuyEnabled ?? true)
          : txSide === 'sell'
            ? ((chainConfig as any)?.bloxrouteSellEnabled ?? true)
            : true;
      const willUseBloxroute = includeBloxroute && this.bloxroutePrivateTxEnabled && bloxHeader && bloxEnabledBySide;
      if (bundlePriorityMode && bundleSignerContext) {
        const rpcBundlePromises: Array<Promise<BroadcastTxResult>> = [];
        let rpcBundleNonceError: string | null = null;
        let rpcBundleDeterministicError: string | null = null;
        const runBloxBundle = async () => {
          const tipTx = await bundleSignerContext.account.signTransaction({
            to: this.bloxrouteDynamicFeeReceiver,
            value: priorityFeeWei,
            gas: this.bloxrouteDynamicFeeTxGas,
            gasPrice: bundleSignerContext.gasPrice,
            chain: runtime.viemChain,
            chainId: bundleSignerContext.chainId,
            nonce: bundleSignerContext.nonce + 1,
            data: '0x',
          });
          await BloxRouterAPI.sendBundle(targetChainId, [signedTx, tipTx]);
          return { txHash: keccak256(signedTx) as `0x${string}`, via: 'bloxroute', isBundle: true } as BroadcastTxResult;
        };
        for (const url of urls) {
          const tipReceiver = this.getBundleTipReceiver(url);
          if (!tipReceiver) continue;
          rpcBundlePromises.push(
            (async () => {
              const client = this.getClientForUrl(url, targetChainId);
              try {
                const tipTx = await bundleSignerContext.account.signTransaction({
                  to: tipReceiver,
                  value: priorityFeeWei,
                  gas: 21000n,
                  gasPrice: bundleSignerContext.gasPrice,
                  chain: runtime.viemChain,
                  chainId: bundleSignerContext.chainId,
                  nonce: bundleSignerContext.nonce + 1,
                  data: '0x',
                });
                const txHash = await this.sendBundleViaRpc(client, signedTx, tipTx);
                return { txHash, via: 'rpc', rpcUrl: url, isBundle: true };
              } catch (e: any) {
                const detail = extractErrText(e);
                bundleFailures.push(`${url}: ${detail}`);
                if (!rpcBundleNonceError && classifyBroadcastError(detail) === 'nonce') {
                  rpcBundleNonceError = `${url}: ${detail}`;
                }
                if (!rpcBundleDeterministicError && isDeterministicSellAllowanceFailure(detail)) {
                  rpcBundleDeterministicError = `${url}: ${detail}`;
                }
                console.error(`Error broadcasting tx bundle to ${url}:`, e);
                throw e;
              }
            })(),
          );
        }
        if (rpcBundlePromises.length === 0 && !willUseBloxroute) {
          throw new Error('Priority fee preset is active but no bundle-capable route available. Configure blockrazor/bloxroute bundle route or switch preset to none.');
        }
        if (rpcBundlePromises.length > 0) {
          try {
            return await Promise.any(rpcBundlePromises);
          } catch {
          }
        }
        if (rpcBundleDeterministicError) {
          throw new Error(`Bundle deterministic sell failure detected. ${rpcBundleDeterministicError}`);
        }
        if (rpcBundleNonceError) {
          throw new Error(`Bundle nonce mismatch detected. ${rpcBundleNonceError}`);
        }
        if (willUseBloxroute) {
          try {
            return await runBloxBundle();
          } catch (e: any) {
            const detail = extractErrText(e);
            bundleFailures.push(`bloxroute: ${detail}`);
            console.error('Error broadcasting tx via BloxRoute bundle:', e);
          }
        }
        const detail = bundleFailures.length ? ` Details: ${bundleFailures.join(' | ')}` : '';
        throw new Error(`Failed to broadcast transaction via bundle routes.${detail}`);
      }

      let rawDeterministicError: string | null = null;
      const runBloxRaw = async (): Promise<BroadcastTxResult> => {
        const txHash = await BloxRouterAPI.sendPrivateTx(targetChainId, signedTx);
        if (!txHash) throw new Error('BloxRoute did not return tx hash');
        return { txHash, via: 'bloxroute' };
      };

      const rpcRawPromises: Array<Promise<BroadcastTxResult>> = [];
      for (const url of urls) {
        rpcRawPromises.push(
          (async () => {
            const client = this.getClientForUrl(url, targetChainId);
            try {
              const txHash = await client.sendRawTransaction({ serializedTransaction: signedTx });
              return { txHash, via: 'rpc', rpcUrl: url, isBundle: false };
            } catch (e: any) {
              const detail = extractErrText(e);
              rawFailures.push(`${url}: ${detail}`);
              if (!rawDeterministicError && isDeterministicSellAllowanceFailure(detail)) {
                rawDeterministicError = `${url}: ${detail}`;
              }
              console.error(`Error broadcasting tx to ${url}:`, e);
              if (classifyBroadcastError(detail) === 'already_known') {
                const txHash = keccak256(signedTx) as `0x${string}`;
                return { txHash, via: 'rpc', rpcUrl: url } as BroadcastTxResult;
              }
              throw e;
            }
          })(),
        );
      }
      if (txSide === 'sell') {
        try {
          return await Promise.any(rpcRawPromises);
        } catch {
          if (rawDeterministicError) {
            throw new Error(`Raw deterministic sell failure detected. ${rawDeterministicError}`);
          }
          if (willUseBloxroute) {
            try {
              return await runBloxRaw();
            } catch (e: any) {
              const detail = extractErrText(e);
              rawFailures.push(`bloxroute: ${detail}`);
              console.error('Error broadcasting tx via BloxRoute:', e);
            }
          }
          const detail = rawFailures.length ? ` Details: ${rawFailures.join(' | ')}` : '';
          throw new Error(`Failed to broadcast transaction to any raw route.${detail}`);
        }
      }
      const rawPromises: Array<Promise<BroadcastTxResult>> = [...rpcRawPromises];
      if (willUseBloxroute) {
        rawPromises.push(
          (async () => {
            try {
              return await runBloxRaw();
            } catch (e: any) {
              const detail = extractErrText(e);
              rawFailures.push(`bloxroute: ${detail}`);
              console.error('Error broadcasting tx via BloxRoute:', e);
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
