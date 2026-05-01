import { decodeAbiParameters } from 'viem';
import { RpcService } from '../rpc';
import type { ChainSettings, GasPreset } from '../../types/extention';
import { classifyBroadcastError, collectErrorText, extractNextNonceHintFromText, getNonceErrorKindFromText } from '../../utils/txErrorClassify';
import { parseGweiToWei } from '../../utils/dexUtils';
import { getChainRuntime } from '@/constants/chains';

export function getGasPriceWei(chainSettings: ChainSettings, preset: GasPreset, side: 'buy' | 'sell'): bigint {
  const baseConfig = side === 'buy' ? chainSettings.buyGasGwei : chainSettings.sellGasGwei;
  const fallbackConfig = {
    slow: '0.06',
    standard: '0.12',
    fast: '1',
    turbo: '5',
  };
  const cfg = baseConfig || fallbackConfig;
  let value = cfg.standard;
  if (preset === 'slow') value = cfg.slow;
  else if (preset === 'fast') value = cfg.fast;
  else if (preset === 'turbo') value = cfg.turbo;
  const wei = parseGweiToWei(value);
  if (wei <= 0n) {
    return parseGweiToWei(fallbackConfig.standard);
  }
  return wei;
}

function scoreRevertReason(reason: string) {
  const r = reason.toLowerCase();
  let v = 0;
  if (/^0x[0-9a-f]*$/i.test(reason)) v -= 120;
  if (r.includes('zero_input')) v -= 80;
  if (r.includes('insufficient allowance') || r.includes('allowance')) v += 200;
  if (r.includes('insufficient balance') || r.includes('balance')) v += 120;
  if (r.includes('transfer') || r.includes('transferfrom')) v += 80;
  if (r.includes('slippage') || r.includes('min') || r.includes('amount')) v += 20;
  if (/^[A-Z0-9_]{3,}$/.test(reason)) v -= 30;
  if (reason.includes('0x') && reason.length > 60) v -= 40;
  v += Math.min(30, Math.floor(reason.length / 10));
  return v;
}

function decodeRevertDataToReason(data: any) {
  if (typeof data !== 'string') return null;
  const hex = data.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex === '0x' || hex.length < 10) return null;
  const sel = hex.slice(0, 10).toLowerCase();
  if (sel === '0x08c379a0') {
    const body = (`0x${hex.slice(10)}`) as `0x${string}`;
    try {
      const [msg] = decodeAbiParameters([{ type: 'string' }], body);
      return typeof msg === 'string' && msg.trim() ? msg.trim() : null;
    } catch {
      return null;
    }
  }
  if (sel === '0x4e487b71') {
    const body = (`0x${hex.slice(10)}`) as `0x${string}`;
    try {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], body);
      const n = typeof code === 'bigint' ? code : BigInt(code as any);
      const key = `0x${n.toString(16)}`;
      return `Panic(${key})`;
    } catch {
      return null;
    }
  }
  return null;
}

function extractRevertReasonFromError(e: any) {
  const texts: string[] = [];
  const push = (s: any) => {
    if (typeof s !== 'string') return;
    const t = s.trim();
    if (!t) return;
    texts.push(t);
  };

  if (Array.isArray(e?.metaMessages)) {
    for (const x of e.metaMessages) push(x);
  }
  push(e?.details);
  push(e?.shortMessage);
  push(e?.message);
  push(e?.data);
  push(e?.cause?.data);
  push(e?.cause?.message);

  const reasons: string[] = [];
  const patterns = [
    /Fail with error\s+'([^']+)'/i,
    /reverted with reason string\s+'([^']+)'/i,
    /execution reverted(?::\s*([^\n]+))?/i,
    /revert(?:ed)?(?::\s*([^\n]+))?/i,
  ];

  for (const t of texts) {
    const direct = decodeRevertDataToReason(t);
    if (direct) reasons.push(direct);

    const hexes = t.match(/0x[0-9a-fA-F]{8,}/g) ?? [];
    for (const h of hexes) {
      const decoded = decodeRevertDataToReason(h);
      if (decoded) reasons.push(decoded);
    }

    for (const re of patterns) {
      const m = re.exec(t);
      if (!m) continue;
      const g = (m[1] ?? '').trim();
      if (g && !/^0x[0-9a-f]*$/i.test(g)) reasons.push(g);
    }
  }

  if (!reasons.length) return null;
  let best = reasons[0];
  let bestScore = scoreRevertReason(best);
  for (const r of reasons.slice(1)) {
    const s = scoreRevertReason(r);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

const nonceLocked = new Set<string>();
const nonceLockQueue = new Map<string, Array<() => void>>();
const nonceState = new Map<string, { nextNonce: number; ts: number }>();
const NONCE_CACHE_WINDOW_MS = 300_000;
const txFlowLocked = new Set<string>();
const txFlowQueue = new Map<string, Array<() => void>>();

async function acquireNonceLock(key: string): Promise<() => void> {
  if (!nonceLocked.has(key)) {
    nonceLocked.add(key);
    return () => releaseNonceLock(key);
  }
  return await new Promise<() => void>((resolve) => {
    const q = nonceLockQueue.get(key) ?? [];
    q.push(() => resolve(() => releaseNonceLock(key)));
    nonceLockQueue.set(key, q);
  });
}

function releaseNonceLock(key: string) {
  const q = nonceLockQueue.get(key);
  if (!q || q.length === 0) {
    nonceLocked.delete(key);
    nonceLockQueue.delete(key);
    return;
  }
  const next = q.shift();
  if (next) next();
  if (q.length === 0) {
    nonceLockQueue.delete(key);
  } else {
    nonceLockQueue.set(key, q);
  }
}

async function acquireTxFlowLock(key: string): Promise<() => void> {
  if (!txFlowLocked.has(key)) {
    txFlowLocked.add(key);
    return () => releaseTxFlowLock(key);
  }
  return await new Promise<() => void>((resolve) => {
    const q = txFlowQueue.get(key) ?? [];
    q.push(() => resolve(() => releaseTxFlowLock(key)));
    txFlowQueue.set(key, q);
  });
}

function releaseTxFlowLock(key: string) {
  const q = txFlowQueue.get(key);
  if (!q || q.length === 0) {
    txFlowLocked.delete(key);
    txFlowQueue.delete(key);
    return;
  }
  const next = q.shift();
  if (next) next();
  if (q.length === 0) {
    txFlowQueue.delete(key);
  } else {
    txFlowQueue.set(key, q);
  }
}

async function reserveNonce(client: any, chainId: number, address: `0x${string}`): Promise<number> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const release = await acquireNonceLock(key);
  try {
    const now = Date.now();
    const state = nonceState.get(key);
    if (state && now - state.ts < NONCE_CACHE_WINDOW_MS) {
      const nonce = state.nextNonce;
      state.nextNonce += 1;
      state.ts = now;
      nonceState.set(key, state);
      return nonce;
    }
    const nonce = await client.getTransactionCount({ address, blockTag: 'pending' });
    nonceState.set(key, { nextNonce: nonce + 1, ts: now });
    return nonce;
  } finally {
    release();
  }
}

export async function prewarmNonce(
  client: any,
  chainId: number,
  address: `0x${string}`,
  opts?: { force?: boolean }
): Promise<number> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const release = await acquireNonceLock(key);
  try {
    const now = Date.now();
    const state = nonceState.get(key);
    if (!opts?.force && state && now - state.ts < NONCE_CACHE_WINDOW_MS) {
      // Sliding expiration: page-level prewarm keeps hot nonce cache alive.
      state.ts = now;
      nonceState.set(key, state);
      return state.nextNonce;
    }
    const pendingNonce = await client.getTransactionCount({ address, blockTag: 'pending' });
    let nextNonce = pendingNonce;
    if (opts?.force) {
      try {
        const observed = await RpcService.getObservedPendingNonce({
          chainId,
          address,
          prefer: 'max',
          scope: 'both',
        });
        if (observed != null && observed > nextNonce) {
          nextNonce = observed;
        }
      } catch {
      }
    }
    nonceState.set(key, { nextNonce, ts: now });
    return nextNonce;
  } finally {
    release();
  }
}

function clearNonceState(chainId: number, address: `0x${string}`) {
  const key = `${chainId}:${address.toLowerCase()}`;
  nonceState.delete(key);
}

function setNextNonceAtLeast(chainId: number, address: `0x${string}`, nextNonce: number) {
  const key = `${chainId}:${address.toLowerCase()}`;
  const state = nonceState.get(key);
  const safeNext = Math.max(0, Math.floor(nextNonce));
  if (!state) {
    nonceState.set(key, { nextNonce: safeNext, ts: Date.now() });
    return;
  }
  if (state.nextNonce < safeNext) state.nextNonce = safeNext;
  state.ts = Date.now();
  nonceState.set(key, state);
}

function isNonceRelatedError(e: any): boolean {
  const msg = collectErrorText(e, true);
  if (!msg) return false;
  return classifyBroadcastError(msg) === 'nonce' || msg.includes('nonce');
}

function getNonceErrorKind(e: any): 'too_high' | 'too_low' | 'other' {
  const msg = collectErrorText(e, true);
  if (!msg) return 'other';
  return getNonceErrorKindFromText(msg);
}

function isBroadcastParamError(e: any): boolean {
  const msg = collectErrorText(e, true);
  if (!msg) return false;
  if (msg.includes('failed to broadcast transaction to any rpc endpoint')) return true;
  if (msg.includes('missing or invalid parameters')) return true;
  return false;
}

function extractNextNonceHint(e: any): number | null {
  const msg = collectErrorText(e, false);
  if (!msg) return null;
  return extractNextNonceHintFromText(msg);
}

export async function sendTransaction(
  client: any,
  account: any,
  to: string,
  data: any,
  value: bigint,
  gasPriceWei: bigint,
  chainId: number,
  opts?: { nonce?: number; skipEstimateGas?: boolean; gasLimit?: bigint; trace?: (label: string, ms: number) => void; txSide?: 'buy' | 'sell'; priorityFeeBnbOverride?: string; feeMode?: 'fixed' | 'dynamic'; gasPreset?: GasPreset }
) {
  const flowKey = `${chainId}:${String(account?.address ?? '').toLowerCase()}`;
  const releaseFlow = await acquireTxFlowLock(flowKey);
  try {
  const trace = opts?.trace;
  const useAutoNonce = opts?.nonce === undefined;
  const noncePromise = opts?.nonce !== undefined
    ? Promise.resolve(opts.nonce)
    : (async () => {
      const start = Date.now();
      const nonce = await reserveNonce(client, chainId, account.address);
      trace?.('reserveNonce', Date.now() - start);
      return nonce;
    })();

  let gasLimit = opts?.gasLimit ?? 900000n;
  if (!opts?.skipEstimateGas && opts?.gasLimit === undefined) {
    try {
      const start = Date.now();
      gasLimit = await client.estimateGas({
        account,
        to: to as `0x${string}`,
        data,
        value,
      });
      gasLimit = gasLimit * 120n / 100n;
      trace?.('estimateGas', Date.now() - start);
    } catch (e: any) {
      const reason = extractRevertReasonFromError(e);
      if (reason && scoreRevertReason(reason) >= 60) {
        throw new Error(reason);
      }
      console.warn('Gas estimation failed, using default', e);
    }
  }

  const nonce = await noncePromise;

  const runtime = getChainRuntime(chainId);
  const shouldUseDynamicFee = opts?.feeMode === 'dynamic' && chainId === 1;
  const multiplierBpsByPreset: Record<GasPreset, bigint> = {
    slow: 10000n,
    standard: 11000n,
    fast: 12000n,
    turbo: 14000n,
  };
  const dynamicMultiplierBps = multiplierBpsByPreset[opts?.gasPreset ?? 'standard'] ?? 10000n;
  const applyMultiplier = (value: bigint) => {
    if (value <= 0n) return value;
    const scaled = (value * dynamicMultiplierBps + 9999n) / 10000n;
    return scaled > 0n ? scaled : 1n;
  };

  const resolveDynamicFees = async () => {
    const feeStart = Date.now();
    try {
      const estimated = await client.estimateFeesPerGas();
      const maxPriorityFeePerGas = typeof estimated?.maxPriorityFeePerGas === 'bigint' && estimated.maxPriorityFeePerGas > 0n
        ? estimated.maxPriorityFeePerGas
        : parseGweiToWei('1');
      const maxFeePerGas = typeof estimated?.maxFeePerGas === 'bigint' && estimated.maxFeePerGas > 0n
        ? estimated.maxFeePerGas
        : (maxPriorityFeePerGas * 2n);
      trace?.('estimateFeesPerGas', Date.now() - feeStart);
      return {
        maxFeePerGas: applyMultiplier(maxFeePerGas),
        maxPriorityFeePerGas: applyMultiplier(maxPriorityFeePerGas),
      };
    } catch {
      const fallbackPriority = parseGweiToWei('1');
      const fallbackMax = gasPriceWei > 0n ? gasPriceWei : parseGweiToWei('2');
      trace?.('estimateFeesPerGasFallback', Date.now() - feeStart);
      return {
        maxFeePerGas: applyMultiplier(fallbackMax),
        maxPriorityFeePerGas: applyMultiplier(fallbackPriority),
      };
    }
  };

  const signAndBroadcast = async (useNonce: number, labelPrefix: string) => {
    const dynamicFees = shouldUseDynamicFee ? await resolveDynamicFees() : null;
    const signStart = Date.now();
    const signed = shouldUseDynamicFee
      ? await account.signTransaction({
        to: to as `0x${string}`,
        data,
        value,
        gas: gasLimit,
        maxFeePerGas: dynamicFees!.maxFeePerGas,
        maxPriorityFeePerGas: dynamicFees!.maxPriorityFeePerGas,
        chain: runtime.viemChain,
        chainId,
        nonce: useNonce,
      })
      : await account.signTransaction({
        to: to as `0x${string}`,
        data,
        value,
        gas: gasLimit,
        gasPrice: gasPriceWei,
        chain: runtime.viemChain,
        chainId,
        nonce: useNonce,
      });
    trace?.(`${labelPrefix}signTransaction`, Date.now() - signStart);

    const broadcastStart = Date.now();
    const res0 = await RpcService.broadcastTxDetailed(signed, {
      txSide: opts?.txSide,
      priorityFeeBnbOverride: opts?.priorityFeeBnbOverride,
      signerContext: {
        account,
        chainId,
        nonce: useNonce,
        gas: gasLimit,
        gasPrice: dynamicFees?.maxFeePerGas ?? gasPriceWei,
      },
    });
    trace?.(`${labelPrefix}broadcastTx`, Date.now() - broadcastStart);
    const consumed = res0.isBundle ? 2 : 1;
    setNextNonceAtLeast(chainId, account.address, useNonce + consumed);
    return {
      txHash: res0.txHash,
      broadcastVia: res0.via,
      broadcastUrl: res0.rpcUrl,
      isBundle: res0.isBundle,
    };
  };

  try {
    return await signAndBroadcast(nonce, '');
  } catch (e: any) {
    if (useAutoNonce && (isNonceRelatedError(e) || isBroadcastParamError(e))) {
      clearNonceState(chainId, account.address);
      const retryTrace: string[] = [];
      const toErrMsg = (err: any) => String(err?.shortMessage || err?.message || err || 'unknown error');
      const attemptObserved = async (prefer: 'min' | 'max', scope: 'protected' | 'both') => {
        const start = Date.now();
        const observedNonce = await RpcService.getObservedPendingNonce({
          chainId,
          address: account.address,
          txSide: opts?.txSide,
          prefer,
          scope,
        });
        trace?.('observeNonce', Date.now() - start);
        if (observedNonce == null) {
          retryTrace.push(`observe:scope=${scope},prefer=${prefer},nonce=null`);
          return null;
        }
        retryTrace.push(`observe:scope=${scope},prefer=${prefer},nonce=${observedNonce}`);
        return await signAndBroadcast(observedNonce, 'observe:');
      };

      let lastErr: any = e;
      const firstKind = getNonceErrorKind(e);
      retryTrace.push(`firstErrorKind=${firstKind},msg=${toErrMsg(e)}`);
      const hintedFromFirst = extractNextNonceHint(e);
      if (hintedFromFirst != null) {
        try {
          retryTrace.push(`hint:firstNonce=${hintedFromFirst}`);
          return await signAndBroadcast(hintedFromFirst, 'hint:first:');
        } catch (ex) {
          lastErr = ex;
          retryTrace.push(`hint:firstFailed,kind=${getNonceErrorKind(ex)},msg=${toErrMsg(ex)}`);
        }
      }

      const preferObserved: 'min' | 'max' = firstKind === 'too_high' ? 'min' : 'max';
      const scopeObserved: 'protected' | 'both' = firstKind === 'too_high' ? 'protected' : 'both';
      try {
        const observed = await attemptObserved(preferObserved, scopeObserved);
        if (observed) return observed;
      } catch (ex) {
        lastErr = ex;
        retryTrace.push(`observe:firstFailed,kind=${getNonceErrorKind(ex)},msg=${toErrMsg(ex)}`);
      }

      try {
        const start = Date.now();
        const retryNonce = await reserveNonce(client, chainId, account.address);
        trace?.('reserveNonceRetry', Date.now() - start);
        retryTrace.push(`retry:reservedNonce=${retryNonce}`);
        return await signAndBroadcast(retryNonce, 'retry:');
      } catch (e2) {
        lastErr = e2;
        retryTrace.push(`retry:failed,kind=${getNonceErrorKind(e2)},msg=${toErrMsg(e2)}`);
      }

      const hintedNonce = extractNextNonceHint(lastErr);
      if (hintedNonce != null) {
        try {
          retryTrace.push(`hint:nonce=${hintedNonce}`);
          return await signAndBroadcast(hintedNonce, 'hint:');
        } catch (ex) {
          lastErr = ex;
          retryTrace.push(`hint:failed,kind=${getNonceErrorKind(ex)},msg=${toErrMsg(ex)}`);
        }
      }

      const observedKind = getNonceErrorKind(lastErr);
      const prefer: 'min' | 'max' = observedKind === 'too_high' ? 'min' : 'max';
      const scope: 'protected' | 'both' = observedKind === 'too_high' ? 'protected' : 'both';
      try {
        const r = await attemptObserved(prefer, scope);
        if (r) return r;
      } catch (ex) {
        lastErr = ex;
        retryTrace.push(`observe:failed,kind=${getNonceErrorKind(ex)},msg=${toErrMsg(ex)}`);
      }

      clearNonceState(chainId, account.address);
      throw new Error(`Auto nonce recovery failed. attempts=${retryTrace.join(' | ')} ; last=${toErrMsg(lastErr)}`);
    }

    clearNonceState(chainId, account.address);
    throw e;
  }
  } finally {
    releaseFlow();
  }
}
