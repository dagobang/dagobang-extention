import { ChainId } from '@/constants/chains/chainId';
import { SettingsService } from '@/services/settings';
import { TokenService } from '@/services/token';
import { SolanaRpcService, type SolanaConfirmationCommitment } from './rpc';
import { solanaWalletAdapter } from './solanaWalletAdapter';
import type { TradeExecutor } from '../types';
import type { ChainAddress, EvmAddress } from '@/types/chain';
import type { SubmitChannel, TxBuyInput, TxSellInput } from '@/types/extention';
import type { TokenInfo } from '@/types/token';
import { resolveKnownSolanaDirectSource, resolveSolanaSourceAlias, SOLANA_NATIVE_MINT, SOLANA_ZERO_ADDRESS } from './trade/constants';
import { broadcastSolanaBuiltTransaction } from './trade/broadcaster';
import { planSolanaTrade, prewarmSolanaTradePlan } from './trade/planner';
import type { SolanaSignerContext, SolanaTradeRequest } from './trade/types';
import { prewarmPumpfunTrade } from '../../../packages/solana-dex-core/src/protocols/pumpfun/adapter';
import { prewarmBagsTrade } from '../../../packages/solana-dex-core/src/protocols/bags/adapter';
import { prewarmBonkTrade } from '../../../packages/solana-dex-core/src/protocols/bonk/adapter';
import { prewarmMeteoraTrade } from '../../../packages/solana-dex-core/src/protocols/meteora/adapter';

import { prewarmPumpSwapTrade } from '../../../packages/solana-dex-core/src/protocols/pumpswap/adapter';
import { prewarmRaydiumTrade } from '../../../packages/solana-dex-core/src/protocols/raydium/cpmm/adapter';
import { getSolanaTradeAdapter } from '../../../packages/solana-dex-core/src/registry';

function logSubmitGap(location: string, msg: string, data: Record<string, unknown>) {
  fetch('http://127.0.0.1:7779/event', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: 'solana-submit-gap',
      runId: 'pre-fix',
      hypothesisId: 'A',
      location,
      msg,
      data,
      ts: Date.now(),
    }),
  }).catch(() => { });
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
    || message.includes('pool base mint mismatch');
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
    // #region debug-point G:submit-gap-get-signer-start
    logSubmitGap('solanaTradeExecutor.ts:getSigner:start', '[DEBUG] submit gap get signer start', {
      requestId,
      fromAddress: fromAddress ?? null,
    });
    // #endregion
    const signer = await solanaWalletAdapter.getSigner(fromAddress);
    const address = signer.publicKey.toBase58();
    if (fromAddress && fromAddress !== address) throw new Error('Invalid from address');
    // #region debug-point G:submit-gap-get-signer-done
    logSubmitGap('solanaTradeExecutor.ts:getSigner:done', '[DEBUG] submit gap get signer done', {
      requestId,
      fromAddress: fromAddress ?? null,
      resolvedAddress: address,
      elapsedMs: Date.now() - signerStartedAt,
    });
    // #endregion
    return { signer, address };
  }

  private async buildTradeRequest(
    side: 'buy' | 'sell',
    input: TxBuyInput | TxSellInput,
    ownerAddress: string,
  ): Promise<SolanaTradeRequest> {
    const buildStartedAt = Date.now();
    const requestId = String((input as any).__debugSubmitGapId || '').trim() || null;
    // #region debug-point G:submit-gap-build-request-start
    logSubmitGap('solanaTradeExecutor.ts:buildTradeRequest:start', '[DEBUG] submit gap build trade request start', {
      requestId,
      side,
      ownerAddress,
      tokenAddress: input.tokenAddress,
    });
    // #endregion
    // #region debug-point D:executor-build-start
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:buildTradeRequest:start', msg: '[DEBUG] executor build trade request start', data: { side, ownerAddress, tokenAddress: input.tokenAddress, executionModeOverride: (input as TxBuyInput | TxSellInput).executionModeOverride ?? null }, ts: Date.now() }) }).catch(() => { });
    // #endregion
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
    // #region debug-point P1:executor-build-request
    fetch('http://127.0.0.1:7778/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'pumpfun-legacy-route',
        runId: 'post-fix',
        hypothesisId: 'P1',
        location: 'solanaTradeExecutor.ts:buildTradeRequest',
        msg: '[DEBUG] solana trade request built',
        data: {
          side,
          ownerAddress,
          tokenAddress: input.tokenAddress,
          baseTokenAddress: side === 'buy' ? (input as TxBuyInput).baseTokenAddress ?? null : (input as TxSellInput).baseTokenAddress ?? null,
          amount,
          slippageBps,
          platform: tokenInfo?.launchpad_platform ?? tokenInfo?.launchpad ?? null,
          poolPair: tokenInfo?.pool_pair ?? null,
          dexType: tokenInfo?.dex_type ?? null,
          quoteTokenAddress: tokenInfo?.quote_token_address ?? null,
        },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    // #region debug-point D:executor-build-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:buildTradeRequest:done', msg: '[DEBUG] executor build trade request done', data: { side, ownerAddress, tokenAddress: input.tokenAddress, amount, slippageBps, elapsedMs: Date.now() - buildStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point D:executor-build-input-summary
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-trade-latency',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'solanaTradeExecutor.ts:buildTradeRequest:inputSummary',
        msg: '[DEBUG] executor build trade request input summary',
        data: {
          side,
          ownerAddress,
          tokenAddress: input.tokenAddress,
          executionModeOverride: (input as TxBuyInput | TxSellInput).executionModeOverride ?? null,
          submitChannel: (input as TxBuyInput | TxSellInput).submitChannel ?? null,
          gasPreset: (input as TxBuyInput | TxSellInput).gasPreset ?? null,
          priorityFeeNative: (input as TxBuyInput | TxSellInput).priorityFeeNative ?? null,
        },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    // #region debug-point G:submit-gap-build-request-done
    logSubmitGap('solanaTradeExecutor.ts:buildTradeRequest:done', '[DEBUG] submit gap build trade request done', {
      requestId,
      side,
      ownerAddress,
      tokenAddress: input.tokenAddress,
      amount,
      slippageBps,
      elapsedMs: Date.now() - buildStartedAt,
    });
    // #endregion
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
    // #region debug-point D:executor-execute-start
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:executeRequest:start', msg: '[DEBUG] executor execute request start', data: { side: request.side, ownerAddress: request.ownerAddress, inputMint: request.inputMint, outputMint: request.outputMint, amount: request.amount }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point G:submit-gap-execute-start
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:start', '[DEBUG] submit gap execute request start', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      amount: request.amount,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
    });
    // #endregion
    const planStartedAt = Date.now();
    const hintedSource = resolveKnownSolanaDirectSource(
      request.tokenInfo,
      request.side === 'buy' ? request.outputMint : request.inputMint,
    );
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
      // #region debug-point G:submit-gap-plan-fastpath
      logSubmitGap('solanaTradeExecutor.ts:executeRequest:planFastPath', '[DEBUG] submit gap plan fast path', {
        requestId,
        side: request.side,
        ownerAddress: request.ownerAddress,
        hintedSource,
        launchpadStatus: request.tokenInfo?.launchpad_status ?? null,
        platform: request.tokenInfo?.launchpad_platform ?? request.tokenInfo?.launchpad ?? null,
        tpoolLaunchType: (request.tokenInfo as any)?.tpool_launch_type ?? null,
        elapsedMs: Date.now() - planStartedAt,
      });
      // #endregion
    } else {
      const planned = await planSolanaTrade(request);
      adapter = planned.adapter;
      plan = planned.plan;
      if (request.rawInput && typeof request.rawInput === 'object') {
        (request.rawInput as any).__plannedSource = plan.source;
      }
    }
    // #region debug-point D:executor-plan-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:executeRequest:planDone', msg: '[DEBUG] executor plan trade done', data: { side: request.side, ownerAddress: request.ownerAddress, reason: plan.reason, elapsedMs: Date.now() - planStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point D:executor-plan-detail
    fetch('http://127.0.0.1:7777/event', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'solana-trade-latency',
        runId: 'pre-fix',
        hypothesisId: 'D',
        location: 'solanaTradeExecutor.ts:executeRequest:planDetail',
        msg: '[DEBUG] executor plan detail',
        data: {
          side: request.side,
          ownerAddress: request.ownerAddress,
          hintedSource: hintedSource ?? null,
          planSource: plan.source,
          planMode: plan.mode,
          reason: plan.reason,
        },
        ts: Date.now(),
      }),
    }).catch(() => { });
    // #endregion
    // #region debug-point G:submit-gap-plan-done
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:planDone', '[DEBUG] submit gap plan trade done', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      reason: plan.reason,
      elapsedMs: Date.now() - planStartedAt,
    });
    // #endregion
    const adapterBuildStartedAt = Date.now();
    let built;
    try {
      built = await adapter.build(request);
    } catch (error) {
      // #region debug-point sell-timeout-build-catch
      fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:executeRequest:adapterBuildCatch', msg: '[DEBUG] sell execute adapter build failed', data: { side: request.side, ownerAddress: request.ownerAddress, inputMint: request.inputMint, outputMint: request.outputMint, hintedSource: hintedSource ?? null, plannedSource: plan?.source ?? null, reason: plan?.reason ?? null, platform: request.tokenInfo?.launchpad_platform ?? request.tokenInfo?.launchpad ?? null, launchpadStatus: request.tokenInfo?.launchpad_status ?? null, errorMessage: String((error as any)?.message || error || ''), elapsedMs: Date.now() - adapterBuildStartedAt }, ts: Date.now() }) }).catch(() => { });
      // #endregion
      if (!hintedSource || !shouldFallbackKnownDirectSource(error)) throw error;
      const fallbackPlanStartedAt = Date.now();
      const planned = await planSolanaTrade(request);
      adapter = planned.adapter;
      plan = planned.plan;
      if (request.rawInput && typeof request.rawInput === 'object') {
        (request.rawInput as any).__plannedSource = plan.source;
      }
      // #region debug-point G:submit-gap-plan-fallback
      logSubmitGap('solanaTradeExecutor.ts:executeRequest:planFallback', '[DEBUG] submit gap plan fallback', {
        requestId,
        side: request.side,
        ownerAddress: request.ownerAddress,
        hintedSource,
        fallbackSource: plan.source,
        launchpadStatus: request.tokenInfo?.launchpad_status ?? null,
        platform: request.tokenInfo?.launchpad_platform ?? request.tokenInfo?.launchpad ?? null,
        tpoolLaunchType: (request.tokenInfo as any)?.tpool_launch_type ?? null,
        error: String((error as any)?.message || error || ''),
        elapsedMs: Date.now() - fallbackPlanStartedAt,
      });
      // #endregion
      built = await adapter.build(request);
    }
    // #region debug-point D:executor-adapter-build-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:executeRequest:adapterBuildDone', msg: '[DEBUG] executor adapter build done', data: { side: request.side, ownerAddress: request.ownerAddress, source: built.source, tokenMinOutWei: built.tokenMinOutWei ?? null, elapsedMs: Date.now() - adapterBuildStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point sell-timeout-build-done
    fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:executeRequest:adapterBuildDone', msg: '[DEBUG] sell execute adapter build done', data: { side: request.side, ownerAddress: request.ownerAddress, source: built.source, plannerReason: plan.reason, tokenMinOutWei: built.tokenMinOutWei ?? null, submitChannel: (request.rawInput as TxBuyInput | TxSellInput | undefined)?.submitChannel ?? null, executionMode: (request.rawInput as TxBuyInput | TxSellInput | undefined)?.executionModeOverride ?? 'default', elapsedMs: Date.now() - adapterBuildStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point G:submit-gap-adapter-build-done
    logSubmitGap('solanaTradeExecutor.ts:executeRequest:adapterBuildDone', '[DEBUG] submit gap adapter build done', {
      requestId,
      side: request.side,
      ownerAddress: request.ownerAddress,
      source: built.source,
      tokenMinOutWei: built.tokenMinOutWei ?? null,
      elapsedMs: Date.now() - adapterBuildStartedAt,
    });
    // #endregion
    built.plannerReason = plan.reason;
    const submitChannel = (request.rawInput as TxBuyInput | TxSellInput | undefined)?.submitChannel;
    const executionMode = (request.rawInput as TxBuyInput | TxSellInput | undefined)?.executionModeOverride === 'turbo'
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
        executionMode,
        debugRequestId: requestId ?? undefined,
      });
    } catch (error) {
      // #region debug-point sell-timeout-broadcast-catch
      fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:executeRequest:broadcastCatch', msg: '[DEBUG] sell execute broadcast failed', data: { side: request.side, ownerAddress: request.ownerAddress, source: built.source, submitChannel: submitChannel ?? null, executionMode, errorMessage: String((error as any)?.message || error || ''), elapsedMs: Date.now() - broadcastStartedAt, totalElapsedMs: Date.now() - executeStartedAt }, ts: Date.now() }) }).catch(() => { });
      // #endregion
      throw error;
    }
    // #region debug-point D:executor-broadcast-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:executeRequest:broadcastDone', msg: '[DEBUG] executor broadcast done', data: { side: request.side, ownerAddress: request.ownerAddress, txHash: result.txHash, broadcastVia: result.broadcastVia, broadcastUrl: result.broadcastUrl ?? null, broadcastElapsedMs: Date.now() - broadcastStartedAt, totalElapsedMs: Date.now() - executeStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point sell-timeout-broadcast-done
    fetch('http://127.0.0.1:7780/event', { method: 'POST', body: JSON.stringify({ sessionId: 'sell-request-timeout', runId: 'pre-fix', hypothesisId: 'D', location: 'solanaTradeExecutor.ts:executeRequest:broadcastDone', msg: '[DEBUG] sell execute broadcast done', data: { side: request.side, ownerAddress: request.ownerAddress, txHash: result.txHash, broadcastVia: result.broadcastVia, broadcastUrl: result.broadcastUrl ?? null, broadcastElapsedMs: Date.now() - broadcastStartedAt, totalElapsedMs: Date.now() - executeStartedAt }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    // #region debug-point G:submit-gap-broadcast-done
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
    // #endregion
    return result;
  }

  async prewarmTurbo(_input: {
    chainId: number;
    tokenAddress: string;
    tokenInfo?: TokenInfo;
    fromAddress?: string;
    submitChannel?: SubmitChannel;
    platform?: string;
  }) {
    if (_input.chainId !== ChainId.SOL) return;
    const tokenAddress = String(_input.tokenAddress || '').trim();
    if (!tokenAddress) return;
    const directSource = resolveKnownSolanaDirectSource(_input.tokenInfo, tokenAddress)
      ?? resolveSolanaSourceAlias(_input.tokenInfo?.launchpad_platform || _input.tokenInfo?.launchpad || null)
      ?? resolveSolanaSourceAlias(_input.platform);
    const runtime = {
      getConnection: () => SolanaRpcService.getConnection(),
    };
    const planRequest = {
      side: 'buy' as const,
      chainId: _input.chainId,
      ownerAddress: _input.fromAddress || '11111111111111111111111111111111',
      inputMint: SOLANA_NATIVE_MINT,
      outputMint: tokenAddress,
      amount: '1',
      slippageBps: 100,
      tokenInfo: _input.tokenInfo,
      rawInput: { executionModeOverride: 'turbo' } as any,
      runtime,
    };
    // #region debug-point A:solana-prewarm-start
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:start', msg: '[DEBUG] solana prewarm turbo start', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    if (directSource === 'pumpswap') {
      await Promise.all([
        prewarmPumpSwapTrade({
          tokenAddress,
          ownerAddress: _input.fromAddress,
          executionMode: 'turbo',
          tokenInfo: _input.tokenInfo,
          runtime,
        }),
        prewarmSolanaTradePlan(planRequest),
      ]);
      // #region debug-point A:solana-prewarm-done
      fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
      // #endregion
      return;
    }
    if (directSource === 'raydium') {
      await Promise.all([
        prewarmRaydiumTrade({
          tokenAddress,
          ownerAddress: _input.fromAddress,
          executionMode: 'turbo',
          tokenInfo: _input.tokenInfo,
          runtime,
        }),
        prewarmSolanaTradePlan(planRequest),
      ]);
      fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
      return;
    }
    if (directSource === 'bonk') {
      await Promise.all([
        prewarmBonkTrade({
          tokenAddress,
          ownerAddress: _input.fromAddress,
          executionMode: 'turbo',
          tokenInfo: _input.tokenInfo,
          runtime,
        }),
        prewarmSolanaTradePlan(planRequest),
      ]);
      fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
      return;
    }
    if (directSource === 'meteora') {
      await Promise.all([
        prewarmMeteoraTrade({
          tokenAddress,
          ownerAddress: _input.fromAddress,
          executionMode: 'turbo',
          tokenInfo: _input.tokenInfo,
          runtime,
        }),
        prewarmSolanaTradePlan(planRequest),
      ]);
      fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
      return;
    }
    if (directSource === 'bags') {
      await Promise.all([
        prewarmBagsTrade({
          tokenAddress,
          ownerAddress: _input.fromAddress,
          executionMode: 'turbo',
          tokenInfo: _input.tokenInfo,
          runtime,
        }),
        prewarmSolanaTradePlan(planRequest),
      ]);
      fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
      return;
    }
    if (directSource !== 'pumpfun') {
      await prewarmSolanaTradePlan(planRequest);
      // #region debug-point A:solana-prewarm-done
      fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
      // #endregion
      return;
    }
    await Promise.all([
      prewarmPumpfunTrade({
        tokenAddress,
        ownerAddress: _input.fromAddress,
        executionMode: 'turbo',
        tokenInfo: _input.tokenInfo,
        runtime,
      }),
      prewarmSolanaTradePlan(planRequest),
    ]);
    // #region debug-point A:solana-prewarm-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'A', location: 'solanaTradeExecutor.ts:prewarmTurbo:done', msg: '[DEBUG] solana prewarm turbo done', data: { chainId: _input.chainId, tokenAddress, ownerAddress: _input.fromAddress ?? null, directSource, submitChannel: _input.submitChannel ?? null }, ts: Date.now() }) }).catch(() => { });
    // #endregion
  }

  async refreshNonce(_input: {
    chainId: number;
    fromAddress?: EvmAddress;
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
    // #region debug-point G:submit-gap-buy-start
    logSubmitGap('solanaTradeExecutor.ts:buy:start', '[DEBUG] submit gap buy start', {
      requestId,
      fromAddress: input.fromAddress ?? null,
      tokenAddress: input.tokenAddress,
      amount: input.nativeAmountWei ?? (input as any).bnbAmountWei ?? null,
    });
    // #endregion
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
    // #region debug-point C:solana-buy-confirm-start
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'C', location: 'solanaTradeExecutor.ts:buyConfirmStart', msg: '[DEBUG] solana buy confirm start', data: { txHash: rsp.txHash, blockhash: (rsp as any).blockhash ?? null, lastValidBlockHeight: (rsp as any).lastValidBlockHeight ?? null, timeoutMs: opts?.timeoutMs ?? null, commitment: confirmation.commitment, pollIntervalMs: confirmation.pollIntervalMs }, ts: Date.now() }) }).catch(() => { });
    // #endregion
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
    // #region debug-point C:solana-buy-confirm-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'C', location: 'solanaTradeExecutor.ts:buyConfirmDone', msg: '[DEBUG] solana buy confirm done', data: { txHash: rsp.txHash, confirmUrl: (confirmationResult as any)?.confirmUrl ?? null, receiptElapsedMs: Date.now() - receiptStart }, ts: Date.now() }) }).catch(() => { });
    // #endregion
    const receiptElapsedMs = Date.now() - receiptStart;
    return {
      txHash: rsp.txHash,
      tokenMinOutWei: rsp.tokenMinOutWei,
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
    // #region debug-point C:solana-sell-confirm-start
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'C', location: 'solanaTradeExecutor.ts:sellConfirmStart', msg: '[DEBUG] solana sell confirm start', data: { txHash: rsp.txHash, blockhash: (rsp as any).blockhash ?? null, lastValidBlockHeight: (rsp as any).lastValidBlockHeight ?? null, timeoutMs: opts?.timeoutMs ?? null, commitment: confirmation.commitment, pollIntervalMs: confirmation.pollIntervalMs }, ts: Date.now() }) }).catch(() => { });
    // #endregion
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
    // #region debug-point C:solana-sell-confirm-done
    fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'solana-trade-latency', runId: 'pre-fix', hypothesisId: 'C', location: 'solanaTradeExecutor.ts:sellConfirmDone', msg: '[DEBUG] solana sell confirm done', data: { txHash: rsp.txHash, confirmUrl: (confirmationResult as any)?.confirmUrl ?? null, receiptElapsedMs: Date.now() - receiptStart }, ts: Date.now() }) }).catch(() => { });
    // #endregion
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
    _opts?: { extraSpenders?: string[]; fromAddress?: EvmAddress; submitChannel?: SubmitChannel }
  ) {
    return null;
  }

  async checkSellAllowanceInsufficient(
    _chainId: number,
    _tokenAddress: string,
    _tokenInfo: TokenInfo,
    _opts?: { extraSpenders?: string[]; fromAddress?: EvmAddress }
  ) {
    return { insufficient: false, checked: [] };
  }
}

export const solanaTradeExecutor = new SolanaTradeExecutor();
