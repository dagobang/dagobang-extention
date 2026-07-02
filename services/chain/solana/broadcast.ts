import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { ChainId } from '@/constants/chains/chainId';
import { RpcReadBalancer } from '@/services/rpcReadBalancer';
import { SettingsService } from '@/services/settings';
import type { SubmitChannel } from '@/types/extention';
import type { SolanaSwqosProviderSettings, SolanaSwqosRegion, SolanaSwqosSettings } from '@/types/extention';
import type { VersionedTransaction } from '@solana/web3.js';
import { SolanaRpcService } from './rpc';

type SolanaBroadcastResult = {
  txHash: string;
  broadcastVia: string;
  broadcastUrl?: string;
  isBundle?: boolean;
};

function reportPumpSwapBroadcastDebug(location: string, msg: string, data: Record<string, unknown>): void {
}

const DEFAULT_JITO_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'https://mainnet.block-engine.jito.wtf',
  newyork: 'https://ny.mainnet.block-engine.jito.wtf',
  frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
  amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
  slc: 'https://slc.mainnet.block-engine.jito.wtf',
  tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
  london: 'https://london.mainnet.block-engine.jito.wtf',
  losangeles: 'https://ny.mainnet.block-engine.jito.wtf',
};

const DEFAULT_NEXTBLOCK_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://frankfurt.nextblock.io',
  newyork: 'http://ny.nextblock.io',
  frankfurt: 'http://frankfurt.nextblock.io',
  amsterdam: 'http://amsterdam.nextblock.io',
  slc: 'http://slc.nextblock.io',
  tokyo: 'http://tokyo.nextblock.io',
  london: 'http://london.nextblock.io',
  losangeles: 'http://singapore.nextblock.io',
};

const DEFAULT_BLOX_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'https://germany.solana.dex.blxrbdn.com',
  newyork: 'https://ny.solana.dex.blxrbdn.com',
  frankfurt: 'https://germany.solana.dex.blxrbdn.com',
  amsterdam: 'https://amsterdam.solana.dex.blxrbdn.com',
  slc: 'https://ny.solana.dex.blxrbdn.com',
  tokyo: 'https://tokyo.solana.dex.blxrbdn.com',
  london: 'https://uk.solana.dex.blxrbdn.com',
  losangeles: 'https://la.solana.dex.blxrbdn.com',
};

const DEFAULT_TEMPORAL_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://fra2.nozomi.temporal.xyz',
  newyork: 'http://ewr1.nozomi.temporal.xyz',
  frankfurt: 'http://fra2.nozomi.temporal.xyz',
  amsterdam: 'http://ams1.nozomi.temporal.xyz',
  slc: 'http://ewr1.nozomi.temporal.xyz',
  tokyo: 'http://tyo1.nozomi.temporal.xyz',
  london: 'http://sgp1.nozomi.temporal.xyz',
  losangeles: 'http://pit1.nozomi.temporal.xyz',
};

function getLocalTransactionSignature(transaction: VersionedTransaction): string {
  const signature = transaction.signatures[0];
  if (!signature || signature.length === 0) {
    throw new Error('Signed Solana transaction has no signature');
  }
  return bs58.encode(signature);
}

function getSerializedTransactionBase64(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64');
}

function resolveProviderEndpoint(provider: SolanaSwqosProviderSettings, region: SolanaSwqosRegion): string {
  if (provider.endpoint?.trim()) return provider.endpoint.trim();
  if (provider.type === 'jito') return DEFAULT_JITO_ENDPOINTS[region];
  if (provider.type === 'nextblock') return DEFAULT_NEXTBLOCK_ENDPOINTS[region];
  if (provider.type === 'blox') return DEFAULT_BLOX_ENDPOINTS[region];
  if (provider.type === 'temporal') return DEFAULT_TEMPORAL_ENDPOINTS[region];
  throw new Error(`Unsupported Solana SWQoS provider: ${provider.type}`);
}

function resolveEnabledProviders(config: SolanaSwqosSettings | undefined): SolanaSwqosProviderSettings[] {
  if (!config?.enabled) return [];
  return (config.providers ?? [])
    .filter((provider) => provider.enabled)
    .slice()
    .sort((left, right) => (right.weight ?? 1) - (left.weight ?? 1));
}

async function postJson(input: {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(input.headers ?? {}),
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function submitViaProvider(input: {
  provider: SolanaSwqosProviderSettings;
  transaction: VersionedTransaction;
  timeoutMs: number;
  region: SolanaSwqosRegion;
}): Promise<SolanaBroadcastResult> {
  const endpoint = resolveProviderEndpoint(input.provider, input.region);
  const transactionBase64 = getSerializedTransactionBase64(input.transaction);
  const txHash = getLocalTransactionSignature(input.transaction);
  reportPumpSwapBroadcastDebug('broadcast.ts:submitViaProvider:start', '[DEBUG] pumpswap broadcast provider start', {
    providerType: input.provider.type,
    endpoint,
    timeoutMs: input.timeoutMs,
    region: input.region,
    txHash,
  });

  if (input.provider.type === 'jito') {
    const url = `${endpoint}/api/v1/transactions${input.provider.authKey ? `?uuid=${encodeURIComponent(input.provider.authKey)}` : ''}`;
    await postJson({
      url,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { 'x-jito-auth': input.provider.authKey } : undefined,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transactionBase64,
          { encoding: 'base64' },
        ],
      },
    });
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaProvider:done', '[DEBUG] pumpswap broadcast provider done', {
      providerType: input.provider.type,
      endpoint,
      txHash,
    });
    return {
      txHash,
      broadcastVia: 'jito',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'nextblock') {
    await postJson({
      url: `${endpoint}/api/v2/submit`,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { Authorization: input.provider.authKey } : undefined,
      body: {
        transaction: {
          content: transactionBase64,
        },
        frontRunningProtection: false,
      },
    });
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaProvider:done', '[DEBUG] pumpswap broadcast provider done', {
      providerType: input.provider.type,
      endpoint,
      txHash,
    });
    return {
      txHash,
      broadcastVia: 'nextblock',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'blox') {
    await postJson({
      url: `${endpoint}/api/v2/submit`,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { Authorization: input.provider.authKey } : undefined,
      body: {
        transaction: {
          content: transactionBase64,
        },
        frontRunningProtection: false,
        useStakedRPCs: true,
      },
    });
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaProvider:done', '[DEBUG] pumpswap broadcast provider done', {
      providerType: input.provider.type,
      endpoint,
      txHash,
    });
    return {
      txHash,
      broadcastVia: 'blox',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'temporal') {
    const temporalUrl = `${endpoint}/?c=${encodeURIComponent(input.provider.authKey ?? '')}`;
    await postJson({
      url: temporalUrl,
      timeoutMs: input.timeoutMs,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transactionBase64,
          { encoding: 'base64' },
        ],
      },
    });
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaProvider:done', '[DEBUG] pumpswap broadcast provider done', {
      providerType: input.provider.type,
      endpoint,
      txHash,
    });
    return {
      txHash,
      broadcastVia: 'temporal',
      broadcastUrl: endpoint,
    };
  }

  throw new Error(`Unsupported Solana SWQoS provider: ${input.provider.type}`);
}

async function submitViaRpc(input: {
  transaction: VersionedTransaction;
  txSide?: 'buy' | 'sell';
  submitChannel?: SubmitChannel;
  executionMode?: 'default' | 'turbo';
}): Promise<SolanaBroadcastResult> {
  const submitStartedAt = Date.now();
  const skipPreflight = input.executionMode === 'turbo'
    && (
      input.submitChannel === 'protectRpcs'
      || input.submitChannel === 'mixed'
      || input.submitChannel === 'blockrazor'
    );
  const urls = await SolanaRpcService.getSubmitRpcUrls({
    txSide: input.txSide,
    submitChannel: input.submitChannel,
  });
  const serialized = input.transaction.serialize();
  const attempts = urls.map(async (url) => {
    const attemptStartedAt = Date.now();
    try {
      const connection = SolanaRpcService.getConnectionForUrl(url);
      const signature = await connection.sendRawTransaction(serialized, {
        skipPreflight,
        preflightCommitment: 'confirmed',
      });
      reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:attemptDone', '[DEBUG] pumpswap rpc submit attempt done', {
        submitChannel: input.submitChannel ?? null,
        txSide: input.txSide ?? null,
        executionMode: input.executionMode ?? null,
        skipPreflight,
        url,
        signature,
      });
      return { signature, url };
    } catch (error: any) {
      const errorMessage = String(error?.message || error || '');
      const errorCode = error?.code ?? error?.cause?.code ?? error?.statusCode ?? error?.response?.status ?? null;
      const httpStatus = error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? null;
      reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:attemptError', '[DEBUG] pumpswap rpc submit attempt failed', {
        submitChannel: input.submitChannel ?? null,
        txSide: input.txSide ?? null,
        executionMode: input.executionMode ?? null,
        skipPreflight,
        url,
        errorName: String(error?.name || ''),
        errorMessage,
      });
      throw error;
    }
  });
  let winner: Awaited<typeof attempts[number]>;
  try {
    winner = await Promise.any(attempts);
  } catch (error: any) {
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:anyError', '[DEBUG] pumpswap rpc submit all attempts rejected', {
      submitChannel: input.submitChannel ?? null,
      txSide: input.txSide ?? null,
      executionMode: input.executionMode ?? null,
      skipPreflight,
      urls,
      errorName: String(error?.name || ''),
      errorMessage: String(error?.message || error || ''),
      errors: Array.isArray(error?.errors)
        ? error.errors.map((item: any) => String(item?.message || item || ''))
        : [],
    });
    throw error;
  }
  await RpcReadBalancer.recordBusinessSuccess({
    chainId: ChainId.SOL,
    url: winner.url,
    elapsedMs: Date.now() - submitStartedAt,
  });
  return {
    txHash: winner.signature,
    broadcastVia: 'rpc',
    broadcastUrl: winner.url,
  };
}

async function submitViaSwqos(transaction: VersionedTransaction): Promise<SolanaBroadcastResult> {
  const settings = await SettingsService.get();
  const config = settings.chains?.[ChainId.SOL]?.solanaSwqos;
  const providers = resolveEnabledProviders(config);
  if (providers.length === 0) {
    throw new Error('No enabled Solana SWQoS providers configured');
  }

  const timeoutMs = Math.max(1000, Number(config?.timeoutMs ?? 10_000));
  const region = (config?.region ?? 'default') as SolanaSwqosRegion;
  const strategy = config?.strategy ?? 'concurrent';

  if (strategy === 'single') {
    let lastError: unknown;
    for (const provider of providers) {
      try {
        return await submitViaProvider({
          provider,
          transaction,
          timeoutMs,
          region,
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('All Solana SWQoS providers failed');
  }

  const attempts = providers.map((provider) => submitViaProvider({
    provider,
    transaction,
    timeoutMs,
    region,
  }).catch((error: any) => {
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaSwqos:providerError', '[DEBUG] pumpswap swqos provider failed', {
      providerType: provider.type,
      endpoint: resolveProviderEndpoint(provider, region),
      timeoutMs,
      region,
      errorName: String(error?.name || ''),
      errorMessage: String(error?.message || error || ''),
    });
    throw error;
  }));

  try {
    return await Promise.any(attempts);
  } catch (error: any) {
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaSwqos:anyError', '[DEBUG] pumpswap swqos all providers failed', {
      providerTypes: providers.map((provider) => provider.type),
      strategy,
      timeoutMs,
      region,
      errorName: String(error?.name || ''),
      errorMessage: String(error?.message || error || ''),
      errors: Array.isArray(error?.errors)
        ? error.errors.map((item: any) => String(item?.message || item || ''))
        : [],
    });
    throw new Error('All Solana SWQoS providers failed');
  }
}

async function resolveBroadcastStrategy(): Promise<{
  primary: 'swqos' | 'rpc';
  fallback: 'swqos' | 'rpc' | null;
  swqosEnabled: boolean;
  swqosConfigured: boolean;
}> {
  const settings = await SettingsService.get();
  const config = settings.chains?.[ChainId.SOL]?.solanaSwqos;
  const swqosEnabled = !!config?.enabled;
  const swqosConfigured = resolveEnabledProviders(config).length > 0;
  if (swqosEnabled && swqosConfigured) {
    return {
      primary: 'swqos',
      fallback: 'rpc',
      swqosEnabled,
      swqosConfigured,
    };
  }
  return {
    primary: 'rpc',
    fallback: null,
    swqosEnabled,
    swqosConfigured,
  };
}

export class SolanaBroadcastService {
  static async sendSignedTransaction(input: {
    transaction: VersionedTransaction;
    txSide?: 'buy' | 'sell';
    submitChannel?: SubmitChannel;
    executionMode?: 'default' | 'turbo';
  }): Promise<SolanaBroadcastResult> {
    const startedAt = Date.now();
    const strategy = await resolveBroadcastStrategy();
    if (strategy.primary === 'rpc') {
      const rpcResult = await submitViaRpc(input);
      return rpcResult;
    }
    try {
      const swqosResult = await submitViaSwqos(input.transaction);
      return swqosResult;
    } catch (error: any) {
      if (strategy.fallback !== 'rpc') throw error;
      const rpcResult = await submitViaRpc(input);
      return rpcResult;
    }
  }
}
