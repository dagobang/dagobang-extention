import { browser } from 'wxt/browser';
import type { BgRequest, BgResponse } from '../types/extention';

export async function call<T extends BgRequest>(req: T): Promise<BgResponse<T>> {
  try {
    // #region debug-point A:messaging-call-start
    if (req.type === 'tx:sellWithReceiptAuto') fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'A', location: 'utils/messaging.ts:call:start', msg: '[DEBUG] messaging call start', data: { type: req.type, chainId: (req as any)?.input?.chainId ?? null, tokenAddress: (req as any)?.input?.tokenAddress ?? null, fromAddress: (req as any)?.input?.fromAddress ?? null }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    const p = browser.runtime.sendMessage(req);
    // Longer timeout for transaction flows that include auto-repair/retry.
    const timeoutMs = (
      req.type === 'tx:waitForReceipt' ||
      req.type === 'tx:buyWithReceiptAuto' ||
      req.type === 'tx:sellWithReceiptAuto' ||
      req.type === 'telegram:quickBuy' ||
      req.type === 'telegram:quickSell' ||
      req.type === 'ai:generateLogo'
    )
      ? 60000
      : req.type === 'twitter:signal'
        ? 20000
      : req.type.startsWith('limitOrder:')
        ? 15000
        : 5000;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), timeoutMs));
    const res = (await Promise.race([p, timeout])) as any;
    if (typeof res?.error === 'string' && res.error) {
      // #region debug-point A:messaging-call-response-error
      if (req.type === 'tx:sellWithReceiptAuto') fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'A', location: 'utils/messaging.ts:call:responseError', msg: '[DEBUG] messaging call response error', data: { type: req.type, chainId: (req as any)?.input?.chainId ?? null, tokenAddress: (req as any)?.input?.tokenAddress ?? null, fromAddress: (req as any)?.input?.fromAddress ?? null, error: res.error }, ts: Date.now() }) }).catch(() => { });
      // #endregion
      throw new Error(res.error);
    }
    return res as BgResponse<T>;
  } catch (e: any) {
    // #region debug-point A:messaging-call-catch
    if (req.type === 'tx:sellWithReceiptAuto') fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'A', location: 'utils/messaging.ts:call:catch', msg: '[DEBUG] messaging call catch', data: { type: req.type, chainId: (req as any)?.input?.chainId ?? null, tokenAddress: (req as any)?.input?.tokenAddress ?? null, fromAddress: (req as any)?.input?.fromAddress ?? null, errorName: String(e?.name || ''), errorMessage: String(e?.message || e || '') }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    const isTimeout = e?.message?.includes('Request timed out');
    if (!(req.type === 'twitter:signal' && isTimeout)) {
      console.error('Call failed:', req.type, e);
    }
    if (req.type === 'bg:ping') throw e;
    if (e?.message?.includes('Could not establish connection') || e?.message?.includes('closed')) {
      await new Promise(r => setTimeout(r, 1000));
      return (await browser.runtime.sendMessage(req)) as BgResponse<T>;
    }
    throw e;
  }
}
