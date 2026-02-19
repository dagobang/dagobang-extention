import { decodeAbiParameters } from 'viem';
import { bsc } from 'viem/chains';
import { RpcService } from '../rpc';
import type { ChainSettings, GasPreset } from '../../types/extention';

function parseGweiToWei(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const intPart = match[1] || '0';
  const fracPartRaw = match[2] || '';
  const fracPadded = (fracPartRaw + '000000000').slice(0, 9);
  const intBig = BigInt(intPart);
  const fracBig = BigInt(fracPadded);
  return intBig * 1000000000n + fracBig;
}

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
const NONCE_CACHE_WINDOW_MS = 60_000;

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

export async function prewarmNonce(client: any, chainId: number, address: `0x${string}`): Promise<void> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const release = await acquireNonceLock(key);
  try {
    const now = Date.now();
    const state = nonceState.get(key);
    if (state && now - state.ts < NONCE_CACHE_WINDOW_MS) return;
    const nonce = await client.getTransactionCount({ address, blockTag: 'pending' });
    nonceState.set(key, { nextNonce: nonce, ts: now });
  } finally {
    release();
  }
}

function clearNonceState(chainId: number, address: `0x${string}`) {
  const key = `${chainId}:${address.toLowerCase()}`;
  nonceState.delete(key);
}

function isNonceRelatedError(e: any): boolean {
  const msg = String(e?.shortMessage || e?.message || e || '').toLowerCase();
  if (!msg) return false;
  if (!msg.includes('nonce') && !msg.includes('replacement')) return false;
  return (
    msg.includes('nonce too low') ||
    msg.includes('nonce is too low') ||
    msg.includes('nonce has already been used') ||
    msg.includes('already known') ||
    msg.includes('known transaction') ||
    msg.includes('replacement transaction underpriced') ||
    msg.includes('transaction underpriced')
  );
}

export async function sendTransaction(
  client: any,
  account: any,
  to: string,
  data: any,
  value: bigint,
  gasPriceWei: bigint,
  chainId: number,
  opts?: { nonce?: number; skipEstimateGas?: boolean; gasLimit?: bigint; trace?: (label: string, ms: number) => void }
) {
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

  const signAndBroadcast = async (useNonce: number, labelPrefix: string) => {
    const signStart = Date.now();
    const signed = await account.signTransaction({
      to: to as `0x${string}`,
      data,
      value,
      gas: gasLimit,
      gasPrice: gasPriceWei,
      chain: bsc,
      chainId,
      nonce: useNonce,
    });
    trace?.(`${labelPrefix}signTransaction`, Date.now() - signStart);

    const broadcastStart = Date.now();
    const res = await RpcService.broadcastTxDetailed(signed);
    trace?.(`${labelPrefix}broadcastTx`, Date.now() - broadcastStart);
    return {
      txHash: res.txHash,
      broadcastVia: res.via,
      broadcastUrl: res.rpcUrl,
    };
  };

  try {
    return await signAndBroadcast(nonce, '');
  } catch (e: any) {
    if (useAutoNonce && isNonceRelatedError(e)) {
      clearNonceState(chainId, account.address);
      try {
        const start = Date.now();
        const retryNonce = await reserveNonce(client, chainId, account.address);
        trace?.('reserveNonceRetry', Date.now() - start);
        return await signAndBroadcast(retryNonce, 'retry:');
      } catch (e2) {
        clearNonceState(chainId, account.address);
        throw e2;
      }
    }

    clearNonceState(chainId, account.address);
    throw e;
  }
}
