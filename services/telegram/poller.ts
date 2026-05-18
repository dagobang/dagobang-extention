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
  | { type: 'holdings'; chain?: string }
  | { type: 'wallets' }
  | { type: 'whoami' }
  | { type: 'switchWallet'; target: string }
  | { type: 'orders'; chain?: string }
  | { type: 'tokenInfo'; tokenAddress: `0x${string}`; chain?: string }
  | { type: 'cancel'; orderId: string }
  | { type: 'buy'; tokenAddress: `0x${string}`; amountBnb: string; chain?: string }
  | { type: 'sell'; tokenAddress: `0x${string}`; sellPercent: number; chain?: string }
  | { type: 'actionOrders'; chainId?: number }
  | { type: 'actionOrdersPage'; page: number; chainId?: number }
  | { type: 'actionTokenInfo'; tokenAddress: `0x${string}`; chainId?: number }
  | { type: 'actionCancel'; orderId: string }
  | { type: 'actionBuy'; tokenAddress: `0x${string}`; amountBnb: string; chainId?: number }
  | { type: 'actionSell'; tokenAddress: `0x${string}`; sellPercent: number; chainId?: number }
  | { type: 'actionMenu' }
  | { type: 'actionChainMenu' }
  | { type: 'actionSwitchChain'; chain: string }
  | { type: 'actionStatus' }
  | { type: 'actionHoldings'; chainId?: number }
  | { type: 'actionWallets' }
  | { type: 'actionWhoami' }
  | { type: 'actionSwitchWallet'; target: string }
  | { type: 'actionSettings' }
  | { type: 'actionXSniperSettings' }
  | { type: 'actionNewCoinSniperSettings' }
  | { type: 'actionQuickTradeSettings' }
  | { type: 'actionSetXSniperDryRun'; enabled: boolean }
  | { type: 'actionSetXSniperAutoSell'; enabled: boolean }
  | { type: 'actionSetXSniperBuyAmount'; amountBnb: string }
  | { type: 'actionSetXSniperBuyCaCount'; count: number }
  | { type: 'actionInputXSniperBuyAmount' }
  | { type: 'actionInputXSniperBuyCaCount' }
  | { type: 'actionSetNewCoinSniperDryRun'; enabled: boolean }
  | { type: 'actionSetNewCoinSniperAutoSell'; enabled: boolean }
  | { type: 'actionSetNewCoinSniperBuyAmount'; amountBnb: string }
  | { type: 'actionSetNewCoinSniperBuyCaCount'; count: number }
  | { type: 'actionInputNewCoinSniperBuyAmount' }
  | { type: 'actionInputNewCoinSniperBuyCaCount' }
  | { type: 'actionInputQuickBuyPresets' }
  | { type: 'actionInputQuickSellPresets' }
  | { type: 'actionXSniperOrder'; orderId: string }
  | { type: 'unknown'; text: string };

export function parseTelegramCommand(text: string): ParsedTelegramCommand {
  const raw = String(text || '').trim();
  if (raw.startsWith('act:')) {
    const [_, action, arg1, arg2, arg3] = raw.split(':');
    if (action === 'orders') {
      const chainId = Number(arg1 || '');
      return { type: 'actionOrders', chainId: Number.isFinite(chainId) ? chainId : undefined };
    }
    if (action === 'ordersp') {
      const chainId = Number(arg1 || '');
      const page = Number(arg2 || '1');
      return {
        type: 'actionOrdersPage',
        chainId: Number.isFinite(chainId) ? chainId : undefined,
        page: Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1,
      };
    }
    if (action === 'menu') return { type: 'actionMenu' };
    if (action === 'chain') return { type: 'actionChainMenu' };
    if (action === 'schain' && (arg1 || '').trim()) return { type: 'actionSwitchChain', chain: (arg1 || '').trim() };
    if (action === 'settings') return { type: 'actionSettings' };
    if (action === 'xset') return { type: 'actionXSniperSettings' };
    if (action === 'ncset') return { type: 'actionNewCoinSniperSettings' };
    if (action === 'qset') return { type: 'actionQuickTradeSettings' };
    if (action === 'xsdry' && (arg1 === '0' || arg1 === '1')) return { type: 'actionSetXSniperDryRun', enabled: arg1 === '1' };
    if (action === 'xsell' && (arg1 === '0' || arg1 === '1')) return { type: 'actionSetXSniperAutoSell', enabled: arg1 === '1' };
    if (action === 'xsamt' && (arg1 || '').trim() && Number.isFinite(Number(arg1 || ''))) return { type: 'actionSetXSniperBuyAmount', amountBnb: (arg1 || '').trim() };
    if (action === 'xsca' && Number.isFinite(Number(arg1 || ''))) return { type: 'actionSetXSniperBuyCaCount', count: Math.max(0, Math.floor(Number(arg1 || '0'))) };
    if (action === 'xsamtin') return { type: 'actionInputXSniperBuyAmount' };
    if (action === 'xscain') return { type: 'actionInputXSniperBuyCaCount' };
    if (action === 'ncdry' && (arg1 === '0' || arg1 === '1')) return { type: 'actionSetNewCoinSniperDryRun', enabled: arg1 === '1' };
    if (action === 'ncsell' && (arg1 === '0' || arg1 === '1')) return { type: 'actionSetNewCoinSniperAutoSell', enabled: arg1 === '1' };
    if (action === 'ncamt' && (arg1 || '').trim() && Number.isFinite(Number(arg1 || ''))) return { type: 'actionSetNewCoinSniperBuyAmount', amountBnb: (arg1 || '').trim() };
    if (action === 'ncca' && Number.isFinite(Number(arg1 || ''))) return { type: 'actionSetNewCoinSniperBuyCaCount', count: Math.max(0, Math.floor(Number(arg1 || '0'))) };
    if (action === 'ncamtin') return { type: 'actionInputNewCoinSniperBuyAmount' };
    if (action === 'nccain') return { type: 'actionInputNewCoinSniperBuyCaCount' };
    if (action === 'qbuyin') return { type: 'actionInputQuickBuyPresets' };
    if (action === 'qsellin') return { type: 'actionInputQuickSellPresets' };
    if (action === 'status') return { type: 'actionStatus' };
    if (action === 'holdings') {
      const chainId = Number(arg1 || '');
      return { type: 'actionHoldings', chainId: Number.isFinite(chainId) ? chainId : undefined };
    }
    if (action === 'wallets') return { type: 'actionWallets' };
    if (action === 'whoami') return { type: 'actionWhoami' };
    if (action === 'switch' && (arg1 || '').trim()) {
      return { type: 'actionSwitchWallet', target: (arg1 || '').trim() };
    }
    if (action === 'token') {
      const chainId = Number(arg1 || '');
      const tokenAddress = Number.isFinite(chainId) ? (arg2 || '') : (arg1 || '');
      if (/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
        return {
          type: 'actionTokenInfo',
          chainId: Number.isFinite(chainId) ? chainId : undefined,
          tokenAddress: tokenAddress as `0x${string}`,
        };
      }
    }
    if (action === 'cancel' && (arg1 || '').trim()) {
      return { type: 'actionCancel', orderId: (arg1 || '').trim() };
    }
    if (action === 'buy') {
      const chainId = Number(arg1 || '');
      const tokenAddress = Number.isFinite(chainId) ? (arg2 || '') : (arg1 || '');
      const amountBnb = Number.isFinite(chainId) ? (arg3 || '') : (arg2 || '');
      if (/^0x[a-fA-F0-9]{40}$/.test(tokenAddress) && amountBnb.trim()) {
        return {
          type: 'actionBuy',
          chainId: Number.isFinite(chainId) ? chainId : undefined,
          tokenAddress: tokenAddress as `0x${string}`,
          amountBnb: amountBnb.trim(),
        };
      }
    }
    if (action === 'sell') {
      const chainId = Number(arg1 || '');
      const tokenAddress = Number.isFinite(chainId) ? (arg2 || '') : (arg1 || '');
      const sellPercentRaw = Number.isFinite(chainId) ? (arg3 || '') : (arg2 || '');
      if (/^0x[a-fA-F0-9]{40}$/.test(tokenAddress) && Number.isFinite(Number(sellPercentRaw))) {
        return {
          type: 'actionSell',
          chainId: Number.isFinite(chainId) ? chainId : undefined,
          tokenAddress: tokenAddress as `0x${string}`,
          sellPercent: Number(sellPercentRaw),
        };
      }
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
  if (cmd === '/holdings') {
    const chain = (rest[0] || '').trim();
    return { type: 'holdings', chain: chain || undefined };
  }
  if (cmd === '/wallets') return { type: 'wallets' };
  if (cmd === '/whoami') return { type: 'whoami' };
  if (cmd === '/switch') {
    const target = rest.join(' ').trim();
    if (!target) return { type: 'unknown', text: raw };
    return { type: 'switchWallet', target };
  }
  if (cmd === '/orders') {
    const chain = (rest[0] || '').trim();
    return { type: 'orders', chain: chain || undefined };
  }
  if (cmd === '/token') {
    const hasChainArg = rest.length >= 2;
    const chain = hasChainArg ? (rest[0] || '').trim() : undefined;
    const tokenAddress = (hasChainArg ? rest[1] : rest[0] || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return { type: 'unknown', text: raw };
    return { type: 'tokenInfo', tokenAddress: tokenAddress as `0x${string}`, chain };
  }
  if (cmd === '/cancel') {
    const orderId = (rest[0] || '').trim();
    if (!orderId) return { type: 'unknown', text: raw };
    return { type: 'cancel', orderId };
  }
  if (cmd === '/buy') {
    const hasChainArg = rest.length >= 3;
    const chain = hasChainArg ? (rest[0] || '').trim() : undefined;
    const tokenAddress = (hasChainArg ? rest[1] : rest[0] || '').trim();
    const amountBnb = (hasChainArg ? rest[2] : rest[1] || '').trim();
    if (!tokenAddress || !amountBnb || !tokenAddress.startsWith('0x')) {
      return { type: 'unknown', text: raw };
    }
    return { type: 'buy', tokenAddress: tokenAddress as `0x${string}`, amountBnb, chain };
  }
  if (cmd === '/sell') {
    const hasChainArg = rest.length >= 3;
    const chain = hasChainArg ? (rest[0] || '').trim() : undefined;
    const tokenAddress = (hasChainArg ? rest[1] : rest[0] || '').trim();
    const sellPercentRaw = (hasChainArg ? rest[2] : rest[1] || '').trim();
    const sellPercent = Number(sellPercentRaw);
    if (!tokenAddress || !tokenAddress.startsWith('0x') || !Number.isFinite(sellPercent)) {
      return { type: 'unknown', text: raw };
    }
    return { type: 'sell', tokenAddress: tokenAddress as `0x${string}`, sellPercent, chain };
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
