import { browser } from 'wxt/browser';
import type { BgRequest, BgResponse } from '../types/extention';

export async function call<T extends BgRequest>(req: T): Promise<BgResponse<T>> {
  try {
    const p = browser.runtime.sendMessage(req);
    // Longer timeout for transaction waiting
    const timeoutMs = (req.type === 'tx:waitForReceipt' || req.type === 'ai:generateLogo') ? 60000 : 5000;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), timeoutMs));
    const res = (await Promise.race([p, timeout])) as any;
    if (res?.error) {
      throw new Error(res.error);
    }
    return res as BgResponse<T>;
  } catch (e: any) {
    console.error('Call failed:', req.type, e);
    if (req.type === 'bg:ping') throw e;
    if (e?.message?.includes('Could not establish connection') || e?.message?.includes('closed')) {
      await new Promise(r => setTimeout(r, 1000));
      return (await browser.runtime.sendMessage(req)) as BgResponse<T>;
    }
    throw e;
  }
}
