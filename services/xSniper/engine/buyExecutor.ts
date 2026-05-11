import { parseEther } from 'viem';
import { WalletService } from '@/services/wallet';
import { TradeService } from '@/services/trade';
import { buildTweetUrl, getSignalTimeMs, isRepostOrQuoteSignal, parseNumber, sanitizeMarketCapUsd, shouldBuyByConfig, type TokenMetrics } from '@/services/xSniper/engine/metrics';
import type { WsConfirmFailedCheck } from '@/services/xSniper/engine/wsSnapshots';
import type { UnifiedTwitterSignal, XSniperBuyRecord } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import type { DryRunAutoSellPos } from '@/services/xSniper/engine/dryRunAutoSell';

const resolveEntryMcapAnchor = (input: {
  postBuyMcapUsd?: number | null;
  entryPriceUsd?: number | null;
  referencePriceUsd?: number | null;
  referenceMcapUsd?: number | null;
  fallbackMcapUsd?: number | null;
}) => {
  const postBuyMcapUsd = sanitizeMarketCapUsd(input.postBuyMcapUsd);
  if (postBuyMcapUsd != null) return postBuyMcapUsd;
  const entryPriceUsd = Number(input.entryPriceUsd);
  const referencePriceUsd = Number(input.referencePriceUsd);
  const referenceMcapUsd = sanitizeMarketCapUsd(input.referenceMcapUsd);
  if (
    Number.isFinite(entryPriceUsd) && entryPriceUsd > 0
    && Number.isFinite(referencePriceUsd) && referencePriceUsd > 0
    && referenceMcapUsd != null
  ) {
    const impliedSupply = referenceMcapUsd / referencePriceUsd;
    if (Number.isFinite(impliedSupply) && impliedSupply > 0) {
      const estimatedMcap = sanitizeMarketCapUsd(entryPriceUsd * impliedSupply);
      if (estimatedMcap != null) return estimatedMcap;
    }
  }
  return sanitizeMarketCapUsd(input.fallbackMcapUsd);
};

const terminalFailedBuyKeys = new Map<string, number>();
const globalBuyInFlightKeys = new Set<string>();
const globalBoughtLockKeys = new Set<string>();

const buildGlobalBuyLockKey = (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  walletAddress?: `0x${string}`;
}) => {
  const walletKey = input.walletAddress ? String(input.walletAddress).toLowerCase() : 'all-wallets';
  return `${input.chainId}:${input.tokenAddress.toLowerCase()}:${walletKey}`;
};

const buildPositionKey = (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  walletAddress?: `0x${string}`;
  dryRun: boolean;
}) => {
  const walletKey = input.walletAddress ? String(input.walletAddress).toLowerCase() : 'all-wallets';
  return `${input.dryRun ? 'dry:' : ''}${input.chainId}:${input.tokenAddress.toLowerCase()}:${walletKey}`;
};

const parseStrategyWalletAddress = (input: unknown): `0x${string}` | undefined => {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  if (!/^0x[a-f0-9]{40}$/.test(raw)) return undefined;
  return raw as `0x${string}`;
};

const classifyBuySubmitFailureReason = (error: unknown): string => {
  const e = error as any;
  const text = String(
    e?.shortMessage ??
    e?.message ??
    e?.cause?.shortMessage ??
    e?.cause?.message ??
    e ??
    '',
  ).toLowerCase();
  if (!text) return 'buy_submit_failed_unknown';
  if (text.includes('nonce')) return 'buy_submit_failed_nonce';
  if (text.includes('allowance') || text.includes('insufficient allowance')) return 'buy_submit_failed_allowance';
  if (text.includes('pool') || text.includes('liquidity') || text.includes('route') || text.includes('pair')) {
    return 'buy_submit_failed_route';
  }
  if (text.includes('token info') || text.includes('token_info')) return 'buy_submit_failed_token_info';
  if (text.includes('timeout') || text.includes('timed out')) return 'buy_submit_failed_timeout';
  if (text.includes('insufficient funds') || text.includes('insufficient balance')) {
    return 'buy_submit_failed_insufficient_funds';
  }
  if (text.includes('in flight') || text.includes('in_flight')) return 'buy_submit_failed_in_flight';
  return 'buy_submit_failed_unknown';
};

const classifyBuyReceiptFailureReason = (error: unknown): string => {
  const submitLike = classifyBuySubmitFailureReason(error);
  if (!submitLike.startsWith('buy_submit_failed_')) return 'buy_receipt_failed_unknown';
  return submitLike.replace('buy_submit_failed_', 'buy_receipt_failed_');
};

const summarizeTokenInfoForLog = (tokenInfo: TokenInfo | null | undefined) => {
  if (!tokenInfo) return null;
  return {
    chain: tokenInfo.chain,
    address: tokenInfo.address,
    symbol: tokenInfo.symbol,
    launchpad: (tokenInfo as any)?.launchpad,
    launchpad_platform: tokenInfo.launchpad_platform,
    launchpad_status: (tokenInfo as any)?.launchpad_status,
    pool_pair: (tokenInfo as any)?.pool_pair,
    quote_token: tokenInfo.quote_token,
    ai_creator: (tokenInfo as any)?.ai_creator,
  };
};

const summarizeErrorForLog = (error: unknown) => {
  const e = error as any;
  return {
    shortMessage: e?.shortMessage ? String(e.shortMessage) : undefined,
    message: e?.message ? String(e.message) : undefined,
    causeShortMessage: e?.cause?.shortMessage ? String(e.cause.shortMessage) : undefined,
    causeMessage: e?.cause?.message ? String(e.cause.message) : undefined,
    name: e?.name ? String(e.name) : undefined,
  };
};

export const tryAutoBuyOnce = async (input: {
  chainId: number;
  tokenAddress: `0x${string}`;
  metrics: TokenMetrics;
  strategy: any;
  signal?: UnifiedTwitterSignal;
  amountNativeOverride?: number;
  gasPriceGweiOverride?: string;
  priorityFeeBnbOverride?: string;
  tokenAgeMode?: 'signal_delta' | 'now_age';
  onStateChanged: () => void;
  loadBoughtOnceIfNeeded: () => Promise<void>;
  persistBoughtOnce: () => Promise<void>;
  getKey: (chainId: number, tokenAddress: `0x${string}`, opts?: { dry?: boolean; walletAddress?: `0x${string}` }) => string;
  boughtOnceAtMs: Map<string, number>;
  buyInFlight: Set<string>;
  computeWsConfirm: (tokenAddress: `0x${string}`, nowMs: number, strategy: any) => {
    pass: boolean;
    windowMs: number;
    stats?: { mcapChangePct?: number; holdersDelta?: number; buySellRatio?: number };
  };
  shouldLogWsConfirmFail: (key: string, nowMs: number) => boolean;
  shouldEmitBuyFailureRecord?: (input: {
    reason: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    signal?: UnifiedTwitterSignal;
  }) => boolean;
  emitRecord: (record: XSniperBuyRecord) => void;
  broadcastToActiveTabs: (message: any) => Promise<void>;
  fetchTokenInfoFresh: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  buildGenericTokenInfo: (chainId: number, tokenAddress: `0x${string}`) => Promise<TokenInfo | null>;
  getEntryPriceUsd: (
    chainId: number,
    tokenAddress: `0x${string}`,
    tokenInfo: TokenInfo,
    fallback: number | null,
    fallbackMcapUsd: number | null,
  ) => Promise<number | null>;
  registerRapidExitPosition: (input: {
    strategy: any;
    posKey: string;
    chainId: number;
    tokenAddress: `0x${string}`;
    dryRun: boolean;
    entryMcapUsd: number | null;
    buyAmountNative: number;
    openedAtMs: number;
    tweetAtMs?: number;
    tweetUrl?: string;
    tweetType?: string;
    channel?: string;
    signalId?: string;
    signalEventId?: string;
    signalTweetId?: string;
    entryPriceUsd?: number | null;
    walletAddress?: `0x${string}`;
  }) => void;
  dryRunAutoSellByPosKey: Map<string, DryRunAutoSellPos>;
  onAttemptOutcome?: (outcome: { bought: boolean; attempted: boolean; reason?: string; detail?: any }) => void;
}) => {
  await input.loadBoughtOnceIfNeeded();
  const dryRun = input.strategy?.dryRun === true;
  const status = dryRun ? null : await WalletService.getStatus();
  const strategyWalletAddress = parseStrategyWalletAddress(input.strategy?.walletAddress);
  const availableWalletSet = new Set(
    (status?.accounts ?? [])
      .map((acc) => String(acc?.address ?? '').trim().toLowerCase())
      .filter((addr): addr is `0x${string}` => /^0x[a-f0-9]{40}$/.test(addr)),
  );
  if (!dryRun && strategyWalletAddress && !availableWalletSet.has(strategyWalletAddress)) {
    console.warn('XSniperTrade configured wallet not found in unlocked accounts', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      strategyWalletAddress,
    });
    try {
      input.onAttemptOutcome?.({ bought: false, attempted: false, reason: 'configured_wallet_not_unlocked' });
    } catch {
    }
    return false;
  }
  const tradeFromAddress =
    strategyWalletAddress || (!dryRun && status?.address)
      ? (String(strategyWalletAddress || status?.address).toLowerCase() as `0x${string}`)
      : undefined;
  const key = input.getKey(input.chainId, input.tokenAddress, { dry: dryRun, walletAddress: tradeFromAddress });
  const globalLockKey = !dryRun
    ? buildGlobalBuyLockKey({ chainId: input.chainId, tokenAddress: input.tokenAddress, walletAddress: tradeFromAddress })
    : null;
  let attempted = false;
  let lastFailureReason: string | undefined;
  const notifyOutcome = (outcome: { bought: boolean; attempted: boolean; reason?: string; detail?: any }) => {
    try {
      input.onAttemptOutcome?.(outcome);
    } catch {
    }
  };
  const emitBuyFailure = (reason: string, extras?: {
    buyAmountNative?: number;
    metrics?: TokenMetrics;
    tokenInfo?: TokenInfo | null;
    confirm?: { windowMs?: number; stats?: { mcapChangePct?: number; holdersDelta?: number; buySellRatio?: number } };
    txHash?: `0x${string}`;
    buySubmittedAtMs?: number;
  }) => {
    lastFailureReason = reason;
    if (dryRun) {
      const m = extras?.metrics ?? input.metrics;
      console.log('XSniperTrade dry-run buy skipped', {
        reason,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        launchpadPlatform: m.launchpadPlatform,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        buyAmountNative: extras?.buyAmountNative,
        confirmWindowMs: extras?.confirm?.windowMs,
        confirmStats: extras?.confirm?.stats,
      });
      return;
    }
    if (input.shouldEmitBuyFailureRecord && !input.shouldEmitBuyFailureRecord({
      reason,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      signal: input.signal,
    })) return;
    console.warn('XSniperTrade buy skipped', { reason, chainId: input.chainId, tokenAddress: input.tokenAddress });
    const now = Date.now();
    const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
    const tweetUrl = buildTweetUrl(input.signal);
    const m = extras?.metrics ?? input.metrics;
    input.emitRecord({
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      side: 'buy',
      tsMs: now,
      buySubmittedAtMs: extras?.buySubmittedAtMs,
      tweetAtMs,
      tweetUrl,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      walletAddress: tradeFromAddress,
      tokenSymbol: extras?.tokenInfo?.symbol ? String(extras.tokenInfo.symbol) : (m.tokenSymbol ? String(m.tokenSymbol) : undefined),
      tokenName: extras?.tokenInfo?.name ? String(extras.tokenInfo.name) : undefined,
      launchpadPlatform: m.launchpadPlatform,
      buyAmountNative: extras?.buyAmountNative,
      dryRun: false,
      reason,
      txHash: extras?.txHash,
      marketCapUsd: m.marketCapUsd,
      liquidityUsd: m.liquidityUsd,
      holders: m.holders,
      kol: m.kol,
      vol24hUsd: m.vol24hUsd,
      netBuy24hUsd: m.netBuy24hUsd,
      buyTx24h: m.buyTx24h,
      sellTx24h: m.sellTx24h,
      smartMoney: m.smartMoney,
      createdAtMs: m.createdAtMs,
      devAddress: m.devAddress,
      devHoldPercent: m.devHoldPercent,
      devMaxBuyPercent: (m as any).devMaxBuyPercent,
      viewerCount: (m as any).viewerCount,
      devCreatedTokenCount: (m as any).devCreatedTokenCount,
      devHasSold: m.devHasSold,
      confirmWindowMs: extras?.confirm?.windowMs,
      confirmMcapChangePct: extras?.confirm?.stats?.mcapChangePct,
      confirmHoldersDelta: extras?.confirm?.stats?.holdersDelta,
      confirmBuySellRatio: extras?.confirm?.stats?.buySellRatio,
      userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
      userName: input.signal?.userName ? String(input.signal.userName) : undefined,
      tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
      channel: input.signal?.channel ? String(input.signal.channel) : undefined,
      signalId: input.signal?.id ? String(input.signal.id) : undefined,
      signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
      signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
    } as XSniperBuyRecord);
  };
  if (input.boughtOnceAtMs.has(key)) {
    emitBuyFailure('buy_skipped_recently_bought');
    notifyOutcome({ bought: false, attempted: false, reason: lastFailureReason });
    return false;
  }
  if (!dryRun && terminalFailedBuyKeys.has(key)) {
    emitBuyFailure('buy_skipped_terminal_failed');
    notifyOutcome({ bought: false, attempted: false, reason: lastFailureReason });
    return false;
  }
  if (input.buyInFlight.has(key)) {
    emitBuyFailure('buy_skipped_in_flight');
    notifyOutcome({ bought: false, attempted: false, reason: lastFailureReason });
    return false;
  }
  if (globalLockKey && globalBoughtLockKeys.has(globalLockKey)) {
    emitBuyFailure('buy_skipped_global_locked');
    notifyOutcome({ bought: false, attempted: false, reason: lastFailureReason });
    return false;
  }
  if (globalLockKey && globalBuyInFlightKeys.has(globalLockKey)) {
    emitBuyFailure('buy_skipped_global_in_flight');
    notifyOutcome({ bought: false, attempted: false, reason: lastFailureReason });
    return false;
  }
  input.buyInFlight.add(key);
  if (globalLockKey) globalBuyInFlightKeys.add(globalLockKey);
  try {
    attempted = true;
    const amountNumber = (typeof input.amountNativeOverride === 'number' && Number.isFinite(input.amountNativeOverride)
      ? input.amountNativeOverride
      : (parseNumber(input.strategy.buyAmountNative) ?? 0));
    if (amountNumber <= 0) {
      emitBuyFailure('buy_invalid_amount', { buyAmountNative: amountNumber });
      notifyOutcome({ bought: false, attempted, reason: lastFailureReason });
      return false;
    }

    const confirmNowMs = Date.now();
    const confirm = input.computeWsConfirm(input.tokenAddress, confirmNowMs, input.strategy);
    if (!confirm.pass) {
      if (dryRun) {
        const sigKey = typeof input.signal?.id === 'string' && input.signal.id.trim() ? input.signal.id.trim() : '';
        const dedupe = `${sigKey}:${input.chainId}:${input.tokenAddress.toLowerCase()}`;
        if (input.shouldLogWsConfirmFail(dedupe, confirmNowMs)) {
          const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
          const tweetUrl = buildTweetUrl(input.signal);
          input.emitRecord({
            id: `${confirmNowMs}-${Math.random().toString(16).slice(2)}`,
            side: 'buy',
            tsMs: confirmNowMs,
            tweetAtMs,
            tweetUrl,
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            walletAddress: tradeFromAddress,
            tokenSymbol: input.metrics.tokenSymbol,
            launchpadPlatform: input.metrics.launchpadPlatform,
            buyAmountNative: amountNumber,
            dryRun: true,
            reason: 'ws_confirm_failed',
            marketCapUsd: input.metrics.marketCapUsd,
            liquidityUsd: input.metrics.liquidityUsd,
            holders: input.metrics.holders,
            kol: input.metrics.kol,
            vol24hUsd: input.metrics.vol24hUsd,
            netBuy24hUsd: input.metrics.netBuy24hUsd,
            buyTx24h: input.metrics.buyTx24h,
            sellTx24h: input.metrics.sellTx24h,
            smartMoney: input.metrics.smartMoney,
            createdAtMs: input.metrics.createdAtMs,
            devAddress: input.metrics.devAddress,
            devHoldPercent: input.metrics.devHoldPercent,
            devMaxBuyPercent: (input.metrics as any).devMaxBuyPercent,
            viewerCount: (input.metrics as any).viewerCount,
            devCreatedTokenCount: (input.metrics as any).devCreatedTokenCount,
            devHasSold: input.metrics.devHasSold,
            confirmWindowMs: confirm.windowMs,
            confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
            confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
            confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
            userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
            userName: input.signal?.userName ? String(input.signal.userName) : undefined,
            tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
            channel: input.signal?.channel ? String(input.signal.channel) : undefined,
            signalId: input.signal?.id ? String(input.signal.id) : undefined,
            signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
            signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
          } as XSniperBuyRecord);
        }
      }
      emitBuyFailure('ws_confirm_failed', {
        buyAmountNative: amountNumber,
        confirm,
      });
      notifyOutcome({
        bought: false,
        attempted,
        reason: lastFailureReason,
        detail: {
          wsConfirm: {
            windowMs: confirm.windowMs,
            failedChecks: (confirm as any).failedChecks as WsConfirmFailedCheck[] | undefined,
            stats: confirm.stats ?? undefined,
          },
        },
      });
      return false;
    }

    if (!dryRun && (!status || status.locked || !status.address)) {
      emitBuyFailure('wallet_locked', { buyAmountNative: amountNumber, confirm });
      notifyOutcome({ bought: false, attempted, reason: lastFailureReason });
      return false;
    }

    const tokenInfo =
      (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
      (await input.buildGenericTokenInfo(input.chainId, input.tokenAddress));
    if (!tokenInfo) {
      emitBuyFailure('token_info_missing', { buyAmountNative: amountNumber, confirm });
      notifyOutcome({ bought: false, attempted, reason: lastFailureReason });
      return false;
    }

    const sanitizedInputMcap = sanitizeMarketCapUsd(input.metrics.marketCapUsd);
    const refreshedMcap = Number(tokenInfo?.tokenPrice?.marketCap ?? 0);
    const sanitizedRefreshedMcap = sanitizeMarketCapUsd(refreshedMcap);
    const refreshedMetrics: TokenMetrics = {
      ...input.metrics,
      tokenAddress: input.tokenAddress,
      marketCapUsd: sanitizedRefreshedMcap ?? sanitizedInputMcap ?? undefined,
      priceUsd: input.metrics.priceUsd,
    };
    const signalAtMs = getSignalTimeMs(input.signal);
    const skipTokenCreatedAtWindowCheck = isRepostOrQuoteSignal(input.signal);
    if (!shouldBuyByConfig(refreshedMetrics, input.strategy, signalAtMs, Date.now(), {
      skipTokenCreatedAtWindowCheck,
      tokenAgeMode: input.tokenAgeMode,
    })) {
      emitBuyFailure('buy_filter_mismatch_after_refresh', {
        buyAmountNative: amountNumber,
        metrics: refreshedMetrics,
        tokenInfo,
        confirm,
      });
      notifyOutcome({ bought: false, attempted, reason: lastFailureReason });
      return false;
    }

    if (dryRun) {
      const dryRunBuyDelayMs = Math.max(0, Math.min(10_000, Math.floor(parseNumber(input.strategy?.dryRunBuyDelayMs) ?? 1000)));
      if (dryRunBuyDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, dryRunBuyDelayMs));
      }
      const delayedRefreshed: any = (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ?? {};
      const delayedTokenInfo = delayedRefreshed.tokenInfo ?? tokenInfo;
      const delayedRawMcap = Number(delayedTokenInfo?.tokenPrice?.marketCap ?? 0);
      const delayedMcap = sanitizeMarketCapUsd(delayedRawMcap);
      const dryRunMetrics: TokenMetrics = {
        ...refreshedMetrics,
        marketCapUsd: delayedMcap ?? refreshedMetrics.marketCapUsd,
      };
      const entryPriceUsd = await input.getEntryPriceUsd(
        input.chainId,
        input.tokenAddress,
        delayedTokenInfo,
        dryRunMetrics.priceUsd ?? null,
        dryRunMetrics.marketCapUsd ?? null,
      );
      const delayedTokenPriceUsd = Number(delayedTokenInfo?.tokenPrice?.price ?? 0);
      const dryRunEntryMcapAnchor = resolveEntryMcapAnchor({
        postBuyMcapUsd: delayedMcap,
        entryPriceUsd,
        referencePriceUsd: Number.isFinite(dryRunMetrics.priceUsd as any) ? Number(dryRunMetrics.priceUsd) : delayedTokenPriceUsd,
        referenceMcapUsd: dryRunMetrics.marketCapUsd ?? null,
        fallbackMcapUsd: dryRunMetrics.marketCapUsd ?? null,
      });
      input.boughtOnceAtMs.set(key, Date.now());
      void input.persistBoughtOnce();
      input.onStateChanged();

      const posKey = buildPositionKey({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        walletAddress: tradeFromAddress,
        dryRun: true,
      });
      const openedAtMs = Date.now();
      const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
      const tweetUrl = buildTweetUrl(input.signal);
      const tweetType = input.signal?.tweetType ? String(input.signal.tweetType) : undefined;
      const channel = input.signal?.channel ? String(input.signal.channel) : undefined;
      const signalId = input.signal?.id ? String(input.signal.id) : undefined;
      const signalEventId = input.signal?.eventId ? String(input.signal.eventId) : undefined;
      const signalTweetId = input.signal?.tweetId ? String(input.signal.tweetId) : undefined;
      input.registerRapidExitPosition({
        strategy: input.strategy,
        posKey,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        dryRun: true,
        entryMcapUsd: dryRunEntryMcapAnchor,
        buyAmountNative: amountNumber,
        openedAtMs,
        tweetAtMs,
        tweetUrl,
        tweetType,
        channel,
        signalId,
        signalEventId,
        signalTweetId,
        entryPriceUsd,
        walletAddress: tradeFromAddress,
      });

      const now = Date.now();
      input.emitRecord({
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        side: 'buy',
        tsMs: now,
        tweetAtMs,
        tweetUrl,
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        walletAddress: tradeFromAddress,
        tokenSymbol: delayedTokenInfo.symbol ? String(delayedTokenInfo.symbol) : undefined,
        tokenName: delayedTokenInfo.name ? String(delayedTokenInfo.name) : undefined,
        launchpadPlatform: dryRunMetrics.launchpadPlatform,
        buyAmountNative: amountNumber,
        txHash: undefined,
        entryPriceUsd: entryPriceUsd ?? undefined,
        dryRun: true,
        marketCapUsd: dryRunEntryMcapAnchor ?? dryRunMetrics.marketCapUsd,
        athMarketCapUsd: dryRunEntryMcapAnchor ?? dryRunMetrics.marketCapUsd,
        liquidityUsd: dryRunMetrics.liquidityUsd,
        holders: dryRunMetrics.holders,
        kol: dryRunMetrics.kol,
        vol24hUsd: dryRunMetrics.vol24hUsd,
        netBuy24hUsd: dryRunMetrics.netBuy24hUsd,
        buyTx24h: dryRunMetrics.buyTx24h,
        sellTx24h: dryRunMetrics.sellTx24h,
        smartMoney: dryRunMetrics.smartMoney,
        createdAtMs: dryRunMetrics.createdAtMs,
        devAddress: dryRunMetrics.devAddress,
        devHoldPercent: dryRunMetrics.devHoldPercent,
        devMaxBuyPercent: (dryRunMetrics as any).devMaxBuyPercent,
        viewerCount: (dryRunMetrics as any).viewerCount,
        devCreatedTokenCount: (dryRunMetrics as any).devCreatedTokenCount,
        devHasSold: dryRunMetrics.devHasSold,
        confirmWindowMs: confirm.windowMs,
        confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
        confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
        confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
        userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
        userName: input.signal?.userName ? String(input.signal.userName) : undefined,
        tweetType: input.signal?.tweetType ? String(input.signal.tweetType) : undefined,
        channel: input.signal?.channel ? String(input.signal.channel) : undefined,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
      } as XSniperBuyRecord);
      notifyOutcome({ bought: true, attempted, reason: undefined });
      return true;
    }

    const amountWei = parseEther(String(amountNumber));
    let rsp: any;
    let buySubmittedAtMs: number | undefined;
    let submittedTxHash: `0x${string}` | undefined;
    let tokenInfoForTrade = tokenInfo;
    try {
      rsp = await TradeService.buyWithReceiptAndNonceRecovery({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        bnbAmountWei: amountWei.toString(),
        fromAddress: tradeFromAddress,
        tokenInfo: tokenInfoForTrade,
        gasPriceGwei: input.gasPriceGweiOverride,
        priorityFeeBnb: input.priorityFeeBnbOverride,
      } as any, {
        // Hard cap: at most one nonce-triggered resend.
        maxRetry: 1,
        onRetry: async (ctx) => {
          await input.broadcastToActiveTabs({
            type: 'bg:tradeRetrying',
            source: 'xsniper',
            side: 'buy',
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            attempt: ctx.attempt,
            reason: ctx.reason,
          });
        },
        onSubmitted: async (ctx) => {
          buySubmittedAtMs = Date.now();
          submittedTxHash = ctx.txHash;
          await input.broadcastToActiveTabs({
            type: 'bg:tradeSubmitted',
            source: 'xsniper',
            side: 'buy',
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            txHash: ctx.txHash,
            submitElapsedMs: ctx.submitElapsedMs,
          });
        },
      });
    } catch (e: any) {
      const stage = buySubmittedAtMs ? 'receipt' : 'submit';
      const buyFailReason = stage === 'receipt' ? classifyBuyReceiptFailureReason(e) : classifyBuySubmitFailureReason(e);
      console.error('[xsniper.buy.failed]', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        fromAddress: tradeFromAddress,
        stage,
        buyAmountNative: amountNumber,
        buyAmountWei: amountWei.toString(),
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        reason: buyFailReason,
        tokenInfo: summarizeTokenInfoForLog(tokenInfoForTrade),
        error: summarizeErrorForLog(e),
      });
      console.warn('[xsniper.buy.failed]', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        walletAddress: tradeFromAddress,
        stage,
        signalId: input.signal?.id ? String(input.signal.id) : undefined,
        signalEventId: input.signal?.eventId ? String(input.signal.eventId) : undefined,
        signalTweetId: input.signal?.tweetId ? String(input.signal.tweetId) : undefined,
        reason: buyFailReason,
        error: String(e?.shortMessage || e?.message || e || ''),
      });
      emitBuyFailure(buyFailReason, {
        buyAmountNative: amountNumber,
        metrics: refreshedMetrics,
        tokenInfo: tokenInfoForTrade,
        confirm,
        txHash: submittedTxHash,
        buySubmittedAtMs,
      });
    }
    if (!rsp) {
      console.error('XSniperTrade buy submit failed', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        fromAddress: tradeFromAddress,
        buyAmountNative: amountNumber,
        buyAmountWei: amountWei.toString(),
        tokenInfo: summarizeTokenInfoForLog(tokenInfoForTrade),
      });
      notifyOutcome({ bought: false, attempted, reason: lastFailureReason || 'buy_submit_failed' });
      return false;
    }
    void input.broadcastToActiveTabs({
      type: 'bg:tradeSuccess',
      source: 'xsniper',
      side: 'buy',
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      txHash: (rsp as any)?.txHash,
      submitElapsedMs: (rsp as any)?.submitElapsedMs,
      receiptElapsedMs: (rsp as any)?.receiptElapsedMs,
      totalElapsedMs: (rsp as any)?.totalElapsedMs,
      broadcastVia: (rsp as any)?.broadcastVia,
      broadcastUrl: (rsp as any)?.broadcastUrl,
      isBundle: (rsp as any)?.isBundle,
    });


    // PreApproveForAutoSell
    if (tradeFromAddress) {
      const approveStartAtMs = Date.now();
      void (async () => {
        try {
          const approveTx = await TradeService.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfoForTrade, {
            fromAddress: tradeFromAddress,
          });
          if (approveTx) {
            console.log('[xsniper.buy.post_approve][submitted]', {
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              approveTx,
              elapsedMs: Date.now() - approveStartAtMs,
            });
          }
        } catch (e: any) {
          console.warn('[xsniper.buy.post_approve][failed]', {
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            error: String(e?.shortMessage || e?.message || e || ''),
            elapsedMs: Date.now() - approveStartAtMs,
          });
        }
      })();
    }

    const entryPriceUsd = await input.getEntryPriceUsd(
      input.chainId,
      input.tokenAddress,
      tokenInfoForTrade,
      refreshedMetrics.priceUsd ?? null,
      refreshedMetrics.marketCapUsd ?? null,
    );
    const postBuyTokenInfo =
      (await input.fetchTokenInfoFresh(input.chainId, input.tokenAddress)) ??
      tokenInfoForTrade;
    const postBuyRawMcap = Number(postBuyTokenInfo?.tokenPrice?.marketCap ?? 0);
    const postBuyMcapUsd = sanitizeMarketCapUsd(postBuyRawMcap);
    const postBuyPriceUsd = Number(postBuyTokenInfo?.tokenPrice?.price ?? 0);
    const entryMcapAnchor = resolveEntryMcapAnchor({
      postBuyMcapUsd,
      entryPriceUsd,
      referencePriceUsd: Number.isFinite(refreshedMetrics.priceUsd as any) ? Number(refreshedMetrics.priceUsd) : postBuyPriceUsd,
      referenceMcapUsd: refreshedMetrics.marketCapUsd ?? null,
      fallbackMcapUsd: refreshedMetrics.marketCapUsd ?? null,
    });
    input.boughtOnceAtMs.set(key, Date.now());
    if (globalLockKey) globalBoughtLockKeys.add(globalLockKey);
    terminalFailedBuyKeys.delete(key);
    void input.persistBoughtOnce();
    input.onStateChanged();
    const posKey = buildPositionKey({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      walletAddress: tradeFromAddress,
      dryRun: false,
    });
    const openedAtMs = Date.now();
    const tweetAtMs = getSignalTimeMs(input.signal) ?? undefined;
    const tweetUrl = buildTweetUrl(input.signal);
    const tweetType = input.signal?.tweetType ? String(input.signal.tweetType) : undefined;
    const channel = input.signal?.channel ? String(input.signal.channel) : undefined;
    const signalId = input.signal?.id ? String(input.signal.id) : undefined;
    const signalEventId = input.signal?.eventId ? String(input.signal.eventId) : undefined;
    const signalTweetId = input.signal?.tweetId ? String(input.signal.tweetId) : undefined;

    input.registerRapidExitPosition({
      strategy: input.strategy,
      posKey,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      dryRun: false,
      entryMcapUsd: entryMcapAnchor,
      buyAmountNative: amountNumber,
      openedAtMs,
      tweetAtMs,
      tweetUrl,
      tweetType,
      channel,
      signalId,
      signalEventId,
      signalTweetId,
      entryPriceUsd,
      walletAddress: tradeFromAddress,
    });
    const effectiveEntryPriceUsd = entryPriceUsd;

    const now = Date.now();
    input.emitRecord({
      id: `${now}-${Math.random().toString(16).slice(2)}`,
      side: 'buy',
      tsMs: now,
      buySubmittedAtMs,
      tweetAtMs,
      tweetUrl,
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      walletAddress: tradeFromAddress,
      tokenSymbol: tokenInfoForTrade.symbol ? String(tokenInfoForTrade.symbol) : undefined,
      tokenName: tokenInfoForTrade.name ? String(tokenInfoForTrade.name) : undefined,
      launchpadPlatform: refreshedMetrics.launchpadPlatform,
      buyAmountNative: amountNumber,
      txHash: typeof (rsp as any)?.txHash === 'string' ? ((rsp as any).txHash as any) : undefined,
      entryPriceUsd: effectiveEntryPriceUsd ?? undefined,
      dryRun: false,
      marketCapUsd: entryMcapAnchor ?? refreshedMetrics.marketCapUsd,
      athMarketCapUsd: entryMcapAnchor ?? refreshedMetrics.marketCapUsd,
      liquidityUsd: refreshedMetrics.liquidityUsd,
      holders: refreshedMetrics.holders,
      kol: refreshedMetrics.kol,
      vol24hUsd: refreshedMetrics.vol24hUsd,
      netBuy24hUsd: refreshedMetrics.netBuy24hUsd,
      buyTx24h: refreshedMetrics.buyTx24h,
      sellTx24h: refreshedMetrics.sellTx24h,
      smartMoney: refreshedMetrics.smartMoney,
      createdAtMs: refreshedMetrics.createdAtMs,
      devAddress: refreshedMetrics.devAddress,
      devHoldPercent: refreshedMetrics.devHoldPercent,
      devMaxBuyPercent: (refreshedMetrics as any).devMaxBuyPercent,
      viewerCount: (refreshedMetrics as any).viewerCount,
      devCreatedTokenCount: (refreshedMetrics as any).devCreatedTokenCount,
      devHasSold: refreshedMetrics.devHasSold,
      confirmWindowMs: confirm.windowMs,
      confirmMcapChangePct: confirm.stats?.mcapChangePct ?? undefined,
      confirmHoldersDelta: confirm.stats?.holdersDelta ?? undefined,
      confirmBuySellRatio: confirm.stats?.buySellRatio ?? undefined,
      userScreen: input.signal?.userScreen ? String(input.signal.userScreen) : undefined,
      userName: input.signal?.userName ? String(input.signal.userName) : undefined,
      tweetType,
      channel,
      signalId,
      signalEventId,
      signalTweetId,
    } as XSniperBuyRecord);

    console.log('XSniperTrade buy tx', (rsp as any)?.txHash ?? '');
    notifyOutcome({ bought: true, attempted, reason: undefined });
    return true;
  } finally {
    input.buyInFlight.delete(key);
    if (globalLockKey) globalBuyInFlightKeys.delete(globalLockKey);
  }
};
