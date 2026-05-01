import { browser } from 'wxt/browser';
import type { TelegramApiConfig } from './api';
import { isTelegramConfigured, telegramAnswerCallbackQuery, telegramGetCommands } from './api';
import type { TelegramPollStatus } from '@/types/extention';

const LAST_UPDATE_ID_KEY = 'dagobang_telegram_last_update_id_v1';

export type ParsedTelegramCommand =
  | { type: 'start' }
  | { type: 'menu' }
  | { type: 'chain' }
  | { type: 'switchChain'; chain: string }
  | { type: 'settings' }
  | { type: 'status' }
  | { type: 'holdings' }
  | { type: 'wallets' }
  | { type: 'whoami' }
  | { type: 'switchWallet'; target: string }
  | { type: 'orders' }
  | { type: 'tokenInfo'; tokenAddress: `0x${string}` }
  | { type: 'cancel'; orderId: string }
  | { type: 'buy'; tokenAddress: `0x${string}`; amountBnb: string }
  | { type: 'sell'; tokenAddress: `0x${string}`; sellPercent: number }
  | { type: 'actionOrders' }
  | { type: 'actionOrdersPage'; page: number }
  | { type: 'actionTokenInfo'; tokenAddress: `0x${string}` }
  | { type: 'actionCancel'; orderId: string }
  | { type: 'actionBuy'; tokenAddress: `0x${string}`; amountBnb: string }
  | { type: 'actionSell'; tokenAddress: `0x${string}`; sellPercent: number }
  | { type: 'actionMenu' }
  | { type: 'actionChainMenu' }
  | { type: 'actionSwitchChain'; chain: string }
  | { type: 'actionStatus' }
  | { type: 'actionHoldings' }
  | { type: 'actionWallets' }
  | { type: 'actionWhoami' }
  | { type: 'actionSwitchWallet'; target: string }
  | { type: 'actionSettings' }
  | { type: 'actionXSniperSettings' }
  | { type: 'actionQuickTradeSettings' }
  | { type: 'actionSetXSniperDryRun'; enabled: boolean }
  | { type: 'actionSetXSniperAutoSell'; enabled: boolean }
  | { type: 'actionSetXSniperBuyAmount'; amountBnb: string }
  | { type: 'actionSetXSniperBuyCaCount'; count: number }
  | { type: 'actionInputXSniperBuyAmount' }
  | { type: 'actionInputXSniperBuyCaCount' }
  | { type: 'actionInputQuickBuyPresets' }
  | { type: 'actionInputQuickSellPresets' }
  | { type: 'actionXSniperOrder'; orderId: string }
  | { type: 'unknown'; text: string };

export function parseTelegramCommand(text: string): ParsedTelegramCommand {
  const raw = String(text || '').trim();
  if (raw.startsWith('act:')) {
    const [_, action, arg1, arg2] = raw.split(':');
    if (action === 'orders') return { type: 'actionOrders' };
    if (action === 'ordersp') {
      const page = Number(arg1 || '1');
      return { type: 'actionOrdersPage', page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1 };
    }
    if (action === 'menu') return { type: 'actionMenu' };
    if (action === 'chain') return { type: 'actionChainMenu' };
    if (action === 'schain' && (arg1 || '').trim()) return { type: 'actionSwitchChain', chain: (arg1 || '').trim() };
    if (action === 'settings') return { type: 'actionSettings' };
    if (action === 'xset') return { type: 'actionXSniperSettings' };
    if (action === 'qset') return { type: 'actionQuickTradeSettings' };
    if (action === 'xsdry' && (arg1 === '0' || arg1 === '1')) return { type: 'actionSetXSniperDryRun', enabled: arg1 === '1' };
    if (action === 'xsell' && (arg1 === '0' || arg1 === '1')) return { type: 'actionSetXSniperAutoSell', enabled: arg1 === '1' };
    if (action === 'xsamt' && (arg1 || '').trim() && Number.isFinite(Number(arg1 || ''))) return { type: 'actionSetXSniperBuyAmount', amountBnb: (arg1 || '').trim() };
    if (action === 'xsca' && Number.isFinite(Number(arg1 || ''))) return { type: 'actionSetXSniperBuyCaCount', count: Math.max(0, Math.floor(Number(arg1 || '0'))) };
    if (action === 'xsamtin') return { type: 'actionInputXSniperBuyAmount' };
    if (action === 'xscain') return { type: 'actionInputXSniperBuyCaCount' };
    if (action === 'qbuyin') return { type: 'actionInputQuickBuyPresets' };
    if (action === 'qsellin') return { type: 'actionInputQuickSellPresets' };
    if (action === 'status') return { type: 'actionStatus' };
    if (action === 'holdings') return { type: 'actionHoldings' };
    if (action === 'wallets') return { type: 'actionWallets' };
    if (action === 'whoami') return { type: 'actionWhoami' };
    if (action === 'switch' && (arg1 || '').trim()) {
      return { type: 'actionSwitchWallet', target: (arg1 || '').trim() };
    }
    if (action === 'token' && /^0x[a-fA-F0-9]{40}$/.test(arg1 || '')) {
      return { type: 'actionTokenInfo', tokenAddress: arg1 as `0x${string}` };
    }
    if (action === 'cancel' && (arg1 || '').trim()) {
      return { type: 'actionCancel', orderId: (arg1 || '').trim() };
    }
    if (action === 'buy' && /^0x[a-fA-F0-9]{40}$/.test(arg1 || '') && (arg2 || '').trim()) {
      return { type: 'actionBuy', tokenAddress: arg1 as `0x${string}`, amountBnb: (arg2 || '').trim() };
    }
    if (action === 'sell' && /^0x[a-fA-F0-9]{40}$/.test(arg1 || '') && Number.isFinite(Number(arg2 || ''))) {
      return { type: 'actionSell', tokenAddress: arg1 as `0x${string}`, sellPercent: Number(arg2) };
    }
    if (action === 'xso' && (arg1 || '').trim()) {
      return { type: 'actionXSniperOrder', orderId: (arg1 || '').trim() };
    }
    return { type: 'unknown', text: raw };
  }
  const [cmdRaw, ...rest] = raw.split(/\s+/).filter(Boolean);
  const cmd = cmdRaw?.toLowerCase() || '';
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    return { type: 'tokenInfo', tokenAddress: raw as `0x${string}` };
  }
  if (cmd === '/start') return { type: 'start' };
  if (cmd === '/menu') return { type: 'menu' };
  if (cmd === '/chain') {
    const target = (rest[0] || '').trim();
    if (!target) return { type: 'chain' };
    return { type: 'switchChain', chain: target };
  }
  if (cmd === '/settings') return { type: 'settings' };
  if (cmd === '/status') return { type: 'status' };
  if (cmd === '/holdings') return { type: 'holdings' };
  if (cmd === '/wallets') return { type: 'wallets' };
  if (cmd === '/whoami') return { type: 'whoami' };
  if (cmd === '/switch') {
    const target = rest.join(' ').trim();
    if (!target) return { type: 'unknown', text: raw };
    return { type: 'switchWallet', target };
  }
  if (cmd === '/orders') return { type: 'orders' };
  if (cmd === '/token') {
    const tokenAddress = (rest[0] || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return { type: 'unknown', text: raw };
    return { type: 'tokenInfo', tokenAddress: tokenAddress as `0x${string}` };
  }
  if (cmd === '/cancel') {
    const orderId = (rest[0] || '').trim();
    if (!orderId) return { type: 'unknown', text: raw };
    return { type: 'cancel', orderId };
  }
  if (cmd === '/buy') {
    const tokenAddress = (rest[0] || '').trim();
    const amountBnb = (rest[1] || '').trim();
    if (!tokenAddress || !amountBnb || !tokenAddress.startsWith('0x')) {
      return { type: 'unknown', text: raw };
    }
    return { type: 'buy', tokenAddress: tokenAddress as `0x${string}`, amountBnb };
  }
  if (cmd === '/sell') {
    const tokenAddress = (rest[0] || '').trim();
    const sellPercentRaw = (rest[1] || '').trim();
    const sellPercent = Number(sellPercentRaw);
    if (!tokenAddress || !tokenAddress.startsWith('0x') || !Number.isFinite(sellPercent)) {
      return { type: 'unknown', text: raw };
    }
    return { type: 'sell', tokenAddress: tokenAddress as `0x${string}`, sellPercent };
  }
  return { type: 'unknown', text: raw };
}

export function createTelegramPoller(deps: {
  getConfig: () => Promise<TelegramApiConfig | null>;
  getPollIntervalMs: () => Promise<number>;
  onCommand: (input: {
    chatId: string;
    userId: string;
    command: ParsedTelegramCommand;
    rawText: string;
    callbackQueryId?: string;
  }) => Promise<void>;
}) {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPollAtMs: number | null = null;
  let lastError: string | null = null;

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const getLastUpdateId = async (): Promise<number> => {
    try {
      const res = await browser.storage.local.get(LAST_UPDATE_ID_KEY);
      const raw = (res as any)?.[LAST_UPDATE_ID_KEY];
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  };

  const setLastUpdateId = async (id: number) => {
    try {
      await browser.storage.local.set({ [LAST_UPDATE_ID_KEY]: Math.max(0, Math.floor(id)) } as any);
    } catch {
    }
  };

  const tick = async () => {
    if (!running) return;
    const cfg = await deps.getConfig();
    if (!isTelegramConfigured(cfg)) {
      lastError = null;
      lastPollAtMs = Date.now();
      scheduleNext(1500);
      return;
    }
    const intervalMs = await deps.getPollIntervalMs();
    try {
      const baseOffset = await getLastUpdateId();
      const updates = await telegramGetCommands(cfg, baseOffset > 0 ? baseOffset + 1 : 0);
      let maxUpdateId = baseOffset;
      for (const upd of updates) {
        if (upd.updateId > maxUpdateId) maxUpdateId = upd.updateId;
        if (upd.chatId !== cfg.chatId) continue;
        const command = parseTelegramCommand(upd.text);
        await deps.onCommand({
          chatId: upd.chatId,
          userId: upd.userId,
          command,
          rawText: upd.text,
          callbackQueryId: upd.callbackQueryId,
        });
        if (upd.callbackQueryId) {
          try {
            await telegramAnswerCallbackQuery(cfg, upd.callbackQueryId);
          } catch {
          }
        }
      }
      if (maxUpdateId !== baseOffset) {
        await setLastUpdateId(maxUpdateId);
      }
      lastError = null;
    } catch (e: any) {
      lastError = String(e?.message || e || 'poll_failed');
    } finally {
      lastPollAtMs = Date.now();
      scheduleNext(intervalMs);
    }
  };

  const scheduleNext = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      void tick();
    }, Math.max(800, Math.floor(delayMs)));
  };

  const start = () => {
    if (running) return;
    running = true;
    scheduleNext(200);
  };

  const stop = () => {
    running = false;
    clearTimer();
  };

  const getStatus = (): TelegramPollStatus => ({
    enabled: true,
    running,
    lastPollAtMs,
    lastError,
  });

  return {
    start,
    stop,
    getStatus,
  };
}
