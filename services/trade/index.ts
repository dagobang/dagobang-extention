import { encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import { RpcService } from '../rpc';
import { WalletService } from '../wallet';
import { SettingsService } from '../settings';
import type { GasPreset, TxBuyInput, TxSellInput } from '../../types/extention';
import { TokenInfo } from '../../types/token';
import { ContractNames } from '../../constants/contracts/names';
import { DeployAddress } from '../../constants/contracts/address';
import { ChainId } from '../../constants/chains/chainId';
import { getBridgeTokenDexPreference } from '../../constants/tokens/allTokens';
import { USDC, USDT } from '../../constants/tokens/chains/common';
import { dagobangAbi } from '@/constants/contracts/abi';
import { Address, HyperSwapType, SwapDescLike, SwapType, ZERO_ADDRESS, applySlippage, getDeadline, getRouterSwapDesc, getSlippageBps, getV3FeeForDesc, toHyperDexSwapType } from './tradeTypes';
import { assertDexQuoteOk, getBridgeToken, quoteBestExactIn as quoteBestExactInDex, resolveBridgeHopExactIn, resolveDexExactIn } from './tradeDex';
import { getGasPriceWei, prewarmNonce, sendTransaction } from './tradeTx';
import { getSellSpenders, hasInsufficientSellAllowance, type SellAllowanceCheckResult } from './sellAllowance';
import { encodeFourMemeBuyTokenData, encodeFourMemeUint256, tryFourMemeBuyEstimatedAmount, tryFourMemeSellEstimatedFunds } from './tradeFourMeme';
import {
  encodeHyperZapBuyData,
  encodeHyperZapSellData,
  getHyperZapBuyGrossMinUsdc,
  getHyperTradeState,
  getHyperUsdcAddress,
  isHyperAltfunPlatform,
  quoteHyperBuyFromUsdc,
  quoteHyperSellToUsdc,
} from './tradeHyper';
import { formatBroadcastProvider } from '@/utils/format';
import { getDexPoolPrefer, parseGweiToWei } from '@/utils/dexUtils';
import { classifyBroadcastError, collectErrorText, getNonceErrorKindFromText, isAllowanceLikeText, isInFlightLimitLikeText } from '@/utils/txErrorClassify';
import { tryGetReceiptRevertReason } from '@/services/tx/errors';
import { getNativeSymbol } from '@/constants/chains';
import { getChainRuntime } from '@/constants/chains/runtime';

function getDefaultBridgeV3Fee(chainId: number): number {
  return chainId === ChainId.HYPER ? 3000 : 500;
}

export class TradeService {
  private static sellInFlightByToken = new Set<string>();
  private static readonly approveInFlightByKey = new Map<string, Promise<`0x${string}`>>();
  private static readonly fastApproveRetryMaxWaitMs = 800;
  private static readonly fastApproveRetryPollMs = 200;
  private static readonly quoteBestExactInCache = new Map<string, { ts: number; value: { amountOut: bigint; swapType: number; fee?: number; poolAddress: string } }>();
  private static readonly quoteBestExactInInFlight = new Map<string, Promise<{ amountOut: bigint; swapType: number; fee?: number; poolAddress: string }>>();
  private static readonly turboPrewarmInFlight = new Map<string, Promise<void>>();

  private static makeApproveKey(chainId: number, owner: string, token: string, spender: string) {
    return `${chainId}:${owner.toLowerCase()}:${token.toLowerCase()}:${spender.toLowerCase()}`;
  }

  private static getTurboWarmFingerprint(tokenInfo: TokenInfo) {
    return [
      String(tokenInfo.launchpad_platform || '').toLowerCase(),
      String(tokenInfo.launchpad_status ?? ''),
      String(tokenInfo.pool_pair || '').toLowerCase(),
      String(tokenInfo.dex_type || '').toLowerCase(),
      String(tokenInfo.quote_token_address || '').toLowerCase(),
    ].join('|');
  }

  private static makeTurboWarmKey(input: {
    chainId: number;
    owner: `0x${string}`;
    tokenAddress: Address;
    tokenInfo: TokenInfo;
  }) {
    return [
      input.chainId,
      input.owner.toLowerCase(),
      input.tokenAddress.toLowerCase(),
      this.getTurboWarmFingerprint(input.tokenInfo),
    ].join(':');
  }

  private static async awaitTurboPrewarmIfInFlight(input: {
    chainId: number;
    owner: `0x${string}`;
    tokenAddress: Address;
    tokenInfo: TokenInfo;
  }) {
    const key = this.makeTurboWarmKey(input);
    const task = this.turboPrewarmInFlight.get(key);
    if (!task) return false;
    await task;
    return true;
  }

  private static async approveMaxForSpenderIfNeeded(input: {
    chainId: number;
    tokenAddress: string;
    owner: `0x${string}`;
    spender: string;
    maxUint256: bigint;
    client: any;
  }): Promise<`0x${string}` | null> {
    const allowance = await input.client.readContract({
      address: input.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, input.spender as `0x${string}`]
    });
    if (allowance >= input.maxUint256 / 2n) return null;

    const key = this.makeApproveKey(input.chainId, input.owner, input.tokenAddress, input.spender);
    const inFlight = this.approveInFlightByKey.get(key);
    if (inFlight) return await inFlight;

    const task = (async () => await this.approve(input.chainId, input.tokenAddress, input.spender, input.maxUint256.toString(), input.owner))();
    this.approveInFlightByKey.set(key, task);
    try {
      return await task;
    } finally {
      const cur = this.approveInFlightByKey.get(key);
      if (cur === task) this.approveInFlightByKey.delete(key);
    }
  }


  static async quoteBestExactIn(
    chainId: number,
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    amountIn: bigint,
    opts?: { v3Fee?: number; poolPair?: string; prefer?: 'v2' | 'v3'; cacheTtlMs?: number; force?: boolean }
  ): Promise<{ amountOut: bigint; swapType: number; fee?: number; poolAddress: string }> {
    const ttlMs = Math.max(0, Number(opts?.cacheTtlMs ?? 0));
    const force = opts?.force === true;
    const cacheKey = [
      chainId,
      tokenIn.toLowerCase(),
      tokenOut.toLowerCase(),
      amountIn.toString(),
      opts?.v3Fee ?? '',
      opts?.poolPair?.toLowerCase() ?? '',
      opts?.prefer ?? '',
    ].join(':');
    const cached = this.quoteBestExactInCache.get(cacheKey);
    if (!force && ttlMs > 0 && cached && Date.now() - cached.ts < ttlMs) return cached.value;
    const inflight = this.quoteBestExactInInFlight.get(cacheKey);
    if (!force && ttlMs > 0 && inflight) return await inflight;
    const p = quoteBestExactInDex(chainId, tokenIn, tokenOut, amountIn, opts).finally(() => {
      this.quoteBestExactInInFlight.delete(cacheKey);
    });
    if (ttlMs > 0) this.quoteBestExactInInFlight.set(cacheKey, p);
    const resolved = await p;
    if (ttlMs > 0) this.quoteBestExactInCache.set(cacheKey, { ts: Date.now(), value: resolved });
    return resolved;
  }

  static async prewarmTurbo(input: { chainId: number; tokenAddress: Address; tokenInfo?: TokenInfo; fromAddress?: `0x${string}` }) {
    const settings = await SettingsService.get();
    const consoleLogsEnabled = settings.ui?.consoleLogsEnabled === true;
    const startedAt = Date.now();
    const tokenInfo = input.tokenInfo;
    if (!tokenInfo) return;

    const client = await RpcService.getClient(input.chainId);
    const account = await WalletService.getSigner(input.fromAddress);
    const warmKey = this.makeTurboWarmKey({
      chainId: input.chainId,
      owner: account.address,
      tokenAddress: input.tokenAddress,
      tokenInfo,
    });
    const existing = this.turboPrewarmInFlight.get(warmKey);
    if (existing) {
      if (consoleLogsEnabled) {
        console.info('[trade.buy.prewarm.reuse]', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          fromAddress: account.address,
          warmKey,
        });
      }
      await existing;
      return;
    }

    const task = (async () => {
      await prewarmNonce(client, input.chainId, account.address);

      const token = input.tokenAddress;
      const bridgeToken = getBridgeToken(input.chainId as ChainId, tokenInfo.address, tokenInfo.quote_token_address);
      const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      const dexPrefer = getDexPoolPrefer(tokenInfo.dex_type);
      const tokenPrefer = dexPrefer === 'v2' || dexPrefer === 'v3' ? dexPrefer : (bridgePrefer ?? 'v2');

      const amountIn = 0n;
      const warmTasks: Array<Promise<unknown>> = [];

      if (tokenInfo.pool_pair && tokenPrefer === 'v2') {
        warmTasks.push(resolveDexExactIn(input.chainId, ZERO_ADDRESS, token, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v2' }, true, false));
        warmTasks.push(resolveDexExactIn(input.chainId, token, ZERO_ADDRESS, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v2' }, true, false));
      }

      if (tokenInfo.pool_pair && tokenPrefer === 'v3') {
        warmTasks.push(
          resolveDexExactIn(
            input.chainId,
            ZERO_ADDRESS,
            token,
            amountIn,
            { poolPair: tokenInfo.pool_pair, prefer: 'v3' },
            true,
            false
          )
        );
        warmTasks.push(
          resolveDexExactIn(
            input.chainId,
            token,
            ZERO_ADDRESS,
            amountIn,
            { poolPair: tokenInfo.pool_pair, prefer: 'v3' },
            true,
            false
          )
        );
      }

      if (bridgeToken) {
        warmTasks.push(resolveBridgeHopExactIn(
          input.chainId,
          ZERO_ADDRESS,
          bridgeToken,
          amountIn,
          bridgePrefer,
          true,
          false,
        ));
        warmTasks.push(resolveBridgeHopExactIn(
          input.chainId,
          bridgeToken,
          ZERO_ADDRESS,
          amountIn,
          bridgePrefer,
          true,
          false,
        ));
      }

      if (bridgeToken && tokenInfo.pool_pair && tokenPrefer === 'v3') {
        warmTasks.push(resolveDexExactIn(input.chainId, token, bridgeToken, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v3' }, true, false));
        warmTasks.push(resolveDexExactIn(input.chainId, bridgeToken, token, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v3' }, true, false));
      }

      await Promise.allSettled(warmTasks);
      const elapsedMs = Date.now() - startedAt;
      if (consoleLogsEnabled || elapsedMs >= 600) {
        console.info('[trade.buy.prewarm]', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          fromAddress: account.address,
          warmTaskCount: warmTasks.length,
          hasBridgeToken: !!bridgeToken,
          tokenPrefer,
          elapsedMs,
          warmKey,
        });
      }
    })().finally(() => {
      const current = this.turboPrewarmInFlight.get(warmKey);
      if (current === task) this.turboPrewarmInFlight.delete(warmKey);
    });

    this.turboPrewarmInFlight.set(warmKey, task);
    await task;
  }

  static async refreshNonce(input: {
    chainId: number;
    fromAddress?: `0x${string}`;
    txSide?: 'buy' | 'sell';
    error?: any;
  }): Promise<number> {
    const client = await RpcService.getClient(input.chainId);
    const account = await WalletService.getSigner(input.fromAddress);
    const errorText = typeof input.error === 'string'
      ? input.error.toLowerCase()
      : collectErrorText(input.error, true);
    const nonceKind = getNonceErrorKindFromText(errorText);
    const prefer = nonceKind === 'too_high' ? 'min' : 'max';
    const scope = nonceKind === 'too_high' ? 'protected' : 'both';
    const nextNonce = await prewarmNonce(client, input.chainId, account.address, {
      force: true,
      txSide: input.txSide,
      prefer,
      scope,
    });
    console.info('[nonce.refresh]', {
      chainId: input.chainId,
      address: account.address,
      nextNonce,
      txSide: input.txSide,
      nonceKind,
      prefer,
      scope,
    });
    return nextNonce;
  }

  private static isNonceLikeError(e: any): boolean {
    const msg = collectErrorText(e, true);
    return classifyBroadcastError(msg) === 'nonce' || msg.includes('nonce');
  }

  private static isAllowanceLikeError(e: any): boolean {
    const msg = collectErrorText(e, true);
    return isAllowanceLikeText(msg);
  }

  private static isInFlightLimitError(e: any): boolean {
    const msg = collectErrorText(e, true);
    return isInFlightLimitLikeText(msg);
  }

  private static async ensureTxSuccess(
    txHash: `0x${string}`,
    chainId: number,
    txSide: 'buy' | 'sell',
    timeoutMs: number
  ) {
    let receipt: any;
    try {
      receipt = await RpcService.waitForTransactionReceiptAny(txHash, {
        chainId,
        txSide,
        timeoutMs,
      });
    } catch (e: any) {
      console.error('[trade.receipt.wait.failed]', {
        side: txSide,
        chainId,
        txHash,
        timeoutMs,
        error: String(e?.shortMessage || e?.message || e || ''),
      });
      throw e;
    }
    if (receipt.status === 'success') return;
    let revertReason: string | null = null;
    try {
      const client = await RpcService.getClient(chainId);
      revertReason = await tryGetReceiptRevertReason(client, txHash, receipt.blockNumber);
    } catch {
    }
    throw new Error(revertReason || `${txSide} receipt reverted`);
  }

  private static async repairSellAllowanceIfNeeded(input: {
    chainId: number;
    tokenAddress: string;
    tokenInfo: TokenInfo;
    timeoutMs?: number;
    fromAddress?: `0x${string}`;
  }): Promise<boolean> {
    const allowanceCheck = await this.checkSellAllowanceInsufficient(input.chainId, input.tokenAddress, input.tokenInfo, {
      fromAddress: input.fromAddress,
    });
    if (!allowanceCheck.insufficient) return false;
    const approveTx = await this.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, input.tokenInfo, {
      fromAddress: input.fromAddress,
    });
    if (approveTx) {
      await this.waitApproveFastForRetry(input.chainId, approveTx);
    }
    return true;
  }

  private static async waitApproveFastForRetry(chainId: number, approveTx: `0x${string}`): Promise<void> {
    // Fast path for allowance recovery:
    // poll receipt briefly and continue as soon as approve is visible/success.
    // keep total wait short to preserve sniping speed.
    const client = await RpcService.getClient(chainId);
    const deadline = Date.now() + this.fastApproveRetryMaxWaitMs;
    const start = Date.now();
    let polls = 0;
    console.log('[trade.sell.approve.fastwait][start]', {
      chainId,
      approveTx,
      maxWaitMs: this.fastApproveRetryMaxWaitMs,
      pollMs: this.fastApproveRetryPollMs,
    });
    while (Date.now() < deadline) {
      polls += 1;
      try {
        const receipt = await (client as any).getTransactionReceipt({ hash: approveTx });
        if (receipt?.status === 'reverted') {
          throw new Error('approve receipt reverted');
        }
        if (receipt?.status === 'success') {
          console.log('[trade.sell.approve.fastwait][success]', {
            chainId,
            approveTx,
            polls,
            elapsedMs: Date.now() - start,
          });
          return;
        }
      } catch {
      }
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.fastApproveRetryPollMs, remain)));
    }
    console.log('[trade.sell.approve.fastwait][timeout]', {
      chainId,
      approveTx,
      polls,
      elapsedMs: Date.now() - start,
    });
  }

  private static isInnerDisk(tokenInfo: TokenInfo): boolean {
    if (tokenInfo.launchpad) {
      // Assuming 'status' 1 means Trading (Outer), anything else (0/2?) is Inner/Launchpad
      // Or checking if platform is known launchpad
      if (['fourmeme', 'bn_fourmeme', 'fourmeme_agent', 'four_xmode_agent', 'flap'].includes(tokenInfo.launchpad_platform?.toLowerCase() || '')) {
        // If status is NOT 1 (assuming 1 is "Trading on DEX"), treat as Inner
        // This logic might need adjustment based on exact status codes
        return tokenInfo.launchpad_status !== 1;
      }
    }
    return false;
  }

  private static getLaunchpadConfig(tokenInfo: TokenInfo, chainId: number) {
    const platform = tokenInfo.launchpad_platform?.toLowerCase();
    const contracts = DeployAddress[chainId as ChainId] || {};

    if (platform.includes('four')) {
      return {
        buyType: SwapType.FOUR_MEME_BUY_AMAP,
        sellType: SwapType.FOUR_MEME_SELL,
        manager: (contracts[ContractNames.FourMemeTokenManagerV2]?.address || ZERO_ADDRESS) as Address
      };
    }

    if (platform === 'flap') {
      return {
        buyType: SwapType.FLAP_EXACT_INPUT,
        sellType: SwapType.FLAP_EXACT_INPUT, // Assuming same for sell
        manager: (contracts[ContractNames.FlapshTokenManager]?.address || ZERO_ADDRESS) as Address
      };
    }
    return null;
  }

  private static resolveNativeAmountWei(input: TxBuyInput): string {
    const raw = (typeof input.nativeAmountWei === 'string' && input.nativeAmountWei.trim())
      ? input.nativeAmountWei
      : input.bnbAmountWei;
    return String(raw || '0').trim();
  }

  private static resolvePriorityFeeNative(input: TxBuyInput | TxSellInput): string | undefined {
    const v = (typeof (input as any).priorityFeeNative === 'string' && (input as any).priorityFeeNative.trim())
      ? (input as any).priorityFeeNative
      : (typeof input.priorityFeeBnb === 'string' ? input.priorityFeeBnb : '');
    const t = String(v || '').trim();
    return t || undefined;
  }

  private static resolveBaseTokenAddress(_chainId: number, input: { baseTokenAddress?: `0x${string}` }): Address {
    const raw = typeof input.baseTokenAddress === 'string' ? input.baseTokenAddress.trim() : '';
    if (!raw || raw.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return ZERO_ADDRESS;
    return raw as Address;
  }

  private static resolveBaseTokenSymbol(chainId: number, baseTokenAddress: Address): string {
    if (baseTokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return getNativeSymbol(chainId);
    const wrapped = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (baseTokenAddress.toLowerCase() === wrapped) return `W${getNativeSymbol(chainId)}`;
    const usdc = USDC[chainId as keyof typeof USDC]?.address?.toLowerCase();
    if (usdc && baseTokenAddress.toLowerCase() === usdc) return 'USDC';
    const usdt = USDT[chainId as keyof typeof USDT]?.address?.toLowerCase();
    if (usdt && baseTokenAddress.toLowerCase() === usdt) return 'USDT';
    return 'TOKEN';
  }

  private static resolveConfiguredBaseTokenAddress(chainId: number, settings: { tradeBaseToken?: string; chains?: Record<number, { tradeBaseToken?: string }> }): Address {
    const runtime = getChainRuntime(chainId);
    const tradeBaseToken = String(settings.chains?.[chainId]?.tradeBaseToken ?? settings.tradeBaseToken ?? 'BNB').toUpperCase();
    if (tradeBaseToken === 'WBNB') return runtime.wrappedNativeAddress as Address;
    if (tradeBaseToken === 'USDC') {
      const usdc = USDC[chainId as keyof typeof USDC]?.address;
      if (usdc) return usdc as Address;
    }
    if (tradeBaseToken === 'USDT') {
      const usdt = USDT[chainId as keyof typeof USDT]?.address;
      if (usdt) return usdt as Address;
    }
    return ZERO_ADDRESS;
  }

  static async buy(
    input: TxBuyInput,
    runtimeOpts?: {
      forceRefreshHyperState?: boolean;
    }
  ) {
    const settings = await SettingsService.get();
    const routerAddress = DeployAddress[input.chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');
    if (!input.tokenInfo) throw new Error('Token info required');
    const tokenInfo = input.tokenInfo;

    const account = await WalletService.getSigner(input.fromAddress);
    const client = await RpcService.getClient(input.chainId);

    const amountIn = BigInt(this.resolveNativeAmountWei(input));
    const configuredBaseTokenAddress = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
    const baseTokenAddress = (typeof input.baseTokenAddress === 'string' && input.baseTokenAddress.trim())
      ? this.resolveBaseTokenAddress(input.chainId, input)
      : configuredBaseTokenAddress;
    const baseTokenSymbol = this.resolveBaseTokenSymbol(input.chainId, baseTokenAddress);
    const baseFee = input.poolFee ?? 2500;
    const executionMode = input.executionModeOverride ?? settings.chains[input.chainId]?.executionMode ?? 'default';
    const isTurbo = executionMode === 'turbo';
    if (isTurbo) {
      const reusedPrewarm = await this.awaitTurboPrewarmIfInFlight({
        chainId: input.chainId,
        owner: account.address,
        tokenAddress: input.tokenAddress as Address,
        tokenInfo,
      });
      if (reusedPrewarm) {
        console.info('[trade.buy.prewarm.awaited]', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          fromAddress: account.address,
        });
      }
    }
    const chainSettings = settings.chains[input.chainId];
    const gasPriceMode = chainSettings.gasPriceMode ?? 'fixed';
    const gasPreset = input.gasPreset ?? chainSettings.buyGasPreset ?? chainSettings.gasPreset;
    const gasPriceFromInput = typeof input.gasPriceGwei === 'string' ? parseGweiToWei(input.gasPriceGwei) : 0n;
    const configuredGasPriceWei = gasPriceFromInput > 0n
      ? gasPriceFromInput
      : getGasPriceWei(chainSettings, gasPreset, 'buy');
    const gasPriceWei = configuredGasPriceWei;

    const consoleLogsEnabled = settings.ui?.consoleLogsEnabled === true;
    const perfEnabled = isTurbo || consoleLogsEnabled;
    const perfStart = perfEnabled ? Date.now() : 0;
    const perfSteps: Array<{ label: string; ms: number }> = [];
    const timeStep = async <T>(label: string, fn: () => Promise<T>) => {
      if (!perfEnabled) return await fn();
      const start = Date.now();
      const res = await fn();
      perfSteps.push({ label, ms: Date.now() - start });
      return res;
    };
    const trace = perfEnabled
      ? (label: string, ms: number) => {
        perfSteps.push({ label, ms });
      }
      : undefined;

    const tokenOut = input.tokenAddress;
    const isHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(tokenInfo.launchpad_platform);
    const isInner = isHyperAltfun ? false : this.isInnerDisk(tokenInfo);
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId) : null;

    const bridgeToken = isHyperAltfun
      ? null
      : getBridgeToken(input.chainId, tokenInfo.address, tokenInfo.quote_token_address);
    console.log('input.tokenInfo', tokenInfo, isInner, launchpadConfig)
    console.log('bridgeToken', bridgeToken);
    const descs: SwapDescLike[] = [];
    let currentRouterToken: Address = baseTokenAddress;
    let currentAmount = amountIn;
    let minOut = 0n;

    if (isHyperAltfun) {
      const hyperState = await timeStep('hyper:state', () => getHyperTradeState(tokenOut as Address, { force: runtimeOpts?.forceRefreshHyperState === true }));
      if (!hyperState.isInner && !hyperState.isOuter) throw new Error('该代币不是有效的 alt.fun Hyper 代币');

      const routeBridgeToken = getHyperUsdcAddress();
      if (currentRouterToken.toLowerCase() !== routeBridgeToken.toLowerCase()) {
        const bridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, routeBridgeToken);
        const q1 = await timeStep('quote:hyper:bridge', () =>
          resolveBridgeHopExactIn(
            input.chainId,
            currentRouterToken,
            routeBridgeToken,
            currentAmount,
            bridgePrefer,
            isTurbo,
            !isTurbo
          )
        );
        if (isTurbo) {
          if (!q1.poolAddress || q1.poolAddress === ZERO_ADDRESS) {
            throw new Error(`找不到 ${baseTokenSymbol}/USDC 的 Hyper 桥接交易池`);
          }
        } else {
          try {
            assertDexQuoteOk(q1);
          } catch {
            throw new Error(`找不到 ${baseTokenSymbol}/USDC 的 Hyper 桥接交易池`);
          }
          if (q1.amountOut <= 0n) throw new Error(`找不到 ${baseTokenSymbol}/USDC 的 Hyper 桥接交易池`);
        }
        descs.push(getRouterSwapDesc({
          swapType: toHyperDexSwapType(q1.swapType),
          tokenIn: currentRouterToken,
          tokenOut: routeBridgeToken,
          poolAddress: q1.poolAddress,
          fee: getV3FeeForDesc(q1, getDefaultBridgeV3Fee(input.chainId)),
        }));
        currentRouterToken = routeBridgeToken;
        currentAmount = isTurbo ? 1n : q1.amountOut;
      }

      const canValidateHyperUsdcGrossMin =
        currentRouterToken.toLowerCase() === routeBridgeToken.toLowerCase()
        && currentAmount > 0n
        && (!isTurbo || baseTokenAddress.toLowerCase() === routeBridgeToken.toLowerCase());
      if (canValidateHyperUsdcGrossMin) {
        const { minGrossUsdc, buyFeeBps } = await timeStep('quote:hyper:buy:min', () => getHyperZapBuyGrossMinUsdc());
        if (currentAmount < minGrossUsdc) {
          const minGrossText = Number(formatUnits(minGrossUsdc, 6)).toFixed(6).replace(/\.?0+$/, '');
          const feePctText = (Number(buyFeeBps) / 100).toFixed(2).replace(/\.?0+$/, '');
          throw new Error(`alt.fun 最低买入已按 ${minGrossText} USDC 限制，当前输入扣除 Zap ${feePctText}% 手续费后仍低于门槛`);
        }
      }

      const estimatedOut = isTurbo
        ? 0n
        : await timeStep('quote:hyper:zap:buy', () => quoteHyperBuyFromUsdc(tokenOut as Address, currentAmount));
      if (!isTurbo && estimatedOut <= 0n) throw new Error('alt.fun 买入报价失败');
      if (estimatedOut > 0n) {
        const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
        minOut = applySlippage(estimatedOut, slippageBps);
      }
      descs.push(getRouterSwapDesc({
        swapType: HyperSwapType.HYPER_ZAP_BUY,
        tokenIn: routeBridgeToken,
        tokenOut,
        poolAddress: ZERO_ADDRESS,
        fee: 0,
        data: encodeHyperZapBuyData(minOut),
      }));
    } else {
      if (bridgeToken && currentRouterToken.toLowerCase() !== bridgeToken.toLowerCase()) {
        // Hop 1: [BaseToken] -> [Quote]
        const bridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken);
        const needAmountOut = !isTurbo;
        const q1 = await timeStep('quote:bridge', () =>
          resolveBridgeHopExactIn(
            input.chainId,
            currentRouterToken,
            bridgeToken,
            currentAmount,
            bridgePrefer,
            isTurbo,
            needAmountOut
          )
        );
        if (isTurbo) {
          if (!q1.poolAddress || q1.poolAddress === ZERO_ADDRESS) {
            throw new Error(`找不到 ${baseTokenSymbol}/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
        } else {
          try {
            assertDexQuoteOk(q1);
          } catch {
            throw new Error(`找不到 ${baseTokenSymbol}/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          if (q1.amountOut <= 0n) {
            throw new Error(`找不到 ${baseTokenSymbol}/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
        }
        descs.push(getRouterSwapDesc({
          swapType: q1.swapType,
          tokenIn: currentRouterToken,
          tokenOut: bridgeToken,
          poolAddress: q1.poolAddress,
          fee: getV3FeeForDesc(q1, getDefaultBridgeV3Fee(input.chainId)),
        }));
        currentRouterToken = bridgeToken;
        currentAmount = isTurbo ? 1n : q1.amountOut;
      }

      // Hop 2: [BaseToken/Quote] -> Meme
      if (isInner && launchpadConfig) {
        const platform = tokenInfo.launchpad_platform?.toLowerCase() || '';
        let dataForDesc: `0x${string}` = '0x';

        if (platform.includes('four')) {
          const to = account.address as Address;
          const fundsForEstimate = currentRouterToken === ZERO_ADDRESS ? amountIn : currentAmount;
          let minAmount = 0n;
          if (!isTurbo) {
            try {
              const est = await timeStep('fourmeme:tryBuy', () =>
                tryFourMemeBuyEstimatedAmount(client, input.chainId, tokenOut as Address, fundsForEstimate)
              );
              if (est && est.estimatedAmount > 0n) {
                const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
                minAmount = applySlippage(est.estimatedAmount, slippageBps);
              }
            } catch {
            }
          }

          minOut = minAmount;

        const wantEncodedBuy = tokenInfo.aiCreator === true && currentRouterToken === ZERO_ADDRESS;
          if (wantEncodedBuy) {
            dataForDesc = encodeFourMemeBuyTokenData({
              token: tokenOut as Address,
              to,
              funds: amountIn,
              minAmount,
            });
          } else {
            dataForDesc = encodeFourMemeUint256(minAmount);
          }
        }

        descs.push(getRouterSwapDesc({
          swapType: launchpadConfig.buyType,
          tokenIn: currentRouterToken,
          tokenOut,
          poolAddress: launchpadConfig.manager,
          fee: 0,
          data: dataForDesc,
        }));
      } else {
        const poolVersion = getDexPoolPrefer(tokenInfo.dex_type);
        const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
        const q2 = await timeStep('quote:token:hop2', () =>
          resolveDexExactIn(
            input.chainId,
            currentRouterToken,
            tokenOut,
            currentAmount,
            {
              v3Fee: input.poolFee,
              poolPair: tokenInfo.pool_pair,
              prefer: poolVersion ?? (bridgePrefer ?? (isTurbo && !input.poolFee ? 'v2' : undefined)),
            },
            isTurbo
          )
        );
        if (isTurbo) {
          if (!q2.poolAddress || q2.poolAddress === ZERO_ADDRESS) {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
        } else {
          try {
            assertDexQuoteOk(q2);
          } catch {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
        }
        const usedFee = getV3FeeForDesc(q2, input.poolFee ?? baseFee);
        if (isTurbo) {
          minOut = 0n;
        } else {
          if (q2.amountOut <= 0n) {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
          const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
          minOut = applySlippage(q2.amountOut, slippageBps);
        }
        descs.push(getRouterSwapDesc({
          swapType: q2.swapType,
          tokenIn: currentRouterToken,
          tokenOut,
          poolAddress: q2.poolAddress,
          fee: usedFee,
        }));
      }
    }

    const deadline = getDeadline(settings, input.chainId, input.deadlineSeconds);

    const data = encodeFunctionData({
      abi: dagobangAbi,
      functionName: 'swap',
      args: [
        descs,
        ZERO_ADDRESS, // feeToken
          amountIn,
        minOut,       // minReturn
        deadline
      ]
    });

    const txOpts = {
      skipEstimateGas: true,
      gasLimit: 900000n,
      trace,
      txSide: 'buy' as const,
      priorityFeeBnbOverride: this.resolvePriorityFeeNative(input),
      feeMode: gasPriceMode,
      gasPreset,
    };
    const txValue = baseTokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase() ? amountIn : 0n;
    console.log('[trade.buy.submit]', {
      chainId: input.chainId,
      from: account.address,
      tokenAddress: input.tokenAddress,
      baseTokenAddress,
      amountIn: amountIn.toString(),
      txValue: txValue.toString(),
      routeCount: descs.length,
      route: descs.map((d) => ({
        swapType: d.swapType,
        tokenIn: d.tokenIn,
        tokenOut: d.tokenOut,
        poolAddress: d.poolAddress,
        fee: d.fee,
      })),
      gasPreset,
      gasPriceWei: gasPriceWei.toString(),
      mode: executionMode,
    });
    const { txHash, broadcastVia, broadcastUrl, isBundle } = await timeStep('sendTransaction', () =>
      this.sendTransaction(client, account, routerAddress, data, txValue, gasPriceWei, input.chainId, txOpts)
    );
    console.log('[trade.buy.broadcasted]', {
      chainId: input.chainId,
      txHash,
      broadcastVia,
      broadcastUrl,
      isBundle: !!isBundle,
    });
    if (perfEnabled) {
      const totalMs = Date.now() - perfStart;
      if (consoleLogsEnabled || isTurbo || totalMs >= 800) {
        console.log('[trade.buy.timing]', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          total: totalMs,
          steps: perfSteps,
          broadcastProvider: formatBroadcastProvider(broadcastVia, broadcastUrl, isBundle),
          txHash,
          mode: executionMode,
        });
      }
    }
    return { txHash, tokenMinOutWei: minOut.toString(), broadcastVia, broadcastUrl, isBundle };
  }

  static async buyWithReceiptAndNonceRecovery(
    input: TxBuyInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: { side: 'buy'; attempt: number; reason: 'nonce' }) => void | Promise<void>;
      onSubmitted?: (ctx: { side: 'buy'; txHash: `0x${string}`; submitElapsedMs: number }) => void | Promise<void>;
    }
  ) {
    const flowId = `buy-auto:${input.chainId}:${input.tokenAddress.toLowerCase()}:${Date.now().toString(36)}`;
    const flowStart = Date.now();
    console.log('[trade.buy.auto][start]', {
      flowId,
      chainId: input.chainId,
      token: input.tokenAddress,
      maxRetry: opts?.maxRetry ?? 1,
      timeoutMs: opts?.timeoutMs ?? 20_000,
    });
    const timeoutMs = opts?.timeoutMs ?? 20_000;
    const maxRetry = opts?.maxRetry ?? 1;
    let lastErr: any;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      const attemptNo = attempt + 1;
      const attemptStart = Date.now();
      console.log('[trade.buy.auto][attempt.start]', { flowId, attempt: attemptNo });
      try {
        const submitStart = Date.now();
        const rsp = await this.buy(input, {
          forceRefreshHyperState: attempt > 0,
        });
        const submitElapsedMs = Date.now() - submitStart;
        await opts?.onSubmitted?.({ side: 'buy', txHash: rsp.txHash, submitElapsedMs });
        const receiptStart = Date.now();
        await this.ensureTxSuccess(rsp.txHash, input.chainId, 'buy', timeoutMs);
        const receiptElapsedMs = Date.now() - receiptStart;
        const totalElapsedMs = Date.now() - attemptStart;
        console.log('[trade.buy.auto][attempt.success]', {
          flowId,
          attempt: attemptNo,
          txHash: rsp.txHash,
          elapsedMs: totalElapsedMs,
          totalElapsedMs: Date.now() - flowStart,
          submitElapsedMs,
          receiptElapsedMs,
        });
        return { ...rsp, submitElapsedMs, receiptElapsedMs, totalElapsedMs };
      } catch (e: any) {
        lastErr = e;
        const nonceLike = this.isNonceLikeError(e);
        const inFlightLimit = this.isInFlightLimitError(e);
        const allowanceLike = this.isAllowanceLikeError(e);
        const errText = collectErrorText(e, true);
        console.warn('[trade.buy.auto][attempt.failed]', {
          flowId,
          attempt: attemptNo,
          elapsedMs: Date.now() - attemptStart,
          nonceLike,
          inFlightLimit,
          allowanceLike,
          chainId: input.chainId,
          token: input.tokenAddress,
          fromAddress: input.fromAddress,
          baseTokenAddress: input.baseTokenAddress ?? '0x0000000000000000000000000000000000000000',
          amountInWei: this.resolveNativeAmountWei(input),
          error: String(e?.shortMessage || e?.message || e || ''),
          classifyText: errText,
        });
        if (attempt >= maxRetry || !nonceLike) break;
        console.log('[trade.buy.auto][retry.signal]', {
          flowId,
          attempt: attemptNo,
          reason: 'nonce',
        });
        await opts?.onRetry?.({ side: 'buy', attempt: attempt + 1, reason: 'nonce' });
        await this.refreshNonce({
          chainId: input.chainId,
          fromAddress: input.fromAddress,
          txSide: 'buy',
          error: e,
        });
      }
    }
    console.warn('[trade.buy.auto][final.failed]', {
      flowId,
      totalElapsedMs: Date.now() - flowStart,
      error: String(lastErr?.shortMessage || lastErr?.message || lastErr || ''),
    });
    throw lastErr;
  }

  static async sellWithReceiptAndAutoRecovery(
    input: TxSellInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: { side: 'sell'; attempt: number; nonceLike: boolean; allowanceRepaired: boolean }) => void | Promise<void>;
      onSubmitted?: (ctx: { side: 'sell'; txHash: `0x${string}`; submitElapsedMs: number }) => void | Promise<void>;
    }
  ) {
    if (!input.tokenInfo) throw new Error('Token info required');
    const flowId = `sell-auto:${input.chainId}:${input.tokenAddress.toLowerCase()}:${Date.now().toString(36)}`;
    const flowStart = Date.now();
    console.log('[trade.sell.auto][start]', {
      flowId,
      chainId: input.chainId,
      token: input.tokenAddress,
      maxRetry: opts?.maxRetry ?? 1,
      timeoutMs: opts?.timeoutMs ?? 20_000,
    });
    const timeoutMs = opts?.timeoutMs ?? 20_000;
    const maxRetry = opts?.maxRetry ?? 1;
    let lastErr: any;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      const attemptNo = attempt + 1;
      const attemptStart = Date.now();
      console.log('[trade.sell.auto][attempt.start]', { flowId, attempt: attemptNo });
      try {
        const submitStart = Date.now();
        const rsp = await this.sell(input, {
          traceId: flowId,
          attempt: attemptNo,
          forceRefreshHyperState: attempt > 0,
          onAllowanceRepairStart: async () => {
            console.log('[trade.sell.auto][allowance.repair.start]', { flowId, attempt: attemptNo });
            await opts?.onRetry?.({
              side: 'sell',
              attempt: attemptNo,
              nonceLike: false,
              allowanceRepaired: true,
            });
          },
        });
        const submitElapsedMs = Date.now() - submitStart;
        await opts?.onSubmitted?.({ side: 'sell', txHash: rsp.txHash, submitElapsedMs });
        const receiptStart = Date.now();
        await this.ensureTxSuccess(rsp.txHash, input.chainId, 'sell', timeoutMs);
        const receiptElapsedMs = Date.now() - receiptStart;
        const totalElapsedMs = Date.now() - attemptStart;
        console.log('[trade.sell.auto][attempt.success]', {
          flowId,
          attempt: attemptNo,
          txHash: rsp.txHash,
          elapsedMs: totalElapsedMs,
          totalElapsedMs: Date.now() - flowStart,
          submitElapsedMs,
          receiptElapsedMs,
        });
        return { ...rsp, submitElapsedMs, receiptElapsedMs, totalElapsedMs };
      } catch (e: any) {
        lastErr = e;
        console.warn('[trade.sell.auto][attempt.failed]', {
          flowId,
          attempt: attemptNo,
          elapsedMs: Date.now() - attemptStart,
          error: String(e?.shortMessage || e?.message || e || ''),
        });
        if (attempt >= maxRetry) break;
        const nonceLike = this.isNonceLikeError(e);
        const allowanceLike = this.isAllowanceLikeError(e);
        if (nonceLike || allowanceLike) {
          console.log('[trade.sell.auto][retry.signal]', {
            flowId,
            attempt: attemptNo,
            nonceLike,
            allowanceLike,
          });
          await opts?.onRetry?.({
            side: 'sell',
            attempt: attemptNo,
            nonceLike,
            allowanceRepaired: allowanceLike,
          });
        }
        let allowanceRepaired = false;
        try {
          allowanceRepaired = await this.repairSellAllowanceIfNeeded({
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenInfo: input.tokenInfo,
            timeoutMs,
            fromAddress: input.fromAddress,
          });
        } catch (repairErr: any) {
          lastErr = repairErr;
          console.warn('[trade.sell.auto][repair.failed]', {
            flowId,
            attempt: attemptNo,
            error: String(repairErr?.shortMessage || repairErr?.message || repairErr || ''),
          });
          break;
        }
        if (!nonceLike && !allowanceRepaired && !this.isAllowanceLikeError(e)) break;
        console.log('[trade.sell.auto][nonce.refresh]', { flowId, attempt: attemptNo, allowanceRepaired, nonceLike });
        await this.refreshNonce({
          chainId: input.chainId,
          fromAddress: input.fromAddress,
          txSide: 'sell',
          error: e,
        });
      }
    }
    console.warn('[trade.sell.auto][final.failed]', {
      flowId,
      totalElapsedMs: Date.now() - flowStart,
      error: String(lastErr?.shortMessage || lastErr?.message || lastErr || ''),
    });
    throw lastErr;
  }

  static async approveMaxForSellIfNeeded(
    chainId: number,
    tokenAddress: string,
    tokenInfo: TokenInfo,
    opts?: { extraSpenders?: string[]; fromAddress?: `0x${string}` }
  ) {
    const routerAddress = DeployAddress[chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');

    const account = await WalletService.getSigner(opts?.fromAddress);
    const client = await RpcService.getClient(chainId);

    const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const platform = tokenInfo.launchpad_platform?.toLowerCase() || '';
    const isInner = this.isInnerDisk(tokenInfo);
    const isInnerFourMeme = isInner && platform.includes('four');

    const spenders = getSellSpenders({
      chainId,
      tokenInfo,
      routerAddress,
      extraSpenders: opts?.extraSpenders,
      getLaunchpadManager: (ti, cid) => {
        const platform = ti.launchpad_platform?.toLowerCase() || '';
        const cfg = platform ? this.getLaunchpadConfig(ti, cid) : null;
        return cfg?.manager ?? null;
      },
    });
    let lastTxHash: `0x${string}` | null = null;
    for (const spender of spenders) {
      const txHash = await this.approveMaxForSpenderIfNeeded({
        chainId,
        tokenAddress,
        owner: account.address,
        spender,
        maxUint256,
        client,
      });
      if (txHash) lastTxHash = txHash;
    }

    const bridgeToken = isInnerFourMeme ? getBridgeToken(chainId, tokenInfo.address, tokenInfo.quote_token_address) : null;
    if (bridgeToken && bridgeToken !== ZERO_ADDRESS) {
      const txHash = await this.approveMaxForSpenderIfNeeded({
        chainId,
        tokenAddress: bridgeToken,
        owner: account.address,
        spender: routerAddress,
        maxUint256,
        client,
      });
      if (txHash) lastTxHash = txHash;
    }

    return lastTxHash;
  }

  static async checkSellAllowanceInsufficient(
    chainId: number,
    tokenAddress: string,
    tokenInfo: TokenInfo,
    opts?: { extraSpenders?: string[]; fromAddress?: `0x${string}` }
  ): Promise<SellAllowanceCheckResult> {
    const routerAddress = DeployAddress[chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');
    const account = await WalletService.getSigner(opts?.fromAddress);
    const client = await RpcService.getClient(chainId);
    const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    return await hasInsufficientSellAllowance({
      chainId,
      tokenAddress,
      tokenInfo,
      owner: account.address,
      client,
      maxUint256,
      routerAddress,
      extraSpenders: opts?.extraSpenders,
      getLaunchpadManager: (ti, cid) => {
        const platform = ti.launchpad_platform?.toLowerCase() || '';
        const cfg = platform ? this.getLaunchpadConfig(ti, cid) : null;
        return cfg?.manager ?? null;
      },
      isInnerDisk: (ti) => this.isInnerDisk(ti),
    });
  }

  static async sell(
    input: TxSellInput,
    runtimeOpts?: {
      onAllowanceRepairStart?: (ctx: { chainId: number; tokenAddress: string }) => void | Promise<void>;
      traceId?: string;
      attempt?: number;
      forceRefreshHyperState?: boolean;
    }
  ) {
    const sellFrom = String(input.fromAddress || 'default').toLowerCase();
    const sellLockKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}:${sellFrom}`;
    if (this.sellInFlightByToken.has(sellLockKey)) {
      throw new Error('SELL_IN_FLIGHT');
    }
    this.sellInFlightByToken.add(sellLockKey);
    const run = async () => {
      const settings = await SettingsService.get();
      const routerAddress = DeployAddress[input.chainId as ChainId]?.DagobangRouter?.address;
      if (!routerAddress) throw new Error('Router address not set');
      if (!input.tokenInfo) throw new Error('Token info required');
      const tokenInfo = input.tokenInfo;

      const account = await WalletService.getSigner(input.fromAddress);
      const client = await RpcService.getClient(input.chainId);

      let amountIn = BigInt(input.tokenAmountWei);
      const configuredBaseTokenAddress = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
      const baseTokenAddress = (typeof input.baseTokenAddress === 'string' && input.baseTokenAddress.trim())
        ? this.resolveBaseTokenAddress(input.chainId, input)
        : configuredBaseTokenAddress;
      const baseTokenSymbol = this.resolveBaseTokenSymbol(input.chainId, baseTokenAddress);
      const baseFee = input.poolFee ?? 2500;
      const executionMode = input.executionModeOverride ?? settings.chains[input.chainId]?.executionMode ?? 'default';
      const isTurbo = executionMode === 'turbo';
      const percentBps = isTurbo ? (input.sellPercentBps ?? 0) : 0;
      if (!isTurbo && amountIn <= 0n) throw new Error('Invalid amount');
      const chainSettings = settings.chains[input.chainId];
      const gasPriceMode = chainSettings.gasPriceMode ?? 'fixed';
      const gasPreset = input.gasPreset ?? chainSettings.sellGasPreset ?? chainSettings.gasPreset;
      const configuredGasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');
      const gasPriceWei = configuredGasPriceWei;

      const perfEnabled = isTurbo;
      const perfStart = perfEnabled ? Date.now() : 0;
      const perfSteps: Array<{ label: string; ms: number }> = [];
      const timeStep = async <T>(label: string, fn: () => Promise<T>) => {
        if (!perfEnabled) return await fn();
        const start = Date.now();
        const res = await fn();
        perfSteps.push({ label, ms: Date.now() - start });
        return res;
      };
      const trace = perfEnabled
        ? (label: string, ms: number) => {
          perfSteps.push({ label, ms });
        }
        : undefined;

      const isHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(tokenInfo.launchpad_platform);
      const isInner = isHyperAltfun ? false : this.isInnerDisk(tokenInfo);
      const platformLower = tokenInfo.launchpad_platform?.toLowerCase() || '';
      const isInnerFourMeme = isInner && platformLower.includes('four');
      const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId) : null;
      const bridgeToken = isHyperAltfun ? null : getBridgeToken(input.chainId as ChainId, tokenInfo.address, tokenInfo.quote_token_address);
      const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      console.log('sell input.tokenInfo', tokenInfo, isInner, launchpadConfig)
      console.log('sell bridgeToken', bridgeToken, bridgePrefer);
      const descs: SwapDescLike[] = [];
      const sellToken: Address = input.tokenAddress;
      let estimatedOut = 0n;
      let minFundsForSell = 0n;
      let sellTokenManager: Address | null = null;
      let sellManagerForRoute: Address = isHyperAltfun ? ZERO_ADDRESS : (launchpadConfig?.manager ?? ZERO_ADDRESS);
      let amountInForQuote = amountIn;
      if (isTurbo) {
        if (percentBps <= 0 || percentBps > 10000) throw new Error('Invalid percent');
        const baseBal = input.expectedTokenInWei ? BigInt(input.expectedTokenInWei) : 0n;
        amountInForQuote = baseBal > 0n ? (baseBal * BigInt(percentBps)) / 10000n : 1n;
      }

      if (isHyperAltfun) {
        const hyperState = await timeStep('hyper:state', () => getHyperTradeState(sellToken, { force: runtimeOpts?.forceRefreshHyperState === true }));
        if (!hyperState.isInner && !hyperState.isOuter) throw new Error('该代币不是有效的 alt.fun Hyper 代币');

        const innerTokenOut = getHyperUsdcAddress();
        let minUsdcOut = 0n;
        if (!isTurbo) {
          const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
          const estimatedUsdc = await timeStep('quote:hyper:zap:sell', () => quoteHyperSellToUsdc(sellToken, amountIn));
          if (estimatedUsdc <= 0n) throw new Error('alt.fun 卖出报价失败');
          minUsdcOut = applySlippage(estimatedUsdc, slippageBps);
          if (baseTokenAddress.toLowerCase() === innerTokenOut.toLowerCase()) {
            estimatedOut = estimatedUsdc;
          }
        }

        descs.push(getRouterSwapDesc({
          swapType: HyperSwapType.HYPER_ZAP_SELL,
          tokenIn: sellToken,
          tokenOut: innerTokenOut,
          poolAddress: ZERO_ADDRESS,
          fee: 0,
          data: encodeHyperZapSellData(minUsdcOut),
        }));

        if (baseTokenAddress.toLowerCase() !== innerTokenOut.toLowerCase()) {
          const bridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, innerTokenOut);
          const hop2AmountIn = isTurbo ? 1n : (minUsdcOut > 0n ? minUsdcOut : 1n);
          const hop2 = await timeStep('quote:hyper:bridge:hop2', () =>
            resolveBridgeHopExactIn(
              input.chainId,
              innerTokenOut,
              baseTokenAddress,
              hop2AmountIn,
              bridgePrefer,
              isTurbo,
              !isTurbo
            )
          );
          if (!hop2.poolAddress || hop2.poolAddress === ZERO_ADDRESS) {
            throw new Error(`找不到 USDC/${baseTokenSymbol} 的 Hyper 桥接交易池`);
          }
          if (!isTurbo) {
            try {
              assertDexQuoteOk(hop2);
            } catch {
              throw new Error(`找不到 USDC/${baseTokenSymbol} 的 Hyper 桥接交易池`);
            }
            if (hop2.amountOut <= 0n) throw new Error(`找不到 USDC/${baseTokenSymbol} 的 Hyper 桥接交易池`);
            estimatedOut = hop2.amountOut;
          }
          descs.push(getRouterSwapDesc({
            swapType: toHyperDexSwapType(hop2.swapType),
            tokenIn: innerTokenOut,
            tokenOut: baseTokenAddress,
            poolAddress: hop2.poolAddress,
            fee: getV3FeeForDesc(hop2, getDefaultBridgeV3Fee(input.chainId)),
          }));
        }
      } else if (isInner && launchpadConfig) {
        const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
        let minFunds = 0n;
        let dataForSell: `0x${string}` = '0x';

        if (!isTurbo && isInnerFourMeme) {
          if (amountIn > 0n) {
            const aligned = (amountIn / 1000000000n) * 1000000000n;
            if (aligned > 0n) amountIn = aligned;
          }
          try {
            const est = await timeStep('fourmeme:trySell', () =>
              tryFourMemeSellEstimatedFunds(client, input.chainId, sellToken, amountIn)
            );
            if (est && est.funds > 0n) {
              sellTokenManager = est.tokenManager ?? null;
              if (sellTokenManager && sellTokenManager !== ZERO_ADDRESS) {
                sellManagerForRoute = sellTokenManager;
              }
              const netFunds = est.funds > est.fee ? (est.funds - est.fee) : 0n;
              if (netFunds > 0n) {
                minFunds = applySlippage(netFunds, slippageBps);
                if (minFunds > 0n) {
                  dataForSell = encodeFourMemeUint256(minFunds);
                  minFundsForSell = minFunds;
                }
                if (!bridgeToken) {
                  estimatedOut = netFunds;
                }
              }
            }
          } catch (ex) {
            console.log('fourmeme sell error', ex);
          }
        }

        const innerTokenOut = bridgeToken ?? baseTokenAddress;
        descs.push(getRouterSwapDesc({
          swapType: launchpadConfig.sellType,
          tokenIn: sellToken,
          tokenOut: innerTokenOut,
          poolAddress: sellManagerForRoute,
          fee: 0,
          data: dataForSell,
        }));

        if (innerTokenOut !== ZERO_ADDRESS && bridgeToken) {
          const hop2AmountIn = isTurbo ? 1n : (minFunds > 0n ? minFunds : 1n);
          const hop2 = await timeStep('quote:bridge:hop2', () =>
            resolveBridgeHopExactIn(
              input.chainId,
              bridgeToken,
              baseTokenAddress,
              hop2AmountIn,
              bridgePrefer,
              isTurbo,
              !isTurbo
            )
          );
          if (!hop2.poolAddress || hop2.poolAddress === ZERO_ADDRESS) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          descs.push(getRouterSwapDesc({
            swapType: hop2.swapType,
            tokenIn: bridgeToken,
            tokenOut: baseTokenAddress,
            poolAddress: hop2.poolAddress,
            fee: getV3FeeForDesc(hop2, getDefaultBridgeV3Fee(input.chainId)),
          }));
          if (!isTurbo && hop2.amountOut > 0n) {
            estimatedOut = hop2.amountOut;
          }
        }
      }

      if (!isInner && !isHyperAltfun) {
        // hop1
        const hop1RouterOut = bridgeToken ? bridgeToken : baseTokenAddress;
        const hop1NeedAmountOut = !!bridgeToken && !isTurbo;
        const poolVersion = getDexPoolPrefer(tokenInfo.dex_type);
        const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
        const hop1 = await timeStep('quote:token', () =>
          resolveDexExactIn(
            input.chainId,
            sellToken,
            hop1RouterOut,
            amountInForQuote,
            {
              v3Fee: input.poolFee,
              poolPair: tokenInfo.pool_pair,
              prefer: poolVersion ?? (bridgePrefer ?? (isTurbo && !input.poolFee ? 'v2' : undefined)),
            },
            isTurbo,
            hop1NeedAmountOut
          )
        );
        if (isTurbo && !hop1NeedAmountOut) {
          if (!hop1.poolAddress || hop1.poolAddress === ZERO_ADDRESS) {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
        } else {
          try {
            assertDexQuoteOk(hop1);
          } catch {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
        }
        if (!isTurbo && hop1.amountOut <= 0n) {
          throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        descs.push(getRouterSwapDesc({
          swapType: hop1.swapType,
          tokenIn: sellToken,
          tokenOut: hop1RouterOut,
          poolAddress: hop1.poolAddress,
          fee: getV3FeeForDesc(hop1, input.poolFee ?? baseFee),
        }));

        // hop2
        if (!bridgeToken) {
          estimatedOut = isTurbo ? 0n : hop1.amountOut;
        } else {
          if (!isTurbo && hop1.amountOut <= 0n) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          const hop2AmountIn = isTurbo ? 1n : hop1.amountOut;
          const hop2 = await timeStep('quote:bridge:hop2', () =>
            resolveBridgeHopExactIn(
              input.chainId,
              bridgeToken,
              baseTokenAddress,
              hop2AmountIn,
              bridgePrefer,
              isTurbo,
              !isTurbo
            )
          );
          if (isTurbo) {
            if (!hop2.poolAddress || hop2.poolAddress === ZERO_ADDRESS) {
              throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
            }
          } else {
            try {
              assertDexQuoteOk(hop2);
            } catch {
              throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
            }
          }
          if (!isTurbo && hop2.amountOut <= 0n) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          descs.push(getRouterSwapDesc({
            swapType: hop2.swapType,
            tokenIn: bridgeToken,
            tokenOut: baseTokenAddress,
            poolAddress: hop2.poolAddress,
            fee: getV3FeeForDesc(hop2, getDefaultBridgeV3Fee(input.chainId)),
          }));
          estimatedOut = isTurbo ? 0n : hop2.amountOut;
        }
      }

      let minOut = 0n;
      if (estimatedOut > 0n) {
        const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
        minOut = applySlippage(estimatedOut, slippageBps);
      }
      if (isInnerFourMeme && !bridgeToken && minFundsForSell > 0n) {
        const v2Manager = (DeployAddress[input.chainId as ChainId]?.[ContractNames.FourMemeTokenManagerV2]?.address || ZERO_ADDRESS) as Address;
        const managerToCheck = sellTokenManager ?? sellManagerForRoute;
        const isV2 = managerToCheck && v2Manager !== ZERO_ADDRESS && managerToCheck.toLowerCase() === v2Manager.toLowerCase();
        if (isV2) {
          minOut = 0n;
        }
      }

      const deadline = getDeadline(settings, input.chainId, input.deadlineSeconds);
      const data = isTurbo
        ? encodeFunctionData({
          abi: dagobangAbi,
          functionName: 'swapPercent',
          args: [
            descs,
            ZERO_ADDRESS,
            percentBps,
            minOut,
            deadline
          ]
        })
        : encodeFunctionData({
          abi: dagobangAbi,
          functionName: 'swap',
          args: [
            descs,
            ZERO_ADDRESS,
            amountIn,
            minOut,
            deadline
          ]
        });

      const txOpts = {
        skipEstimateGas: true,
        gasLimit: 900000n,
        trace,
        txSide: 'sell' as const,
        priorityFeeBnbOverride: this.resolvePriorityFeeNative(input),
        feeMode: gasPriceMode,
        gasPreset,
      };
      const traceId = runtimeOpts?.traceId;
      const attempt = runtimeOpts?.attempt;
      console.log('[trade.sell.submit]', {
        chainId: input.chainId,
        token: input.tokenAddress,
        isTurbo,
        percentBps: isTurbo ? percentBps : undefined,
        amountIn: isTurbo ? undefined : amountIn.toString(),
        routeManager: sellManagerForRoute,
        routeCount: descs.length,
        traceId,
        attempt,
      });
      const allowanceExtraSpenders = sellManagerForRoute && sellManagerForRoute !== ZERO_ADDRESS
        ? [sellManagerForRoute]
        : undefined;
      let allowanceRetried = false;
      let sent: { txHash: `0x${string}`; broadcastVia?: 'rpc' | 'bloxroute'; broadcastUrl?: string; isBundle?: boolean };
      try {
        sent = await timeStep('sendTransaction', () =>
          this.sendTransaction(client, account, routerAddress, data, 0n, gasPriceWei, input.chainId, txOpts)
        );
      } catch (e: any) {
        const errText = collectErrorText(e, true);
        const maybeAllowanceIssue = isAllowanceLikeText(errText);
        console.warn('[trade.sell.send.failed]', {
          chainId: input.chainId,
          token: input.tokenAddress,
          maybeAllowanceIssue,
          errText,
          routeManager: sellManagerForRoute,
        });
        if (!maybeAllowanceIssue) throw e;
        console.log('[trade.sell.allowance.repair.trigger]', {
          chainId: input.chainId,
          token: input.tokenAddress,
          traceId,
          attempt,
        });
        await runtimeOpts?.onAllowanceRepairStart?.({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
        });
        const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
        const allowanceCheck: SellAllowanceCheckResult = await hasInsufficientSellAllowance({
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          tokenInfo,
          owner: account.address,
          client,
          maxUint256,
          routerAddress,
          extraSpenders: allowanceExtraSpenders,
          getLaunchpadManager: (ti, cid) => {
            const platform = ti.launchpad_platform?.toLowerCase() || '';
            const cfg = platform ? this.getLaunchpadConfig(ti, cid) : null;
            return cfg?.manager ?? null;
          },
          isInnerDisk: (ti) => this.isInnerDisk(ti),
        });
        console.log('[trade.sell.allowance.check]', {
          chainId: input.chainId,
          token: input.tokenAddress,
          insufficient: allowanceCheck.insufficient,
          checked: allowanceCheck.checked,
        });
        if (!allowanceCheck.insufficient) throw e;
        const approveTx = await this.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo, {
          extraSpenders: allowanceExtraSpenders,
        });
        if (approveTx) {
          console.log('[trade.sell.retry.approve]', { chainId: input.chainId, token: input.tokenAddress, approveTx });
          await this.waitApproveFastForRetry(input.chainId, approveTx);
        }
        console.log('[trade.sell.retry.send]', { chainId: input.chainId, token: input.tokenAddress });
        allowanceRetried = true;
        sent = await timeStep('sendTransactionRetryAfterApprove', () =>
          this.sendTransaction(client, account, routerAddress, data, 0n, gasPriceWei, input.chainId, txOpts)
        );
      }
      const { txHash, broadcastVia, broadcastUrl, isBundle } = sent;
      if (perfEnabled) {
        const totalMs = Date.now() - perfStart;
        console.log('[trade.sell.turbo] timing ms', {
          total: totalMs, steps: perfSteps,
          broadcastProvider: formatBroadcastProvider(broadcastVia, broadcastUrl, isBundle)
        });
      }
      return { txHash, broadcastVia, broadcastUrl, isBundle, allowanceRetried };
    };
    try {
      return await run();
    } finally {
      this.sellInFlightByToken.delete(sellLockKey);
    }
  }

  static async approve(
    chainId: number,
    tokenAddress: string,
    spender: string,
    amountWei: string,
    fromAddress?: `0x${string}`
  ) {
    const settings = await SettingsService.get();
    const account = await WalletService.getSigner(fromAddress);
    const client = await RpcService.getClient(chainId);
    const chainSettings = settings.chains[chainId];
    const gasPriceMode = chainSettings.gasPriceMode ?? 'fixed';
    const gasPreset = chainSettings.sellGasPreset ?? chainSettings.gasPreset;
    const approveGasGwei = typeof chainSettings.approveGasGwei === 'string' ? chainSettings.approveGasGwei.trim() : '';
    let configuredGasPriceWei = approveGasGwei ? parseGweiToWei(approveGasGwei) : 0n;
    if (configuredGasPriceWei <= 0n) {
      configuredGasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');
    }
    if (configuredGasPriceWei <= 0n) configuredGasPriceWei = parseGweiToWei('0.12');
    const gasPriceWei = configuredGasPriceWei;

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender as `0x${string}`, BigInt(amountWei)]
    });

    const { txHash } = await this.sendTransaction(
      client,
      account,
      tokenAddress,
      data,
      0n,
      gasPriceWei,
      chainId,
      { skipEstimateGas: true, gasLimit: 900000n, feeMode: gasPriceMode, gasPreset }
    );
    return txHash;
  }

  static async wrapNative(chainId: number, amountWei: string, fromAddress?: `0x${string}`) {
    const settings = await SettingsService.get();
    const account = await WalletService.getSigner(fromAddress);
    const client = await RpcService.getClient(chainId);
    const chainSettings = settings.chains[chainId];
    const gasPriceMode = chainSettings.gasPriceMode ?? 'fixed';
    const gasPreset = chainSettings.buyGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'buy');
    const wrapped = getChainRuntime(chainId).wrappedNativeAddress;
    const value = BigInt(String(amountWei || '0').trim());
    if (value <= 0n) throw new Error('Invalid amount');
    const data = encodeFunctionData({
      abi: [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }],
      functionName: 'deposit',
      args: [],
    });
    const { txHash, broadcastVia, broadcastUrl, isBundle } = await this.sendTransaction(
      client,
      account,
      wrapped,
      data,
      value,
      gasPriceWei,
      chainId,
      { skipEstimateGas: true, gasLimit: 300000n, feeMode: gasPriceMode, gasPreset }
    );
    return { txHash, broadcastVia, broadcastUrl, isBundle };
  }

  static async unwrapWrapped(chainId: number, amountWei: string, fromAddress?: `0x${string}`) {
    const settings = await SettingsService.get();
    const account = await WalletService.getSigner(fromAddress);
    const client = await RpcService.getClient(chainId);
    const chainSettings = settings.chains[chainId];
    const gasPriceMode = chainSettings.gasPriceMode ?? 'fixed';
    const gasPreset = chainSettings.sellGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');
    const wrapped = getChainRuntime(chainId).wrappedNativeAddress;
    const amount = BigInt(String(amountWei || '0').trim());
    if (amount <= 0n) throw new Error('Invalid amount');
    const data = encodeFunctionData({
      abi: [{ type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] }],
      functionName: 'withdraw',
      args: [amount],
    });
    const { txHash, broadcastVia, broadcastUrl, isBundle } = await this.sendTransaction(
      client,
      account,
      wrapped,
      data,
      0n,
      gasPriceWei,
      chainId,
      { skipEstimateGas: true, gasLimit: 300000n, feeMode: gasPriceMode, gasPreset }
    );
    return { txHash, broadcastVia, broadcastUrl, isBundle };
  }

  static async sendTransaction(
    client: any,
    account: any,
    to: string,
    data: any,
    value: bigint,
    gasPriceWei: bigint,
    chainId: number,
    opts?: { nonce?: number; skipEstimateGas?: boolean; gasLimit?: bigint; trace?: (label: string, ms: number) => void; txSide?: 'buy' | 'sell'; priorityFeeBnbOverride?: string; feeMode?: 'fixed' | 'dynamic'; gasPreset?: GasPreset }
  ) {
    return await sendTransaction(client, account, to, data, value, gasPriceWei, chainId, opts);
  }
}
