import { ChainId } from '@/constants/chains/chainId';
import { SettingsService } from '@/services/settings';
import { TokenService } from '@/services/token';
import { SolanaRpcService, type SolanaConfirmationCommitment } from './rpc';
import { solanaWalletAdapter } from './solanaWalletAdapter';
import type { TradeExecutor } from '../types';
import type { ChainAddress, EvmAddress } from '@/types/chain';
import type { SolanaFeeMode, SubmitChannel, TradeTurboPrewarmInput, TxBuyInput, TxSellInput } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { resolveSolanaTradeSource, SOLANA_NATIVE_MINT, SOLANA_ZERO_ADDRESS } from './trade/constants';
import { broadcastSolanaBuiltTransaction } from './trade/broadcaster';
import { planSolanaTrade } from './trade/planner';
import { prewarmSolanaTurboTradeContext } from './trade/prewarm';
import type { SolanaSignerContext, SolanaTradeRequest } from './trade/types';
import { getSolanaTradeAdapter } from '../../../packages/solana-dex-core/src/registry';

function logSubmitGap(_location: string, _msg: string, _data: Record<string, unknown>) {
}

function unsupported(method: string): never {
  throw new Error(`Solana ${method} is not supported in this executor`);
}

function shouldFallbackKnownDirectSource(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  if (!message) return false;
  return message.includes('use pumpswap/amm route instead')
    || message.includes('cannot handle this trade')
    || message.includes('bonding curve is complete')
    || message.includes('pool account not found')
    || message.includes('pool context')
    || message.includes('pool quote mint is not wsol')
    || message.includes('pool base mint mismatch')
    || message.includes('quotereserve');
}

function shouldFallbackPlannedDirectSource(
  request: SolanaTradeRequest,
  plan: { source: string; mode: string; reason: string },
  error: unknown,
): boolean {
  if (plan.source === 'jupiter' || plan.mode !== 'direct') return false;
  const { resolvedPlatform: platform } = resolveSolanaTradeSource({
    tokenInfo: request.tokenInfo,
    tokenAddress: request.side === 'buy' ? request.outputMint : request.inputMint,
  });
  if (platform === 'pump' || platform === 'pumpfun' || platform === 'pump.fun' || platform === 'pumpswap' || platform === 'pump_swap' || platform === 'pumpamm' || platform === 'pump amm') {
    return false;
  }
  return shouldFallbackKnownDirectSource(error);
}

export class SolanaTradeExecutor implements TradeExecutor {
  private async resolveExecutionMode(chainId: number, override?: 'default' | 'turbo'): Promise<'default' | 'turbo'> {
    if (override === 'turbo' || override === 'default') return override;
    const settings = await SettingsService.get();
    return settings.chains?.[chainId]?.executionMode === 'turbo' ? 'turbo' : 'default';
  }

  private async resolveConfirmationOptions(chainId: number, override?: 'default' | 'turbo'): Promise<{
    commitment: SolanaConfirmationCommitment;
    pollIntervalMs: number;
  }> {
    const mode = await this.resolveExecutionMode(chainId, override);
    return mode === 'turbo'
      ? { commitment: 'processed', pollIntervalMs: 250 }
      : { commitment: 'confirmed', pollIntervalMs: 1000 };
  }

  private async resolveSlippageBps(chainId: number, inputSlippageBps?: number): Promise<number> {
    if (typeof inputSlippageBps === 'number' && inputSlippageBps > 0) return inputSlippageBps;
    const settings = await SettingsService.get();
    return settings.chains?.[chainId]?.slippageBps ?? 100;
  }

  private resolveMint(address?: ChainAddress): string {
    const raw = typeof address === 'string' ? address.trim() : '';
    if (!raw || raw.toLowerCase() === SOLANA_ZERO_ADDRESS.toLowerCase()) return SOLANA_NATIVE_MINT;
    return raw;
  }

  private async getSigner(fromAddress?: ChainAddress): Promise<SolanaSignerContext> {
    const signerStartedAt = Date.now();
    const requestId = String((globalThis as any).__solanaSubmitGapRequestId || '').trim() || null;
    logSubmitGap('solanaTradeExecutor.ts:getSigner:start', '[DEBUG] submit gap get signer start', {
      requestId,
      fromAddress: fromAddress ?? null,
    });
    const signer = await solanaWalletAdapter.getSigner(fromAddress);
    const address = signer.publicKey.toBase58();
    if (fromAddress && fromAddress !== address) throw new Error('Invalid from address');
    logSubmitGap('solanaTradeExecutor.ts:getSigner:done', '[DEBUG] submit gap get signer done', {
      requestId,
      fromAddress: fromAddress ?? null,
      resolvedAddress: address,
      elapsedMs: Date.now() - signerStartedAt,
    });
    return { signer, address };
  }

  private async buildTradeRequest(
    side: 'buy' | 'sell',
    input: TxBuyInput | TxSellInput,
    ownerAddress: string,
  ): Promise<SolanaTradeRequest> {
    const buildStartedAt = Date.now();
    const requestId = String((input as any).__debugSubmitGapId || '').trim() || null;
    logSubmitGap('solanaTradeExecutor.ts:buildTradeRequest:start', '[DEBUG] submit gap build trade request start', {
      requestId,
      side,
      ownerAddress,
      tokenAddress: input.tokenAddress,
    });
    if (input.chainId !== ChainId.SOL) throw new Error('Unsupported chain');
    let amount = side === 'buy'
      ? String((input as TxBuyInput).nativeAmountWei || (input as TxBuyInput).bnbAmountWei || '0').trim()
      : String((input as TxSellInput).tokenAmountWei || '0').trim();
    if (side === 'sell' && (!amount || BigInt(amount) <= 0n)) {
      const sellInput = input as TxSellInput;
      const percentBps = Number(sellInput.sellPercentBps ?? 0);
      if (Number.isFinite(percentBps) && percentBps > 0 && percentBps <= 10000) {
        const hintedBalance = (() => {
          const raw = String(sellInput.expectedTokenInWei || '0').trim();
          if (!raw) return 0n;
          try {
            return BigInt(raw);
          } catch {
            return 0n;
          }
        })();
        if (input.chainId === ChainId.SOL && hintedBalance <= 0n) {
          throw new Error('Solana sellable balance not ready');
        }
        const onchainBalance = hintedBalance > 0n
          ? hintedBalance
          : BigInt(await TokenService.getBalance(sellInput.tokenAddress, ownerAddress, input.chainId));
        let computedAmount = percentBps >= 10000
          ? onchainBalance
          : (onchainBalance * BigInt(percentBps)) / 10000n;
        if (computedAmount <= 0n && onchainBalance > 0n && percentBps >= 10000) {
          computedAmount = onchainBalance;
        }
        amount = computedAmount.toString();
      }
    }
    if (!amount || BigInt(amount) <= 0n) throw new Error('Invalid amount');
    const slippageBps = await this.resolveSlippageBps(input.chainId, input.slippageBps);
    const tokenInfo = input.tokenInfo ?? undefined;
    logSubmitGap('solanaTradeExecutor.ts:buildTradeRequest:done', '[DEBUG] submit gap build trade request done', {
      requestId,
      side,
      ownerAddress,
      tokenAddress: input.tokenAddress,
      amount,
      slippageBps,
      elapsedMs: Date.now() - buildStartedAt,
    });
    return {
      side,
      chainId: input.chainId,
      ownerAddress,
      inputMint: side === 'buy'
        ? this.resolveMint((input as TxBuyInput).baseTokenAddress)
        : input.tokenAddress,
      outputMint: side === 'buy'
        ? input.tokenAddress
        : this.resolveMint((input as TxSellInput).baseTokenAddress),
      amount,
      slippageBps,
      fromAddress: input.fromAddress,
      tokenInfo,
      rawInput: input,
      runtime: {
        getConnection: () => SolanaRpcService.getConnection(),
      },
    };
  }

  private async executeRequest(request: SolanaTradeRequest, signer: SolanaSignerContext) {
    const executeStartedAt = Date.now();
    const requestId = String((request.rawInput as any)?.__debugSubmitGapId || '').trim() || null;
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:start', '[DEBUG] submit gap execute request start', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      amount: request.amount,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
    });
    const planStartedAt = Date.now();
    const tokenAddress = request.side === 'buy' ? request.outputMint : request.inputMint;
    const sourceResolution = resolveSolanaTradeSource({
      tokenInfo: request.tokenInfo,
      tokenAddress,
    });
    const hintedSource = sourceResolution.knownDirectSource;
    let adapter;
    let plan;
    if (hintedSource) {
      adapter = getSolanaTradeAdapter(hintedSource);
      plan = {
        source: hintedSource,
        mode: adapter.capability.mode,
        reason: `hint:${hintedSource}`,
      };
      if (request.rawInput && typeof request.rawInput === 'object') {
        (request.rawInput as any).__plannedSource = plan.source;
      }
      logSubmitGap('solanaTradeExecutor.ts:executeRequest:planFastPath', '[DEBUG] submit gap plan fast path', {
        requestId,
        side: request.side,
        ownerAddress: request.ownerAddress,
        hintedSource,
        launchpadStatus: request.tokenInfo?.launchpad_status ?? null,
        platform: sourceResolution.resolvedPlatform || null,
        tpoolLaunchType: (request.tokenInfo as any)?.tpool_launch_type ?? null,
        elapsedMs: Date.now() - planStartedAt,
      });
    } else {
      const planned = await planSolanaTrade(request);
      adapter = planned.adapter;
      plan = planned.plan;
      if (request.rawInput && typeof request.rawInput === 'object') {
        (request.rawInput as any).__plannedSource = plan.source;
      }
    }
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:planDone', '[DEBUG] submit gap plan trade done', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      reason: plan.reason,
      elapsedMs: Date.now() - planStartedAt,
    });
    const adapterBuildStartedAt = Date.now();
    let built;
    try {
      built = await adapter.build(request);
    } catch (error) {
      if (!hintedSource && !shouldFallbackPlannedDirectSource(request, plan, error)) throw error;
      if (hintedSource && !shouldFallbackKnownDirectSource(error)) throw error;
      const fallbackPlanStartedAt = Date.now();
      if (hintedSource) {
        const planned = await planSolanaTrade(request);
        adapter = planned.adapter;
        plan = planned.plan;
      } else {
        adapter = getSolanaTradeAdapter('jupiter');
        plan = {
          source: 'jupiter',
          mode: 'aggregator',
          reason: `fallback:jupiter:${plan.source}`,
        };
      }
      if (request.rawInput && typeof request.rawInput === 'object') {
        (request.rawInput as any).__plannedSource = plan.source;
      }
      logSubmitGap('solanaTradeExecutor.ts:executeRequest:planFallback', '[DEBUG] submit gap plan fallback', {
        requestId,
        side: request.side,
        ownerAddress: request.ownerAddress,
        hintedSource,
        fallbackSource: plan.source,
        launchpadStatus: request.tokenInfo?.launchpad_status ?? null,
        platform: sourceResolution.resolvedPlatform || null,
        tpoolLaunchType: (request.tokenInfo as any)?.tpool_launch_type ?? null,
        error: String((error as any)?.message || error || ''),
        elapsedMs: Date.now() - fallbackPlanStartedAt,
      });
      built = await adapter.build(request);
    }
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:adapterBuildDone', '[DEBUG] submit gap adapter build done', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      source: built.source,
      protectionMinOutWei: built.protectionMinOutWei ?? null,
      quotedOutWei: built.quotedOutWei ?? null,
      elapsedMs: Date.now() - adapterBuildStartedAt,
    });
    built.plannerReason = plan.reason;
    const rawInput = (request.rawInput as TxBuyInput | TxSellInput | undefined);
    const submitChannel = rawInput?.submitChannel;
    const solanaFeeMode: SolanaFeeMode = rawInput?.solanaFeeMode === 'tip' || rawInput?.solanaFeeMode === 'pf_and_tip'
      ? rawInput.solanaFeeMode
      : 'pf';
    const executionMode = rawInput?.executionModeOverride === 'turbo'
      ? 'turbo'
      : 'default';
    const broadcastStartedAt = Date.now();
    let result;
    try {
      result = await broadcastSolanaBuiltTransaction({
        built,
        signer,
        txSide: request.side,
        submitChannel,
        solanaFeeMode,
        executionMode,
        debugRequestId: requestId ?? undefined,
      });
    } catch (error) {
      throw error;
    }
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:broadcastDone', '[DEBUG] submit gap broadcast done', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      txHash: result.txHash,
      broadcastVia: result.broadcastVia,
      broadcastUrl: result.broadcastUrl ?? null,
      broadcastElapsedMs: Date.now() - broadcastStartedAt,
      totalElapsedMs: Date.now() - executeStartedAt,
    });
    return result;
  }

  async prewarmTurbo(_input: TradeTurboPrewarmInput) {
    await prewarmSolanaTurboTradeContext(_input);
  }

  async refreshNonce(_input: {
    chainId: number;
    fromAddress?: string;
    txSide?: 'buy' | 'sell';
    submitChannel?: SubmitChannel;
    error?: any;
  }) {
    return 0;
  }

  async buy(
    input: TxBuyInput,
    _runtimeOpts?: {
      forceRefreshHyperState?: boolean;
    }
  ) {
    const requestId = `buy:${input.fromAddress || 'unknown'}:${input.tokenAddress}:${Date.now()}`;
    (input as any).__debugSubmitGapId = requestId;
    (globalThis as any).__solanaSubmitGapRequestId = requestId;
    logSubmitGap('solanaTradeExecutor.ts:buy:start', '[DEBUG] submit gap buy start', {
      requestId,
      fromAddress: input.fromAddress ?? null,
      tokenAddress: input.tokenAddress,
      amount: input.nativeAmountWei ?? (input as any).bnbAmountWei ?? null,
    });
    const signer = await this.getSigner(input.fromAddress);
    const request = await this.buildTradeRequest('buy', input, signer.address);
    try {
      return await this.executeRequest(request, signer);
    } finally {
      if ((globalThis as any).__solanaSubmitGapRequestId === requestId) {
        delete (globalThis as any).__solanaSubmitGapRequestId;
      }
    }
  }

  async buyWithReceiptAndNonceRecovery(
    input: TxBuyInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: import('../types').BuyRetryContext) => void | Promise<void>;
      onSubmitted?: (ctx: import('../types').BuySubmittedContext) => void | Promise<void>;
    }
  ) {
    const startedAt = Date.now();
    const submitStart = Date.now();
    const rsp = await this.buy(input);
    const submitElapsedMs = Date.now() - submitStart;
    await opts?.onSubmitted?.({ side: 'buy', txHash: rsp.txHash, submitElapsedMs, broadcastVia: rsp.broadcastVia, broadcastUrl: rsp.broadcastUrl });
    const receiptStart = Date.now();
    const confirmation = await this.resolveConfirmationOptions(input.chainId, input.executionModeOverride);
    const confirmationResult = await SolanaRpcService.confirmSignature(
      rsp.txHash,
      (rsp as any).blockhash,
      (rsp as any).lastValidBlockHeight,
      opts?.timeoutMs,
      {
        ...confirmation,
        txSide: 'buy',
        submitChannel: input.submitChannel,
      },
    );
    const receiptElapsedMs = Date.now() - receiptStart;
    return {
      txHash: rsp.txHash,
      protectionMinOutWei: rsp.protectionMinOutWei,
      quotedOutWei: rsp.quotedOutWei ?? null,
      broadcastVia: rsp.broadcastVia,
      broadcastUrl: rsp.broadcastUrl,
      confirmUrl: (confirmationResult as any)?.confirmUrl,
      submitElapsedMs,
      receiptElapsedMs,
      totalElapsedMs: Date.now() - startedAt,
    };
  }

  async sell(
    input: TxSellInput,
    _runtimeOpts?: {
      forceRefreshHyperState?: boolean;
      traceId?: string;
      attempt?: number;
      onAllowanceRepairStart?: (ctx: { chainId: number; tokenAddress: string }) => void | Promise<void>;
    }
  ) {
    const signer = await this.getSigner(input.fromAddress);
    const request = await this.buildTradeRequest('sell', input, signer.address);
    return await this.executeRequest(request, signer);
  }

  async sellWithReceiptAndAutoRecovery(
    input: TxSellInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: import('../types').SellRetryContext) => void | Promise<void>;
      onSubmitted?: (ctx: import('../types').SellSubmittedContext) => void | Promise<void>;
    }
  ) {
    const startedAt = Date.now();
    const submitStart = Date.now();
    const rsp = await this.sell(input);
    const submitElapsedMs = Date.now() - submitStart;
    await opts?.onSubmitted?.({ side: 'sell', txHash: rsp.txHash, submitElapsedMs, broadcastVia: rsp.broadcastVia, broadcastUrl: rsp.broadcastUrl });
    const receiptStart = Date.now();
    const confirmation = await this.resolveConfirmationOptions(input.chainId, input.executionModeOverride);
    const confirmationResult = await SolanaRpcService.confirmSignature(
      rsp.txHash,
      (rsp as any).blockhash,
      (rsp as any).lastValidBlockHeight,
      opts?.timeoutMs,
      {
        ...confirmation,
        txSide: 'sell',
        submitChannel: input.submitChannel,
      },
    );
    const receiptElapsedMs = Date.now() - receiptStart;
    return {
      txHash: rsp.txHash,
      broadcastVia: rsp.broadcastVia,
      broadcastUrl: rsp.broadcastUrl,
      confirmUrl: (confirmationResult as any)?.confirmUrl,
      submitElapsedMs,
      receiptElapsedMs,
      totalElapsedMs: Date.now() - startedAt,
    };
  }

  async approve(
    _chainId: number,
    _tokenAddress: EvmAddress,
    _spender: EvmAddress,
    _amountWei: string,
    _fromAddress?: EvmAddress,
    _submitChannel?: SubmitChannel,
  ) {
    return unsupported('approve');
  }

  async wrapNative(_chainId: number, _amountWei: string, _fromAddress?: EvmAddress) {
    return unsupported('wrapNative');
  }

  async unwrapWrapped(_chainId: number, _amountWei: string, _fromAddress?: EvmAddress) {
    return unsupported('unwrapWrapped');
  }

  async approveMaxForSellIfNeeded(
    _chainId: number,
    _tokenAddress: string,
    _tokenInfo: TokenInfo,
    _opts?: { extraSpenders?: string[]; fromAddress?: string; submitChannel?: SubmitChannel }
  ) {
    return null;
  }

  async checkSellAllowanceInsufficient(
    _chainId: number,
    _tokenAddress: string,
    _tokenInfo: TokenInfo,
    _opts?: { extraSpenders?: string[]; fromAddress?: string }
  ) {
    return { insufficient: false, checked: [] };
  }
}

export const solanaTradeExecutor = new SolanaTradeExecutor();
