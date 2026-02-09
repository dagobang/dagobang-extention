import { parseEther } from 'viem';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';

type TokenMetrics = {
  tokenAddress?: `0x${string}`;
  marketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  createdAtMs?: number;
  devAddress?: `0x${string}`;
  devHoldPercent?: number;
  devHasSold?: boolean;
  priceUsd?: number;
};

const parseNumber = (v: string | null | undefined) => {
  if (!v) return null;
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return null;
  return n;
};

const extractTokenMetrics = (data: any): TokenMetrics | null => {
  if (!data || typeof data !== 'object') return null;
  let obj = data;
  if (obj.data && typeof obj.data === 'object') obj = obj.data;
  const metrics: TokenMetrics = {};
  const visit = (source: any) => {
    if (!source || typeof source !== 'object') return;
    for (const [k, v] of Object.entries(source)) {
      const key = k.toLowerCase();
      if (!metrics.tokenAddress && typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)) {
        if (key.includes('token') || key.includes('contract') || key === 'ca' || key === 'address') {
          metrics.tokenAddress = v as `0x${string}`;
        }
      }
      if (!metrics.marketCapUsd && typeof v === 'number' && key.includes('market') && key.includes('cap')) {
        metrics.marketCapUsd = v;
      }
      if (!metrics.liquidityUsd && typeof v === 'number' && key.includes('liquidity')) {
        metrics.liquidityUsd = v;
      }
      if (!metrics.holders && typeof v === 'number' && (key.includes('holder') || key.includes('holders'))) {
        metrics.holders = v;
      }
      if (!metrics.priceUsd && typeof v === 'number' && (key === 'price' || key.includes('price_usd'))) {
        metrics.priceUsd = v;
      }
      if (!metrics.createdAtMs && typeof v === 'number' && (key.includes('create_time') || key.includes('launch_time') || key.includes('created_at'))) {
        metrics.createdAtMs = v * (v < 10_000_000_000 ? 1000 : 1);
      }
      if (!metrics.devAddress && typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v) && (key.includes('dev') || key.includes('owner') || key.includes('creator'))) {
        metrics.devAddress = v as `0x${string}`;
      }
      if (!metrics.devHoldPercent && typeof v === 'number' && (key.includes('dev') && key.includes('percent'))) {
        metrics.devHoldPercent = v;
      }
      if (metrics.devHasSold == null && typeof v === 'boolean' && (key.includes('dev') && key.includes('sell'))) {
        metrics.devHasSold = v;
      }
      if (v && typeof v === 'object') visit(v);
    }
  };
  visit(obj);
  if (!metrics.tokenAddress) return null;
  return metrics;
};

const shouldBuyByConfig = (metrics: TokenMetrics, config: any) => {
  if (!metrics || !config) return false;
  const maxMcap = parseNumber(config.maxMarketCapUsd);
  if (maxMcap != null && metrics.marketCapUsd != null && metrics.marketCapUsd > maxMcap) return false;
  const minLiq = parseNumber(config.minLiquidityUsd);
  if (minLiq != null && metrics.liquidityUsd != null && metrics.liquidityUsd < minLiq) return false;
  const minHolders = parseNumber(config.minHolders);
  if (minHolders != null && metrics.holders != null && metrics.holders < minHolders) return false;
  const maxAgeMin = parseNumber(config.maxTokenAgeMinutes);
  if (maxAgeMin != null && metrics.createdAtMs != null) {
    const ageMin = (Date.now() - metrics.createdAtMs) / 60000;
    if (ageMin > maxAgeMin) return false;
  }
  const maxDevPct = parseNumber(config.maxDevHoldPercent);
  if (maxDevPct != null && metrics.devHoldPercent != null && metrics.devHoldPercent > maxDevPct) return false;
  if (config.blockIfDevSell && metrics.devHasSold === true) return false;
  return true;
};

export const createAutoTrade = (deps: { onStateChanged: () => void }) => {
  const recentAutoBuys = new Map<string, number>();
  const autoPositions = new Map<string, {
    chainId: number;
    tokenAddress: `0x${string}`;
    entryPriceUsd: number | null;
    entryTime: number;
    lastPriceUsd: number | null;
  }>();

  const getKey = (chainId: number, tokenAddress: `0x${string}`) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const handleAutoTradeWebSocket = async (payload: any) => {
    try {
      if (!payload || payload.direction !== 'receive') return;
      const settings = await SettingsService.get();
      const config = (settings as any).autoTrade;
      if (!config || !config.enabled) return;
      const metrics = extractTokenMetrics(payload.data);
      if (!metrics || !metrics.tokenAddress) return;
      if (!shouldBuyByConfig(metrics, config)) return;
      const chainId = settings.chainId;
      const key = getKey(chainId, metrics.tokenAddress);
      const now = Date.now();
      const last = recentAutoBuys.get(key);
      if (last && now - last < 5 * 60 * 1000) return;
      const amountNumber = parseNumber(config.buyAmountBnb) ?? 0;
      if (amountNumber <= 0) return;
      const amountWei = parseEther(String(amountNumber));
      const status = await WalletService.getStatus();
      if (status.locked || !status.address) return;
      const rsp = await TradeService.buy({
        chainId,
        tokenAddress: metrics.tokenAddress,
        bnbAmountWei: amountWei.toString(),
      });
      console.log('AutoTrade buy tx', rsp.txHash);
      recentAutoBuys.set(key, now);
      autoPositions.set(key, {
        chainId,
        tokenAddress: metrics.tokenAddress,
        entryPriceUsd: metrics.priceUsd ?? null,
        entryTime: now,
        lastPriceUsd: metrics.priceUsd ?? null,
      });
      deps.onStateChanged();
    } catch (e) {
      console.error('AutoTrade ws handler error', e);
    }
  };

  const handleAutoSellCheck = async (payload: any) => {
    try {
      const settings = await SettingsService.get();
      const config = (settings as any).autoTrade;
      if (!config || !config.autoSellEnabled) return;
      const metrics = extractTokenMetrics(payload.data);
      if (!metrics || !metrics.tokenAddress) return;
      const chainId = settings.chainId;
      const key = getKey(chainId, metrics.tokenAddress);
      const pos = autoPositions.get(key);
      if (!pos) return;
      const now = Date.now();
      const price = metrics.priceUsd ?? pos.lastPriceUsd;
      if (price != null) pos.lastPriceUsd = price;
      const tp = parseNumber(config.takeProfitMultiple);
      const sl = parseNumber(config.stopLossMultiple);
      const maxHoldMin = parseNumber(config.maxHoldMinutes);
      const entryPrice = pos.entryPriceUsd;
      let shouldSell = false;
      if (entryPrice && price) {
        if (tp && tp > 0 && price >= entryPrice * tp) shouldSell = true;
        if (!shouldSell && sl && sl > 0 && price <= entryPrice * sl) shouldSell = true;
      }
      if (!shouldSell && maxHoldMin && maxHoldMin > 0) {
        const ageMin = (now - pos.entryTime) / 60000;
        if (ageMin >= maxHoldMin) shouldSell = true;
      }
      if (!shouldSell) return;
      autoPositions.delete(key);
      const txHash = await TradeService.sell({
        chainId,
        tokenAddress: metrics.tokenAddress,
        tokenAmountWei: '0',
        sellPercentBps: 10000,
      });
      console.log('AutoTrade sell tx', txHash);
      deps.onStateChanged();
    } catch (e) {
      console.error('AutoTrade sell handler error', e);
    }
  };

  return { handleAutoTradeWebSocket, handleAutoSellCheck };
};

