import type { Settings, XSniperBuyRecord } from '@/types/extention';
import { isTelegramConfigured, telegramSendMessage, telegramSendMessageWithOptions, type TelegramApiConfig } from './api';

function shortAddr(addr: string | undefined): string {
  const v = String(addr || '').trim();
  if (!v || v.length < 12) return v;
  return `${v.slice(0, 6)}...${v.slice(-4)}`;
}

function tokenLabel(input: { tokenName?: string; tokenSymbol?: string; tokenAddress?: string }): string {
  const name = String(input.tokenName || '').trim();
  const symbol = String(input.tokenSymbol || '').trim();
  if (symbol && name && symbol !== name) return `${symbol} (${name})`;
  if (symbol) return symbol;
  if (name) return name;
  return shortAddr(input.tokenAddress) || '-';
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
  const formatUsd = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '-';
    if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
  };

  const formatAge = (createdAtMs: number | undefined) => {
    if (!Number.isFinite(createdAtMs) || Number(createdAtMs) <= 0) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - Number(createdAtMs)) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}h`;
    const day = Math.floor(hour / 24);
    return `${day}d`;
  };
  const formatPnlPct = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '-';
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  };

  const sendText = async (
    text: string,
    predicate: (settings: Settings) => boolean,
    options?: { inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>> }
  ) => {
    try {
      const settings = await deps.getSettings();
      if (!predicate(settings)) return false;
      const cfg = buildConfig(settings);
      if (!cfg) return false;
      if (options?.inlineKeyboard?.length) {
        await telegramSendMessageWithOptions(cfg, text, options);
      } else {
        await telegramSendMessage(cfg, text);
      }
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
    tokenName?: string;
    tokenSymbol?: string;
    marketCapUsd?: number | null;
    txHash?: string;
    submitElapsedMs?: number;
    receiptElapsedMs?: number;
  }) => {
    const side = input.side === 'sell' ? '卖出' : '买入';
    const text = [
      `成功: ${side}`,
      `来源: ${input.source || '-'}`,
      `代币: ${tokenLabel(input)}`,
      `地址: ${shortAddr(input.tokenAddress) || '-'}`,
      `市值: ${formatUsd(input.marketCapUsd)}`,
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
    tokenName?: string;
    tokenSymbol?: string;
    marketCapUsd?: number | null;
    txHash?: string;
    error?: string;
  }) => {
    const stageText = input.stage === 'submitted' ? '已提交' : input.stage === 'success' ? '执行成功' : '执行失败';
    const text = [
      `挂单: ${stageText}`,
      `订单: ${input.orderId}`,
      `方向: ${input.side === 'sell' ? '卖出' : '买入'}`,
      `代币: ${tokenLabel(input)}`,
      `地址: ${shortAddr(input.tokenAddress)}`,
      `市值: ${formatUsd(input.marketCapUsd)}`,
      input.txHash ? `Tx: ${input.txHash}` : '',
      input.error ? `错误: ${input.error}` : '',
    ].filter(Boolean).join('\n');
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyLimitOrder);
  };

  const notifyQuickTrade = async (text: string) => {
    return await sendText(text, (settings) => !!(settings as any).telegram?.notifyQuickTrade);
  };

  const notifyXSniperOrderCard = async (record: XSniperBuyRecord) => {
    const entryMcap = typeof record.marketCapUsd === 'number' && Number.isFinite(record.marketCapUsd) && record.marketCapUsd > 0
      ? record.marketCapUsd
      : null;
    const athMcap = typeof record.athMarketCapUsd === 'number' && Number.isFinite(record.athMarketCapUsd) && record.athMarketCapUsd > 0
      ? record.athMarketCapUsd
      : entryMcap;
    const pnlAthPct =
      entryMcap != null && athMcap != null && entryMcap > 0
        ? ((athMcap / entryMcap) - 1) * 100
        : null;
    const mode = record.dryRun ? '🧪 DryRun' : '✅ 实盘';
    const screen = String(record.userScreen || '').trim();
    const user = String(record.userName || '').trim();
    const account = screen ? `@${screen}` : (user || '-');
    const symbol = String(record.tokenSymbol || record.tokenName || 'TOKEN').trim();
    const title = `🎯 推文狙击订单 ${mode}`;
    const text = [
      title,
      `订单: ${record.id}`,
      `代币: ${symbol}`,
      `地址: ${shortAddr(record.tokenAddress) || '-'}`,
      `PnL(MCap): - | ATH PnL: ${formatPnlPct(pnlAthPct)}`,
      `市值: 入场 ${formatUsd(entryMcap)} | ATH ${formatUsd(athMcap)}`,
      `买入: ${record.buyAmountBnb != null ? `${record.buyAmountBnb} BNB` : '-'} | 入场价: ${record.entryPriceUsd != null ? `$${record.entryPriceUsd}` : '-'}`,
      `持有人: ${Number.isFinite(record.holders) ? Number(record.holders) : '-'} | KOL: ${Number.isFinite(record.kol) ? Number(record.kol) : '-'} | Smart: ${Number.isFinite(record.smartMoney) ? Number(record.smartMoney) : '-'}`,
      `Dev持仓: ${record.devHoldPercent != null ? `${record.devHoldPercent.toFixed(2)}%` : '-'} | Dev卖出: ${record.devHasSold === true ? '是' : record.devHasSold === false ? '否' : '-'}`,
      `24h: Vol ${formatUsd(record.vol24hUsd)} | NetBuy ${formatUsd(record.netBuy24hUsd)} | Buy/Sell ${record.buyTx24h ?? '-'} / ${record.sellTx24h ?? '-'}`,
      `代币Age: ${formatAge(record.createdAtMs)}`,
      `推文类型: ${record.tweetType || '-'}`,
      `推文账户: ${account}`,
      `推文链接: ${record.tweetUrl || '-'}`,
      `Tx: ${record.txHash || '-'}`,
    ].join('\n');
    return await sendText(
      text,
      () => true,
      {
        inlineKeyboard: [
          [
            { text: '🔄 刷新', callbackData: `act:xso:${record.id}` },
            { text: '🔍 查看代币', callbackData: `act:token:${record.tokenAddress}` },
          ],
        ],
      }
    );
  };

  return {
    notifyTradeSubmitted,
    notifyTradeSuccess,
    notifyRetrying,
    notifyLimitOrderResult,
    notifyQuickTrade,
    notifyXSniperOrderCard,
  };
}
