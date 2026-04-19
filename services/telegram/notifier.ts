import type { Settings } from '@/types/extention';
import { isTelegramConfigured, telegramSendMessage, type TelegramApiConfig } from './api';

function shortAddr(addr: string | undefined): string {
  const v = String(addr || '').trim();
  if (!v || v.length < 12) return v;
  return `${v.slice(0, 6)}...${v.slice(-4)}`;
}

function timingLine(submitElapsedMs?: number, receiptElapsedMs?: number): string {
  const parts: string[] = [];
  if (Number.isFinite(submitElapsedMs) && Number(submitElapsedMs) > 0) {
    parts.push(`提交 ${Number(submitElapsedMs)}ms`);
  }
  if (Number.isFinite(receiptElapsedMs) && Number(receiptElapsedMs) > 0) {
    parts.push(`上链 ${Number(receiptElapsedMs)}ms`);
  }
  return parts.length ? `\n耗时: ${parts.join(' / ')}` : '';
}

function buildConfig(settings: Settings): TelegramApiConfig | null {
  const tg = (settings as any).telegram;
  if (!tg || tg.enabled !== true) return null;
  const cfg: TelegramApiConfig = {
    botToken: String(tg.botToken || '').trim(),
    chatId: String(tg.chatId || '').trim(),
  };
  return isTelegramConfigured(cfg) ? cfg : null;
}

export function createTelegramNotifier(deps: {
  getSettings: () => Promise<Settings>;
}) {
  const sendText = async (text: string, predicate: (settings: Settings) => boolean) => {
    try {
      const settings = await deps.getSettings();
      if (!predicate(settings)) return false;
      const cfg = buildConfig(settings);
      if (!cfg) return false;
      await telegramSendMessage(cfg, text);
      return true;
    } catch {
      return false;
    }
  };

  const notifyTradeSubmitted = async (input: {
    source?: string;
    side?: 'buy' | 'sell';
    tokenAddress?: string;
    txHash?: string;
    submitElapsedMs?: number;
  }) => {
    const side = input.side === 'sell' ? '卖出' : '买入';
    const text = [
      `提交: ${side}`,
      `来源: ${input.source || '-'}`,
      `Token: ${shortAddr(input.tokenAddress) || '-'}`,
      `Tx: ${input.txHash || '-'}`,
      timingLine(input.submitElapsedMs, undefined).trim(),
    ].filter(Boolean).join('\n');
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyTradeSubmitted);
  };

  const notifyTradeSuccess = async (input: {
    source?: string;
    side?: 'buy' | 'sell';
    tokenAddress?: string;
    txHash?: string;
    submitElapsedMs?: number;
    receiptElapsedMs?: number;
  }) => {
    const side = input.side === 'sell' ? '卖出' : '买入';
    const text = [
      `成功: ${side}`,
      `来源: ${input.source || '-'}`,
      `Token: ${shortAddr(input.tokenAddress) || '-'}`,
      `Tx: ${input.txHash || '-'}`,
      timingLine(input.submitElapsedMs, input.receiptElapsedMs).trim(),
    ].filter(Boolean).join('\n');
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyTradeSuccess);
  };

  const notifyRetrying = async (input: {
    side?: 'buy' | 'sell';
    tokenAddress?: string;
    attempt?: number;
    reason?: string;
  }) => {
    const side = input.side === 'sell' ? '卖出' : '买入';
    const text = [
      `重试: ${side}`,
      `Token: ${shortAddr(input.tokenAddress) || '-'}`,
      `次数: ${input.attempt ?? 1}`,
      `原因: ${input.reason || '-'}`,
    ].join('\n');
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyTradeRetrying);
  };

  const notifyLimitOrderResult = async (input: {
    stage: 'submitted' | 'success' | 'failed';
    orderId: string;
    side: 'buy' | 'sell';
    tokenAddress: string;
    txHash?: string;
    error?: string;
  }) => {
    const stageText = input.stage === 'submitted' ? '已提交' : input.stage === 'success' ? '执行成功' : '执行失败';
    const text = [
      `挂单: ${stageText}`,
      `订单: ${input.orderId}`,
      `方向: ${input.side === 'sell' ? '卖出' : '买入'}`,
      `Token: ${shortAddr(input.tokenAddress)}`,
      input.txHash ? `Tx: ${input.txHash}` : '',
      input.error ? `错误: ${input.error}` : '',
    ].filter(Boolean).join('\n');
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyLimitOrder);
  };

  const notifyQuickTrade = async (text: string) => {
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyQuickTrade);
  };

  return {
    notifyTradeSubmitted,
    notifyTradeSuccess,
    notifyRetrying,
    notifyLimitOrderResult,
    notifyQuickTrade,
  };
}
