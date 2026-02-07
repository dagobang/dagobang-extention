import { browser } from 'wxt/browser';
import { parseEther, decodeAbiParameters, decodeFunctionData, parseAbi } from 'viem';
import { WalletService } from '@/services/wallet';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { TokenService } from '@/services/token';
import { RpcService } from '@/services/rpc';
import { getLimitOrders, setLimitOrders } from '@/services/storage';
import { buildAdvancedAutoSellSellLimitOrderInputs } from '@/services/advancedAutoSell';
import type { BgRequest, LimitOrder, LimitOrderCreateInput, LimitOrderScanStatus, LimitOrderType } from '@/types/extention';
import { TokenFourmemeService } from '@/services/token.fourmeme';
import { TokenFlapService } from '@/services/token.flap';
import FourmemeAPI from '@/services/fourmeme.api';
import BloxRouterAPI from '@/services/blox-router.api';

export default defineBackground(() => {
  console.log('Dagobang Background Service Started');

  const recentAutoBuys = new Map<string, number>();
  const autoPositions = new Map<string, {
    chainId: number;
    tokenAddress: `0x${string}`;
    entryPriceUsd: number | null;
    entryTime: number;
    lastPriceUsd: number | null;
  }>();

  const getKey = (chainId: number, tokenAddress: `0x${string}`) => `${chainId}:${tokenAddress.toLowerCase()}`;

  const scoreRevertReason = (reason: string) => {
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
  };

  const decodeRevertDataToReason = (data: any) => {
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
        const map: Record<string, string> = {
          '0x01': 'Panic(0x01)',
          '0x11': 'Panic(0x11)',
          '0x12': 'Panic(0x12)',
          '0x21': 'Panic(0x21)',
          '0x22': 'Panic(0x22)',
          '0x31': 'Panic(0x31)',
          '0x32': 'Panic(0x32)',
          '0x41': 'Panic(0x41)',
          '0x51': 'Panic(0x51)',
        };
        const key = `0x${n.toString(16)}`;
        return map[key] ?? `Panic(${key})`;
      } catch {
        return null;
      }
    }
    return null;
  };

  const routerSwapAbi = parseAbi([
    'struct SwapDesc { uint8 swapType; address tokenIn; address tokenOut; address poolAddress; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; address poolManager; bytes32 parameters; bytes data; }',
    'function swap(SwapDesc[] descs, address feeToken, uint256 amountIn, uint256 minReturn, uint256 deadline) payable',
    'function swapPercent(SwapDesc[] descs, address feeToken, uint16 percentBps, uint256 minReturn, uint256 deadline) payable'
  ]);
  const erc20AbiLite = parseAbi([
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ]);

  const tryDecodeSwapInput = (input: any) => {
    if (typeof input !== 'string') return null;
    try {
      const decoded = decodeFunctionData({ abi: routerSwapAbi, data: input as `0x${string}` }) as any;
      const fn = decoded?.functionName as string | undefined;
      const args = decoded?.args as any[] | undefined;
      if (!args || args.length < 5) return null;
      const descs = args[0] as any[];
      const tokenIn = descs?.[0]?.tokenIn as string | undefined;
      if (!tokenIn || !/^0x[a-fA-F0-9]{40}$/.test(tokenIn)) return null;
      if (fn === 'swap') {
        const amountIn = args[2] as bigint | number;
        const a = typeof amountIn === 'bigint' ? amountIn : BigInt(amountIn as any);
        return { kind: 'swap' as const, tokenIn: tokenIn as `0x${string}`, amountIn: a };
      }
      if (fn === 'swapPercent') {
        const percentBps = args[2] as bigint | number;
        const p = typeof percentBps === 'bigint' ? percentBps : BigInt(percentBps as any);
        return { kind: 'swapPercent' as const, tokenIn: tokenIn as `0x${string}`, percentBps: p };
      }
      return null;
    } catch {
      return null;
    }
  };

  const extractRevertReasonFromText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const directPatterns = [
      /ERC20:[^\n]{0,160}insufficient allowance[^\n]{0,80}/i,
      /ERC20:[^\n]{0,160}insufficient balance[^\n]{0,80}/i,
      /insufficient allowance/i,
      /insufficient balance/i,
    ];
    for (const re of directPatterns) {
      const m = re.exec(trimmed);
      if (!m) continue;
      const g = (m[0] ?? '').trim();
      if (g) return g;
    }
    const hexes = trimmed.match(/0x[0-9a-fA-F]{8,}/g) ?? [];
    for (const h of hexes) {
      const decoded = decodeRevertDataToReason(h);
      if (decoded) return decoded;
    }
    const patterns = [
      /Fail with error\s+'([^']+)'/i,
      /reverted with reason string\s+'([^']+)'/i,
      /execution reverted(?::\s*([^\n]+))?/i,
      /revert(?:ed)?(?::\s*([^\n]+))?/i,
    ];
    for (const re of patterns) {
      const m = re.exec(trimmed);
      if (!m) continue;
      const g = (m[1] ?? '').trim();
      if (g && !/^0x[0-9a-f]*$/i.test(g)) return g;
    }
    return null;
  };

  const collectErrorTexts = (e: any) => {
    const seen = new Set<any>();
    const texts: string[] = [];
    const visit = (err: any, depth: number) => {
      if (!err || depth > 4) return;
      if (seen.has(err)) return;
      seen.add(err);
      const push = (s: any) => {
        if (typeof s !== 'string') return;
        const t = s.trim();
        if (!t) return;
        texts.push(t);
      };
      if (Array.isArray(err?.metaMessages)) {
        for (const x of err.metaMessages) push(x);
      }
      push(err?.details);
      push(err?.shortMessage);
      push(err?.message);
      push(err?.data);
      const cause = err?.cause;
      if (cause) visit(cause, depth + 1);
    };
    visit(e as any, 0);
    return texts;
  };

  const extractRevertReasonFromError = (e: any) => {
    const texts = collectErrorTexts(e);

    const reasons: string[] = [];
    for (const s of texts) {
      const reason = extractRevertReasonFromText(s);
      if (reason) reasons.push(reason);
      const decoded = decodeRevertDataToReason(s);
      if (decoded) reasons.push(decoded);
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
  };

  const debugLogTxError = (tag: string, e: any, extra?: Record<string, unknown>) => {
    const texts = collectErrorTexts(e);
    const reasons: string[] = [];
    for (const s of texts) {
      const reason = extractRevertReasonFromText(s);
      if (reason) reasons.push(reason);
      const decoded = decodeRevertDataToReason(s);
      if (decoded) reasons.push(decoded);
    }
    const uniqueReasons = Array.from(new Set(reasons));
    const scored = uniqueReasons
      .map((r) => ({ reason: r, score: scoreRevertReason(r) }))
      .sort((a, b) => b.score - a.score);

    console.error(tag, {
      ...extra,
      parsedBest: scored[0]?.reason,
      parsedAll: scored,
      raw: serializeTxError(e),
      rawTexts: texts,
    });
  };

  const tryGetTxFailureReasonByAuthorization = async (client: any, bn: bigint, tx: any) => {
    const decoded = tryDecodeSwapInput(tx?.input);
    if (!decoded) return null;
    const tokenInLower = decoded.tokenIn.toLowerCase();
    if (tokenInLower === '0x0000000000000000000000000000000000000000') return null;
    try {
      const [balance, allowanceToRouter] = await Promise.all([
        client.readContract({
          address: decoded.tokenIn,
          abi: erc20AbiLite,
          functionName: 'balanceOf',
          args: [tx.from],
          blockNumber: bn,
        }) as Promise<bigint>,
        client.readContract({
          address: decoded.tokenIn,
          abi: erc20AbiLite,
          functionName: 'allowance',
          args: [tx.from, tx.to],
          blockNumber: bn,
        }) as Promise<bigint>,
      ]);
      const requiredAmountIn = decoded.kind === 'swap'
        ? decoded.amountIn
        : (balance * decoded.percentBps) / 10000n;
      if (requiredAmountIn <= 0n) return 'ZERO_INPUT';
      if (allowanceToRouter < requiredAmountIn) return 'ERC20: insufficient allowance';
      if (balance < requiredAmountIn) return 'ERC20: insufficient balance';
      return null;
    } catch {
      return null;
    }
  };

  const serializeTxError = (e: any) => {
    const err = e as any;
    const cause = err?.cause as any;
    const metaMessages = Array.isArray(err?.metaMessages) ? err.metaMessages.filter((x: any) => typeof x === 'string') : [];
    const message = typeof err?.message === 'string' ? err.message : String(err);
    const shortMessage = typeof err?.shortMessage === 'string' ? err.shortMessage : undefined;
    const details = typeof err?.details === 'string' ? err.details : undefined;
    const code = cause?.code ?? err?.code;
    const data = cause?.data ?? err?.data;
    return {
      name: typeof err?.name === 'string' ? err.name : undefined,
      message,
      shortMessage,
      details,
      meta: metaMessages.length ? metaMessages : undefined,
      cause: cause?.message ? String(cause.message) : undefined,
      code: code != null ? (typeof code === 'string' || typeof code === 'number' ? code : String(code)) : undefined,
      data,
    };
  };

  const tryGetReceiptRevertReason = async (client: any, hash: `0x${string}`, bn: bigint) => {
    let tx: any;
    try {
      tx = await client.getTransaction({ hash });
    } catch {
      return null;
    }
    if (!tx?.to || !tx?.input) return null;
    return await tryGetTxFailureReasonByAuthorization(client, bn, tx);
  };

  const parseNumber = (v: string | null | undefined) => {
    if (!v) return null;
    const n = Number(v.trim());
    if (!Number.isFinite(n)) return null;
    return n;
  };

  const extractTokenMetrics = (data: any) => {
    if (!data || typeof data !== 'object') return null;
    let obj = data;
    if (obj.data && typeof obj.data === 'object') obj = obj.data;
    const metrics: {
      tokenAddress?: `0x${string}`;
      marketCapUsd?: number;
      liquidityUsd?: number;
      holders?: number;
      createdAtMs?: number;
      devAddress?: `0x${string}`;
      devHoldPercent?: number;
      devHasSold?: boolean;
      priceUsd?: number;
    } = {};
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
        if (v && typeof v === 'object') {
          visit(v);
        }
      }
    };
    visit(obj);
    if (!metrics.tokenAddress) return null;
    return metrics;
  };

  const shouldBuyByConfig = (metrics: ReturnType<typeof extractTokenMetrics>, config: any) => {
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

  const makeLimitOrderId = () => {
    try {
      return crypto.randomUUID();
    } catch {
      return `lo_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
  };

  const normalizeLimitOrderType = (orderType: LimitOrderType | undefined, side: 'buy' | 'sell'): LimitOrderType => {
    if (orderType === 'take_profit_sell' || orderType === 'stop_loss_sell' || orderType === 'low_buy' || orderType === 'high_buy') {
      return orderType;
    }
    return side === 'buy' ? 'low_buy' : 'take_profit_sell';
  };

  const sideFromLimitOrderType = (orderType: LimitOrderType): 'buy' | 'sell' => {
    return orderType === 'low_buy' || orderType === 'high_buy' ? 'buy' : 'sell';
  };

  const hitLimitOrder = (orderType: LimitOrderType, priceUsd: number, triggerPriceUsd: number) => {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;
    if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) return false;
    if (orderType === 'high_buy' || orderType === 'take_profit_sell') return priceUsd >= triggerPriceUsd;
    return priceUsd <= triggerPriceUsd;
  };

  const listLimitOrders = async (chainId: number, tokenAddress?: `0x${string}`) => {
    const all = await getLimitOrders();
    const filtered = all.filter((o) => {
      if (o.chainId !== chainId) return false;
      if (tokenAddress && o.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) return false;
      return true;
    });
    filtered.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return filtered;
  };

  const createLimitOrder = async (input: LimitOrderCreateInput) => {
    const triggerPriceUsd = Number(input.triggerPriceUsd);
    if (!Number.isFinite(triggerPriceUsd) || triggerPriceUsd <= 0) throw new Error('Invalid trigger price');
    if (!input.tokenInfo) throw new Error('Token info required');
    const orderType = normalizeLimitOrderType(input.orderType, input.side);
    const side = sideFromLimitOrderType(orderType);
    if (input.orderType && side !== input.side) throw new Error('Order type mismatches side');

    if (side === 'buy') {
      if (!input.buyBnbAmountWei) throw new Error('Buy amount required');
      const v = BigInt(input.buyBnbAmountWei);
      if (v <= 0n) throw new Error('Invalid buy amount');
    } else {
      const tokenAmountWei = (() => {
        try {
          return input.sellTokenAmountWei ? BigInt(input.sellTokenAmountWei) : 0n;
        } catch {
          return 0n;
        }
      })();
      const bps = input.sellPercentBps ?? 0;
      const hasTokenAmount = tokenAmountWei > 0n;
      const hasPercent = Number.isFinite(bps) && bps > 0 && bps <= 10000;
      if (!hasTokenAmount && !hasPercent) throw new Error('Invalid sell amount');
    }

    const order: LimitOrder = {
      id: makeLimitOrderId(),
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenSymbol: input.tokenSymbol ?? null,
      side,
      orderType,
      triggerPriceUsd,
      buyBnbAmountWei: input.buyBnbAmountWei,
      sellPercentBps: input.sellPercentBps,
      sellTokenAmountWei: input.sellTokenAmountWei,
      createdAtMs: Date.now(),
      status: 'open',
      tokenInfo: input.tokenInfo,
    };

    const all = await getLimitOrders();
    await setLimitOrders([order, ...all]);
    return order;
  };

  const cancelLimitOrder = async (id: string) => {
    const all = await getLimitOrders();
    const next = all.filter((o) => !(o.id === id));
    await setLimitOrders(next);
    return next;
  };

  const cancelAllLimitOrders = async (chainId: number, tokenAddress?: `0x${string}`) => {
    const all = await getLimitOrders();
    const next = all.filter((o) => {
      if (o.chainId !== chainId) return true;
      if (tokenAddress && o.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) return true;
      if (o.status === 'executed') return true;
      return false;
    });
    await setLimitOrders(next);
    return next;
  };

  const cancelAllSellLimitOrdersForToken = async (chainId: number, tokenAddress: `0x${string}` | null | undefined) => {
    if (!tokenAddress) return getLimitOrders();
    const keyAddr = tokenAddress.toLowerCase();
    const all = await getLimitOrders();
    const next = all.filter((o) => {
      if (o.chainId !== chainId) return true;
      if (o.tokenAddress.toLowerCase() !== keyAddr) return true;
      if (o.side !== 'sell') return true;
      if (o.status === 'executed') return true;
      return false;
    });
    await setLimitOrders(next);
    return next;
  };

  const patchLimitOrder = async (id: string, patch: Partial<LimitOrder>) => {
    const all = await getLimitOrders();
    const next = all.map((o) => (o.id === id ? { ...o, ...patch } : o));
    await setLimitOrders(next);
    return next;
  };

  const executeLimitOrder = async (order: LimitOrder, ctx?: { priceUsd?: number }) => {
    if (!order.tokenInfo) throw new Error('Token info required');
    if (order.side === 'buy') {
      if (!order.buyBnbAmountWei) throw new Error('Buy amount required');
      const res = await TradeService.buy({
        chainId: order.chainId,
        tokenAddress: order.tokenAddress,
        bnbAmountWei: order.buyBnbAmountWei,
        tokenInfo: order.tokenInfo,
      });

      // Approve max for sell if needed
      await TradeService.approveMaxForSellIfNeeded(order.chainId, order.tokenAddress, order.tokenInfo);

      // Auto sell limit orders
      try {
        const settings = await SettingsService.get();
        const config = (settings as any).advancedAutoSell;
        const basePriceUsd = Number(ctx?.priceUsd ?? order.triggerPriceUsd);
        const orders = buildAdvancedAutoSellSellLimitOrderInputs({
          config,
          chainId: order.chainId,
          tokenAddress: order.tokenAddress,
          tokenSymbol: order.tokenSymbol ?? null,
          tokenInfo: order.tokenInfo,
          basePriceUsd,
        });
        if (orders.length) {
          for (const o of orders) {
            await createLimitOrder(o);
          }
          broadcastStateChange();
          scheduleLimitScanFromStorage().catch(() => { });
        }
      } catch {
      }

      return res.txHash as `0x${string}`;
    }

    // Sell
    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();
    const balance = await client.readContract({
      address: order.tokenAddress,
      abi: erc20AbiLite,
      functionName: 'balanceOf',
      args: [account.address],
    });
    const fixedAmount = (() => {
      try {
        return order.sellTokenAmountWei ? BigInt(order.sellTokenAmountWei) : 0n;
      } catch {
        return 0n;
      }
    })();
    const percentBps = order.sellPercentBps ?? 0;
    const amountByPercent = (Number.isFinite(percentBps) && percentBps > 0 && percentBps <= 10000)
      ? (balance * BigInt(percentBps)) / 10000n
      : 0n;
    const rawAmountIn = fixedAmount > 0n ? fixedAmount : amountByPercent;
    const amountIn = rawAmountIn > balance ? balance : rawAmountIn;
    if (amountIn <= 0n) throw new Error('No balance');

    const res = await TradeService.sell({
      chainId: order.chainId,
      tokenAddress: order.tokenAddress,
      tokenAmountWei: amountIn.toString(),
      tokenInfo: order.tokenInfo,
      sellPercentBps: Number.isFinite(percentBps) && percentBps > 0 && percentBps <= 10000 ? percentBps : undefined,
    });

    // Cancel limit order if exists
    if (percentBps === 10000) {
      setTimeout(() => {
        void cancelAllSellLimitOrdersForToken(order.chainId, order.tokenAddress);
        broadcastStateChange();
        scheduleLimitScanFromStorage().catch(() => { });
      }, 2000);
    }

    return res as `0x${string}`;
  };

  const tickLimitOrders = async (chainId: number, tokenAddress: `0x${string}`, priceUsd: number) => {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return { triggered: [], executed: [], failed: [] as Array<{ id: string; error: string }> };

    const all = await getLimitOrders();
    const keyAddr = tokenAddress.toLowerCase();
    const candidates = all.filter((o) => o.chainId === chainId && o.status === 'open' && o.tokenAddress.toLowerCase() === keyAddr);
    if (!candidates.length) return { triggered: [], executed: [], failed: [] as Array<{ id: string; error: string }> };

    const triggered: string[] = [];
    const executed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const o of candidates) {
      const orderType = normalizeLimitOrderType(o.orderType, o.side);
      const hit = hitLimitOrder(orderType, priceUsd, o.triggerPriceUsd);
      if (!hit) continue;

      triggered.push(o.id);
      await patchLimitOrder(o.id, { status: 'triggered' as const });

      try {
        const txHash = await executeLimitOrder({ ...o, status: 'triggered' }, { priceUsd });
        executed.push(o.id);
        await patchLimitOrder(o.id, { status: 'executed' as const, txHash });
      } catch (e: any) {
        const msg = typeof e?.message === 'string' ? e.message : String(e);
        failed.push({ id: o.id, error: msg });
        await patchLimitOrder(o.id, { status: 'failed' as const, lastError: msg });
      }
    }

    return { triggered, executed, failed };
  };

  const LIMIT_SCAN_ALARM = 'limitOrder:scan';
  const LIMIT_SCAN_INTERVAL_DEFAULT_MS = 3000;
  const LIMIT_SCAN_INTERVAL_OPTIONS_MS = [1000, 3000, 5000, 10000, 30000, 60000, 120000] as const;
  let limitScanIntervalMs = LIMIT_SCAN_INTERVAL_DEFAULT_MS;
  const limitScanPricesByTokenKey = new Map<string, { priceUsd: number; ts: number }>();
  let limitScanRunning = false;
  let limitScanLastAtMs = 0;
  let limitScanLastOk = true;
  let limitScanLastError: string | null = null;

  const normalizeLimitScanIntervalMs = (value: any) => {
    const v = Math.floor(Number(value));
    if (!Number.isFinite(v)) return LIMIT_SCAN_INTERVAL_DEFAULT_MS;
    if (LIMIT_SCAN_INTERVAL_OPTIONS_MS.includes(v as any)) return v;
    return LIMIT_SCAN_INTERVAL_DEFAULT_MS;
  };

  const refreshLimitScanIntervalFromSettings = async () => {
    try {
      const settings = await SettingsService.get();
      limitScanIntervalMs = normalizeLimitScanIntervalMs((settings as any).limitOrderScanIntervalMs);
    } catch {
    }
  };

  const scanAndTriggerLimitOrdersOnce = async () => {
    if (limitScanRunning) return;
    limitScanRunning = true;
    const startedAt = Date.now();
    limitScanLastOk = true;
    limitScanLastError = null;
    try {
      const all = await getLimitOrders();
      const openOrders = all.filter((o) => o.status === 'open');
      if (!openOrders.length) return;

      const walletStatus = await WalletService.getStatus();
      if (walletStatus.locked || !walletStatus.address) return;

      let changed = false;

      const byToken = new Map<string, LimitOrder[]>();
      for (const o of openOrders) {
        const k = `${o.chainId}:${o.tokenAddress.toLowerCase()}`;
        const arr = byToken.get(k) ?? [];
        arr.push(o);
        byToken.set(k, arr);
      }

      for (const [, orders] of byToken) {
        const base = orders[0];
        const priceUsd = await TokenService.getTokenPriceUsdFromRpc({
          chainId: base.chainId,
          tokenAddress: base.tokenAddress,
          tokenInfo: base.tokenInfo ?? null,
          cacheTtlMs: limitScanIntervalMs,
        });
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        limitScanPricesByTokenKey.set(`${base.chainId}:${base.tokenAddress.toLowerCase()}`, { priceUsd, ts: Date.now() });

        for (const o of orders) {
          const orderType = normalizeLimitOrderType(o.orderType, o.side);
          const hit = hitLimitOrder(orderType, priceUsd, o.triggerPriceUsd);
          if (!hit) continue;

          await patchLimitOrder(o.id, { status: 'triggered' as const });
          changed = true;

          try {
            const txHash = await executeLimitOrder({ ...o, status: 'triggered' }, { priceUsd });
            await patchLimitOrder(o.id, { status: 'executed' as const, txHash });
          } catch (e: any) {
            const msg = typeof e?.message === 'string' ? e.message : String(e);
            await patchLimitOrder(o.id, { status: 'failed' as const, lastError: msg });
          }
        }
      }

      if (changed) {
        broadcastStateChange();
      }
      limitScanLastOk = true;
      limitScanLastError = null;
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : String(e);
      limitScanLastOk = false;
      limitScanLastError = msg;
      throw e;
    } finally {
      limitScanLastAtMs = startedAt;
      limitScanRunning = false;
    }
  };

  const scheduleNextLimitScan = (delayMs: number) => {
    try {
      const safeDelayMs = Number.isFinite(delayMs) ? Math.max(0, delayMs) : limitScanIntervalMs;
      (browser as any).alarms?.create(LIMIT_SCAN_ALARM, { when: Date.now() + safeDelayMs });
    } catch {
    }
  };

  const scheduleLimitScanFromStorage = async () => {
    let hasOpen = false;
    try {
      const all = await getLimitOrders();
      hasOpen = all.some((o) => o.status === 'open');
    } catch {
    }
    if (!hasOpen) {
      try {
        (browser as any).alarms?.clear?.(LIMIT_SCAN_ALARM);
      } catch {
      }
      return;
    }
    scheduleNextLimitScan(limitScanIntervalMs);
  };

  try {
    (browser as any).alarms?.onAlarm?.addListener((alarm: any) => {
      if (!alarm || alarm.name !== LIMIT_SCAN_ALARM) return;
      scanAndTriggerLimitOrdersOnce()
        .catch(() => { })
        .finally(() => {
          scheduleLimitScanFromStorage().catch(() => { });
        });
    });
    refreshLimitScanIntervalFromSettings()
      .catch(() => { })
      .finally(() => {
        scheduleLimitScanFromStorage().catch(() => { });
      });
  } catch {
  }

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
      broadcastStateChange();
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
      if (price != null) {
        pos.lastPriceUsd = price;
      }
      const tp = parseNumber(config.takeProfitMultiple);
      const sl = parseNumber(config.stopLossMultiple);
      const maxHoldMin = parseNumber(config.maxHoldMinutes);
      const entryPrice = pos.entryPriceUsd;
      let shouldSell = false;
      if (entryPrice && price) {
        if (tp && tp > 0 && price >= entryPrice * tp) {
          shouldSell = true;
        }
        if (!shouldSell && sl && sl > 0 && price <= entryPrice * sl) {
          shouldSell = true;
        }
      }
      if (!shouldSell && maxHoldMin && maxHoldMin > 0) {
        const ageMin = (now - pos.entryTime) / 60000;
        if (ageMin >= maxHoldMin) {
          shouldSell = true;
        }
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
      broadcastStateChange();
    } catch (e) {
      console.error('AutoTrade sell handler error', e);
    }
  };

  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');
  });

  // Helper to broadcast state changes
  const broadcastStateChange = async () => {
    try {
      const tabs = await browser.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          browser.tabs.sendMessage(tab.id, { type: 'bg:stateChanged' }).catch(() => { });
        }
      }
    } catch (e) {
      console.error('Broadcast failed', e);
    }
  };

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as BgRequest;
    if (msg.type === 'chain:getBalance' || msg.type === 'token:getBalance' || msg.type === 'bg:getState') {
      const from = sender?.url || sender?.tab?.url || '';
      const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : null;
      const active = sender?.tab ? !!sender.tab.active : null;
      console.log('Bg received:', msg.type, { from, tabId, active });
    } else {
      console.log('Bg received:', msg.type);
    }

    // Return true to indicate async response
    const handle = async () => {
      try {
        switch (msg.type) {
          case 'bg:ping':
            return { ok: true, time: Date.now() };

          case 'bg:openPopup':
            try {
              // @ts-ignore
              await browser.action.openPopup();
              return { ok: true };
            } catch (e) {
              console.error('Failed to open popup:', e);
              return { ok: false, error: 'Not supported' };
            }

          case 'bg:getState': {
            const status = await WalletService.getStatus();
            const settings = await SettingsService.get();
            const ttl = status.expiresAt ? Math.floor((status.expiresAt - Date.now()) / 1000) : null;

            return {
              wallet: {
                hasEncrypted: status.hasWallet,
                isUnlocked: !status.locked,
                address: status.address,
                accounts: status.accounts,
                unlockTtlSeconds: ttl && ttl > 0 ? ttl : null,
              },
              settings,
              network: { chainId: settings.chainId }
            };
          }

          case 'settings:set':
            limitScanIntervalMs = normalizeLimitScanIntervalMs((msg.settings as any).limitOrderScanIntervalMs);
            await SettingsService.update(msg.settings);
            try {
              await (browser as any).alarms?.clear?.(LIMIT_SCAN_ALARM);
            } catch {
            }
            scheduleLimitScanFromStorage().catch(() => { });
            broadcastStateChange();
            return { ok: true };

          case 'settings:setAccountAlias': {
            const current = await SettingsService.get();
            const nextAliases = { ...(current.accountAliases ?? {}) };
            const key = msg.address.toLowerCase();
            const alias = msg.alias.trim();
            if (alias) {
              nextAliases[key] = alias;
            } else {
              delete nextAliases[key];
            }
            await SettingsService.update({ accountAliases: nextAliases });
            broadcastStateChange();
            return { ok: true };
          }

          case 'wallet:create':
            const resCreate = await WalletService.create(msg.input.password);
            broadcastStateChange();
            return { ok: true, ...resCreate };

          case 'wallet:import':
            const resImport = await WalletService.import(msg.input.password, msg.input);
            broadcastStateChange();
            return { ok: true, ...resImport };

          case 'wallet:unlock':
            const resUnlock = await WalletService.unlock(msg.input.password);
            broadcastStateChange();
            return { ok: true, ...resUnlock };

          case 'wallet:lock':
            await WalletService.lock();
            broadcastStateChange();
            return { ok: true };

          case 'wallet:wipe':
            await WalletService.wipe();
            broadcastStateChange();
            return { ok: true };

          case 'wallet:addAccount':
            const resAdd = await WalletService.addAccount(msg.name, msg.password, msg.privateKey);
            broadcastStateChange();
            return { ok: true, ...resAdd };

          case 'wallet:switchAccount':
            await WalletService.switchAccount(msg.address);
            broadcastStateChange();
            return { ok: true };

          case 'wallet:updatePassword':
            await WalletService.updatePassword(msg.oldPassword, msg.newPassword);
            broadcastStateChange();
            return { ok: true };

          case 'wallet:exportPrivateKey':
            return { ok: true, privateKey: await WalletService.exportPrivateKey(msg.password) };

          case 'wallet:exportAccountPrivateKey':
            return { ok: true, privateKey: await WalletService.exportAccountPrivateKey(msg.password, msg.address) };

          case 'wallet:exportMnemonic':
            return { ok: true, mnemonic: await WalletService.exportMnemonic(msg.password) };

          case 'chain:getBalance':
            return { ok: true, balanceWei: await TokenService.getNativeBalance(msg.address) };

          case 'token:getMeta':
            return { ok: true, ...(await TokenService.getMeta(msg.tokenAddress)) };

          case 'token:getBalance':
            return { ok: true, balanceWei: await TokenService.getBalance(msg.tokenAddress, msg.address) };

          case 'token:getPoolPair': {
            const { token0, token1 } = await TokenService.getPoolPair(msg.pair);
            return { ok: true, token0, token1 };
          }

          case 'token:getPriceUsd': {
            const priceUsd = await TokenService.getTokenPriceUsdFromRpc({
              chainId: msg.chainId,
              tokenAddress: msg.tokenAddress,
              tokenInfo: msg.tokenInfo ?? null,
              cacheTtlMs: 3000,
            });
            return { ok: true, priceUsd };
          }

          case 'token:getTokenInfo:fourmeme':
            return { ok: true, ...(await TokenFourmemeService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:flap':
            return { ok: true, ...(await TokenFlapService.getTokenInfo(msg.chainId, msg.tokenAddress)) };

          case 'token:getTokenInfo:fourmemeHttp': {
            const tokenInfo = await FourmemeAPI.getTokenInfo(msg.chain, msg.address);
            return { ok: true, tokenInfo };
          }

          case 'token:createFourmeme': {
            const settings = await SettingsService.get();
            const account = await WalletService.getSigner();
            const address = account.address;
            const networkCode = 'BSC';

            const nonce = await FourmemeAPI.generateNonce(address, networkCode);
            const message = `You are sign in Meme ${nonce}`;
            const signature = await account.signMessage({ message });

            const accessToken = await FourmemeAPI.loginDex({
              address,
              signature,
              networkCode,
              walletName: 'undefined',
            });

            const uploadedImgUrl = await FourmemeAPI.uploadImageFromUrl(msg.input.imgUrl, accessToken);

            const createData = await FourmemeAPI.createToken(
              {
                ...msg.input,
                imgUrl: uploadedImgUrl,
              },
              accessToken
            );

            if (!createData || !createData.createArg || !createData.sign) {
              return { ok: true, data: { api: createData } };
            }

            const onChainResult = await TokenFourmemeService.createTokenOnChain(
              settings.chainId,
              createData.createArg,
              createData.sign
            );

            return {
              ok: true,
              data: {
                api: createData,
                txHash: onChainResult.txHash,
                tokenAddress: onChainResult.tokenAddress,
              },
            };
          }

          case 'ai:generateLogo': {
            const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${msg.apiKey}`,
              },
              body: JSON.stringify({
                model: 'doubao-seedream-4-5-251128',
                prompt: msg.prompt,
                size: msg.size || '2K',
                watermark: false,
                response_format: 'url',
              }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              throw new Error(text || `Seedream4.5 request failed: ${res.status}`);
            }
            const data: any = await res.json();
            let imageUrl = '';
            if (Array.isArray(data.data) && data.data.length > 0) {
              const item = data.data[0];
              imageUrl = item.url || item.url || '';
            } else if (typeof data.url === 'string') {
              imageUrl = data.url;
            }
            if (!imageUrl) {
              throw new Error('Seedream4.5 response missing image url');
            }
            return { ok: true, imageUrl };
          }

          case 'limitOrder:list': {
            const orders = await listLimitOrders(msg.chainId, msg.tokenAddress);
            return { ok: true, orders };
          }

          case 'limitOrder:create': {
            const order = await createLimitOrder(msg.input);
            broadcastStateChange();
            scheduleLimitScanFromStorage().catch(() => { });
            return { ok: true, order };
          }

          case 'limitOrder:cancel': {
            const orders = await cancelLimitOrder(msg.id);
            broadcastStateChange();
            scheduleLimitScanFromStorage().catch(() => { });
            return { ok: true, orders };
          }

          case 'limitOrder:cancelAll': {
            const orders = await cancelAllLimitOrders(msg.chainId, msg.tokenAddress);
            broadcastStateChange();
            scheduleLimitScanFromStorage().catch(() => { });
            return { ok: true, orders };
          }

          case 'limitOrder:scanStatus': {
            let totalOrders = 0;
            let openOrders = 0;
            try {
              const all = await getLimitOrders();
              totalOrders = all.filter((o) => o.chainId === msg.chainId).length;
              openOrders = all.filter((o) => o.chainId === msg.chainId && o.status === 'open').length;
            } catch {
            }

            const pricesByTokenKey: Record<string, { priceUsd: number; ts: number }> = {};
            for (const [k, v] of limitScanPricesByTokenKey.entries()) {
              if (k.startsWith(`${msg.chainId}:`)) pricesByTokenKey[k] = v;
            }

            const res: ({ ok: true } & LimitOrderScanStatus) = {
              ok: true,
              intervalMs: limitScanIntervalMs,
              running: limitScanRunning,
              lastScanAtMs: limitScanLastAtMs,
              lastScanOk: limitScanLastOk,
              lastScanError: limitScanLastError,
              totalOrders,
              openOrders,
              pricesByTokenKey,
            };
            return res;
          }

          case 'limitOrder:tick': {
            const res = await tickLimitOrders(msg.chainId, msg.tokenAddress, msg.priceUsd);
            if (res.triggered.length || res.executed.length || res.failed.length) {
              broadcastStateChange();
            }
            return { ok: true, ...res };
          }

          case 'tx:buy': {
            try {
              const t1 = Date.now();
              const rsp = await TradeService.buy(msg.input);
              const t2 = Date.now();
              console.log(`Buy transaction ${rsp.txHash} took ${t2 - t1}ms`);
              broadcastStateChange();
              return { ok: true, ...rsp };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:buy failed', e, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'tx:sell': {
            try {
              const txHash = await TradeService.sell(msg.input);
              broadcastStateChange();
              return { ok: true, txHash };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:sell failed', e, { input: msg.input as any });
              }
              return { ok: false, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'tx:approve': {
            const txHash = await TradeService.approve(msg.chainId, msg.tokenAddress, msg.spender, msg.amountWei);
            broadcastStateChange();
            return { ok: true, txHash };
          }

          case 'tx:approveMaxForSellIfNeeded': {
            const txHash = await TradeService.approveMaxForSellIfNeeded(msg.chainId, msg.tokenAddress, msg.tokenInfo);
            broadcastStateChange();
            return txHash ? { ok: true, txHash } : { ok: true };
          }

          case 'tx:bloxroutePrivate': {
            try {
              const txHash = await BloxRouterAPI.sendBscPrivateTx(msg.signedTx);
              return { ok: true, txHash: txHash ?? undefined };
            } catch {
              return { ok: true };
            }
          }

          case 'tx:waitForReceipt': {
            const client = await RpcService.getClient();
            try {
              const receipt = await client.waitForTransactionReceipt({ hash: msg.hash });
              const ok = receipt.status === 'success';
              const blockNumber = Number(receipt.blockNumber);
              const txHash = receipt.transactionHash;
              const status = receipt.status;
              const revertReason = !ok ? await tryGetReceiptRevertReason(client, msg.hash, receipt.blockNumber) : null;
              broadcastStateChange();
              return {
                ok,
                blockNumber,
                txHash,
                status,
                revertReason: revertReason ?? undefined,
              };
            } catch (e: any) {
              const reason = extractRevertReasonFromError(e);
              if (!reason || reason.toLowerCase().includes('zero_input')) {
                debugLogTxError('tx:waitForReceipt failed', e, { hash: msg.hash, chainId: msg.chainId });
              }
              return { ok: false, txHash: msg.hash, revertReason: reason ?? undefined, error: serializeTxError(e) };
            }
          }

          case 'autotrade:ws': {
            await handleAutoTradeWebSocket(msg.payload);
            await handleAutoSellCheck(msg.payload);
            return { ok: true };
          }
        }
      } catch (e: any) {
        console.error('Handler error:', e);
        throw e;
      }
    };

    handle().then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  });
});
