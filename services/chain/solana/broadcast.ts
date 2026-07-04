import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { ChainId } from '@/constants/chains/chainId';
import { RpcReadBalancer } from '@/services/rpcReadBalancer';
import { SettingsService } from '@/services/settings';
import type { SolanaFeeMode, SubmitChannel } from '@/types/extention';
import type { SolanaSwqosProviderSettings, SolanaSwqosRegion, SolanaSwqosSettings } from '@/types/extention';
import type { VersionedTransaction } from '@solana/web3.js';
import { SolanaRpcService } from './rpc';

type SolanaBroadcastResult = {
  txHash: string;
  broadcastVia: string;
  broadcastUrl?: string;
  isBundle?: boolean;
};

export type SolanaSwqosProbeResult = {
  ok: true;
  status: 'reachable' | 'failed';
  category:
    | 'ok'
    | 'auth_required'
    | 'auth_failed'
    | 'bad_endpoint'
    | 'rate_limited'
    | 'payload_rejected'
    | 'server_error'
    | 'timeout'
    | 'network_error';
  providerType: SolanaSwqosProviderSettings['type'];
  endpoint: string;
  submitUrl: string;
  httpStatus?: number;
  message?: string;
  hasAuthKey: boolean;
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

const DEFAULT_ZEROSLOT_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://de.0slot.trade',
  newyork: 'http://ny.0slot.trade',
  frankfurt: 'http://de.0slot.trade',
  amsterdam: 'http://ams.0slot.trade',
  slc: 'http://ny.0slot.trade',
  tokyo: 'http://jp.0slot.trade',
  london: 'http://ams.0slot.trade',
  losangeles: 'http://la.0slot.trade',
};

const DEFAULT_NODE1_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://fra.node1.me',
  newyork: 'http://ny.node1.me',
  frankfurt: 'http://fra.node1.me',
  amsterdam: 'http://ams.node1.me',
  slc: 'http://ny.node1.me',
  tokyo: 'http://fra.node1.me',
  london: 'http://ams.node1.me',
  losangeles: 'http://ny.node1.me',
};

const DEFAULT_FLASHBLOCK_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://ny.flashblock.trade',
  newyork: 'http://ny.flashblock.trade',
  frankfurt: 'http://fra.flashblock.trade',
  amsterdam: 'http://ams.flashblock.trade',
  slc: 'http://slc.flashblock.trade',
  tokyo: 'http://singapore.flashblock.trade',
  london: 'http://london.flashblock.trade',
  losangeles: 'http://ny.flashblock.trade',
};

const DEFAULT_BLOCKRAZOR_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://frankfurt.solana.blockrazor.xyz:443/sendTransaction',
  newyork: 'http://newyork.solana.blockrazor.xyz:443/sendTransaction',
  frankfurt: 'http://frankfurt.solana.blockrazor.xyz:443/sendTransaction',
  amsterdam: 'http://amsterdam.solana.blockrazor.xyz:443/sendTransaction',
  slc: 'http://newyork.solana.blockrazor.xyz:443/sendTransaction',
  tokyo: 'http://tokyo.solana.blockrazor.xyz:443/sendTransaction',
  london: 'http://frankfurt.solana.blockrazor.xyz:443/sendTransaction',
  losangeles: 'http://newyork.solana.blockrazor.xyz:443/sendTransaction',
};

const DEFAULT_ASTRALANE_ENDPOINTS: Record<SolanaSwqosRegion, string> = {
  default: 'http://lim.gateway.astralane.io/iris',
  newyork: 'http://ny.gateway.astralane.io/iris',
  frankfurt: 'http://fr.gateway.astralane.io/iris',
  amsterdam: 'http://ams.gateway.astralane.io/iris',
  slc: 'http://ny.gateway.astralane.io/iris',
  tokyo: 'http://jp.gateway.astralane.io/iris',
  london: 'http://ny.gateway.astralane.io/iris',
  losangeles: 'http://lax.gateway.astralane.io/iris',
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
  if (provider.type === 'zeroslot') return DEFAULT_ZEROSLOT_ENDPOINTS[region];
  if (provider.type === 'node1') return DEFAULT_NODE1_ENDPOINTS[region];
  if (provider.type === 'flashblock') return DEFAULT_FLASHBLOCK_ENDPOINTS[region];
  if (provider.type === 'blockrazor') return DEFAULT_BLOCKRAZOR_ENDPOINTS[region];
  if (provider.type === 'astralane') return DEFAULT_ASTRALANE_ENDPOINTS[region];
  throw new Error(`Unsupported Solana SWQoS provider: ${provider.type}`);
}

function ensureEndpointSuffix(endpoint: string, suffix: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

function resolveProviderSubmitUrl(provider: SolanaSwqosProviderSettings, endpoint: string): string {
  if (provider.type === 'nextblock') return ensureEndpointSuffix(endpoint, '/api/v2/submit');
  if (provider.type === 'blox') return ensureEndpointSuffix(endpoint, '/api/v2/submit');
  if (provider.type === 'flashblock') return ensureEndpointSuffix(endpoint, '/api/v2/submit-batch');
  if (provider.type === 'blockrazor') return ensureEndpointSuffix(endpoint, '/sendTransaction');
  if (provider.type === 'astralane') return ensureEndpointSuffix(endpoint, '/iris');
  return endpoint.trim().replace(/\/+$/, '');
}

function resolveEnabledProviders(config: SolanaSwqosSettings | undefined): SolanaSwqosProviderSettings[] {
  if (!config?.enabled) return [];
  return (config.providers ?? [])
    .filter((provider) => provider.enabled)
    .slice()
    .sort((left, right) => (right.weight ?? 1) - (left.weight ?? 1));
}

type JsonPostResult = {
  status: number;
  text: string;
  json: any | null;
};

async function postJson(input: {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<JsonPostResult> {
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
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    let json: any | null = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      text,
      json,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function rawPost(input: {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): Promise<{ status: number; text: string }> {
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
    return {
      status: response.status,
      text: await response.text(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function truncateProbeMessage(input: string, maxLength = 220): string {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function classifyProbeHttpResponse(input: {
  status: number;
  text: string;
  hasAuthKey: boolean;
}): SolanaSwqosProbeResult['category'] {
  const status = Number(input.status || 0);
  const text = String(input.text || '').toLowerCase();
  if (status === 401) return input.hasAuthKey ? 'auth_failed' : 'auth_required';
  if (status === 403) return input.hasAuthKey ? 'auth_failed' : 'auth_required';
  if (status === 404) return 'bad_endpoint';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (
    text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('invalid api key')
    || text.includes('missing api key')
    || text.includes('invalid auth')
    || text.includes('authentication')
  ) {
    return input.hasAuthKey ? 'auth_failed' : 'auth_required';
  }
  if (
    text.includes('invalid transaction')
    || text.includes('failed to deserialize')
    || text.includes('base64')
    || text.includes('invalid params')
    || text.includes('invalid param')
    || text.includes('invalid request')
    || text.includes('bad request')
    || text.includes('signature verification failure')
    || text.includes('signature verification failed')
  ) {
    return 'payload_rejected';
  }
  return 'ok';
}

function classifyProbeError(error: unknown): SolanaSwqosProbeResult['category'] {
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (message.includes('aborted') || message.includes('timeout')) return 'timeout';
  return 'network_error';
}

function extractProviderErrorMessage(payload: any): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload?.error === 'string') return payload.error;
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.result?.message === 'string') return payload.result.message;
  if (typeof payload?.error?.message === 'string') return payload.error.message;
  return '';
}

function looksLikeProviderFailureMessage(input: string): boolean {
  const text = String(input || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('error')
    || text.includes('failed')
    || text.includes('failure')
    || text.includes('rejected')
    || text.includes('invalid')
    || text.includes('unauthorized')
    || text.includes('forbidden')
    || text.includes('denied')
    || text.includes('bad request')
    || text.includes('not found')
    || text.includes('deserialize')
    || text.includes('signature verification')
  );
}

function ensureProviderSubmissionAccepted(providerType: SolanaSwqosProviderSettings['type'], result: JsonPostResult): void {
  const payload = result.json;
  if (!payload) {
    throw new Error(`${providerType} returned non-JSON response: ${result.text || `HTTP ${result.status}`}`);
  }
  const errorMessage = extractProviderErrorMessage(payload);
  if (payload?.error) {
    throw new Error(`${providerType} submission rejected: ${errorMessage || JSON.stringify(payload.error)}`);
  }
  const hasExplicitSuccess =
    providerType === 'blox'
      ? typeof payload?.signature === 'string' && !!payload.signature.trim()
      : providerType === 'blockrazor'
        ? !!(payload?.result || payload?.signature)
        : providerType === 'flashblock'
          ? payload?.success === true || !!payload?.result
          : !!payload?.result;
  if (hasExplicitSuccess) {
    return;
  }
  if (looksLikeProviderFailureMessage(errorMessage)) {
    throw new Error(`${providerType} submission rejected: ${errorMessage}`);
  }
}

function buildProviderProbeRequest(input: {
  provider: SolanaSwqosProviderSettings;
  submitUrl: string;
}): {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
} {
  const { provider, submitUrl } = input;
  const authKey = String(provider.authKey || '').trim();
  const probeTx = 'dagobang-swqos-probe';
  if (provider.type === 'jito') {
    return {
      url: `${submitUrl}/api/v1/transactions${authKey ? `?uuid=${encodeURIComponent(authKey)}` : ''}`,
      headers: authKey ? { 'x-jito-auth': authKey } : undefined,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [probeTx, { encoding: 'base64' }],
      },
    };
  }
  if (provider.type === 'nextblock') {
    return {
      url: submitUrl,
      headers: authKey ? { Authorization: authKey } : undefined,
      body: {
        transaction: { content: probeTx },
        frontRunningProtection: false,
      },
    };
  }
  if (provider.type === 'blox') {
    return {
      url: submitUrl,
      headers: authKey ? { Authorization: authKey } : undefined,
      body: {
        transaction: { content: probeTx },
        useStakedRPCs: true,
      },
    };
  }
  if (provider.type === 'temporal') {
    return {
      url: `${submitUrl}/?c=${encodeURIComponent(authKey)}`,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [probeTx, { encoding: 'base64' }],
      },
    };
  }
  if (provider.type === 'zeroslot') {
    return {
      url: `${submitUrl}/?api-key=${encodeURIComponent(authKey)}`,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [probeTx, { encoding: 'base64', skipPreflight: true }],
      },
    };
  }
  if (provider.type === 'node1') {
    return {
      url: submitUrl,
      headers: authKey ? { 'api-key': authKey } : undefined,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [probeTx, { encoding: 'base64', skipPreflight: true }],
      },
    };
  }
  if (provider.type === 'flashblock') {
    return {
      url: submitUrl,
      headers: {
        ...(authKey ? { Authorization: authKey } : {}),
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=30, max=1000',
      },
      body: {
        transactions: [probeTx],
      },
    };
  }
  if (provider.type === 'blockrazor') {
    return {
      url: submitUrl,
      headers: authKey ? { apikey: authKey } : undefined,
      body: {
        transaction: probeTx,
        mode: 'fast',
      },
    };
  }
  if (provider.type === 'astralane') {
    return {
      url: submitUrl,
      headers: authKey ? { api_key: authKey } : undefined,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          probeTx,
          { encoding: 'base64', skipPreflight: true },
          { mevProtect: false },
        ],
      },
    };
  }
  throw new Error(`Unsupported Solana SWQoS provider: ${provider.type}`);
}

async function submitViaProvider(input: {
  provider: SolanaSwqosProviderSettings;
  transaction: VersionedTransaction;
  timeoutMs: number;
  region: SolanaSwqosRegion;
}): Promise<SolanaBroadcastResult> {
  const endpoint = resolveProviderEndpoint(input.provider, input.region);
  const submitUrl = resolveProviderSubmitUrl(input.provider, endpoint);
  const transactionBase64 = getSerializedTransactionBase64(input.transaction);
  const txHash = getLocalTransactionSignature(input.transaction);
  reportPumpSwapBroadcastDebug('broadcast.ts:submitViaProvider:start', '[DEBUG] pumpswap broadcast provider start', {
    providerType: input.provider.type,
    endpoint,
    submitUrl,
    timeoutMs: input.timeoutMs,
    region: input.region,
    txHash,
  });

  if (input.provider.type === 'jito') {
    const url = `${submitUrl}/api/v1/transactions${input.provider.authKey ? `?uuid=${encodeURIComponent(input.provider.authKey)}` : ''}`;
    const response = await postJson({
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
    ensureProviderSubmissionAccepted(input.provider.type, response);
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
    const response = await postJson({
      url: submitUrl,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { Authorization: input.provider.authKey } : undefined,
      body: {
        transaction: {
          content: transactionBase64,
        },
        frontRunningProtection: false,
      },
    });
    ensureProviderSubmissionAccepted(input.provider.type, response);
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
    const response = await postJson({
      url: submitUrl,
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
    ensureProviderSubmissionAccepted(input.provider.type, response);
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
    const temporalUrl = `${submitUrl}/?c=${encodeURIComponent(input.provider.authKey ?? '')}`;
    const response = await postJson({
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
    ensureProviderSubmissionAccepted(input.provider.type, response);
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

  if (input.provider.type === 'zeroslot') {
    const zeroSlotUrl = `${submitUrl}/?api-key=${encodeURIComponent(input.provider.authKey ?? '')}`;
    const response = await postJson({
      url: zeroSlotUrl,
      timeoutMs: input.timeoutMs,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transactionBase64,
          { encoding: 'base64', skipPreflight: true },
        ],
      },
    });
    ensureProviderSubmissionAccepted(input.provider.type, response);
    return {
      txHash,
      broadcastVia: 'zeroslot',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'node1') {
    const response = await postJson({
      url: submitUrl,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { 'api-key': input.provider.authKey } : undefined,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transactionBase64,
          { encoding: 'base64', skipPreflight: true },
        ],
      },
    });
    ensureProviderSubmissionAccepted(input.provider.type, response);
    return {
      txHash,
      broadcastVia: 'node1',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'flashblock') {
    const response = await postJson({
      url: submitUrl,
      timeoutMs: input.timeoutMs,
      headers: {
        ...(input.provider.authKey ? { Authorization: input.provider.authKey } : {}),
        Connection: 'keep-alive',
        'Keep-Alive': 'timeout=30, max=1000',
      },
      body: {
        transactions: [transactionBase64],
      },
    });
    ensureProviderSubmissionAccepted(input.provider.type, response);
    return {
      txHash,
      broadcastVia: 'flashblock',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'blockrazor') {
    const response = await postJson({
      url: submitUrl,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { apikey: input.provider.authKey } : undefined,
      body: {
        transaction: transactionBase64,
        mode: 'fast',
      },
    });
    ensureProviderSubmissionAccepted(input.provider.type, response);
    return {
      txHash,
      broadcastVia: 'blockrazor',
      broadcastUrl: endpoint,
    };
  }

  if (input.provider.type === 'astralane') {
    const response = await postJson({
      url: submitUrl,
      timeoutMs: input.timeoutMs,
      headers: input.provider.authKey ? { api_key: input.provider.authKey } : undefined,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          transactionBase64,
          { encoding: 'base64', skipPreflight: true },
          { mevProtect: false },
        ],
      },
    });
    ensureProviderSubmissionAccepted(input.provider.type, response);
    return {
      txHash,
      broadcastVia: 'astralane',
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
  const effectiveSubmitChannel = await SolanaRpcService.getResolvedSubmitChannel(input.submitChannel);
  const skipPreflight = input.executionMode === 'turbo'
    && (
      effectiveSubmitChannel === 'protectRpcs'
      || effectiveSubmitChannel === 'mixed'
      || effectiveSubmitChannel === 'blockrazor'
    );
  const serialized = input.transaction.serialize();
  const attemptSubmit = async (urls: string[]) => {
    const attempts = urls.map(async (url) => {
      try {
        const connection = SolanaRpcService.getConnectionForUrl(url);
        const signature = await connection.sendRawTransaction(serialized, {
          skipPreflight,
          preflightCommitment: 'confirmed',
        });
        reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:attemptDone', '[DEBUG] pumpswap rpc submit attempt done', {
          submitChannel: effectiveSubmitChannel,
          txSide: input.txSide ?? null,
          executionMode: input.executionMode ?? null,
          skipPreflight,
          url,
          signature,
        });
        return { signature, url };
      } catch (error: any) {
        const errorMessage = String(error?.message || error || '');
        reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:attemptError', '[DEBUG] pumpswap rpc submit attempt failed', {
          submitChannel: effectiveSubmitChannel,
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
    try {
      return await Promise.any(attempts);
    } catch (error: any) {
      reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:anyError', '[DEBUG] pumpswap rpc submit all attempts rejected', {
        submitChannel: effectiveSubmitChannel,
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
      if (Array.isArray(error?.errors) && error.errors.length === 1) {
        throw error.errors[0] instanceof Error ? error.errors[0] : new Error(String(error.errors[0] || 'Solana RPC submit failed'));
      }
      throw error;
    }
  };
  const urls = await SolanaRpcService.getSubmitRpcUrls({
    txSide: input.txSide,
    submitChannel: effectiveSubmitChannel,
  });
  let winner: Awaited<ReturnType<typeof attemptSubmit>>;
  try {
    winner = await attemptSubmit(urls);
  } catch (error: any) {
    const fallbackUrls = await SolanaRpcService.getSubmitRpcUrls({
      txSide: input.txSide,
      submitChannel: effectiveSubmitChannel,
      scope: 'public',
    });
    const fallbackCandidates = fallbackUrls.filter((url) => !urls.includes(url));
    const shouldFallbackToPublic =
      (effectiveSubmitChannel === 'protectRpcs' || effectiveSubmitChannel === 'mixed' || effectiveSubmitChannel === 'blockrazor')
      && fallbackCandidates.length > 0;
    if (!shouldFallbackToPublic) throw error;
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaRpc:publicFallback', '[DEBUG] pumpswap rpc submit fallback to public rpc', {
      submitChannel: effectiveSubmitChannel,
      txSide: input.txSide ?? null,
      executionMode: input.executionMode ?? null,
      skipPreflight,
      primaryUrls: urls,
      fallbackUrls: fallbackCandidates,
      errorName: String(error?.name || ''),
      errorMessage: String(error?.message || error || ''),
    });
    winner = await attemptSubmit(fallbackCandidates);
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
    const providerErrors = Array.isArray(error?.errors) ? error.errors : [];
    reportPumpSwapBroadcastDebug('broadcast.ts:submitViaSwqos:anyError', '[DEBUG] pumpswap swqos all providers failed', {
      providerTypes: providers.map((provider) => provider.type),
      strategy,
      timeoutMs,
      region,
      errorName: String(error?.name || ''),
      errorMessage: String(error?.message || error || ''),
      errors: providerErrors
        ? providerErrors.map((item: any) => String(item?.message || item || ''))
        : [],
    });
    if (providerErrors.length === 1) {
      throw providerErrors[0] instanceof Error ? providerErrors[0] : new Error(String(providerErrors[0] || 'Solana SWQoS provider failed'));
    }
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

function requiresSwqosForSolanaFeeMode(mode: SolanaFeeMode | undefined): boolean {
  return mode === 'tip' || mode === 'pf_and_tip';
}

export class SolanaBroadcastService {
  static async probeProvider(input: {
    provider: SolanaSwqosProviderSettings;
    region: SolanaSwqosRegion;
    timeoutMs?: number;
  }): Promise<SolanaSwqosProbeResult> {
    const endpoint = resolveProviderEndpoint(input.provider, input.region);
    const submitUrl = resolveProviderSubmitUrl(input.provider, endpoint);
    const timeoutMs = Math.max(1000, Number(input.timeoutMs ?? 5000));
    const hasAuthKey = !!String(input.provider.authKey || '').trim();
    try {
      const request = buildProviderProbeRequest({
        provider: input.provider,
        submitUrl,
      });
      const response = await rawPost({
        url: request.url,
        headers: request.headers,
        body: request.body,
        timeoutMs,
      });
      const message = truncateProbeMessage(response.text);
      const category = classifyProbeHttpResponse({
        status: response.status,
        text: response.text,
        hasAuthKey,
      });
      return {
        ok: true,
        status: category === 'ok' || category === 'payload_rejected' || category === 'auth_required' || category === 'auth_failed' || category === 'rate_limited'
          ? 'reachable'
          : 'failed',
        category,
        providerType: input.provider.type,
        endpoint,
        submitUrl,
        httpStatus: response.status,
        message,
        hasAuthKey,
      };
    } catch (error: any) {
      return {
        ok: true,
        status: 'failed',
        category: classifyProbeError(error),
        providerType: input.provider.type,
        endpoint,
        submitUrl,
        message: String(error?.message || error || 'probe failed'),
        hasAuthKey,
      };
    }
  }

  static async sendSignedTransaction(input: {
    transaction: VersionedTransaction;
    txSide?: 'buy' | 'sell';
    submitChannel?: SubmitChannel;
    solanaFeeMode?: SolanaFeeMode;
    executionMode?: 'default' | 'turbo';
  }): Promise<SolanaBroadcastResult> {
    const startedAt = Date.now();
    const strategy = await resolveBroadcastStrategy();
    const solanaFeeMode = input.solanaFeeMode ?? 'pf';
    const swqosRequired = requiresSwqosForSolanaFeeMode(solanaFeeMode);
    if (swqosRequired) {
      if (!strategy.swqosEnabled) {
        throw new Error('Solana Tip requires SWQoS channel to be enabled');
      }
      if (!strategy.swqosConfigured) {
        throw new Error('Solana Tip requires at least one configured SWQoS provider');
      }
      if (strategy.primary !== 'swqos') {
        throw new Error('Solana Tip requires SWQoS as the active submit path');
      }
    }
    if (strategy.primary === 'rpc') {
      const rpcResult = await submitViaRpc(input);
      return rpcResult;
    }
    try {
      const swqosResult = await submitViaSwqos(input.transaction);
      return swqosResult;
    } catch (error: any) {
      if (swqosRequired || strategy.fallback !== 'rpc') throw error;
      const rpcResult = await submitViaRpc(input);
      return rpcResult;
    }
  }
}
