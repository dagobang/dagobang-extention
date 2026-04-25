import { browser } from 'wxt/browser';
import { formatUnits, parseEther } from 'viem';
import { SettingsService } from '@/services/settings';
import { WalletService } from '@/services/wallet';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { cancelLimitOrder, listLimitOrders } from '@/services/limitOrders/store';
import FourmemeAPI from '@/services/api/fourmeme';
import type { TokenInfo } from '@/types/token';
import type { XSniperBuyRecord } from '@/types/extention';
import { ZERO_ADDRESS } from '@/services/trade/tradeTypes';
import { loadXSniperHistory } from '@/services/xSniper/xSniperHistory';
import { createTelegramPoller } from './poller';
import { isTelegramConfigured, telegramSendMessageWithOptions, type TelegramApiConfig } from './api';
import { formatCountShort } from '@/utils/format';

const TG_LIMIT_ORDER_DISPLAY_MODE_KEY = 'dagobang_limit_order_price_display_mode_v1';
const TG_DEFAULT_TOKEN_SUPPLY = 1_000_000_000;

type TelegramNotifierLike = {
  notifyQuickTrade?: (text: string) => Promise<any>;
};

export function createTelegramController(deps: {
  broadcastTradeSuccess: (payload: any) => Promise<void>;
  broadcastStateChange: () => Promise<void>;
  notifier?: TelegramNotifierLike;
  fetchGmgnHoldings?: (chain: string, walletAddress: string) => Promise<any[]>;
  fetchGmgnHoldingDetail?: (chain: string, walletAddress: string, tokenAddress: string) => Promise<any | null>;
}) {
  const pendingInputByChat = new Map<string, 'buyAmountBnb' | 'buyNewCaCount' | 'quickBuyPresets' | 'quickSellPresets'>();
  const getTelegramConfigFromSettings = async (): Promise<TelegramApiConfig | null> => {
    const settings = await SettingsService.get();
    const tg = (settings as any).telegram;
    const cfg = {
      botToken: String(tg?.botToken || '').trim(),
      chatId: String(tg?.chatId || '').trim(),
    };
    if (tg?.enabled !== true) return null;
    return isTelegramConfigured(cfg) ? cfg : null;
  };

  const sendTelegramReply = async (
    text: string,
    options?: { inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>> }
  ) => {
    const cfg = await getTelegramConfigFromSettings();
    if (!cfg) return false;
    await telegramSendMessageWithOptions(cfg, text, options);
    return true;
  };

  const formatPrice = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v) || v <= 0) return '-';
    if (v >= 1) return `$${v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
    return `$${v.toPrecision(6)}`;
  };
  const formatUsd = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '-';
    if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
    return `$${v.toFixed(2)}`;
  };
  const formatPercent = (ratio: number | null | undefined) => {
    if (ratio == null || !Number.isFinite(ratio)) return '-';
    return `${ratio.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
  };
  const formatAge = (createdAtMs: number | undefined) => {
    if (!Number.isFinite(createdAtMs) || Number(createdAtMs) <= 0) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - Number(createdAtMs)) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour}h`;
    return `${Math.floor(hour / 24)}d`;
  };
  const formatPnlPct = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '-';
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  };
  const toneIcon = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '⚪';
    if (v > 0) return '🟢';
    if (v < 0) return '🔴';
    return '⚪';
  };
  const xSniperSellReasonLabel = (reason: unknown) => {
    const raw = String(reason || '').trim();
    if (raw === 'rapid_take_profit') return '里程碑止盈';
    if (raw === 'rapid_stop_loss') return '硬止损';
    if (raw === 'rapid_trailing_stop') return '地板清仓';
    return raw || '未知';
  };
  const clampPercent = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  };
  const computeWeightedPnlPct = (input: {
    entryMcap: number | null;
    latestMcap: number | null;
    sellRecords: XSniperBuyRecord[];
  }) => {
    const entry = input.entryMcap;
    if (entry == null || !Number.isFinite(entry) || entry <= 0) {
      return { pnlPct: null as number | null, soldPct: 0, remainPct: 100 };
    }
    const sortedSells = input.sellRecords
      .filter((x) => x && x.side === 'sell')
      .slice()
      .sort((a, b) => (Number(a.tsMs) || 0) - (Number(b.tsMs) || 0));
    let soldPct = 0;
    let pricedSoldPct = 0;
    let weightedRoi = 0;
    for (const s of sortedSells) {
      const nextPct = clampPercent(s.sellPercent);
      const effectivePct = Math.min(nextPct, Math.max(0, 100 - soldPct));
      if (!(effectivePct > 0)) continue;
      const sellMcap = typeof s.marketCapUsd === 'number' && Number.isFinite(s.marketCapUsd) ? s.marketCapUsd : input.latestMcap;
      if (sellMcap != null && Number.isFinite(sellMcap) && sellMcap > 0) {
        weightedRoi += (effectivePct / 100) * ((sellMcap / entry) - 1);
        pricedSoldPct += effectivePct;
      }
      soldPct += effectivePct;
    }
    const remainPct = Math.max(0, 100 - soldPct);
    if (remainPct > 0 && input.latestMcap != null && Number.isFinite(input.latestMcap) && input.latestMcap > 0) {
      weightedRoi += (remainPct / 100) * ((input.latestMcap / entry) - 1);
    }
    if (pricedSoldPct < soldPct && (remainPct <= 0 || input.latestMcap == null || !Number.isFinite(input.latestMcap) || input.latestMcap <= 0)) {
      return { pnlPct: null as number | null, soldPct, remainPct };
    }
    return { pnlPct: weightedRoi * 100, soldPct, remainPct };
  };
  const readEvalMcap = (r: XSniperBuyRecord) => {
    const keys: Array<keyof XSniperBuyRecord> = ['eval3s', 'eval5s', 'eval8s', 'eval10s', 'eval15s', 'eval20s', 'eval25s', 'eval30s', 'eval60s'];
    return keys
      .map((k) => Number(((r as any)?.[k] as any)?.marketCapUsd))
      .filter((n) => Number.isFinite(n) && n > 0) as number[];
  };

  const getLimitOrderDisplayMode = async (): Promise<'price' | 'marketCap'> => {
    try {
      const res = await browser.storage.local.get(TG_LIMIT_ORDER_DISPLAY_MODE_KEY);
      const raw = (res as any)?.[TG_LIMIT_ORDER_DISPLAY_MODE_KEY];
      return raw === 'marketCap' ? 'marketCap' : 'price';
    } catch {
      return 'price';
    }
  };
  const triggerTextByMode = (triggerPriceUsd: number, mode: 'price' | 'marketCap') => {
    const priceText = `$${Number(triggerPriceUsd).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
    if (mode !== 'marketCap') return `触发价: ${priceText}`;
    const estMarketCap = Number(triggerPriceUsd) * TG_DEFAULT_TOKEN_SUPPLY;
    if (!Number.isFinite(estMarketCap) || estMarketCap <= 0) return `触发价: ${priceText}`;
    return `触发市值: ${formatUsd(estMarketCap)}`;
  };

  const formatTokenAmount = (rawWei: string, decimals: number) => {
    try {
      const value = Number(formatUnits(BigInt(rawWei), decimals));
      if (!Number.isFinite(value)) return '-';
      if (value >= 1) return value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
    } catch {
      return '-';
    }
  };
  const orderTypeLabel = (orderType: string | undefined, side: 'buy' | 'sell') => {
    if (orderType === 'low_buy') return '低价买';
    if (orderType === 'high_buy') return '高价买';
    if (orderType === 'take_profit_sell') return '止盈卖';
    if (orderType === 'stop_loss_sell') return '止损卖';
    if (orderType === 'trailing_stop_sell') return '移动止盈卖';
    return side === 'buy' ? '买入' : '卖出';
  };
  const orderStatusLabel = (status: string) => {
    if (status === 'open') return '等待';
    if (status === 'triggered') return '触发中';
    if (status === 'executed') return '已执行';
    if (status === 'failed') return '失败';
    if (status === 'cancelled') return '已取消';
    return status;
  };
  const compactTokenLabel = (value: string | undefined, max = 8) => {
    const s = String(value || '').trim();
    if (!s) return 'Token';
    return s.length > max ? `${s.slice(0, max)}..` : s;
  };
  const formatHoldingAmount = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return raw;
    if (Math.abs(n) >= 1000) return formatCountShort(n) ?? String(n);
    return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') || '0';
  };

  const buildTokenActionKeyboard = (tokenAddress: `0x${string}`, buyPresets: string[], sellPresets: string[]) => {
    const buyBase = buyPresets && buyPresets.length ? buyPresets : ['0.1', '0.5', '1', '2'];
    const sellBase = sellPresets && sellPresets.length ? sellPresets : ['25', '50', '75', '100'];
    const buy4 = [...buyBase.slice(0, 4)];
    const sell4 = [...sellBase.slice(0, 4)];
    while (buy4.length < 4) buy4.push(buy4[buy4.length - 1] || '0.1');
    while (sell4.length < 4) sell4.push(sell4[sell4.length - 1] || '50');
    return [
      [
        { text: '📋 挂单', callbackData: 'act:orders' },
        { text: '🔄 刷新', callbackData: `act:token:${tokenAddress}` },
      ],
      [
        { text: `买 ${buy4[0]} BNB`, callbackData: `act:buy:${tokenAddress}:${buy4[0]}` },
        { text: `买 ${buy4[1]} BNB`, callbackData: `act:buy:${tokenAddress}:${buy4[1]}` },
      ],
      [
        { text: `买 ${buy4[2]} BNB`, callbackData: `act:buy:${tokenAddress}:${buy4[2]}` },
        { text: `买 ${buy4[3]} BNB`, callbackData: `act:buy:${tokenAddress}:${buy4[3]}` },
      ],
      [
        { text: `🔴 卖 ${sell4[0]}%`, callbackData: `act:sell:${tokenAddress}:${sell4[0]}` },
        { text: `🔴 卖 ${sell4[1]}%`, callbackData: `act:sell:${tokenAddress}:${sell4[1]}` },
      ],
      [
        { text: `🔴 卖 ${sell4[2]}%`, callbackData: `act:sell:${tokenAddress}:${sell4[2]}` },
        { text: `🔴 卖 ${sell4[3]}%`, callbackData: `act:sell:${tokenAddress}:${sell4[3]}` },
      ],
      [
        { text: '↩️ 返回菜单', callbackData: 'act:menu' },
        { text: '⚙️ 钱包', callbackData: 'act:wallets' },
      ],
    ];
  };
  const buildMainMenuKeyboard = () => [
    [{ text: '插件状态', callbackData: 'act:status' }, { text: '挂单列表', callbackData: 'act:orders' }],
    [{ text: '持仓列表', callbackData: 'act:holdings' }, { text: '钱包列表', callbackData: 'act:wallets' }],
    [{ text: '⚙️ 设置', callbackData: 'act:settings' }, { text: '当前钱包', callbackData: 'act:whoami' }],
    [{ text: '使用说明', callbackData: 'act:menu' }],
  ];
  const buildSettingsMenuKeyboard = () => [
    [{ text: '🎯 推文狙击', callbackData: 'act:xset' }],
    [{ text: '⚡ 快捷交易', callbackData: 'act:qset' }],
    [{ text: '↩️ 返回菜单', callbackData: 'act:menu' }],
  ];
  const buildXSniperSettingsKeyboard = (input: { dryRun: boolean; autoSellEnabled: boolean; buyAmountBnb: string; buyNewCaCount: number }) => ([
    [
      { text: `${input.dryRun ? '✅' : '❌'} DryRun`, callbackData: `act:xsdry:${input.dryRun ? '0' : '1'}` },
      { text: `${input.autoSellEnabled ? '✅' : '❌'} 自动卖出`, callbackData: `act:xsell:${input.autoSellEnabled ? '0' : '1'}` },
    ],
    [
      { text: '⌨️ 输入买入金额', callbackData: 'act:xsamtin' },
      { text: '⌨️ 输入CA数量', callbackData: 'act:xscain' },
    ],
    [{ text: '↩️ 设置菜单', callbackData: 'act:settings' }],
  ]);
  const buildQuickTradeSettingsKeyboard = () => ([
    [
      { text: '⌨️ 输入买入金额', callbackData: 'act:qbuyin' },
      { text: '⌨️ 输入卖出金额', callbackData: 'act:qsellin' },
    ],
    [{ text: '↩️ 设置菜单', callbackData: 'act:settings' }],
  ]);
  const applyTwitterSnipePatch = (settings: any, patch: Record<string, any>) => {
    const autoTrade = { ...(settings as any).autoTrade };
    const twitterSnipe = { ...(autoTrade as any).twitterSnipe };
    Object.assign(twitterSnipe, patch);
    const presets = Array.isArray(twitterSnipe.presets) ? [...twitterSnipe.presets] : [];
    const activePresetId = typeof twitterSnipe.activePresetId === 'string' ? twitterSnipe.activePresetId.trim() : '';
    if (activePresetId) {
      twitterSnipe.presets = presets.map((item: any) => {
        if (!item || item.id !== activePresetId) return item;
        return {
          ...item,
          strategy: {
            ...(item.strategy ?? {}),
            ...patch,
          },
        };
      });
    }
    autoTrade.twitterSnipe = twitterSnipe;
    return autoTrade;
  };
  const sendTelegramSettingsMenu = async () => {
    await sendTelegramReply(
      ['⚙️ 设置', '', '可配置项：', '1) 推文狙击'].join('\n'),
      { inlineKeyboard: buildSettingsMenuKeyboard() }
    );
  };
  const sendTelegramXSniperSettings = async () => {
    const settings = await SettingsService.get();
    const dryRun = (settings as any)?.autoTrade?.twitterSnipe?.dryRun === true;
    const autoSellEnabled = (settings as any)?.autoTrade?.twitterSnipe?.autoSellEnabled === true;
    const buyAmountRaw = String((settings as any)?.autoTrade?.twitterSnipe?.buyAmountBnb ?? '0.1').trim();
    const buyAmountBnb = Number.isFinite(Number(buyAmountRaw)) && Number(buyAmountRaw) > 0 ? buyAmountRaw : '0.1';
    const buyNewCaCount = Number((settings as any)?.autoTrade?.twitterSnipe?.buyNewCaCount ?? 1);
    const buyCaCount = Number.isFinite(buyNewCaCount) ? Math.max(0, Math.floor(buyNewCaCount)) : 1;
    await sendTelegramReply(
      [
        '🎯 推文狙击设置',
        '',
        `DryRun: ${dryRun ? '开启' : '关闭'}`,
        `自动卖出: ${autoSellEnabled ? '开启' : '关闭'}`,
        `策略买入金额(BNB): ${buyAmountBnb}`,
        `买入CA数量: ${buyCaCount}`,
      ].join('\n'),
      { inlineKeyboard: buildXSniperSettingsKeyboard({ dryRun, autoSellEnabled, buyAmountBnb, buyNewCaCount: buyCaCount }) }
    );
  };
  const sendTelegramQuickTradeSettings = async () => {
    const settings = await SettingsService.get();
    const chainId = settings.chainId;
    const chain = (settings.chains as any)?.[chainId] ?? {};
    const buyPresets = Array.isArray(chain.buyPresets) ? chain.buyPresets.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 4) : ['0.1', '0.5', '1.0', '2.0'];
    const sellPresets = Array.isArray(chain.sellPresets) ? chain.sellPresets.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 4) : ['25', '50', '75', '100'];
    await sendTelegramReply(
      [
        '⚡ 快捷交易设置',
        '',
        `买入金额(BNB): ${buyPresets.join(',')}`,
        `卖出金额(%): ${sellPresets.join(',')}`,
        '',
        '输入规则: 4个数字，英文逗号分隔',
      ].join('\n'),
      { inlineKeyboard: buildQuickTradeSettingsKeyboard() }
    );
  };
  const sendTelegramMenu = async () => {
    await sendTelegramReply(
      ['Dagobang Telegram 菜单', '', '1) 直接发送 tokenAddress 查看快照与持仓', '2) 使用按钮快速查看状态、持仓和挂单', '3) Token 快照里可一键买卖', '', '命令:', '/menu', '/settings', '/status', '/holdings', '/wallets', '/whoami', '/switch <address|name>', '/orders', '/token <tokenAddress>'].join('\n'),
      { inlineKeyboard: buildMainMenuKeyboard() }
    );
  };
  const shortAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  const buildWalletListKeyboard = (accounts: Array<{ address: string; name?: string }>) => {
    const rows = accounts.slice(0, 12).map((acc, idx) => ([
      { text: `切换 #${idx + 1}`, callbackData: `act:switch:${acc.address}` },
      { text: shortAddress(acc.address), callbackData: `act:switch:${acc.address}` },
    ]));
    rows.push([{ text: '返回菜单', callbackData: 'act:menu' }]);
    return rows;
  };
  const resolveSwitchWalletTarget = (targetRaw: string, accounts: Array<{ address: string; name?: string }>): string | null => {
    const target = targetRaw.trim().toLowerCase();
    if (!target) return null;
    return (
      accounts.find((a) => a.address.toLowerCase() === target)?.address ||
      accounts.find((a) => a.address.toLowerCase().includes(target))?.address ||
      accounts.find((a) => (a.name || '').trim().toLowerCase() === target)?.address ||
      null
    );
  };

  const resolveQuickTradeTokenInfo = async (tokenAddress: `0x${string}`): Promise<TokenInfo | null> => {
    try {
      const byHttp = await FourmemeAPI.getTokenInfo('bsc', tokenAddress);
      if (byHttp) return byHttp;
    } catch { }
    try {
      const meta = await TokenService.getMeta(tokenAddress);
      return {
        chain: 'bsc',
        address: tokenAddress,
        name: meta?.symbol || tokenAddress,
        symbol: meta?.symbol || 'TOKEN',
        decimals: Number(meta?.decimals ?? 18),
        logo: '',
        launchpad: '',
        launchpad_progress: 0,
        launchpad_platform: '',
        launchpad_status: 1,
        quote_token: 'WBNB',
        quote_token_address: ZERO_ADDRESS,
      };
    } catch {
      return null;
    }
  };

  const buildTelegramTokenSnapshot = async (tokenAddress: `0x${string}`) => {
    const settings = await SettingsService.get();
    const chainId = settings.chainId;
    const tokenInfo = await resolveQuickTradeTokenInfo(tokenAddress);
    if (!tokenInfo) return null;
    const symbol = tokenInfo.symbol || 'TOKEN';
    const name = tokenInfo.name || symbol;
    const decimals = Number(tokenInfo.decimals ?? 18);
    const marketCapRaw = Number((tokenInfo as any)?.tokenPrice?.marketCap ?? 0);
    const apiMarketCapUsd = Number.isFinite(marketCapRaw) && marketCapRaw > 0 ? marketCapRaw : null;
    const apiPriceRaw = Number((tokenInfo as any)?.tokenPrice?.price ?? 0);
    const apiPriceUsd = Number.isFinite(apiPriceRaw) && apiPriceRaw > 0 ? apiPriceRaw : null;
    const rpcPriceUsd = await TokenService.getTokenPriceUsdFromRpc({ chainId, tokenAddress, tokenInfo, cacheTtlMs: 3000, allowTokenInfoPriceFallback: true }).catch(() => 0);
    const normalizedRpcPriceUsd = Number.isFinite(rpcPriceUsd) && rpcPriceUsd > 0 ? rpcPriceUsd : null;
    let normalizedPriceUsd = normalizedRpcPriceUsd ?? apiPriceUsd;
    const isInnerDisk = Number((tokenInfo as any)?.launchpad_status ?? 1) !== 1;
    if (!normalizedPriceUsd && isInnerDisk && apiMarketCapUsd) normalizedPriceUsd = apiMarketCapUsd / TG_DEFAULT_TOKEN_SUPPLY;
    const marketCapByPrice = normalizedPriceUsd ? normalizedPriceUsd * TG_DEFAULT_TOKEN_SUPPLY : null;
    const marketCapUsd = isInnerDisk ? (marketCapByPrice ?? apiMarketCapUsd) : (apiMarketCapUsd ?? marketCapByPrice);

    const status = await WalletService.getStatus();
    const holderAddress = status.address;
    let balanceWei = '0';
    let balanceAmount = '-';
    let balanceUsd: number | null = null;
    if (holderAddress) {
      balanceWei = await TokenService.getBalance(tokenAddress, holderAddress).catch(() => '0');
      balanceAmount = formatTokenAmount(balanceWei, decimals);
      if (normalizedPriceUsd && balanceAmount !== '-') {
        const n = Number(balanceAmount);
        if (Number.isFinite(n)) balanceUsd = n * normalizedPriceUsd;
      }
    }
    return { chainId, tokenAddress, symbol, name, priceUsd: normalizedPriceUsd, marketCapUsd, holderAddress, balanceWei, balanceAmount, balanceUsd };
  };

  const sendXSniperOrderCard = async (orderId: string) => {
    const history = await loadXSniperHistory();
    const record = history.find((r) => String(r?.id || '') === orderId) as XSniperBuyRecord | undefined;
    if (!record) {
      await sendTelegramReply('未找到该推文狙击订单记录（可能已过期）', {
        inlineKeyboard: [[{ text: '↩️ 菜单', callbackData: 'act:menu' }]],
      });
      return;
    }
    const addrKey = String(record.tokenAddress || '').toLowerCase();
    const groupKey = `${record.dryRun === true ? 'dry:' : ''}${record.chainId}:${addrKey}`;
    const grouped = history
      .filter((r) => {
        if (!r || typeof r.chainId !== 'number') return false;
        const key = `${r.dryRun === true ? 'dry:' : ''}${r.chainId}:${String(r.tokenAddress || '').toLowerCase()}`;
        return key === groupKey;
      })
      .sort((a, b) => (Number(b.tsMs) || 0) - (Number(a.tsMs) || 0));
    const parent =
      grouped.find((x) => x && x.side !== 'sell' && x.reason !== 'ws_confirm_failed') ??
      grouped[0] ??
      record;
    const sellRecords = grouped.filter((x) => x && x.side === 'sell');

    const tokenAddress = String(parent.tokenAddress || '').trim() as `0x${string}`;
    const snapshot = /^0x[a-fA-F0-9]{40}$/.test(tokenAddress)
      ? await buildTelegramTokenSnapshot(tokenAddress).catch(() => null)
      : null;
    const entryMcap = typeof parent.marketCapUsd === 'number' && Number.isFinite(parent.marketCapUsd) ? parent.marketCapUsd : null;
    const latestMcap = snapshot && typeof snapshot.marketCapUsd === 'number' && Number.isFinite(snapshot.marketCapUsd)
      ? snapshot.marketCapUsd
      : null;
    const athCandidates: number[] = [];
    if (latestMcap != null) athCandidates.push(latestMcap);
    for (const r of grouped) {
      if (typeof r.marketCapUsd === 'number' && Number.isFinite(r.marketCapUsd) && r.marketCapUsd > 0) athCandidates.push(r.marketCapUsd);
      if (typeof r.athMarketCapUsd === 'number' && Number.isFinite(r.athMarketCapUsd) && r.athMarketCapUsd > 0) athCandidates.push(r.athMarketCapUsd);
      athCandidates.push(...readEvalMcap(r));
    }
    const athMcap = athCandidates.length ? Math.max(...athCandidates) : null;
    const weighted = computeWeightedPnlPct({ entryMcap, latestMcap, sellRecords });
    const pnlPct = weighted.pnlPct;
    const pnlAthPct =
      entryMcap != null && athMcap != null && Number.isFinite(entryMcap) && entryMcap > 0
        ? ((athMcap / entryMcap) - 1) * 100
        : null;
    const reasonStats = (() => {
      const acc = {
        tpCount: 0,
        tpPct: 0,
        slCount: 0,
        slPct: 0,
        floorCount: 0,
        floorPct: 0,
        otherCount: 0,
        otherPct: 0,
      };
      for (const s of sellRecords) {
        const pct = clampPercent(s.sellPercent);
        const reason = String(s.reason || '').trim();
        if (reason === 'rapid_take_profit') {
          acc.tpCount += 1;
          acc.tpPct += pct;
          continue;
        }
        if (reason === 'rapid_stop_loss') {
          acc.slCount += 1;
          acc.slPct += pct;
          continue;
        }
        if (reason === 'rapid_trailing_stop') {
          acc.floorCount += 1;
          acc.floorPct += pct;
          continue;
        }
        acc.otherCount += 1;
        acc.otherPct += pct;
      }
      return acc;
    })();
    const latestSell = sellRecords.length
      ? sellRecords
        .slice()
        .sort((a, b) => (Number(a.tsMs) || 0) - (Number(b.tsMs) || 0))[sellRecords.length - 1]
      : null;

    const mode = parent.dryRun ? '🧪 DryRun' : '✅ 实盘';
    const screen = String(parent.userScreen || '').trim();
    const user = String(parent.userName || '').trim();
    const account = screen ? `@${screen}` : (user || '-');
    const symbol = String(parent.tokenSymbol || parent.tokenName || 'TOKEN').trim();
    const priceDeltaPct =
      entryMcap != null && latestMcap != null && Number.isFinite(entryMcap) && entryMcap > 0
        ? ((latestMcap / entryMcap) - 1) * 100
        : null;
    const pnlIcon = toneIcon(pnlPct);
    const athPnlIcon = toneIcon(pnlAthPct);
    const priceIcon = toneIcon(priceDeltaPct);
    await sendTelegramReply(
      [
        `🎯 推文狙击订单 ${mode}`,
        `🧾 基本信息`,
        `订单: ${parent.id}`,
        `代币: ${symbol} | ${shortAddress(parent.tokenAddress)}`,
        '',
        `📦 仓位与执行`,
        `仓位: 已卖 ${weighted.soldPct.toFixed(1)}% | 剩余 ${weighted.remainPct.toFixed(1)}%`,
        `里程碑: 止盈 ${reasonStats.tpCount}次/${reasonStats.tpPct.toFixed(1)}% | 止损 ${reasonStats.slCount}次/${reasonStats.slPct.toFixed(1)}% | 地板 ${reasonStats.floorCount}次/${reasonStats.floorPct.toFixed(1)}%`,
        latestSell
          ? `最近卖出: ${xSniperSellReasonLabel(latestSell.reason)} ${latestSell.sellPercent != null ? `${clampPercent(latestSell.sellPercent).toFixed(1)}%` : ''}`.trim()
          : '最近卖出: -',
        '',
        `📈 价格与PnL`,
        `${pnlIcon} PnL(MCap): ${formatPnlPct(pnlPct)} | ${athPnlIcon} ATH PnL: ${formatPnlPct(pnlAthPct)}`,
        `${priceIcon} 市值: 入场 ${formatUsd(entryMcap)} | 当前 ${formatUsd(latestMcap)} | ATH ${formatUsd(athMcap)}`,
        `买入: ${parent.buyAmountBnb != null ? `${parent.buyAmountBnb} BNB` : '-'} | 入场价: ${formatPrice(parent.entryPriceUsd)}`,
        '',
        `📊 市场指标`,
        `持有人: ${Number.isFinite(parent.holders) ? Number(parent.holders) : '-'} | KOL: ${Number.isFinite(parent.kol) ? Number(parent.kol) : '-'} | Smart: ${Number.isFinite(parent.smartMoney) ? Number(parent.smartMoney) : '-'}`,
        `Dev持仓: ${parent.devHoldPercent != null ? `${parent.devHoldPercent.toFixed(2)}%` : '-'} | Dev卖出: ${parent.devHasSold === true ? '是' : parent.devHasSold === false ? '否' : '-'}`,
        `24h: Vol ${formatUsd(parent.vol24hUsd)} | NetBuy ${formatUsd(parent.netBuy24hUsd)} | Buy/Sell ${parent.buyTx24h ?? '-'} / ${parent.sellTx24h ?? '-'}`,
        '',
        `🐦 推文信息`,
        `代币Age: ${formatAge(parent.createdAtMs)}`,
        `推文类型: ${parent.tweetType || '-'}`,
        `推文账户: ${account}`,
        `推文链接: ${parent.tweetUrl || '-'}`,
      ].join('\n'),
      {
        inlineKeyboard: [
          [
            { text: '🔄 刷新', callbackData: `act:xso:${parent.id}` },
            { text: '🔍 查看代币', callbackData: `act:token:${parent.tokenAddress}` },
          ],
        ],
      }
    );
  };

  const runTelegramQuickBuy = async (tokenAddress: `0x${string}`, amountBnb: string) => {
    const settings = await SettingsService.get();
    const status = await WalletService.getStatus();
    if (status.locked) {
      await sendTelegramReply('买入失败: 钱包未解锁');
      return { ok: false, error: { message: 'wallet_locked' } };
    }
    const tokenInfo = await resolveQuickTradeTokenInfo(tokenAddress);
    if (!tokenInfo) {
      await sendTelegramReply('买入失败: 无法获取 Token 信息');
      return { ok: false, error: { message: 'token_info_missing' } };
    }
    const amountWei = parseEther(String(amountBnb).trim()).toString();
    const rsp = await TradeService.buyWithReceiptAndNonceRecovery({ chainId: settings.chainId, tokenAddress, bnbAmountWei: amountWei, tokenInfo }, {
      maxRetry: 1,
      onSubmitted: async (ctx) => {
        await deps.broadcastTradeSuccess({ type: 'bg:tradeSubmitted', source: 'telegram', side: 'buy', chainId: settings.chainId, tokenAddress, txHash: ctx.txHash, submitElapsedMs: ctx.submitElapsedMs });
      },
    });
    await deps.broadcastTradeSuccess({ type: 'bg:tradeSuccess', source: 'telegram', side: 'buy', chainId: settings.chainId, tokenAddress, txHash: (rsp as any)?.txHash, submitElapsedMs: (rsp as any)?.submitElapsedMs, receiptElapsedMs: (rsp as any)?.receiptElapsedMs, totalElapsedMs: (rsp as any)?.totalElapsedMs, broadcastVia: (rsp as any)?.broadcastVia, broadcastUrl: (rsp as any)?.broadcastUrl, isBundle: (rsp as any)?.isBundle });
    await deps.notifier?.notifyQuickTrade?.(`Telegram 快速买入成功\nToken: ${tokenAddress}\nTx: ${(rsp as any)?.txHash || '-'}`);
    return { ok: true, ...rsp };
  };

  const runTelegramQuickSell = async (tokenAddress: `0x${string}`, sellPercent: number) => {
    const settings = await SettingsService.get();
    const status = await WalletService.getStatus();
    if (status.locked || !status.address) {
      await sendTelegramReply('卖出失败: 钱包未解锁');
      return { ok: false, error: { message: 'wallet_locked' } };
    }
    const tokenInfo = await resolveQuickTradeTokenInfo(tokenAddress);
    if (!tokenInfo) {
      await sendTelegramReply('卖出失败: 无法获取 Token 信息');
      return { ok: false, error: { message: 'token_info_missing' } };
    }
    const balanceWei = BigInt(await TokenService.getBalance(tokenAddress, status.address));
    const pct = Math.max(1, Math.min(100, Math.floor(sellPercent)));
    const amountWei = (balanceWei * BigInt(pct)) / 100n;
    if (amountWei <= 0n) {
      await sendTelegramReply('卖出失败: 可卖余额不足');
      return { ok: false, error: { message: 'no_balance' } };
    }
    const rsp = await TradeService.sellWithReceiptAndAutoRecovery({ chainId: settings.chainId, tokenAddress, tokenAmountWei: amountWei.toString(), sellPercentBps: pct * 100, expectedTokenInWei: balanceWei.toString(), tokenInfo }, {
      maxRetry: 1,
      onSubmitted: async (ctx) => {
        await deps.broadcastTradeSuccess({ type: 'bg:tradeSubmitted', source: 'telegram', side: 'sell', chainId: settings.chainId, tokenAddress, txHash: ctx.txHash, submitElapsedMs: ctx.submitElapsedMs });
      },
    });
    await deps.broadcastTradeSuccess({ type: 'bg:tradeSuccess', source: 'telegram', side: 'sell', chainId: settings.chainId, tokenAddress, txHash: (rsp as any)?.txHash, submitElapsedMs: (rsp as any)?.submitElapsedMs, receiptElapsedMs: (rsp as any)?.receiptElapsedMs, totalElapsedMs: (rsp as any)?.totalElapsedMs, broadcastVia: (rsp as any)?.broadcastVia, broadcastUrl: (rsp as any)?.broadcastUrl, isBundle: (rsp as any)?.isBundle });
    await deps.notifier?.notifyQuickTrade?.(`Telegram 快速卖出成功\nToken: ${tokenAddress}\n比例: ${pct}%\nTx: ${(rsp as any)?.txHash || '-'}`);
    return { ok: true, ...rsp };
  };

  const loadHoldingCandidates = async (chainId: number): Promise<`0x${string}`[]> => {
    const out = new Set<string>();
    const orders = await listLimitOrders(chainId).catch(() => []);
    for (const o of orders) {
      if (typeof o?.tokenAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(o.tokenAddress)) {
        out.add(o.tokenAddress.toLowerCase());
      }
    }
    const historyKeys = ['dagobang_xsniper_order_history_v1', 'dagobang_token_sniper_order_history_v1'];
    try {
      const res = await browser.storage.local.get(historyKeys as any);
      for (const key of historyKeys) {
        const list = (res as any)?.[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const addr = String(item?.tokenAddress || '').trim();
          if (/^0x[a-fA-F0-9]{40}$/.test(addr)) out.add(addr.toLowerCase());
          if (out.size >= 80) break;
        }
      }
    } catch {
    }
    return Array.from(out).slice(0, 80) as `0x${string}`[];
  };

  const sendHoldings = async (chainId: number, walletAddress: `0x${string}`) => {
    const pickNum = (obj: any, keys: string[]) => {
      for (const k of keys) {
        const v = k.includes('.') ? k.split('.').reduce<any>((acc, p) => (acc == null ? undefined : acc[p]), obj) : obj?.[k];
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return null as number | null;
    };
    const toNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const calcMarketCapFromHolding = (h: any) => {
      const priceNum = toNum(h?.price ?? h?.token?.price);
      if (priceNum == null || priceNum <= 0) return null;
      const totalSupply = toNum(h?.token?.max_supply ?? h?.token?.total_supply ?? h?.max_supply ?? h?.total_supply);
      if (totalSupply == null || totalSupply <= 0) return null;
      return totalSupply * priceNum;
    };
    const formatPnlPercent = (ratio: number | null) => {
      if (ratio == null || !Number.isFinite(ratio)) return '-';
      const pct = ratio * 100;
      const sign = pct > 0 ? '+' : '';
      return `${sign}${pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
    };
    const chainCode = chainId === 56 ? 'bsc' : String(chainId);
    try {
      const gmgnHoldings = await deps.fetchGmgnHoldings?.(chainCode, walletAddress);
      if (Array.isArray(gmgnHoldings) && gmgnHoldings.length > 0) {
        const normalized = gmgnHoldings
          .map((h: any) => {
            const tokenAddress = String(h?.token_address || '').toLowerCase();
            if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return null;
            const symbol = String(h?.symbol || h?.token_symbol || h?.token?.symbol || 'TOKEN');
            const balanceNum = Number(h?.balance ?? 0);
            const priceNum = Number(h?.price ?? h?.token?.price ?? 0);
            const usdValue = pickNum(h, ['usd_value', 'value_usd']);
            const usd = usdValue != null
              ? usdValue
              : (Number.isFinite(balanceNum) && Number.isFinite(priceNum) ? balanceNum * priceNum : 0);
            const marketCap = calcMarketCapFromHolding(h);
            const totalCostUsdRaw = pickNum(h, ['accu_cost', 'history_bought_cost', 'total_cost_usd', 'cost_usd', 'total_cost', 'cost', 'buy_amount_usd', 'buy_value_usd']);
            const costUsd = totalCostUsdRaw;
            let pnlUsd = pickNum(h, ['total_profit', 'unrealized_profit', 'realized_profit', 'pnl_usd', 'unrealized_pnl_usd', 'profit_usd', 'pnl', 'profit']);
            if (pnlUsd == null && totalCostUsdRaw != null && Number.isFinite(usd)) {
              pnlUsd = usd - totalCostUsdRaw;
            }
            const pnlRatio = pickNum(h, ['total_profit_pnl', 'unrealized_profit_pnl', 'pnl_ratio', 'profit_pnl']);
            return {
              tokenAddress: tokenAddress as `0x${string}`,
              symbol,
              amountText: Number.isFinite(balanceNum) ? String(balanceNum) : '-',
              usd: Number.isFinite(usd) ? usd : 0,
              marketCapUsd: marketCap,
              costUsd,
              pnlUsd,
              pnlRatio,
            };
          })
          .filter(Boolean) as Array<{ tokenAddress: `0x${string}`; symbol: string; amountText: string; usd: number; marketCapUsd: number | null; costUsd: number | null; pnlUsd: number | null; pnlRatio: number | null }>;

        if (normalized.length > 0) {
          normalized.sort((a, b) => (b.usd || 0) - (a.usd || 0));
          const top = normalized.slice(0, 12);
          const totalUsd = normalized.reduce((s, r) => s + (Number.isFinite(r.usd) ? r.usd : 0), 0);
          const lines = top.map((r, i) => {
            const amountShort = formatHoldingAmount(r.amountText);
            const pnlText = r.pnlUsd != null ? formatUsd(r.pnlUsd) : '-';
            const pnlPct = formatPnlPercent(r.pnlRatio);
            const pnlIcon = (r.pnlUsd ?? 0) > 0 || (r.pnlRatio ?? 0) > 0 ? '🟢' : (r.pnlUsd ?? 0) < 0 || (r.pnlRatio ?? 0) < 0 ? '🔴' : '⚪';
            return `${i + 1}) ${compactTokenLabel(r.symbol, 10)} | ${amountShort} | 持仓${formatUsd(r.usd)} | 市值${formatUsd(r.marketCapUsd)} | ${pnlIcon}PnL ${pnlText} (${pnlPct})`;
          });
          const viewRows = top.slice(0, 6).map((r, i) => ([{ text: `🔍 查看#${i + 1} ${compactTokenLabel(r.symbol, 8)}`, callbackData: `act:token:${r.tokenAddress}` }]));
          await sendTelegramReply(
            ['💼 持仓', `地址: ${shortAddress(walletAddress)}`, `总估值: ${formatUsd(totalUsd)}`, `显示: ${top.length}/${normalized.length}`, '', ...lines].join('\n'),
            { inlineKeyboard: [...viewRows, [{ text: '🔄 刷新持仓', callbackData: 'act:holdings' }, { text: '↩️ 菜单', callbackData: 'act:menu' }]] }
          );
          return;
        }
      }
    } catch {
    }

    const candidates = await loadHoldingCandidates(chainId);
    if (!candidates.length) {
      await sendTelegramReply('暂无可查询的持仓代币。先交易/挂单后再试。', {
        inlineKeyboard: [[{ text: '🔄 刷新持仓', callbackData: 'act:holdings' }, { text: '↩️ 菜单', callbackData: 'act:menu' }]],
      });
      return;
    }
    const rows = (await Promise.all(candidates.map(async (tokenAddress) => {
      try {
        const [meta, balanceWei] = await Promise.all([
          TokenService.getMeta(tokenAddress),
          TokenService.getBalance(tokenAddress, walletAddress),
        ]);
        const bal = BigInt(balanceWei || '0');
        if (bal <= 0n) return null;
        const decimals = Number(meta?.decimals ?? 18);
        const amountNum = Number(formatUnits(bal, decimals));
        if (!Number.isFinite(amountNum) || amountNum <= 0) return null;
        const tokenInfo = await resolveQuickTradeTokenInfo(tokenAddress).catch(() => null);
        const px = await TokenService.getTokenPriceUsdFromRpc({
          chainId,
          tokenAddress,
          tokenInfo: tokenInfo || undefined,
          cacheTtlMs: 3000,
          allowTokenInfoPriceFallback: true,
        }).catch(() => 0);
        const usd = Number.isFinite(px) && px > 0 ? amountNum * px : 0;
        return {
          tokenAddress,
          symbol: String(meta?.symbol || 'TOKEN'),
          amountText: formatTokenAmount(bal.toString(), decimals),
          usd,
        };
      } catch {
        return null;
      }
    }))).filter(Boolean) as Array<{ tokenAddress: `0x${string}`; symbol: string; amountText: string; usd: number }>;

    if (!rows.length) {
      await sendTelegramReply('当前钱包未检测到持仓（基于近期交易代币集合）。', {
        inlineKeyboard: [[{ text: '🔄 刷新持仓', callbackData: 'act:holdings' }, { text: '↩️ 菜单', callbackData: 'act:menu' }]],
      });
      return;
    }
    rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
    const top = rows.slice(0, 12);
    const totalUsd = rows.reduce((s, r) => s + (Number.isFinite(r.usd) ? r.usd : 0), 0);
    const lines = top.map((r, i) => {
      const amountShort = formatHoldingAmount(r.amountText);
      return `${i + 1}) ${compactTokenLabel(r.symbol, 10)} | ${amountShort} | 持仓${formatUsd(r.usd)} | 市值- | ⚪PnL - (-)`;
    });
    const viewRows = top.slice(0, 6).map((r, i) => ([{ text: `🔍 查看#${i + 1} ${compactTokenLabel(r.symbol, 8)}`, callbackData: `act:token:${r.tokenAddress}` }]));
    await sendTelegramReply(
      ['💼 持仓', `钱包: ${walletAddress}`, `总估值: ${formatUsd(totalUsd)}`, `显示: ${top.length}/${rows.length}`, '', ...lines].join('\n'),
      { inlineKeyboard: [...viewRows, [{ text: '🔄 刷新持仓', callbackData: 'act:holdings' }, { text: '↩️ 菜单', callbackData: 'act:menu' }]] }
    );
  };

  const telegramPoller = createTelegramPoller({
    getConfig: getTelegramConfigFromSettings,
    getPollIntervalMs: async () => {
      const settings = await SettingsService.get();
      const n = Number((settings as any).telegram?.pollIntervalMs);
      return Number.isFinite(n) && n >= 1000 && n <= 10000 ? Math.floor(n) : 2000;
    },
    onCommand: async ({ command, rawText, userId, chatId }) => {
      const settings = await SettingsService.get();
      if ((settings as any).telegram?.enabled !== true) return;
      const enforceUserId = (settings as any).telegram?.enforceUserId === true;
      const configuredUserId = String((settings as any).telegram?.userId || '').trim();
      if (enforceUserId && (!configuredUserId || String(userId || '').trim() !== configuredUserId)) return;
      try {
        const isOrdersAction = command.type === 'orders' || command.type === 'actionOrders' || command.type === 'actionOrdersPage';
        const isTokenAction = command.type === 'tokenInfo' || command.type === 'actionTokenInfo';
        const isCancelAction = command.type === 'cancel' || command.type === 'actionCancel';
        const isBuyAction = command.type === 'buy' || command.type === 'actionBuy';
        const isSellAction = command.type === 'sell' || command.type === 'actionSell';
        const isMenuAction = command.type === 'menu' || command.type === 'start' || command.type === 'actionMenu';
        const isSettingsAction = command.type === 'settings' || command.type === 'actionSettings';
        const isXSniperSettingsAction = command.type === 'actionXSniperSettings';
        const isQuickTradeSettingsAction = command.type === 'actionQuickTradeSettings';
        const isSetXSniperDryRunAction = command.type === 'actionSetXSniperDryRun';
        const isSetXSniperAutoSellAction = command.type === 'actionSetXSniperAutoSell';
        const isSetXSniperBuyAmountAction = command.type === 'actionSetXSniperBuyAmount';
        const isSetXSniperBuyCaCountAction = command.type === 'actionSetXSniperBuyCaCount';
        const isInputXSniperBuyAmountAction = command.type === 'actionInputXSniperBuyAmount';
        const isInputXSniperBuyCaCountAction = command.type === 'actionInputXSniperBuyCaCount';
        const isInputQuickBuyPresetsAction = command.type === 'actionInputQuickBuyPresets';
        const isInputQuickSellPresetsAction = command.type === 'actionInputQuickSellPresets';
        const isStatusAction = command.type === 'status' || command.type === 'actionStatus';
        const isHoldingsAction = command.type === 'holdings' || command.type === 'actionHoldings';
        const isWalletsAction = command.type === 'wallets' || command.type === 'actionWallets';
        const isWhoamiAction = command.type === 'whoami' || command.type === 'actionWhoami';
        const isSwitchWalletAction = command.type === 'switchWallet' || command.type === 'actionSwitchWallet';
        const isXSniperOrderAction = command.type === 'actionXSniperOrder';

        if (isMenuAction) {
          await sendTelegramMenu();
          return;
        }
        if (isSettingsAction) {
          await sendTelegramSettingsMenu();
          return;
        }
        if (isXSniperSettingsAction) {
          await sendTelegramXSniperSettings();
          return;
        }
        if (isQuickTradeSettingsAction) {
          await sendTelegramQuickTradeSettings();
          return;
        }
        if (isInputXSniperBuyAmountAction) {
          pendingInputByChat.set(chatId, 'buyAmountBnb');
          await sendTelegramReply('请输入策略买入金额(BNB)，例如: 0.1');
          return;
        }
        if (isInputXSniperBuyCaCountAction) {
          pendingInputByChat.set(chatId, 'buyNewCaCount');
          await sendTelegramReply('请输入买入CA数量（整数），例如: 3');
          return;
        }
        if (isInputQuickBuyPresetsAction) {
          pendingInputByChat.set(chatId, 'quickBuyPresets');
          await sendTelegramReply('请输入买入金额，格式: 0.01,0.2,0.5,1.0');
          return;
        }
        if (isInputQuickSellPresetsAction) {
          pendingInputByChat.set(chatId, 'quickSellPresets');
          await sendTelegramReply('请输入卖出金额(%)，格式: 10,25,50,100');
          return;
        }
        if (isSetXSniperDryRunAction || isSetXSniperAutoSellAction || isSetXSniperBuyAmountAction || isSetXSniperBuyCaCountAction) {
          const nextSettings = await SettingsService.get();
          const patch: Record<string, any> = {};
          if (isSetXSniperDryRunAction) patch.dryRun = command.enabled;
          if (isSetXSniperAutoSellAction) patch.autoSellEnabled = command.enabled;
          if (isSetXSniperBuyAmountAction) patch.buyAmountBnb = command.amountBnb;
          if (isSetXSniperBuyCaCountAction) patch.buyNewCaCount = command.count;
          const autoTrade = applyTwitterSnipePatch(nextSettings, patch);
          await SettingsService.update({ autoTrade } as any);
          pendingInputByChat.delete(chatId);
          await sendTelegramXSniperSettings();
          return;
        }
        if (command.type === 'unknown') {
          const pending = pendingInputByChat.get(chatId);
          if (pending === 'buyAmountBnb') {
            const v = String(rawText || '').trim();
            const n = Number(v);
            if (!Number.isFinite(n) || n <= 0) {
              await sendTelegramReply('输入无效，请输入大于0的数字（例如 0.1）');
              return;
            }
            const nextSettings = await SettingsService.get();
            const autoTrade = applyTwitterSnipePatch(nextSettings, { buyAmountBnb: v });
            await SettingsService.update({ autoTrade } as any);
            pendingInputByChat.delete(chatId);
            await sendTelegramXSniperSettings();
            return;
          }
          if (pending === 'buyNewCaCount') {
            const n = Number(String(rawText || '').trim());
            if (!Number.isFinite(n) || n < 0) {
              await sendTelegramReply('输入无效，请输入整数（例如 3）');
              return;
            }
            const count = Math.max(0, Math.floor(n));
            const nextSettings = await SettingsService.get();
            const autoTrade = applyTwitterSnipePatch(nextSettings, { buyNewCaCount: count });
            await SettingsService.update({ autoTrade } as any);
            pendingInputByChat.delete(chatId);
            await sendTelegramXSniperSettings();
            return;
          }
          if (pending === 'quickBuyPresets' || pending === 'quickSellPresets') {
            const raw = String(rawText || '').trim();
            const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
            if (parts.length !== 4) {
              await sendTelegramReply('输入无效：必须是4个数字，英文逗号分隔。');
              return;
            }
            const allOk = parts.every((p) => Number.isFinite(Number(p)) && Number(p) > 0);
            if (!allOk) {
              await sendTelegramReply('输入无效：请确保4个值都为大于0的数字。');
              return;
            }
            const settings = await SettingsService.get();
            const chainId = settings.chainId;
            const chains = { ...(settings as any).chains };
            const chain = { ...(chains as any)[chainId] };
            if (pending === 'quickBuyPresets') chain.buyPresets = parts;
            if (pending === 'quickSellPresets') chain.sellPresets = parts;
            (chains as any)[chainId] = chain;
            await SettingsService.update({ chains } as any);
            pendingInputByChat.delete(chatId);
            await sendTelegramQuickTradeSettings();
            return;
          }
        }
        if (isStatusAction) {
          const status = await WalletService.getStatus();
          await sendTelegramReply(['插件状态', `链: ${settings.chainId}`, `钱包: ${status.locked ? '已锁定' : '已解锁'}`, `地址: ${status.address || '-'}`].join('\n'), { inlineKeyboard: buildMainMenuKeyboard() });
          return;
        }
        if (isWhoamiAction) {
          const status = await WalletService.getStatus();
          await sendTelegramReply(['当前钱包', `状态: ${status.locked ? '已锁定' : '已解锁'}`, `地址: ${status.address || '-'}`].join('\n'), { inlineKeyboard: buildMainMenuKeyboard() });
          return;
        }
        if (isHoldingsAction) {
          const status = await WalletService.getStatus();
          if (status.locked || !status.address) {
            await sendTelegramReply('钱包已锁定，无法读取持仓', { inlineKeyboard: buildMainMenuKeyboard() });
            return;
          }
          await sendHoldings(settings.chainId, status.address);
          return;
        }
        if (isWalletsAction) {
          const status = await WalletService.getStatus();
          if (status.locked) {
            await sendTelegramReply('钱包已锁定，无法读取钱包列表', { inlineKeyboard: buildMainMenuKeyboard() });
            return;
          }
          const accounts = (status.accounts || []) as Array<{ address: string; name?: string; type?: string }>;
          if (!accounts.length) {
            await sendTelegramReply('当前没有可用钱包账户', { inlineKeyboard: buildMainMenuKeyboard() });
            return;
          }
          const lines = accounts.slice(0, 12).map((acc, idx) => `${idx + 1}. ${(acc.name || '未命名')} | ${acc.address}${acc.address.toLowerCase() === String(status.address || '').toLowerCase() ? ' [当前]' : ''}`);
          await sendTelegramReply(['钱包列表', ...lines, '', '可用: /switch <address|name>'].join('\n'), { inlineKeyboard: buildWalletListKeyboard(accounts) });
          return;
        }
        if (isSwitchWalletAction) {
          const status = await WalletService.getStatus();
          if (status.locked) {
            await sendTelegramReply('钱包已锁定，不能切换账户', { inlineKeyboard: buildMainMenuKeyboard() });
            return;
          }
          const accounts = (status.accounts || []) as Array<{ address: string; name?: string }>;
          const selectedAddress = resolveSwitchWalletTarget(command.target, accounts);
          if (!selectedAddress) {
            await sendTelegramReply(`未找到钱包: ${command.target}`, { inlineKeyboard: buildWalletListKeyboard(accounts) });
            return;
          }
          await WalletService.switchAccount(selectedAddress);
          await deps.broadcastStateChange();
          await sendTelegramReply(`已切换钱包: ${selectedAddress}`, { inlineKeyboard: buildMainMenuKeyboard() });
          return;
        }
        if (isXSniperOrderAction) {
          await sendXSniperOrderCard(command.orderId);
          return;
        }
        if (isOrdersAction) {
          const triggerDisplayMode = await getLimitOrderDisplayMode();
          const orders = await listLimitOrders(settings.chainId);
          const open = orders.filter((o) => o.status === 'open');
          const triggered = orders.filter((o) => o.status === 'triggered');
          const executed = orders.filter((o) => o.status === 'executed');
          const failed = orders.filter((o) => o.status === 'failed');
          const actionable = [...open, ...triggered];
          const perPage = 5;
          const totalPages = Math.max(1, Math.ceil(actionable.length / perPage));
          const requestedPage = command.type === 'actionOrdersPage' ? command.page : 1;
          const currentPage = Math.max(1, Math.min(totalPages, requestedPage));
          const pageStart = (currentPage - 1) * perPage;
          const visible = actionable.slice(pageStart, pageStart + perPage);
          if (!orders.length) {
            await sendTelegramReply('无挂单记录', { inlineKeyboard: buildMainMenuKeyboard() });
            return;
          }
          const lines = visible.map((o, idx) => {
            const triggerText = triggerTextByMode(o.triggerPriceUsd, triggerDisplayMode).replace('触发价: ', '').replace('触发市值: ', '');
            const targetText = typeof o.targetChangePercent === 'number' && Number.isFinite(o.targetChangePercent) ? `${o.targetChangePercent > 0 ? '+' : ''}${o.targetChangePercent}%` : '-';
            const actionText = o.side === 'buy'
              ? `买${formatTokenAmount(o.buyBnbAmountWei || '0', 18)} BNB`
              : o.sellPercentBps
                ? `卖${(o.sellPercentBps / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
                : `卖${formatTokenAmount(o.sellTokenAmountWei || '0', Number(o.tokenInfo?.decimals ?? 18))} ${o.tokenSymbol || 'Token'}`;
            const tokenText = compactTokenLabel(o.tokenSymbol || o.tokenInfo?.name || 'Token', 8);
            return `${idx + 1}) ${o.side === 'sell' ? '🔴' : '🟢'} ${tokenText} ${orderTypeLabel(o.orderType, o.side)} | ${triggerText} | ${targetText} | ${actionText} | ${orderStatusLabel(o.status)}`;
          });
          const keyboard: Array<Array<{ text: string; callbackData: string }>> = [];
          for (const [idx, o] of visible.entries()) keyboard.push([{ text: `❌ 取消 #${idx + 1}`, callbackData: `act:cancel:${o.id}` }, { text: `🔎 查看 #${idx + 1}`, callbackData: `act:token:${o.tokenAddress}` }]);
          const navRow: Array<{ text: string; callbackData: string }> = [];
          if (currentPage > 1) navRow.push({ text: `⬅️ 上一页(${currentPage - 1})`, callbackData: `act:ordersp:${currentPage - 1}` });
          if (currentPage < totalPages) navRow.push({ text: `下一页(${currentPage + 1}) ➡️`, callbackData: `act:ordersp:${currentPage + 1}` });
          if (navRow.length) keyboard.push(navRow);
          keyboard.push([{ text: '🔄 刷新', callbackData: `act:ordersp:${currentPage}` }, { text: '↩️ 菜单', callbackData: 'act:menu' }]);
          await sendTelegramReply(['📋 挂单面板', `📊 等待 ${open.length} | 触发中 ${triggered.length} | 已执行 ${executed.length} | 失败 ${failed.length}`, `🧾 显示: ${pageStart + (visible.length ? 1 : 0)}-${pageStart + visible.length}/${actionable.length} | 第 ${currentPage}/${totalPages} 页`, '', lines.join('\n')].join('\n'), { inlineKeyboard: keyboard });
          return;
        }
        if (isTokenAction) {
          const triggerDisplayMode = await getLimitOrderDisplayMode();
          const tokenAddress = command.tokenAddress;
          const snapshot = await buildTelegramTokenSnapshot(tokenAddress);
          if (!snapshot) {
            await sendTelegramReply(`未找到 Token 信息: ${tokenAddress}`);
            return;
          }
          const tokenOrders = await listLimitOrders(settings.chainId, tokenAddress);
          const tokenOrderLines = tokenOrders.slice(0, 6).map((o, idx) => {
            const triggerText = triggerTextByMode(o.triggerPriceUsd, triggerDisplayMode).replace('触发价: ', '').replace('触发市值: ', '');
            const targetText = typeof o.targetChangePercent === 'number' && Number.isFinite(o.targetChangePercent) ? `${o.targetChangePercent > 0 ? '+' : ''}${o.targetChangePercent}%` : '-';
            const actionText = o.side === 'buy'
              ? `买${formatTokenAmount(o.buyBnbAmountWei || '0', 18)} BNB`
              : o.sellPercentBps
                ? `卖${(o.sellPercentBps / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
                : `卖${formatTokenAmount(o.sellTokenAmountWei || '0', Number(o.tokenInfo?.decimals ?? 18))} ${o.tokenSymbol || 'Token'}`;
            const tokenText = compactTokenLabel(o.tokenSymbol || o.tokenInfo?.name || snapshot.symbol, 8);
            return `${idx + 1}) ${o.side === 'sell' ? '🔴' : '🟢'} ${tokenText} ${orderTypeLabel(o.orderType, o.side)} | ${triggerText} | ${targetText} | ${actionText} | ${orderStatusLabel(o.status)}`;
          });
          const chainSettings = (settings.chains as any)?.[settings.chainId];
          const tokenOrderButtons = tokenOrders.slice(0, 6).map((o, idx) => ([{ text: `❌ 取消挂单#${idx + 1}`, callbackData: `act:cancel:${o.id}` }]));
          const balanceNum = Number(snapshot.balanceAmount);
          const balanceShort = Number.isFinite(balanceNum)
            ? formatHoldingAmount(snapshot.balanceAmount)
            : snapshot.balanceAmount;
          const pickNum = (obj: any, keys: string[]) => {
            for (const k of keys) {
              const v = Number(obj?.[k]);
              if (Number.isFinite(v)) return v;
            }
            return null as number | null;
          };
          const formatPnlPercent = (ratio: number | null) => {
            if (ratio == null || !Number.isFinite(ratio)) return '-';
            const pct = ratio * 100;
            const sign = pct > 0 ? '+' : '';
            return `${sign}${pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
          };
          let holdingPnlText = '⚪PnL - (-)';
          if (snapshot.holderAddress) {
            const chainCode = settings.chainId === 56 ? 'bsc' : String(settings.chainId);
            try {
              const detail = await deps.fetchGmgnHoldingDetail?.(chainCode, snapshot.holderAddress, tokenAddress);
              if (detail) {
                const usdValue = pickNum(detail, ['usd_value', 'value_usd']);
                const totalCostUsdRaw = pickNum(detail, ['accu_cost', 'history_bought_cost', 'total_cost_usd', 'cost_usd', 'total_cost', 'cost', 'buy_amount_usd', 'buy_value_usd']);
                const pnlUsdRaw = pickNum(detail, ['total_profit', 'unrealized_profit', 'realized_profit', 'pnl_usd', 'unrealized_pnl_usd', 'profit_usd', 'pnl', 'profit']);
                const pnlRatio = pickNum(detail, ['total_profit_pnl', 'unrealized_profit_pnl', 'pnl_ratio', 'profit_pnl']);
                const pnlUsd = pnlUsdRaw != null
                  ? pnlUsdRaw
                  : (usdValue != null && totalCostUsdRaw != null ? usdValue - totalCostUsdRaw : null);
                const pnlText = pnlUsd != null ? formatUsd(pnlUsd) : '-';
                const pnlPct = formatPnlPercent(pnlRatio);
                const pnlIcon = (pnlUsd ?? 0) > 0 || (pnlRatio ?? 0) > 0 ? '🟢' : (pnlUsd ?? 0) < 0 || (pnlRatio ?? 0) < 0 ? '🔴' : '⚪';
                holdingPnlText = `${pnlIcon}PnL ${pnlText} (${pnlPct})`;
              }
            } catch {
            }
          }
          const isTurboMode = String(chainSettings?.executionMode || 'default') === 'turbo';
          const modeText = isTurboMode ? 'Turbo' : '普通';
          const buyPf = String(chainSettings?.buyPriorityFeePreset || '无');
          const sellPf = String(chainSettings?.sellPriorityFeePreset || '无');
          const settingsLine = [
            `模式${modeText}`,
            isTurboMode ? '无滑点保护❌' : `滑点${formatPercent(Number(chainSettings?.slippageBps ?? 0) / 100)}`,
            `买:${String(chainSettings?.buyGasPreset || chainSettings?.gasPreset || '-')}`,
            `卖:${String(chainSettings?.sellGasPreset || chainSettings?.gasPreset || '-')}`,
            `PF 买:${buyPf}/卖:${sellPf}`,
            `防夹${chainSettings?.antiMev === true ? '✅' : '❌'}`,
          ].join(' | ');
          await sendTelegramReply(
            [
              `💎 ${snapshot.name} (${snapshot.symbol})`,
              `${snapshot.tokenAddress}`,
              '',
              `📈 价格 ${formatPrice(snapshot.priceUsd)} | 市值 ${formatUsd(snapshot.marketCapUsd)}`,
              '',
              snapshot.holderAddress
                ? `💼 持仓: ${shortAddress(snapshot.holderAddress)} | ${balanceShort} ${snapshot.symbol} | ${formatUsd(snapshot.balanceUsd)} | ${holdingPnlText}`
                : '💼 持仓: 钱包未解锁',
              '',
              `⚙️ 设置: ${settingsLine}`,
              '',
              `📋 该代币挂单列表 (${tokenOrders.length})`,
              ...(tokenOrderLines.length ? tokenOrderLines : ['暂无挂单']),
            ].join('\n'),
            { inlineKeyboard: [...tokenOrderButtons, ...buildTokenActionKeyboard(snapshot.tokenAddress, chainSettings?.buyPresets ?? [], chainSettings?.sellPresets ?? [])] }
          );
          return;
        }
        if (isCancelAction) {
          const allBefore = await listLimitOrders(settings.chainId);
          const targetOrder = allBefore.find((o) => o.id === command.orderId);
          await cancelLimitOrder(command.orderId);
          await deps.broadcastStateChange();
          const buttons: Array<Array<{ text: string; callbackData: string }>> = [];
          if (targetOrder?.tokenAddress) buttons.push([{ text: '🔄 刷新 Token 卡片', callbackData: `act:token:${targetOrder.tokenAddress}` }]);
          buttons.push([{ text: '🔄 刷新挂单列表', callbackData: 'act:orders' }]);
          await sendTelegramReply(`已取消挂单: ${command.orderId}`, { inlineKeyboard: buttons });
          return;
        }
        if (isBuyAction) return void await runTelegramQuickBuy(command.tokenAddress, command.amountBnb);
        if (isSellAction) return void await runTelegramQuickSell(command.tokenAddress, command.sellPercent);
        await sendTelegramReply(['未知命令: ' + rawText, '支持:', '/settings', '/status', '/holdings', '/wallets', '/whoami', '/switch <address|name>', '/orders', '/cancel <orderId>', '/buy <tokenAddress> <bnb>', '/sell <tokenAddress> <percent>', '/token <tokenAddress>', '/menu', '/start', '或直接发送 tokenAddress'].join('\n'), { inlineKeyboard: buildMainMenuKeyboard() });
      } catch (e: any) {
        await sendTelegramReply(`命令执行失败: ${String(e?.message || e || 'unknown_error')}`);
      }
    },
  });

  return {
    start: () => telegramPoller.start(),
    getStatus: async () => {
      const cfg = await getTelegramConfigFromSettings();
      const s = telegramPoller.getStatus();
      return { enabled: !!cfg, running: s.running, lastPollAtMs: s.lastPollAtMs, lastError: s.lastError ?? null };
    },
    test: async () => {
      const sent = await sendTelegramReply('Telegram 测试消息: 连接正常');
      return { ok: true as const, sent };
    },
    runQuickBuy: runTelegramQuickBuy,
    runQuickSell: runTelegramQuickSell,
  };
}
