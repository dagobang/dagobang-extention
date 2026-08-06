import { encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseAbiParameters } from 'viem';
import { RpcService } from '../rpc';
import { WalletService } from '../wallet';
import { SettingsService } from '../settings';
import type { GasPreset, SubmitChannel, TxBuyInput, TxSellInput } from '../../types/extention';
import type { FlapTokenStateV7, TokenInfo } from '../../types/token';
import { ContractNames } from '../../constants/contracts/names';
import { DeployAddress } from '../../constants/contracts/address';
import { ChainId } from '../../constants/chains/chainId';
import { getBridgeTokenAddresses, getBridgeTokenDexPreference } from '../../constants/tokens/allTokens';
import { USDC, USDT } from '../../constants/tokens/chains/common';
import { bscTokens } from '../../constants/tokens/chains/bsc';
import { dagobangAbi, poolV3Abi } from '@/constants/contracts/abi';
import { Address, DexExactInQuote, HyperSwapType, SwapDescLike, SwapType, ZERO_ADDRESS, applySlippage, getDeadline, getRouterSwapDesc, getSlippageBps, getV3FeeForDesc, toHyperDexSwapType } from './tradeTypes';
import { assertDexQuoteOk, getBridgeToken, quoteBestExactIn as quoteBestExactInDex, resolveBridgeHopExactIn, resolveDexExactIn } from './tradeDex';
import { getGasPriceWei, prewarmNonce, sendTransaction } from './tradeTx';
import { getSellSpenders, hasInsufficientSellAllowance, type SellAllowanceCheckResult } from './sellAllowance';
import { encodeFourMemeBuyTokenData, encodeFourMemeUint256, tryFourMemeBuyEstimatedAmount, tryFourMemeSellEstimatedFunds } from './tradeFourMeme';
import { buildScopedTokenKey, normalizeWalletAddressKey } from '@/services/xSniper/engine/metrics';
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
import { chainNames } from '@/constants/chains';
import { getChainRuntime } from '@/constants/chains/runtime';
import { normalizeLaunchpadPlatform } from '@/constants/launchpad';
import { OpenFourInnerLaunchpadManager, OpenFourRegistryAddress } from '@/constants/contracts/address';
import FlapAPI from '@/hooks/FlapAPI';
import DexScreenerAPI, { type DexScreenerPair } from '@/hooks/DexScreenerAPI';
import { GmgnAPI } from '@/hooks/GmgnAPI';
import { call } from '@/utils/messaging';

function getDefaultBridgeV3Fee(chainId: number): number {
  return chainId === ChainId.HYPER ? 3000 : 500;
}

const INNER_LAUNCHPAD_PLATFORMS = new Set([
  'fourmeme',
  'bn_fourmeme',
  'fourmeme_agent',
  'four_xmode_agent',
  'xmode',
  'xmode_agent',
  'flap',
  'flap_stocks',
  'flap_aioracle',
  'printr',
  'openfour',
  'likwid',
  'goplus_skills',
  'goplus_creator',
  'cubepeg',
]);

const FOUR_MEME_PLATFORMS = new Set([
  'fourmeme',
  'bn_fourmeme',
  'fourmeme_agent',
  'four_xmode_agent',
  'xmode',
  'xmode_agent',
]);

const OPEN_FOUR_PLATFORMS = new Set([
  'openfour',
  'likwid',
  'goplus_skills',
  'goplus_creator',
  'cubepeg',
]);

const OPEN_FOUR_RUNTIME_PLATFORMS = new Set(OPEN_FOUR_PLATFORMS);
const FLAP_STOCKS_PLATFORMS = new Set([
  'flap_stocks',
]);

const isFlapSuffixAddress = (address?: string | null) => {
  const lower = String(address || '').trim().toLowerCase();
  return lower.endsWith('7777') || lower.endsWith('8888');
};

const openFourRegistryAbi = parseAbi([
  'function openFourCore() view returns (address)',
  'function openFourTool() view returns (address)',
]);

const openFourCoreAbi = parseAbi([
  'function tokens(address token_) view returns (uint32 version, address creator, uint256 presetId, address token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address tokenModule, address customData, uint256 createBlock, bool exists, bool paused, bool antiSniperEnabled)',
]);

const openFourToolsAbi = parseAbi([
  'function estimateBuyByBudget(address token, address trader, uint256 maxQuotePayAmount, uint256 options, bytes proof) view returns ((uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))',
  'function estimateSell(address token, address trader, uint256 amount, uint256 options, bytes proof) view returns ((uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))',
]);

const openFourVaultAbi = parseAbi([
  'function phase() view returns (uint8)',
]);

type OpenFourNetworkContracts = {
  core: Address;
  tools: Address;
};

type OpenFourRuntimeState = {
  core: Address;
  tools: Address;
  quoteAsset: Address;
  vault: Address;
  phase: number;
  exists: boolean;
  paused: boolean;
};

type OpenFourTradeEstimate = {
  curveQuote: bigint;
  totalFee: bigint;
  userPays: bigint;
  userReceives: bigint;
  tokenAmount: bigint;
  executionPrice: bigint;
};

const DEFAULT_SWAP_GAS_LIMIT = 900000n;
const OPEN_FOUR_SWAP_GAS_LIMIT = 2500000n;

function resolveLaunchpadPlatform(platform: string | undefined): string {
  return normalizeLaunchpadPlatform(platform) ?? String(platform || '').trim().toLowerCase();
}

function resolveTradeLaunchpadPlatform(tokenInfo: Pick<TokenInfo, 'launchpad' | 'launchpad_platform'>): string {
  const launchpad = resolveLaunchpadPlatform(tokenInfo.launchpad);
  if (launchpad === 'openfour') return 'openfour';
  return resolveLaunchpadPlatform(tokenInfo.launchpad_platform || tokenInfo.launchpad);
}

function isFourMemePlatform(platform: string): boolean {
  return FOUR_MEME_PLATFORMS.has(platform);
}

function isOpenFourPlatform(platform: string): boolean {
  return OPEN_FOUR_PLATFORMS.has(platform);
}

function usesOpenFourRuntime(platform: string): boolean {
  return OPEN_FOUR_RUNTIME_PLATFORMS.has(platform);
}

function isAddressLike(value: string | undefined | null): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function toOpenFourEstimate(raw: any): OpenFourTradeEstimate {
  const values = Array.isArray(raw) ? raw : [
    raw?.curveQuote,
    raw?.totalFee,
    raw?.userPays,
    raw?.userReceives,
    raw?.tokenAmount,
    raw?.executionPrice,
  ];
  return {
    curveQuote: BigInt(values[0] ?? 0),
    totalFee: BigInt(values[1] ?? 0),
    userPays: BigInt(values[2] ?? 0),
    userReceives: BigInt(values[3] ?? 0),
    tokenAmount: BigInt(values[4] ?? 0),
    executionPrice: BigInt(values[5] ?? 0),
  };
}

function getOpenFourRouteAddress(runtimeState?: OpenFourRuntimeState | null): Address {
  if (runtimeState?.core && runtimeState.core !== ZERO_ADDRESS) return runtimeState.core;
  return OpenFourInnerLaunchpadManager as Address;
}

function getOpenFourQuoteRouterToken(chainId: number, runtimeState?: OpenFourRuntimeState | null): Address | null {
  const quoteAsset = runtimeState?.quoteAsset;
  if (!quoteAsset || quoteAsset === ZERO_ADDRESS) return null;
  const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
  return quoteAsset.toLowerCase() === wrappedNative ? ZERO_ADDRESS : quoteAsset;
}

function getSwapGasLimitForLaunchpad(platform: string, isInner: boolean): bigint {
  if (isInner && usesOpenFourRuntime(platform)) return OPEN_FOUR_SWAP_GAS_LIMIT;
  return DEFAULT_SWAP_GAS_LIMIT;
}

function encodeOpenFourSwapData(
  isBuy: boolean,
  minAmountOut: bigint,
  options: bigint = 0n,
  proof: `0x${string}` = '0x'
): `0x${string}` {
  return encodeAbiParameters(
    parseAbiParameters('bool isBuy, uint256 minAmountOut, uint256 options, bytes proof'),
    [isBuy, minAmountOut, options, proof]
  );
}

function parseOpenFourOptions(raw: string | undefined): bigint {
  const text = String(raw || '').trim();
  if (!text) return 0n;
  try {
    return text.startsWith('0x') || text.startsWith('0X') ? BigInt(text) : BigInt(text);
  } catch {
    return 0n;
  }
}

export class TradeService {
  private static sellInFlightByToken = new Set<string>();
  private static readonly approveInFlightByKey = new Map<string, Promise<`0x${string}`>>();
  private static readonly fastApproveRetryMaxWaitMs = 800;
  private static readonly fastApproveRetryPollMs = 200;
  private static readonly quoteBestExactInCache = new Map<string, { ts: number; value: { amountOut: bigint; swapType: number; fee?: number; poolAddress: string } }>();
  private static readonly quoteBestExactInInFlight = new Map<string, Promise<{ amountOut: bigint; swapType: number; fee?: number; poolAddress: string }>>();
  private static readonly turboPrewarmInFlight = new Map<string, Promise<void>>();
  private static readonly openFourNetworkCache = new Map<number, OpenFourNetworkContracts>();
  private static readonly flapOuterQuoteInfoCache = new Map<string, Promise<TokenInfo | null>>();
  private static readonly flapKnownPoolMetaCache = new Map<string, Promise<{ prefer: 'v2' | 'v3'; fee?: number } | null>>();
  private static readonly flapOuterBuyQuoteRouteCacheMs = 30_000;
  private static readonly flapOuterBuyQuoteRouteCache = new Map<string, { ts: number; value: SwapDescLike[] | null }>();
  private static readonly flapOuterBuyQuoteRouteInFlight = new Map<string, Promise<SwapDescLike[] | null>>();
  private static readonly flapOuterSellQuoteRouteCache = new Map<string, { ts: number; value: SwapDescLike[] | null }>();
  private static readonly flapOuterSellQuoteRouteInFlight = new Map<string, Promise<SwapDescLike[] | null>>();
  private static readonly flapPoolCounterpartyCache = new Map<string, Address | null>();
  private static readonly flapPoolCounterpartyInFlight = new Map<string, Promise<Address | null>>();

  private static makeApproveKey(chainId: number, owner: string, token: string, spender: string) {
    return `${chainId}:${owner.toLowerCase()}:${token.toLowerCase()}:${spender.toLowerCase()}`;
  }

  private static getTurboWarmFingerprint(tokenInfo: TokenInfo) {
    return [
      resolveTradeLaunchpadPlatform(tokenInfo),
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
    submitChannel?: SubmitChannel;
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

    const task = (async () => await this.approve(
      input.chainId,
      input.tokenAddress,
      input.spender,
      input.maxUint256.toString(),
      input.owner,
      input.submitChannel,
    ))();
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

  static async prewarmTurbo(input: { chainId: number; tokenAddress: Address; tokenInfo?: TokenInfo; fromAddress?: `0x${string}`; submitChannel?: SubmitChannel }) {
    const settings = await SettingsService.get();
    const consoleLogsEnabled = settings.ui?.consoleLogsEnabled === true;
    const startedAt = Date.now();
    const tokenInfo = input.tokenInfo;
    if (!tokenInfo) return;

    const client = await RpcService.getClient(input.chainId);
    const fromAddress = this.resolveOptionalEvmAddress(input.fromAddress, 'from address');
    const account = await WalletService.getSigner(fromAddress);
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
      await prewarmNonce(client, input.chainId, account.address, { submitChannel: input.submitChannel });

      const token = input.tokenAddress;
      const bridgeToken = getBridgeToken(input.chainId as ChainId, tokenInfo.address, tokenInfo.quote_token_address);
      const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      const dexPrefer = getDexPoolPrefer(tokenInfo.dex_type);
      const tokenPrefer = dexPrefer === 'v2' || dexPrefer === 'v3' ? dexPrefer : (bridgePrefer ?? 'v2');
      const launchpadPlatform = resolveTradeLaunchpadPlatform(tokenInfo);
      const rawQuoteToken = this.getLaunchpadRawQuoteToken(input.chainId, tokenInfo, launchpadPlatform);
      const isFlapStocks = !!rawQuoteToken && this.isFlapStocksPlatform(launchpadPlatform, tokenInfo, input.chainId);

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

      if (isFlapStocks && rawQuoteToken) {
          warmTasks.push((async () => {
            const rawQuoteInfo = await this.getFlapOuterQuoteTokenInfo(input.chainId, rawQuoteToken, consoleLogsEnabled);
            const rawQuotePool = this.getKnownDexPoolAddress(rawQuoteInfo);
            if (rawQuotePool) {
              await this.primeKnownPoolCounterpartyToken(input.chainId, rawQuotePool, rawQuoteToken, consoleLogsEnabled);
            }
          })().catch(() => null));
        warmTasks.push(
          this.buildFlapOuterBuyQuoteRoute({
            chainId: input.chainId,
            currentToken: ZERO_ADDRESS,
            targetToken: rawQuoteToken,
              debug: consoleLogsEnabled,
          }).catch(() => null)
        );
        warmTasks.push(
          this.buildFlapOuterSellQuoteRoute({
            chainId: input.chainId,
            currentToken: rawQuoteToken,
            targetToken: ZERO_ADDRESS,
            debug: consoleLogsEnabled,
          }).catch(() => null)
        );
        const outerTargetPool = await this.getPreferredFlapOuterTargetPool({
          chainId: input.chainId,
          tokenAddress: token,
          quoteTokenAddress: rawQuoteToken,
          tokenInfo,
          debug: consoleLogsEnabled,
          logEvent: 'prewarm.target_pool.selected',
        }).catch(() => ({ poolAddress: null, preferHint: null as 'v2' | 'v3' | null, fee: undefined }));
        if (outerTargetPool.poolAddress) {
          warmTasks.push(
            this.resolveKnownPoolRouteDesc({
              chainId: input.chainId,
              tokenIn: rawQuoteToken,
              tokenOut: token,
              poolAddress: outerTargetPool.poolAddress,
              preferHint: outerTargetPool.preferHint,
            }).catch(() => null)
          );
          warmTasks.push(
            this.resolveKnownPoolRouteDesc({
              chainId: input.chainId,
              tokenIn: token,
              tokenOut: rawQuoteToken,
              poolAddress: outerTargetPool.poolAddress,
              preferHint: outerTargetPool.preferHint,
            }).catch(() => null)
          );
        }
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
    submitChannel?: SubmitChannel;
    error?: any;
  }): Promise<number> {
    const client = await RpcService.getSubmitChannelClient(input.chainId, input.submitChannel, input.txSide);
    const fromAddress = this.resolveOptionalEvmAddress(input.fromAddress, 'from address');
    const account = await WalletService.getSigner(fromAddress);
    const errorText = typeof input.error === 'string'
      ? input.error.toLowerCase()
      : collectErrorText(input.error, true);
    const nonceKind = getNonceErrorKindFromText(errorText);
    const prefer = nonceKind === 'too_high' ? 'min' : 'max';
    const scope = nonceKind === 'too_high' ? 'protected' : 'both';
    const nextNonce = await prewarmNonce(client, input.chainId, account.address, {
      force: true,
      txSide: input.txSide,
      submitChannel: input.submitChannel,
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

  private static async resolveSellRouteManagerForAllowance(input: {
    chainId: number;
    tokenAddress: Address;
    tokenInfo: TokenInfo;
    owner: `0x${string}`;
    client: any;
  }): Promise<Address | null> {
    const platform = resolveTradeLaunchpadPlatform(input.tokenInfo);
    const isHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(platform);
    const openFourRuntime = (isHyperAltfun || !usesOpenFourRuntime(platform))
      ? null
      : await this.getOpenFourRuntimeState(input.client, input.chainId, input.tokenAddress);
    const isInner = isHyperAltfun
      ? false
      : usesOpenFourRuntime(platform)
        ? !!openFourRuntime && openFourRuntime.phase === 1 && !openFourRuntime.paused
        : this.isInnerDisk(input.tokenInfo);
    if (!isInner) return null;

    const launchpadConfig = this.getLaunchpadConfig(input.tokenInfo, input.chainId, openFourRuntime);
    let routeManager = launchpadConfig?.manager ?? ZERO_ADDRESS;
    if (!(isFourMemePlatform(platform) && routeManager !== ZERO_ADDRESS)) {
      return routeManager !== ZERO_ADDRESS ? routeManager : null;
    }

    let amountIn = 0n;
    try {
      amountIn = BigInt(await input.client.readContract({
        address: input.tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [input.owner],
      }));
    } catch {
      amountIn = 0n;
    }
    if (amountIn > 0n) {
      const alignedAmount = (amountIn / 1000000000n) * 1000000000n;
      if (alignedAmount > 0n) amountIn = alignedAmount;
      try {
        const est = await tryFourMemeSellEstimatedFunds(input.client, input.chainId, input.tokenAddress, amountIn);
        if (est?.tokenManager && est.tokenManager !== ZERO_ADDRESS) {
          routeManager = est.tokenManager;
        }
      } catch {
      }
    }

    return routeManager !== ZERO_ADDRESS ? routeManager : null;
  }

  private static isInnerDisk(tokenInfo: TokenInfo): boolean {
    if (tokenInfo.launchpad) {
      const platform = resolveTradeLaunchpadPlatform(tokenInfo);
      if (INNER_LAUNCHPAD_PLATFORMS.has(platform)) {
        return tokenInfo.launchpad_status !== 1;
      }
    }
    return false;
  }

  private static async getOpenFourNetworkContracts(client: any, chainId: number): Promise<OpenFourNetworkContracts | null> {
    const cached = this.openFourNetworkCache.get(chainId);
    if (cached) return cached;
    const registryAddress = OpenFourRegistryAddress[chainId as ChainId];
    if (!isAddressLike(registryAddress)) return null;
    const [coreAddress, toolsAddress] = await Promise.all([
      client.readContract({
        address: registryAddress,
        abi: openFourRegistryAbi,
        functionName: 'openFourCore',
      }),
      client.readContract({
        address: registryAddress,
        abi: openFourRegistryAbi,
        functionName: 'openFourTool',
      }),
    ]);
    if (!isAddressLike(coreAddress) || !isAddressLike(toolsAddress)) return null;
    const contracts = {
      core: coreAddress as Address,
      tools: toolsAddress as Address,
    };
    this.openFourNetworkCache.set(chainId, contracts);
    return contracts;
  }

  private static async getOpenFourRuntimeState(client: any, chainId: number, tokenAddress: Address): Promise<OpenFourRuntimeState | null> {
    const contracts = await this.getOpenFourNetworkContracts(client, chainId);
    if (!contracts) return null;
    const cfg = await client.readContract({
      address: contracts.core,
      abi: openFourCoreAbi,
      functionName: 'tokens',
      args: [tokenAddress],
    });
    const values = cfg as any[];
    const quoteAsset = values[9] as Address;
    const vault = values[10] as Address;
    const exists = Boolean(values[17]);
    const paused = Boolean(values[18]);
    if (!exists || !isAddressLike(vault)) return null;
    const phase = Number(await client.readContract({
      address: vault,
      abi: openFourVaultAbi,
      functionName: 'phase',
    }));
    return {
      core: contracts.core,
      tools: contracts.tools,
      quoteAsset: isAddressLike(quoteAsset) ? quoteAsset : ZERO_ADDRESS,
      vault,
      phase,
      exists,
      paused,
    };
  }

  private static async estimateOpenFourBuyByBudget(
    client: any,
    chainId: number,
    tokenAddress: Address,
    trader: Address,
    maxQuotePayAmount: bigint,
    options: bigint,
    proof: `0x${string}`
  ): Promise<OpenFourTradeEstimate | null> {
    const contracts = await this.getOpenFourNetworkContracts(client, chainId);
    if (!contracts) return null;
    const estimate = await client.readContract({
      address: contracts.tools,
      abi: openFourToolsAbi,
      functionName: 'estimateBuyByBudget',
      args: [tokenAddress, trader, maxQuotePayAmount, options, proof],
    });
    return toOpenFourEstimate(estimate);
  }

  private static async estimateOpenFourSell(
    client: any,
    chainId: number,
    tokenAddress: Address,
    trader: Address,
    amount: bigint,
    options: bigint,
    proof: `0x${string}`
  ): Promise<OpenFourTradeEstimate | null> {
    const contracts = await this.getOpenFourNetworkContracts(client, chainId);
    if (!contracts) return null;
    const estimate = await client.readContract({
      address: contracts.tools,
      abi: openFourToolsAbi,
      functionName: 'estimateSell',
      args: [tokenAddress, trader, amount, options, proof],
    });
    return toOpenFourEstimate(estimate);
  }

  private static getLaunchpadConfig(tokenInfo: TokenInfo, chainId: number, openFourRuntime?: OpenFourRuntimeState | null) {
    const platform = resolveTradeLaunchpadPlatform(tokenInfo);
    const contracts = DeployAddress[chainId as ChainId] || {};
    const routeAddress = ((tokenInfo.pool_pair && tokenInfo.pool_pair.trim()) || ZERO_ADDRESS) as Address;
    const openFourRouteAddress = getOpenFourRouteAddress(openFourRuntime);

    if (isFourMemePlatform(platform)) {
      return {
        buyType: SwapType.FOUR_MEME_BUY_AMAP,
        sellType: SwapType.FOUR_MEME_SELL,
        manager: (contracts[ContractNames.FourMemeTokenManagerV2]?.address || ZERO_ADDRESS) as Address
      };
    }

    if (platform === 'flap' || platform === 'flap_stocks') {
      return {
        buyType: SwapType.FLAP_EXACT_INPUT,
        sellType: SwapType.FLAP_EXACT_INPUT,
        manager: (contracts[ContractNames.FlapshTokenManager]?.address || ZERO_ADDRESS) as Address
      };
    }

    if (platform === 'printr') {
      return {
        buyType: SwapType.PRINTR_EXACT_IN,
        sellType: SwapType.PRINTR_EXACT_IN,
        manager: routeAddress,
      };
    }

    if (isOpenFourPlatform(platform)) {
      return {
        buyType: SwapType.OPEN_FOUR_EXACT_IN,
        sellType: SwapType.OPEN_FOUR_EXACT_IN,
        manager: openFourRouteAddress,
      };
    }
    return null;
  }

  private static getLaunchpadQuoteRouterToken(
    chainId: number,
    tokenInfo: TokenInfo,
    platform: string,
    openFourRuntime?: OpenFourRuntimeState | null,
    opts?: { preferRuntimeQuote?: boolean }
  ): Address | null {
    if (opts?.preferRuntimeQuote && usesOpenFourRuntime(platform)) {
      const runtimeToken = getOpenFourQuoteRouterToken(chainId, openFourRuntime);
      if (runtimeToken !== null) return runtimeToken;
    }
    if (!isOpenFourPlatform(platform)) return getBridgeToken(chainId, tokenInfo.address, tokenInfo.quote_token_address);
    const raw = typeof tokenInfo.quote_token_address === 'string' ? tokenInfo.quote_token_address.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    return raw.toLowerCase() === wrappedNative ? ZERO_ADDRESS : raw as Address;
  }

  private static getLaunchpadRawQuoteToken(
    chainId: number,
    tokenInfo: TokenInfo,
    platform: string,
    openFourRuntime?: OpenFourRuntimeState | null,
    opts?: { preferRuntimeQuote?: boolean }
  ): Address | null {
    if (opts?.preferRuntimeQuote && usesOpenFourRuntime(platform)) {
      const runtimeToken = getOpenFourQuoteRouterToken(chainId, openFourRuntime);
      if (runtimeToken !== null) return runtimeToken;
    }
    const raw = typeof tokenInfo.quote_token_address === 'string' ? tokenInfo.quote_token_address.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    const normalized = raw.toLowerCase();
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (normalized === ZERO_ADDRESS.toLowerCase() || normalized === wrappedNative) return ZERO_ADDRESS;
    return raw as Address;
  }

  private static sanitizeFlapQuoteTokenAddress(tokenAddress: Address, quoteTokenAddress?: string | null): Address | null {
    const raw = typeof quoteTokenAddress === 'string' ? quoteTokenAddress.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    if (raw.toLowerCase() === tokenAddress.toLowerCase()) return null;
    return raw as Address;
  }

  private static normalizeFlapPoolCounterpartyToken(chainId: number, tokenAddress?: string | null): Address | null {
    const raw = typeof tokenAddress === 'string' ? tokenAddress.trim() : '';
    if (!isAddressLike(raw)) return null;
    const normalized = raw.toLowerCase();
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (normalized === ZERO_ADDRESS.toLowerCase() || normalized === wrappedNative) return ZERO_ADDRESS;
    return raw as Address;
  }

  private static getCachedPoolCounterpartyToken(
    chainId: number,
    poolAddress: Address,
    tokenAddress: Address,
  ): Address | null {
    const key = this.makeFlapPoolCounterpartyCacheKey(chainId, poolAddress, tokenAddress);
    return this.flapPoolCounterpartyCache.get(key) ?? null;
  }

  private static async primeKnownPoolCounterpartyToken(
    chainId: number,
    poolAddress: Address,
    tokenAddress: Address,
    debug?: boolean,
  ): Promise<Address | null> {
    const key = this.makeFlapPoolCounterpartyCacheKey(chainId, poolAddress, tokenAddress);
    const cached = this.flapPoolCounterpartyCache.get(key);
    if (cached !== undefined) return cached;
    const existing = this.flapPoolCounterpartyInFlight.get(key);
    if (existing) return await existing;

    const task = (async () => {
    try {
      const res = await call({
        type: 'token:getPoolPair',
        pair: poolAddress,
        chainId,
      } as const);
      const token0 = isAddressLike((res as any)?.token0) ? ((res as any).token0 as Address) : null;
      const token1 = isAddressLike((res as any)?.token1) ? ((res as any).token1 as Address) : null;
      const target = tokenAddress.toLowerCase();
      if (token0?.toLowerCase() === target) {
          return this.normalizeFlapPoolCounterpartyToken(chainId, token1);
      }
      if (token1?.toLowerCase() === target) {
          return this.normalizeFlapPoolCounterpartyToken(chainId, token0);
      }
      this.logFlapStocksRoute(debug, 'buy.route.pool_counterparty_miss', {
        chainId,
        poolAddress,
        tokenAddress,
        token0,
        token1,
      });
      return null;
    } catch (error) {
      this.logFlapStocksRoute(debug, 'buy.route.pool_counterparty_error', {
        chainId,
        poolAddress,
        tokenAddress,
        error: collectErrorText(error),
      });
      return null;
    }
    })()
      .then((result) => {
        this.flapPoolCounterpartyCache.set(key, result);
        return result;
      })
      .finally(() => {
        this.flapPoolCounterpartyInFlight.delete(key);
      });
    this.flapPoolCounterpartyInFlight.set(key, task);
    return await task;
  }

  private static getDefaultFlapStocksBridgeToken(chainId: number): Address | null {
    if (chainId === ChainId.BNB) return bscTokens.usdt.address as Address;
    return null;
  }

  private static buildKnownLaunchpadBuyRouteDesc(input: {
    chainId: number;
    tokenIn: Address;
    tokenInfo: TokenInfo;
  }): SwapDescLike | null {
    const platform = resolveTradeLaunchpadPlatform(input.tokenInfo);
    if (!INNER_LAUNCHPAD_PLATFORMS.has(platform) || !this.isInnerDisk(input.tokenInfo)) return null;
    if ((platform === 'flap' || platform === 'flap_stocks') && !this.hasConfirmedFlapLaunchpadIdentity(input.tokenInfo)) {
      return null;
    }

    const launchpadConfig = this.getLaunchpadConfig(input.tokenInfo, input.chainId);
    if (!launchpadConfig || launchpadConfig.manager === ZERO_ADDRESS) return null;

    let data: `0x${string}` = '0x';
    if (isOpenFourPlatform(platform)) {
      data = encodeOpenFourSwapData(true, 0n);
    }

    return getRouterSwapDesc({
      swapType: launchpadConfig.buyType,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenInfo.address as Address,
      poolAddress: launchpadConfig.manager,
      fee: 0,
      data,
    });
  }

  private static getKnownFlapOuterV4Meta(input: {
    chainId: number;
    tokenInfo?: Pick<TokenInfo, 'launchpad_platform' | 'flap_pool_model' | 'flap_v4_fee' | 'flap_v4_tick_spacing' | 'flap_v4_hooks'> | null;
  }): { fee: number; tickSpacing: number; hooks: Address } | null {
    if (input.chainId !== ChainId.BNB) return null;
    const tokenInfo = input.tokenInfo;
    if (!tokenInfo) return null;
    if (resolveTradeLaunchpadPlatform(tokenInfo as TokenInfo) !== 'flap') return null;
    if (tokenInfo.flap_pool_model !== 'v4_cl') return null;
    const fee = Number(tokenInfo.flap_v4_fee ?? 0);
    const tickSpacing = Number(tokenInfo.flap_v4_tick_spacing ?? 0);
    const hooks = isAddressLike(tokenInfo.flap_v4_hooks) ? tokenInfo.flap_v4_hooks as Address : ZERO_ADDRESS;
    if (!(fee > 0) || !Number.isFinite(tickSpacing) || tickSpacing <= 0) return null;
    return { fee, tickSpacing, hooks };
  }

  private static buildKnownFlapOuterV4Desc(input: {
    tokenIn: Address;
    tokenOut: Address;
    fee: number;
    tickSpacing: number;
    hooks?: Address;
  }): SwapDescLike {
    return {
      swapType: SwapType.V4_EXACT_IN,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      poolAddress: ZERO_ADDRESS,
      fee: input.fee,
      tickSpacing: input.tickSpacing,
      hooks: input.hooks ?? ZERO_ADDRESS,
      hookData: '0x',
      poolManager: ZERO_ADDRESS,
      parameters: '0x0000000000000000000000000000000000000000000000000000000000000000',
      data: '0x',
    };
  }

  private static async buildKnownFlapOuterV4BuyRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    targetInfo: TokenInfo;
    debug?: boolean;
    depth?: number;
  }): Promise<SwapDescLike[] | null> {
    const v4Meta = this.getKnownFlapOuterV4Meta({
      chainId: input.chainId,
      tokenInfo: input.targetInfo,
    });
    if (!v4Meta) return null;

    const routeQuoteToken = this.normalizeFlapQuoteTokenAddress(input.chainId, input.targetInfo.quote_token_address)
      ?? this.getDefaultFlapStocksBridgeToken(input.chainId);
    if (!routeQuoteToken) return null;

    const descs: SwapDescLike[] = [];
    let routeCurrentToken = input.currentToken;
    if (routeCurrentToken.toLowerCase() !== routeQuoteToken.toLowerCase()) {
      if (!this.isFlapOuterRouteTerminalToken(input.chainId, routeQuoteToken)) {
        this.logFlapStocksRoute(input.debug, 'buy.route.v4_non_terminal_quote', {
          chainId: input.chainId,
          depth: input.depth ?? 0,
          currentToken: input.currentToken,
          targetToken: input.targetToken,
          routeQuoteToken,
        });
        return null;
      }
      descs.push(await this.resolveRouteHopDesc({
        chainId: input.chainId,
        tokenIn: routeCurrentToken,
        tokenOut: routeQuoteToken,
        prefer: getBridgeTokenDexPreference(input.chainId as ChainId, routeQuoteToken) ?? null,
      }));
      routeCurrentToken = routeQuoteToken;
    }

    this.logFlapStocksRoute(input.debug, 'buy.route.known_v4', {
      chainId: input.chainId,
      depth: input.depth ?? 0,
      currentToken: routeCurrentToken,
      targetToken: input.targetToken,
      routeQuoteToken,
      fee: v4Meta.fee,
      tickSpacing: v4Meta.tickSpacing,
      hooks: v4Meta.hooks,
      dexId: input.targetInfo.dexId ?? null,
      lpFeeProfile: input.targetInfo.flap_lp_fee_profile ?? null,
      poolModel: input.targetInfo.flap_pool_model ?? null,
      clPoolId: input.targetInfo.flap_cl_pool_id ?? null,
    });
    descs.push(this.buildKnownFlapOuterV4Desc({
      tokenIn: routeCurrentToken,
      tokenOut: input.targetToken,
      fee: v4Meta.fee,
      tickSpacing: v4Meta.tickSpacing,
      hooks: v4Meta.hooks,
    }));
    return descs;
  }

  private static async buildKnownFlapOuterV4SellRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    currentInfo: TokenInfo;
    debug?: boolean;
  }): Promise<SwapDescLike[] | null> {
    const v4Meta = this.getKnownFlapOuterV4Meta({
      chainId: input.chainId,
      tokenInfo: input.currentInfo,
    });
    if (!v4Meta) return null;

    const routeQuoteToken = this.normalizeFlapQuoteTokenAddress(input.chainId, input.currentInfo.quote_token_address)
      ?? this.getDefaultFlapStocksBridgeToken(input.chainId);
    if (!routeQuoteToken) return null;

    const descs: SwapDescLike[] = [];
    this.logFlapStocksRoute(input.debug, 'sell.route.known_v4', {
      chainId: input.chainId,
      currentToken: input.currentToken,
      targetToken: input.targetToken,
      routeQuoteToken,
      fee: v4Meta.fee,
      tickSpacing: v4Meta.tickSpacing,
      hooks: v4Meta.hooks,
      dexId: input.currentInfo.dexId ?? null,
      lpFeeProfile: input.currentInfo.flap_lp_fee_profile ?? null,
      poolModel: input.currentInfo.flap_pool_model ?? null,
      clPoolId: input.currentInfo.flap_cl_pool_id ?? null,
    });
    descs.push(this.buildKnownFlapOuterV4Desc({
      tokenIn: input.currentToken,
      tokenOut: routeQuoteToken,
      fee: v4Meta.fee,
      tickSpacing: v4Meta.tickSpacing,
      hooks: v4Meta.hooks,
    }));
    if (routeQuoteToken.toLowerCase() === input.targetToken.toLowerCase()) {
      return descs;
    }
    if (!this.isFlapOuterRouteTerminalToken(input.chainId, routeQuoteToken)) {
      this.logFlapStocksRoute(input.debug, 'sell.route.v4_non_terminal_quote', {
        chainId: input.chainId,
        currentToken: input.currentToken,
        targetToken: input.targetToken,
        routeQuoteToken,
      });
      return null;
    }
    descs.push(await this.resolveRouteHopDesc({
      chainId: input.chainId,
      tokenIn: routeQuoteToken,
      tokenOut: input.targetToken,
      prefer: getBridgeTokenDexPreference(input.chainId as ChainId, routeQuoteToken) ?? null,
    }));
    return descs;
  }

  private static hasFlapStocksMetadata(tokenInfo?: TokenInfo): boolean {
    if (!tokenInfo) return false;
    return tokenInfo.flap_stocks_vault_version != null
      || !!tokenInfo.flap_dividend_token
      || !!tokenInfo.flap_vault_factory
      || !!tokenInfo.flap_basket_token
      || Array.isArray(tokenInfo.flap_supported_assets);
  }

  private static hasConfirmedFlapLaunchpadIdentity(
    tokenInfo?: Pick<TokenInfo, 'address' | 'tokenVersion' | 'extensionID' | 'nativeToQuoteSwapEnabled' | 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_factory' | 'flap_basket_token' | 'flap_supported_assets'> | null
  ): boolean {
    if (!tokenInfo) return false;
    if (this.hasFlapStocksMetadata(tokenInfo as TokenInfo)) return true;
    if (isFlapSuffixAddress(tokenInfo.address)) return true;
    if (Number(tokenInfo.tokenVersion ?? 0) > 0) return true;
    if (tokenInfo.nativeToQuoteSwapEnabled === true) return true;
    const extensionID = String(tokenInfo.extensionID || '').trim().toLowerCase();
    return !!extensionID && extensionID !== '0x' && extensionID !== '0x0';
  }

  private static resolveFlapStocksLaunchpadPlatform(tokenInfo?: Pick<TokenInfo, 'launchpad_platform' | 'flap_stocks_vault_version' | 'flap_dividend_token' | 'flap_vault_factory' | 'flap_basket_token' | 'flap_supported_assets'> | null): string {
    if (this.hasFlapStocksMetadata(tokenInfo as TokenInfo | undefined)) return 'flap_stocks';
    return resolveTradeLaunchpadPlatform((tokenInfo ?? { launchpad: 'flap', launchpad_platform: 'flap' }) as TokenInfo);
  }

  private static isFlapStocksPlatform(platform: string, tokenInfo?: TokenInfo, chainId?: number): boolean {
    if (FLAP_STOCKS_PLATFORMS.has(platform)) return true;
    if (platform !== 'flap' || !tokenInfo || !chainId) return false;

    const rawQuote = typeof tokenInfo.quote_token_address === 'string' ? tokenInfo.quote_token_address.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(rawQuote)) return false;
    const normalizedQuote = rawQuote.toLowerCase();
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (normalizedQuote === ZERO_ADDRESS.toLowerCase() || normalizedQuote === wrappedNative) return false;
    if (getBridgeToken(chainId, tokenInfo.address, rawQuote)) return false;

    const launchType = String(tokenInfo.tpool_launch_type || '').trim().toLowerCase();
    if (launchType === 'migrated') return true;

    if (Number(tokenInfo.launchpad_status ?? 0) !== 1 && this.hasFlapStocksMetadata(tokenInfo)) {
      return true;
    }

    return false;
  }

  private static isUsableDexQuote(q: DexExactInQuote, isTurbo: boolean): boolean {
    if (!q.poolAddress || q.poolAddress === ZERO_ADDRESS) return false;
    if (isTurbo) return true;
    try {
      assertDexQuoteOk(q);
    } catch {
      return false;
    }
    return q.amountOut > 0n;
  }

  private static getQuoteBridgeCandidates(chainId: number, currentToken: Address, targetToken: Address): Address[] {
    const preferred = chainId === ChainId.BNB ? [bscTokens.busd.address as Address] : [];
    const all = [...preferred, ...getBridgeTokenAddresses(chainId as ChainId)] as Address[];
    const seen = new Set<string>();
    const currentLower = currentToken.toLowerCase();
    const targetLower = targetToken.toLowerCase();
    const out: Address[] = [];
    for (const candidate of all) {
      const lowered = candidate.toLowerCase();
      if (lowered === ZERO_ADDRESS.toLowerCase()) continue;
      if (lowered === currentLower || lowered === targetLower) continue;
      if (seen.has(lowered)) continue;
      seen.add(lowered);
      out.push(candidate);
    }
    return out;
  }

  private static async resolveAdaptiveDexHop(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    isTurbo: boolean
  ): Promise<DexExactInQuote> {
    const bridgeAddresses = getBridgeTokenAddresses(chainId as ChainId);
    const inLower = tokenIn.toLowerCase();
    const outLower = tokenOut.toLowerCase();
    const isBridgeLike = (token: string) =>
      token === ZERO_ADDRESS.toLowerCase() || bridgeAddresses.some((x) => x.toLowerCase() === token);

    if (isBridgeLike(inLower) || isBridgeLike(outLower)) {
      const prefer = isBridgeLike(outLower)
        ? getBridgeTokenDexPreference(chainId as ChainId, tokenOut)
        : getBridgeTokenDexPreference(chainId as ChainId, tokenIn);
      return await resolveBridgeHopExactIn(chainId, tokenIn, tokenOut, amountIn, prefer, isTurbo, !isTurbo);
    }

    return await resolveDexExactIn(
      chainId,
      tokenIn,
      tokenOut,
      amountIn,
      undefined,
      isTurbo,
      !isTurbo
    );
  }

  private static async getFlapOuterQuoteTokenInfo(chainId: number, tokenAddress: Address, debug?: boolean): Promise<TokenInfo | null> {
    const chain = String(chainNames[chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return null;
    const key = `${chain}:${tokenAddress.toLowerCase()}`;
    let task = this.flapOuterQuoteInfoCache.get(key);
    if (!task) {
      task = (async () => {
        let onchain: FlapTokenStateV7 | null = null;
        try {
          const res = await call({
            type: 'token:getTokenInfo:flap',
            chainId,
            tokenAddress,
          } as const);
          if ((res as any)?.ok !== false) {
            onchain = res as unknown as FlapTokenStateV7;
          }
        } catch {
          onchain = null;
        }

        const onchainQuoteTokenAddress = this.sanitizeFlapQuoteTokenAddress(
          tokenAddress,
          typeof onchain?.quoteTokenAddress === 'string' ? onchain.quoteTokenAddress : undefined,
        ) ?? undefined;
        const onchainPoolModel = onchain?.poolModel;
        const onchainPoolPair = onchainPoolModel === 'classic' && typeof onchain?.pool === 'string'
          && /^0x[a-fA-F0-9]{40}$/.test(onchain.pool)
          && onchain.pool !== ZERO_ADDRESS
          ? onchain.pool
          : undefined;
        const hasKnownPoolAddress = (info?: Pick<TokenInfo, 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null) =>
          !!(info?.pool_pair || info?.biggest_pool_address || info?.tpool_pool_address);
        const hasRouteMinimum = (info?: Pick<TokenInfo, 'quote_token_address' | 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null) =>
          !!(info?.quote_token_address && hasKnownPoolAddress(info));

        let officialInfo: TokenInfo | null = null;
        let tradeInfo: TokenInfo | null = null;
        if (!onchainPoolPair || !onchainQuoteTokenAddress) {
          officialInfo = await FlapAPI.getTokenInfo(chain, tokenAddress).catch(() => null);
        }
        if (!hasRouteMinimum(officialInfo) || (!officialInfo?.quote_token_address && !onchainQuoteTokenAddress)) {
          tradeInfo = await GmgnAPI.getTokenTradeInfo(chain, tokenAddress).catch(() => null);
        }

        const officialQuoteTokenAddress = this.sanitizeFlapQuoteTokenAddress(tokenAddress, officialInfo?.quote_token_address) ?? undefined;
        const tradeQuoteTokenAddress = this.sanitizeFlapQuoteTokenAddress(tokenAddress, tradeInfo?.quote_token_address) ?? undefined;
        let mergedQuoteTokenAddress = onchainQuoteTokenAddress
          || officialQuoteTokenAddress
          || tradeQuoteTokenAddress;
        let mergedPoolPair = onchainPoolPair
          || officialInfo?.pool_pair
          || tradeInfo?.pool_pair
          || officialInfo?.biggest_pool_address
            || tradeInfo?.biggest_pool_address
            || officialInfo?.tpool_pool_address
            || tradeInfo?.tpool_pool_address;
        let mergedDexType = officialInfo?.dex_type || tradeInfo?.dex_type;
        const mergedQuoteToken = officialInfo?.quote_token || tradeInfo?.quote_token || '';
        const mergedNativeToQuoteSwapEnabled = onchain?.nativeToQuoteSwapEnabled
          ?? officialInfo?.nativeToQuoteSwapEnabled
          ?? tradeInfo?.nativeToQuoteSwapEnabled;
        const mergedTokenVersion = onchain?.tokenVersion;
        const mergedExtensionID = onchain?.extensionID;
        const mergedDexId = onchain?.dexId;
        const mergedLpFeeProfile = onchain?.lpFeeProfile;
        const mergedPoolModel = onchain?.poolModel;
        const mergedPoolCompatAddress = onchain?.poolCompatAddress;
        const mergedClPoolId = onchain?.clPoolId;
        const mergedV4Fee = onchain?.v4Fee;
        const mergedV4TickSpacing = onchain?.v4TickSpacing;
        const mergedV4Hooks = onchain?.v4Hooks;
        const mergedDividendToken = onchain?.dividendToken;
        const mergedVaultAddress = onchain?.vaultAddress;
        const mergedVaultFactory = onchain?.vaultFactory;
        const mergedVaultIsOfficial = onchain?.vaultIsOfficial;
        const mergedVaultIsAIConsumer = onchain?.vaultIsAIConsumer;
        const mergedStocksVaultVersion = onchain?.stocksVaultVersion;
        const mergedBasketToken = onchain?.basketToken;
        const mergedSupportedAssets = onchain?.supportedAssets;
        const onchainHasOuterPool =
          !!onchainPoolPair
          || mergedPoolModel === 'v4_cl'
          || mergedPoolModel === 'infinity_cl'
          || (typeof mergedPoolCompatAddress === 'string'
            && /^0x[a-fA-F0-9]{40}$/.test(mergedPoolCompatAddress)
            && mergedPoolCompatAddress.toLowerCase() !== ZERO_ADDRESS.toLowerCase());
        const onchainLaunchpadStatus = onchainHasOuterPool ? 1 : 0;
        const officialLaunchpadStatus = Number(officialInfo?.launchpad_status ?? Number.NaN);
        const tradeLaunchpadStatus = Number(tradeInfo?.launchpad_status ?? Number.NaN);
        const mergedLaunchpad = officialInfo?.launchpad || tradeInfo?.launchpad || 'flap';
        const mergedLaunchpadPlatform = this.resolveFlapStocksLaunchpadPlatform({
          launchpad_platform: officialInfo?.launchpad_platform || tradeInfo?.launchpad_platform || mergedLaunchpad,
          flap_stocks_vault_version: mergedStocksVaultVersion,
          flap_dividend_token: mergedDividendToken,
          flap_vault_factory: mergedVaultFactory,
          flap_basket_token: mergedBasketToken,
          flap_supported_assets: mergedSupportedAssets,
        });
        const mergedLaunchpadStatus = onchainHasOuterPool
          ? 1
          : Number.isFinite(officialLaunchpadStatus)
            ? officialLaunchpadStatus
            : Number.isFinite(tradeLaunchpadStatus)
              ? tradeLaunchpadStatus
              : onchainLaunchpadStatus;
        const mergedTpoolExchange = officialInfo?.tpool_exchange || tradeInfo?.tpool_exchange;
        const mergedTpoolLaunchType = onchainHasOuterPool
          ? 'migrated'
          : officialInfo?.tpool_launch_type || tradeInfo?.tpool_launch_type || (mergedLaunchpadStatus === 1 ? 'migrated' : undefined);
        const mergedTpoolPoolAddress = officialInfo?.tpool_pool_address || tradeInfo?.tpool_pool_address;
        const mergedBiggestPoolAddress = officialInfo?.biggest_pool_address || tradeInfo?.biggest_pool_address;

        if (!mergedPoolPair || !mergedQuoteTokenAddress || !mergedDexType) {
          const dexFallback = await this.getDexScreenerOuterQuoteFallback({
            chain,
            chainId,
            tokenAddress,
            preferredQuoteToken: mergedQuoteTokenAddress ?? null,
          });
          if (dexFallback) {
            mergedQuoteTokenAddress = mergedQuoteTokenAddress || dexFallback.quoteTokenAddress;
            mergedPoolPair = mergedPoolPair || dexFallback.poolPair;
            mergedDexType = mergedDexType || dexFallback.dexType;
          }
        }

        if (mergedQuoteTokenAddress || mergedPoolPair || mergedTpoolPoolAddress) {
          const mergedInfo = {
            chain,
            address: tokenAddress,
            name: officialInfo?.name || tradeInfo?.name || '',
            symbol: officialInfo?.symbol || tradeInfo?.symbol || '',
            decimals: officialInfo?.decimals || tradeInfo?.decimals || 18,
            logo: officialInfo?.logo || tradeInfo?.logo || '',
            launchpad: mergedLaunchpad,
            launchpad_progress: Number(officialInfo?.launchpad_progress ?? tradeInfo?.launchpad_progress ?? 0),
            launchpad_platform: mergedLaunchpadPlatform,
            launchpad_status: mergedLaunchpadStatus,
            quote_token: mergedQuoteToken,
            quote_token_address: mergedQuoteTokenAddress,
            pool_pair: mergedPoolPair,
            biggest_pool_address: mergedBiggestPoolAddress,
            tpool_exchange: mergedTpoolExchange,
            tpool_launch_type: mergedTpoolLaunchType,
            tpool_pool_address: mergedTpoolPoolAddress,
            dex_type: mergedDexType,
            nativeToQuoteSwapEnabled: mergedNativeToQuoteSwapEnabled,
            tokenVersion: mergedTokenVersion,
            extensionID: mergedExtensionID,
            dexId: mergedDexId,
            flap_lp_fee_profile: mergedLpFeeProfile,
            flap_pool_model: mergedPoolModel,
            flap_pool_compat_address: mergedPoolCompatAddress,
            flap_cl_pool_id: mergedClPoolId,
            flap_v4_fee: mergedV4Fee,
            flap_v4_tick_spacing: mergedV4TickSpacing,
            flap_v4_hooks: mergedV4Hooks,
            flap_dividend_token: mergedDividendToken,
            flap_vault_address: mergedVaultAddress,
            flap_vault_factory: mergedVaultFactory,
            flap_vault_is_official: mergedVaultIsOfficial,
            flap_vault_is_ai_consumer: mergedVaultIsAIConsumer,
            flap_stocks_vault_version: mergedStocksVaultVersion,
            flap_basket_token: mergedBasketToken,
            flap_supported_assets: mergedSupportedAssets,
          } as TokenInfo;
          this.logFlapStocksRoute(debug, 'metadata.merged', {
            chainId,
            tokenAddress,
            onchainQuoteTokenAddress: onchainQuoteTokenAddress ?? null,
            onchainPoolPair: onchainPoolPair ?? null,
              officialQuoteTokenAddress: officialQuoteTokenAddress ?? null,
            officialPoolPair: officialInfo?.pool_pair ?? null,
            officialTpoolPoolAddress: officialInfo?.tpool_pool_address ?? null,
              tradeQuoteTokenAddress: tradeQuoteTokenAddress ?? null,
            tradePoolPair: tradeInfo?.pool_pair ?? null,
            tradeTpoolPoolAddress: tradeInfo?.tpool_pool_address ?? null,
            mergedQuoteTokenAddress: mergedInfo.quote_token_address ?? null,
            mergedPoolPair: mergedInfo.pool_pair ?? null,
            mergedBiggestPoolAddress: mergedInfo.biggest_pool_address ?? null,
            mergedTpoolPoolAddress: mergedInfo.tpool_pool_address ?? null,
            onchainLaunchpadStatus,
            officialLaunchpadStatus: Number.isFinite(officialLaunchpadStatus) ? officialLaunchpadStatus : null,
            tradeLaunchpadStatus: Number.isFinite(tradeLaunchpadStatus) ? tradeLaunchpadStatus : null,
            mergedLaunchpadStatus: mergedInfo.launchpad_status ?? null,
            mergedDexType: mergedInfo.dex_type ?? null,
            mergedLaunchpadPlatform: mergedInfo.launchpad_platform ?? null,
            mergedLaunchType: mergedInfo.tpool_launch_type ?? null,
            mergedLpFeeProfile: mergedInfo.flap_lp_fee_profile ?? null,
            mergedDexId: mergedInfo.dexId ?? null,
            mergedPoolModel: mergedInfo.flap_pool_model ?? null,
            mergedPoolCompatAddress: mergedInfo.flap_pool_compat_address ?? null,
            mergedClPoolId: mergedInfo.flap_cl_pool_id ?? null,
            mergedV4Fee: mergedInfo.flap_v4_fee ?? null,
            mergedV4TickSpacing: mergedInfo.flap_v4_tick_spacing ?? null,
            mergedV4Hooks: mergedInfo.flap_v4_hooks ?? null,
            mergedDividendToken: mergedInfo.flap_dividend_token ?? null,
            mergedVaultFactory: mergedInfo.flap_vault_factory ?? null,
            mergedBasketToken: mergedInfo.flap_basket_token ?? null,
          });
          return mergedInfo;
        }

        this.logFlapStocksRoute(debug, 'metadata.empty', {
          chainId,
          tokenAddress,
          onchainQuoteTokenAddress: onchainQuoteTokenAddress ?? null,
          onchainPoolPair: onchainPoolPair ?? null,
          officialQuoteTokenAddress: officialInfo?.quote_token_address ?? null,
          officialPoolPair: officialInfo?.pool_pair ?? null,
          officialTpoolPoolAddress: officialInfo?.tpool_pool_address ?? null,
          tradeQuoteTokenAddress: tradeInfo?.quote_token_address ?? null,
          tradePoolPair: tradeInfo?.pool_pair ?? null,
          tradeTpoolPoolAddress: tradeInfo?.tpool_pool_address ?? null,
        });
        return tradeInfo;
      })();
      this.flapOuterQuoteInfoCache.set(key, task);
    }
    return await task;
  }

  private static async getKnownPoolRouteMeta(
    chainId: number,
    poolAddress: Address,
    preferHint?: 'v2' | 'v3' | null
  ): Promise<{ prefer: 'v2' | 'v3'; fee?: number } | null> {
    const key = `${chainId}:${poolAddress.toLowerCase()}:${preferHint ?? 'auto'}`;
    let task = this.flapKnownPoolMetaCache.get(key);
    if (!task) {
      task = (async () => {
        const client = await RpcService.getClient(chainId);
        try {
          const fee = Number(await client.readContract({
            address: poolAddress,
            abi: poolV3Abi,
            functionName: 'fee',
          }));
          if (Number.isFinite(fee) && fee > 0) {
            return { prefer: 'v3' as const, fee };
          }
        } catch {
        }
        if (preferHint === 'v3') {
          return { prefer: 'v3' as const, fee: getDefaultBridgeV3Fee(chainId) };
        }
        return { prefer: 'v2' as const };
      })();
      this.flapKnownPoolMetaCache.set(key, task);
    }
    return await task;
  }

  private static async resolveKnownPoolRouteDesc(input: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    poolAddress: Address;
    preferHint?: 'v2' | 'v3' | null;
  }): Promise<SwapDescLike> {
    const meta = await this.getKnownPoolRouteMeta(input.chainId, input.poolAddress, input.preferHint);
    if (!meta) {
      throw new Error(`找不到 ${input.tokenIn}/${input.tokenOut} 的交易池`);
    }
    return getRouterSwapDesc({
      swapType: meta.prefer === 'v3' ? SwapType.V3_EXACT_IN : SwapType.V2_EXACT_IN,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      poolAddress: input.poolAddress,
      fee: meta.prefer === 'v3' ? (meta.fee ?? getDefaultBridgeV3Fee(input.chainId)) : 0,
    });
  }

  private static isFlapOuterRouteTerminalToken(chainId: number, tokenAddress: Address): boolean {
    const lower = tokenAddress.toLowerCase();
    if (lower === ZERO_ADDRESS.toLowerCase()) return true;
    if (lower === getChainRuntime(chainId).wrappedNativeAddress.toLowerCase()) return true;
    return getBridgeTokenAddresses(chainId as ChainId).some((x) => x.toLowerCase() === lower);
  }

  private static normalizeFlapQuoteTokenAddress(chainId: number, quoteTokenAddress?: string): Address | null {
    const raw = typeof quoteTokenAddress === 'string' ? quoteTokenAddress.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    const normalized = raw.toLowerCase();
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (normalized === ZERO_ADDRESS.toLowerCase() || normalized === wrappedNative) return null;
    return raw as Address;
  }

  private static normalizeDexPrefer(dexType?: string): 'v2' | 'v3' | null {
    const prefer = dexType ? getDexPoolPrefer(dexType) : null;
    return prefer === 'v2' || prefer === 'v3' ? prefer : null;
  }

  private static mapDexScreenerPairDexType(pair: DexScreenerPair | null | undefined): string | undefined {
    if (!pair) return undefined;
    const labels = Array.isArray(pair.labels) ? pair.labels.map((item) => String(item).toLowerCase()) : [];
    if (labels.some((item) => item.includes('v3') || item.includes('cl'))) {
      return 'PANCAKE_SWAP_V3';
    }
    return 'PANCAKE_SWAP';
  }

  private static getDexScreenerCounterpartyToken(pair: DexScreenerPair, tokenAddress: Address): Address | null {
    const tokenLower = tokenAddress.toLowerCase();
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    if (isAddressLike(base) && base.toLowerCase() !== tokenLower) return base as Address;
    if (isAddressLike(quote) && quote.toLowerCase() !== tokenLower) return quote as Address;
    return null;
  }

  private static async getDexScreenerOuterQuoteFallback(input: {
    chain: string;
    chainId: number;
    tokenAddress: Address;
    preferredQuoteToken?: Address | null;
  }): Promise<{ quoteTokenAddress?: Address; poolPair?: Address; dexType?: string } | null> {
    if (input.chainId !== ChainId.BNB) return null;

    const candidates = [
      input.preferredQuoteToken ?? null,
      this.getDefaultFlapStocksBridgeToken(input.chainId),
      ...this.getQuoteBridgeCandidates(input.chainId, input.tokenAddress, ZERO_ADDRESS),
    ].filter((value, index, list): value is Address => {
      if (!value || !isAddressLike(value)) return false;
      const lowered = value.toLowerCase();
      if (lowered === input.tokenAddress.toLowerCase()) return false;
      return list.findIndex((item) => String(item || '').toLowerCase() === lowered) === index;
    });

    const pairs = (await Promise.all(candidates.map(async (quoteTokenAddress) => {
      const pair = await DexScreenerAPI.getBestPairBetweenTokens(input.chain, input.tokenAddress, quoteTokenAddress).catch(() => null);
      if (!pair?.pairAddress || !isAddressLike(pair.pairAddress)) return null;
      const counterparty = this.getDexScreenerCounterpartyToken(pair, input.tokenAddress);
      if (!counterparty) return null;
      return { pair, counterparty };
    }))).filter(Boolean) as Array<{ pair: DexScreenerPair; counterparty: Address }>;

    const best = pairs.sort((a, b) => Number(b.pair.liquidity?.usd ?? 0) - Number(a.pair.liquidity?.usd ?? 0))[0];
    if (!best) return null;

    return {
      quoteTokenAddress: best.counterparty,
      poolPair: best.pair.pairAddress as Address,
      dexType: this.mapDexScreenerPairDexType(best.pair),
    };
  }

  private static async getPreferredFlapOuterTargetPool(input: {
    chainId: number;
    tokenAddress: Address;
    quoteTokenAddress: Address;
    tokenInfo?: Pick<TokenInfo, 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address' | 'dex_type'> | null;
    debug?: boolean;
    logEvent?: string;
  }): Promise<{ poolAddress: Address | null; preferHint: 'v2' | 'v3' | null; fee?: number }> {
    const fallbackPool = this.getKnownDexPoolAddress(input.tokenInfo);
    const fallbackPrefer = this.normalizeDexPrefer(input.tokenInfo?.dex_type);
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();

    if (chain) {
      const dexPair = await DexScreenerAPI.getBestPairBetweenTokens(chain, input.tokenAddress, input.quoteTokenAddress).catch(() => null);
      if (dexPair?.pairAddress && isAddressLike(dexPair.pairAddress)) {
        const pairAddress = dexPair.pairAddress as Address;
        const pairPrefer = this.normalizeDexPrefer(this.mapDexScreenerPairDexType(dexPair));
        const pairMeta = await this.getKnownPoolRouteMeta(input.chainId, pairAddress, pairPrefer);
        this.logFlapStocksRoute(input.debug, input.logEvent ?? 'target.pool.selected', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          quoteTokenAddress: input.quoteTokenAddress,
          source: 'dexscreener',
          poolAddress: pairAddress,
          prefer: pairMeta?.prefer ?? pairPrefer ?? null,
          fee: pairMeta?.fee ?? null,
          fallbackPool: fallbackPool ?? null,
          fallbackPrefer: fallbackPrefer ?? null,
        });
        return {
          poolAddress: pairAddress,
          preferHint: pairMeta?.prefer ?? pairPrefer,
          fee: pairMeta?.fee,
        };
      }
    }

    const fallbackMeta = fallbackPool
      ? await this.getKnownPoolRouteMeta(input.chainId, fallbackPool, fallbackPrefer)
      : null;
    this.logFlapStocksRoute(input.debug, input.logEvent ?? 'target.pool.selected', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      quoteTokenAddress: input.quoteTokenAddress,
      source: fallbackPool ? 'token_info' : 'none',
      poolAddress: fallbackPool ?? null,
      prefer: fallbackMeta?.prefer ?? fallbackPrefer ?? null,
      fee: fallbackMeta?.fee ?? null,
    });
    return {
      poolAddress: fallbackPool,
      preferHint: fallbackMeta?.prefer ?? fallbackPrefer,
      fee: fallbackMeta?.fee,
    };
  }

  private static getPreferredDexCounterpartyCandidates(chainId: number, baseTokenAddress: Address): Address[] {
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress as Address;
    const normalizedBase = baseTokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      ? wrappedNative
      : baseTokenAddress;
    const all = [normalizedBase, ...getBridgeTokenAddresses(chainId as ChainId)] as Address[];
    const out: Address[] = [];
    const seen = new Set<string>();
    for (const token of all) {
      const lowered = token.toLowerCase();
      if (seen.has(lowered)) continue;
      seen.add(lowered);
      out.push(token);
    }
    return out;
  }

  private static async buildDexTokenInfoFromDexScreener(input: {
    chainId: number;
    tokenAddress: Address;
    baseTokenAddress: Address;
    debug?: boolean;
  }): Promise<TokenInfo | undefined> {
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return undefined;

    const preferredCounterparties = this.getPreferredDexCounterpartyCandidates(input.chainId, input.baseTokenAddress);
    const tokenLower = input.tokenAddress.toLowerCase();
    const pairs = await DexScreenerAPI.getPairsByToken(chain, input.tokenAddress).catch(() => []);
    if (!pairs.length) {
      this.logFlapStocksRoute(input.debug, 'dex.token_info.missing_pairs', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
      });
      return undefined;
    }

    const candidates = pairs
      .map((pair) => {
        const counterparty = this.getDexScreenerCounterpartyToken(pair, input.tokenAddress);
        const baseAddr = String(pair.baseToken?.address || '').toLowerCase();
        const quoteAddr = String(pair.quoteToken?.address || '').toLowerCase();
        const tokenRef = baseAddr === tokenLower ? pair.baseToken : quoteAddr === tokenLower ? pair.quoteToken : null;
        const candidateIndex = counterparty
          ? preferredCounterparties.findIndex((item) => item.toLowerCase() === counterparty.toLowerCase())
          : -1;
        return {
          pair,
          counterparty,
          tokenRef,
          priority: candidateIndex >= 0 ? candidateIndex : Number.MAX_SAFE_INTEGER,
          liquidity: Number(pair.liquidity?.usd ?? 0),
        };
      })
      .filter((item) => item.counterparty && item.tokenRef);

    const sortDexCandidates = (a: typeof candidates[number], b: typeof candidates[number]) => {
      if (a.liquidity !== b.liquidity) return b.liquidity - a.liquidity;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const marketCapDiff = Number(b.pair.marketCap ?? b.pair.fdv ?? 0) - Number(a.pair.marketCap ?? a.pair.fdv ?? 0);
      if (marketCapDiff !== 0) return marketCapDiff;
      return Number(b.pair.pairCreatedAt ?? 0) - Number(a.pair.pairCreatedAt ?? 0);
    };

    const preferredCandidates = candidates.filter((item) => item.priority !== Number.MAX_SAFE_INTEGER);
    const selected = (preferredCandidates.length ? preferredCandidates : candidates)
      .sort(sortDexCandidates)[0];

    if (!selected?.counterparty || !selected.tokenRef || !isAddressLike(selected.pair.pairAddress)) {
      this.logFlapStocksRoute(input.debug, 'dex.token_info.no_preferred_pair', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        pairCount: pairs.length,
      });
      return undefined;
    }

    const dexType = this.mapDexScreenerPairDexType(selected.pair);
    this.logFlapStocksRoute(input.debug, 'dex.token_info.selected', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      poolAddress: selected.pair.pairAddress,
      quoteTokenAddress: selected.counterparty,
      dexType: dexType ?? null,
      liquidityUsd: selected.liquidity,
      preferredCounterparty: selected.priority !== Number.MAX_SAFE_INTEGER,
      preferredPriority: selected.priority !== Number.MAX_SAFE_INTEGER ? selected.priority : null,
    });

    return {
      chain,
      address: input.tokenAddress,
      name: selected.tokenRef.name || '',
      symbol: selected.tokenRef.symbol || '',
      decimals: 18,
      logo: selected.pair.info?.imageUrl || '',
      launchpad: '',
      launchpad_progress: 0,
      launchpad_platform: '',
      launchpad_status: 1,
      quote_token: selected.counterparty.toLowerCase() === getChainRuntime(input.chainId).wrappedNativeAddress.toLowerCase()
        ? getNativeSymbol(input.chainId)
        : '',
      quote_token_address: selected.counterparty,
      pool_pair: selected.pair.pairAddress,
      biggest_pool_address: selected.pair.pairAddress,
      tpool_pool_address: selected.pair.pairAddress,
      dex_type: dexType,
      tokenPrice: {
        price: String(selected.pair.priceUsd ?? ''),
        marketCap: String(selected.pair.marketCap ?? selected.pair.fdv ?? ''),
        liquidity: String(selected.pair.liquidity?.usd ?? ''),
        timestamp: Date.now(),
      },
      totalSupply: undefined,
    };
  }

  private static isFlapCompatPoolAddress(poolAddress?: string | null): boolean {
    if (!isAddressLike(poolAddress)) return false;
    const normalized = poolAddress.toLowerCase();
    const bnbContracts = DeployAddress[ChainId.BNB];
    const poolManager = bnbContracts?.[ContractNames.PoolManager]?.address?.toLowerCase();
    const infinityVault = bnbContracts?.[ContractNames.PancakeInfinityVault]?.address?.toLowerCase();
    return normalized === poolManager || normalized === infinityVault;
  }

  private static getKnownDexPoolAddress(tokenInfo?: Pick<TokenInfo, 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null): Address | null {
    const candidate = tokenInfo?.pool_pair || tokenInfo?.biggest_pool_address || tokenInfo?.tpool_pool_address;
    if (this.isFlapCompatPoolAddress(candidate)) return null;
    return isAddressLike(candidate) ? candidate as Address : null;
  }

  private static logFlapStocksRoute(debug: boolean | undefined, event: string, payload: Record<string, unknown>) {
    if (!debug) return;
    console.info(`[trade.flapstocks.route][${event}]`, payload);
  }

  private static makeFlapOuterBuyQuoteRouteCacheKey(chainId: number, currentToken: Address, targetToken: Address) {
    return [
      chainId,
      currentToken.toLowerCase(),
      targetToken.toLowerCase(),
    ].join(':');
  }

  private static makeFlapOuterSellQuoteRouteCacheKey(chainId: number, currentToken: Address, targetToken: Address) {
    return [
      chainId,
      currentToken.toLowerCase(),
      targetToken.toLowerCase(),
    ].join(':');
  }

  private static cloneSwapDescLikeArray(descs: SwapDescLike[] | null): SwapDescLike[] | null {
    if (!descs) return null;
    return descs.map((desc) => ({ ...desc }));
  }

  private static makeFlapPoolCounterpartyCacheKey(chainId: number, poolAddress: Address, tokenAddress: Address) {
    return [
      chainId,
      poolAddress.toLowerCase(),
      tokenAddress.toLowerCase(),
    ].join(':');
  }

  private static async buildFlapOuterBuyQuoteRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    visited?: Set<string>;
    debug?: boolean;
    depth?: number;
    skipCache?: boolean;
  }): Promise<SwapDescLike[] | null> {
    const { chainId, currentToken, targetToken } = input;
    const debug = input.debug === true;
    const depth = input.depth ?? 0;
    const useCache = input.skipCache !== true && !input.visited && depth === 0;
    if (useCache) {
      const cacheKey = this.makeFlapOuterBuyQuoteRouteCacheKey(chainId, currentToken, targetToken);
      const cached = this.flapOuterBuyQuoteRouteCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.flapOuterBuyQuoteRouteCacheMs) {
        this.logFlapStocksRoute(debug, 'buy.route.cache_hit', {
          chainId,
          currentToken,
          targetToken,
          cached: cached.value?.length ?? 0,
        });
        return this.cloneSwapDescLikeArray(cached.value);
      }
      const inflight = this.flapOuterBuyQuoteRouteInFlight.get(cacheKey);
      if (inflight) {
        this.logFlapStocksRoute(debug, 'buy.route.cache_await', {
          chainId,
          currentToken,
          targetToken,
        });
        return this.cloneSwapDescLikeArray(await inflight);
      }
      const task = this.buildFlapOuterBuyQuoteRoute({
        ...input,
        skipCache: true,
      }).then((result) => {
          if (result?.length) {
            this.flapOuterBuyQuoteRouteCache.set(cacheKey, {
              ts: Date.now(),
              value: this.cloneSwapDescLikeArray(result),
            });
          }
        return result;
      }).finally(() => {
        this.flapOuterBuyQuoteRouteInFlight.delete(cacheKey);
      });
      this.flapOuterBuyQuoteRouteInFlight.set(cacheKey, task);
      this.logFlapStocksRoute(debug, 'buy.route.cache_miss', {
        chainId,
        currentToken,
        targetToken,
      });
      return this.cloneSwapDescLikeArray(await task);
    }
    if (currentToken.toLowerCase() === targetToken.toLowerCase()) return [];
    if (this.isFlapOuterRouteTerminalToken(chainId, targetToken)) {
      this.logFlapStocksRoute(debug, 'buy.route.terminal', {
        chainId,
        depth,
        currentToken,
        targetToken,
      });
      return [await this.resolveRouteHopDesc({
        chainId,
        tokenIn: currentToken,
        tokenOut: targetToken,
        prefer: getBridgeTokenDexPreference(chainId as ChainId, targetToken) ?? null,
      })];
    }
    let targetInfo = await this.getFlapOuterQuoteTokenInfo(chainId, targetToken, debug);
    if (!targetInfo) {
      targetInfo = await this.buildDexTokenInfoFromDexScreener({
        chainId,
        tokenAddress: targetToken,
        baseTokenAddress: currentToken,
        debug,
      }) ?? null;
    }
    if (!targetInfo) {
      this.logFlapStocksRoute(debug, 'buy.route.no_metadata', {
        chainId,
        depth,
        currentToken,
        targetToken,
      });
      return null;
    }

    let targetPoolPair = this.getKnownDexPoolAddress(targetInfo);
    let targetPoolPrefer = this.normalizeDexPrefer(targetInfo?.dex_type);
    if (!targetPoolPair) {
      const knownV4Route = await this.buildKnownFlapOuterV4BuyRoute({
        chainId,
        currentToken,
        targetToken,
        targetInfo,
        debug,
        depth,
      });
      if (knownV4Route?.length) {
        return knownV4Route;
      }
      const targetPlatform = resolveTradeLaunchpadPlatform(targetInfo);
      const innerLaunchpadDesc = this.buildKnownLaunchpadBuyRouteDesc({
        chainId,
        tokenIn: currentToken,
        tokenInfo: targetInfo,
      });
      if (innerLaunchpadDesc) {
        const routeQuoteToken = this.getLaunchpadQuoteRouterToken(chainId, targetInfo, targetPlatform, null, {
          preferRuntimeQuote: true,
        }) ?? this.normalizeFlapQuoteTokenAddress(chainId, targetInfo.quote_token_address) ?? this.getDefaultFlapStocksBridgeToken(chainId);
        this.logFlapStocksRoute(debug, 'buy.route.inner_launchpad', {
          chainId,
          depth,
          currentToken,
          targetToken,
          targetLaunchpadPlatform: targetInfo.launchpad_platform ?? null,
          targetLaunchpadStatus: targetInfo.launchpad_status ?? null,
          routeQuoteToken: routeQuoteToken ?? null,
        });
        const descs: SwapDescLike[] = [];
        let routeCurrentToken = currentToken;
        if (routeQuoteToken && routeQuoteToken.toLowerCase() !== currentToken.toLowerCase()) {
          if (!this.isFlapOuterRouteTerminalToken(chainId, routeQuoteToken)) {
            this.logFlapStocksRoute(debug, 'buy.route.inner_non_terminal_quote', {
              chainId,
              depth,
              currentToken,
              targetToken,
              routeQuoteToken,
            });
            return null;
          }
          descs.push(await this.resolveRouteHopDesc({
            chainId,
            tokenIn: currentToken,
            tokenOut: routeQuoteToken,
            prefer: getBridgeTokenDexPreference(chainId as ChainId, routeQuoteToken) ?? null,
          }));
          routeCurrentToken = routeQuoteToken;
        }
        descs.push({
          ...innerLaunchpadDesc,
          tokenIn: routeCurrentToken,
        });
        return descs;
      }
      const dexTargetInfo = await this.buildDexTokenInfoFromDexScreener({
        chainId,
        tokenAddress: targetToken,
        baseTokenAddress: currentToken,
        debug,
      });
      if (dexTargetInfo) {
        targetInfo = dexTargetInfo;
        targetPoolPair = this.getKnownDexPoolAddress(targetInfo);
        targetPoolPrefer = this.normalizeDexPrefer(targetInfo?.dex_type);
      }
    }
    if (!targetPoolPair) {
      this.logFlapStocksRoute(debug, 'buy.route.no_target_pool', {
        chainId,
        depth,
        currentToken,
        targetToken,
        targetLaunchpadPlatform: targetInfo.launchpad_platform ?? null,
        targetLaunchpadStatus: targetInfo.launchpad_status ?? null,
      });
      return null;
    }

    const metadataQuote = this.normalizeFlapPoolCounterpartyToken(chainId, targetInfo?.quote_token_address);
    const poolCounterparty = this.getCachedPoolCounterpartyToken(chainId, targetPoolPair, targetToken);
    const defaultBridgeToken = this.getDefaultFlapStocksBridgeToken(chainId);
    const bridgeToken = poolCounterparty ?? metadataQuote ?? defaultBridgeToken;
    this.logFlapStocksRoute(debug, 'buy.route.step', {
      chainId,
      depth,
      currentToken,
      targetToken,
      targetQuote: metadataQuote ?? null,
      poolCounterparty: poolCounterparty ?? null,
      defaultBridgeToken: defaultBridgeToken ?? null,
      bridgeToken: bridgeToken ?? null,
      targetPoolPair,
      targetBiggestPoolAddress: targetInfo.biggest_pool_address ?? null,
      targetTpoolPoolAddress: targetInfo.tpool_pool_address ?? null,
      targetDexType: targetInfo.dex_type ?? null,
      targetLaunchpadPlatform: targetInfo.launchpad_platform ?? null,
      targetLaunchType: targetInfo.tpool_launch_type ?? null,
      targetDividendToken: targetInfo.flap_dividend_token ?? null,
      targetVaultFactory: targetInfo.flap_vault_factory ?? null,
      targetBasketToken: targetInfo.flap_basket_token ?? null,
    });

    const descs: SwapDescLike[] = [];
    let routeCurrentToken = currentToken;
    if (bridgeToken && bridgeToken.toLowerCase() !== currentToken.toLowerCase()) {
      if (!this.isFlapOuterRouteTerminalToken(chainId, bridgeToken)) {
        this.logFlapStocksRoute(debug, 'buy.route.non_terminal_bridge', {
          chainId,
          depth,
          currentToken,
          targetToken,
          bridgeToken,
        });
        return null;
      }
      descs.push(await this.resolveRouteHopDesc({
        chainId,
        tokenIn: currentToken,
        tokenOut: bridgeToken,
        prefer: getBridgeTokenDexPreference(chainId as ChainId, bridgeToken) ?? null,
      }));
      routeCurrentToken = bridgeToken;
    }

    if (routeCurrentToken.toLowerCase() === targetToken.toLowerCase()) {
      return descs;
    }

    if (!bridgeToken) {
      this.logFlapStocksRoute(debug, 'buy.route.bridge_missing', {
        chainId,
        depth,
        currentToken,
        targetToken,
        targetPoolPair,
      });
      return null;
    }

    this.logFlapStocksRoute(debug, 'buy.route.direct_pool', {
      chainId,
      depth,
      currentToken: routeCurrentToken,
      targetToken,
      targetPoolPair,
      targetPoolPrefer: targetPoolPrefer ?? null,
      bridgeToken: bridgeToken ?? null,
    });
    descs.push(await this.resolveKnownPoolRouteDesc({
      chainId,
      tokenIn: routeCurrentToken,
      tokenOut: targetToken,
      poolAddress: targetPoolPair,
      preferHint: targetPoolPrefer,
    }));
    return descs;
  }

  private static async buildFlapOuterSellQuoteRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    debug?: boolean;
  }): Promise<SwapDescLike[] | null> {
    const { chainId, currentToken, targetToken } = input;
    const debug = input.debug === true;
    const cacheKey = this.makeFlapOuterSellQuoteRouteCacheKey(chainId, currentToken, targetToken);
    const cached = this.flapOuterSellQuoteRouteCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.flapOuterBuyQuoteRouteCacheMs) {
      this.logFlapStocksRoute(debug, 'sell.route.cache_hit', {
        chainId,
        currentToken,
        targetToken,
        cached: cached.value?.length ?? 0,
      });
      return this.cloneSwapDescLikeArray(cached.value);
    }
    const inflight = this.flapOuterSellQuoteRouteInFlight.get(cacheKey);
    if (inflight) {
      this.logFlapStocksRoute(debug, 'sell.route.cache_await', {
        chainId,
        currentToken,
        targetToken,
      });
      return this.cloneSwapDescLikeArray(await inflight);
    }

    const task = (async () => {
    if (currentToken.toLowerCase() === targetToken.toLowerCase()) return [];
    if (this.isFlapOuterRouteTerminalToken(chainId, currentToken)) {
      this.logFlapStocksRoute(debug, 'sell.route.terminal', {
        chainId,
        currentToken,
        targetToken,
      });
      return [await this.resolveRouteHopDesc({
        chainId,
        tokenIn: currentToken,
        tokenOut: targetToken,
        prefer: getBridgeTokenDexPreference(chainId as ChainId, currentToken) ?? null,
      })];
    }
    let currentInfo = await this.getFlapOuterQuoteTokenInfo(chainId, currentToken);
    if (!currentInfo) {
      currentInfo = await this.buildDexTokenInfoFromDexScreener({
        chainId,
        tokenAddress: currentToken,
        baseTokenAddress: targetToken,
        debug,
      }) ?? null;
    }
    if (!currentInfo) {
      this.logFlapStocksRoute(debug, 'sell.route.no_metadata', {
        chainId,
        currentToken,
        targetToken,
      });
      return null;
    }
    let currentPoolPair = this.getKnownDexPoolAddress(currentInfo);
    let currentPoolPrefer = this.normalizeDexPrefer(currentInfo?.dex_type);
    if (!currentPoolPair) {
      const knownV4Route = await this.buildKnownFlapOuterV4SellRoute({
        chainId,
        currentToken,
        targetToken,
        currentInfo,
        debug,
      });
      if (knownV4Route?.length) {
        return knownV4Route;
      }
      const dexCurrentInfo = await this.buildDexTokenInfoFromDexScreener({
        chainId,
        tokenAddress: currentToken,
        baseTokenAddress: targetToken,
        debug,
      });
      if (dexCurrentInfo) {
        currentInfo = dexCurrentInfo;
        currentPoolPair = this.getKnownDexPoolAddress(currentInfo);
        currentPoolPrefer = this.normalizeDexPrefer(currentInfo?.dex_type);
      }
    }
    if (!currentPoolPair) {
      this.logFlapStocksRoute(debug, 'sell.route.no_current_pool', {
        chainId,
        currentToken,
        targetToken,
        currentLaunchpadPlatform: currentInfo.launchpad_platform ?? null,
      });
      return null;
    }

    const metadataQuote = this.normalizeFlapPoolCounterpartyToken(chainId, currentInfo?.quote_token_address);
    const poolCounterparty = this.getCachedPoolCounterpartyToken(chainId, currentPoolPair, currentToken);
    const defaultBridgeToken = this.getDefaultFlapStocksBridgeToken(chainId);
    const bridgeToken = poolCounterparty ?? metadataQuote ?? defaultBridgeToken;
    this.logFlapStocksRoute(debug, 'sell.route.step', {
      chainId,
      currentToken,
      targetToken,
      currentQuote: metadataQuote ?? null,
      poolCounterparty: poolCounterparty ?? null,
      defaultBridgeToken: defaultBridgeToken ?? null,
      bridgeToken: bridgeToken ?? null,
      currentPoolPair,
      currentPoolPrefer: currentPoolPrefer ?? null,
    });
    if (!bridgeToken) {
      this.logFlapStocksRoute(debug, 'sell.route.bridge_missing', {
        chainId,
        currentToken,
        targetToken,
        currentPoolPair,
      });
      return null;
    }

    const descs: SwapDescLike[] = [];
    if (currentToken.toLowerCase() !== bridgeToken.toLowerCase()) {
      descs.push(await this.resolveKnownPoolRouteDesc({
        chainId,
        tokenIn: currentToken,
        tokenOut: bridgeToken,
        poolAddress: currentPoolPair,
        preferHint: currentPoolPrefer,
      }));
    }
    if (bridgeToken.toLowerCase() === targetToken.toLowerCase()) {
      return descs;
    }
    if (!this.isFlapOuterRouteTerminalToken(chainId, bridgeToken)) {
      const nextRoute = await this.buildFlapOuterSellQuoteRoute({
        chainId,
        currentToken: bridgeToken,
        targetToken,
        debug,
      });
      if (!nextRoute?.length) {
        this.logFlapStocksRoute(debug, 'sell.route.non_terminal_bridge', {
          chainId,
          currentToken,
          targetToken,
          bridgeToken,
        });
        return null;
      }
      descs.push(...nextRoute);
      return descs;
    }
    descs.push(await this.resolveRouteHopDesc({
      chainId,
      tokenIn: bridgeToken,
      tokenOut: targetToken,
      prefer: getBridgeTokenDexPreference(chainId as ChainId, bridgeToken) ?? null,
    }));
    return descs;
    })().then((result) => {
      if (result?.length) {
        this.flapOuterSellQuoteRouteCache.set(cacheKey, {
          ts: Date.now(),
          value: this.cloneSwapDescLikeArray(result),
        });
      }
      return result;
    }).finally(() => {
      this.flapOuterSellQuoteRouteInFlight.delete(cacheKey);
    });
    this.flapOuterSellQuoteRouteInFlight.set(cacheKey, task);
    this.logFlapStocksRoute(debug, 'sell.route.cache_miss', {
      chainId,
      currentToken,
      targetToken,
    });
    return this.cloneSwapDescLikeArray(await task);
  }

  private static async resolveRouteHopDesc(input: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    prefer?: 'v2' | 'v3' | null;
    poolPair?: string;
    v3Fee?: number;
    forceDexExact?: boolean;
  }): Promise<SwapDescLike> {
    const { chainId, tokenIn, tokenOut, prefer = null, poolPair, v3Fee, forceDexExact = false } = input;
    const isBridgeLike =
      tokenIn.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      || tokenOut.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      || getBridgeTokenAddresses(chainId as ChainId).some((x) => x.toLowerCase() === tokenIn.toLowerCase())
      || getBridgeTokenAddresses(chainId as ChainId).some((x) => x.toLowerCase() === tokenOut.toLowerCase());

    const q = !forceDexExact && isBridgeLike
      ? await resolveBridgeHopExactIn(chainId, tokenIn, tokenOut, 1n, prefer, true, false)
      : await resolveDexExactIn(
        chainId,
        tokenIn,
        tokenOut,
        1n,
        {
          poolPair,
          v3Fee,
          prefer: prefer ?? undefined,
        },
        true,
        false
      );

    if (!q.poolAddress || q.poolAddress === ZERO_ADDRESS) {
      throw new Error(`找不到 ${tokenIn}/${tokenOut} 的交易池`);
    }

    return getRouterSwapDesc({
      swapType: q.swapType,
      tokenIn,
      tokenOut,
      poolAddress: q.poolAddress,
      fee: getV3FeeForDesc(q, v3Fee ?? getDefaultBridgeV3Fee(chainId)),
    });
  }

  private static async resolveQuoteRouteToToken(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    amountIn: bigint;
    isTurbo: boolean;
  }): Promise<{ descs: SwapDescLike[]; amountOut: bigint; finalToken: Address } | null> {
    const { chainId, currentToken, targetToken, amountIn, isTurbo } = input;
    if (currentToken.toLowerCase() === targetToken.toLowerCase()) {
      return { descs: [], amountOut: amountIn, finalToken: targetToken };
    }

    let bestPlan: { descs: SwapDescLike[]; amountOut: bigint; finalToken: Address } | null = null;
    const considerPlan = (plan: { descs: SwapDescLike[]; amountOut: bigint; finalToken: Address } | null) => {
      if (!plan) return;
      if (isTurbo) {
        if (!bestPlan) bestPlan = plan;
        return;
      }
      if (!bestPlan || plan.amountOut > bestPlan.amountOut) {
        bestPlan = plan;
      }
    };

    const direct = await this.resolveAdaptiveDexHop(chainId, currentToken, targetToken, amountIn, isTurbo);
    if (this.isUsableDexQuote(direct, isTurbo)) {
      considerPlan({
        descs: [getRouterSwapDesc({
          swapType: direct.swapType,
          tokenIn: currentToken,
          tokenOut: targetToken,
          poolAddress: direct.poolAddress,
          fee: getV3FeeForDesc(direct, getDefaultBridgeV3Fee(chainId)),
        })],
        amountOut: isTurbo ? 0n : direct.amountOut,
        finalToken: targetToken,
      });
    }

    for (const bridgeToken of this.getQuoteBridgeCandidates(chainId, currentToken, targetToken)) {
      let hop1Amount = amountIn;
      const descs: SwapDescLike[] = [];

      if (currentToken.toLowerCase() !== bridgeToken.toLowerCase()) {
        const hop1 = await this.resolveAdaptiveDexHop(chainId, currentToken, bridgeToken, amountIn, isTurbo);
        if (!this.isUsableDexQuote(hop1, isTurbo)) continue;
        descs.push(getRouterSwapDesc({
          swapType: hop1.swapType,
          tokenIn: currentToken,
          tokenOut: bridgeToken,
          poolAddress: hop1.poolAddress,
          fee: getV3FeeForDesc(hop1, getDefaultBridgeV3Fee(chainId)),
        }));
        hop1Amount = isTurbo ? 1n : hop1.amountOut;
      }

      const hop2 = await resolveDexExactIn(
        chainId,
        bridgeToken,
        targetToken,
        hop1Amount,
        { prefer: getBridgeTokenDexPreference(chainId as ChainId, bridgeToken) ?? undefined },
        isTurbo,
        !isTurbo
      );
      if (!this.isUsableDexQuote(hop2, isTurbo)) continue;

      descs.push(getRouterSwapDesc({
        swapType: hop2.swapType,
        tokenIn: bridgeToken,
        tokenOut: targetToken,
        poolAddress: hop2.poolAddress,
        fee: getV3FeeForDesc(hop2, getDefaultBridgeV3Fee(chainId)),
      }));

      considerPlan({
        descs,
        amountOut: isTurbo ? 0n : hop2.amountOut,
        finalToken: targetToken,
      });
    }

    return bestPlan;
  }

  private static resolveNativeAmountWei(input: TxBuyInput): string {
    const raw = (typeof input.nativeAmountWei === 'string' && input.nativeAmountWei.trim())
      ? input.nativeAmountWei
      : input.bnbAmountWei;
    return String(raw || '0').trim();
  }

  private static resolvePriorityFeeNative(input: TxBuyInput | TxSellInput): string | undefined {
    if (input.submitChannel === 'protectRpcs' || input.submitChannel === 'mixed') return '0';
    const v = (typeof (input as any).priorityFeeNative === 'string' && (input as any).priorityFeeNative.trim())
      ? (input as any).priorityFeeNative
      : (typeof input.priorityFeeBnb === 'string' ? input.priorityFeeBnb : '');
    const t = String(v || '').trim();
    return t || undefined;
  }

  private static resolveEvmAddress(address: string, field = 'address'): `0x${string}` {
    const raw = String(address || '').trim();
    if (!raw || !isAddress(raw)) throw new Error(`Invalid ${field}`);
    return raw as `0x${string}`;
  }

  private static resolveOptionalEvmAddress(address?: string, field = 'address'): `0x${string}` | undefined {
    const raw = typeof address === 'string' ? address.trim() : '';
    if (!raw) return undefined;
    return this.resolveEvmAddress(raw, field);
  }

  private static resolveBaseTokenAddress(_chainId: number, input: { baseTokenAddress?: string }): Address {
    const raw = typeof input.baseTokenAddress === 'string' ? input.baseTokenAddress.trim() : '';
    if (!raw || raw.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return ZERO_ADDRESS;
    return this.resolveEvmAddress(raw, 'base token address') as Address;
  }

  private static resolveBaseTokenSymbol(chainId: number, baseTokenAddress: Address): string {
    if (baseTokenAddress.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return getNativeSymbol(chainId);
    const wrapped = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (baseTokenAddress.toLowerCase() === wrapped) return `W${getNativeSymbol(chainId)}`;
    const usdc = USDC[chainId as keyof typeof USDC]?.address?.toLowerCase();
    if (usdc && baseTokenAddress.toLowerCase() === usdc) return 'USDC';
    const usdt = USDT[chainId as keyof typeof USDT]?.address?.toLowerCase();
    if (usdt && baseTokenAddress.toLowerCase() === usdt) return 'USDT';
    if (chainId === ChainId.BNB && baseTokenAddress.toLowerCase() === bscTokens.busd.address.toLowerCase()) return 'BUSD';
    if (chainId === ChainId.BNB && baseTokenAddress.toLowerCase() === bscTokens.usd1.address.toLowerCase()) return 'USD1';
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
    if (tradeBaseToken === 'USD1' && chainId === ChainId.BNB) {
      return bscTokens.usd1.address as Address;
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

    const fromAddress = this.resolveOptionalEvmAddress(input.fromAddress, 'from address');
    const account = await WalletService.getSigner(fromAddress);
    const client = await RpcService.getClient(input.chainId);

    const amountIn = BigInt(this.resolveNativeAmountWei(input));
    const configuredBaseTokenAddress = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
    const baseTokenAddress = (typeof input.baseTokenAddress === 'string' && input.baseTokenAddress.trim())
      ? this.resolveBaseTokenAddress(input.chainId, input)
      : configuredBaseTokenAddress;
    let tokenInfo: TokenInfo | null | undefined = input.tokenInfo;
    if (!tokenInfo) {
      tokenInfo = await this.buildDexTokenInfoFromDexScreener({
        chainId: input.chainId,
        tokenAddress: this.resolveEvmAddress(input.tokenAddress, 'token address') as Address,
        baseTokenAddress,
        debug: settings.ui?.consoleLogsEnabled === true,
      });
      if (tokenInfo) {
        input.tokenInfo = tokenInfo;
      }
    }
    if (!tokenInfo) throw new Error('Token info required');
    const baseTokenSymbol = this.resolveBaseTokenSymbol(input.chainId, baseTokenAddress);
    const baseFee = input.poolFee ?? 2500;
    const executionMode = input.executionModeOverride ?? settings.chains[input.chainId]?.executionMode ?? 'default';
    const isTurbo = executionMode === 'turbo';
    const consoleLogsEnabled = settings.ui?.consoleLogsEnabled === true;
    if (isTurbo) {
      const reusedPrewarm = this.turboPrewarmInFlight.has(this.makeTurboWarmKey({
        chainId: input.chainId,
        owner: account.address,
        tokenAddress: this.resolveEvmAddress(input.tokenAddress, 'token address') as Address,
        tokenInfo,
      }));
      if (reusedPrewarm && consoleLogsEnabled) {
        console.info('[trade.buy.prewarm.pending]', {
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

    const tokenOut = this.resolveEvmAddress(input.tokenAddress, 'token address') as Address;
    const launchpadPlatform = resolveTradeLaunchpadPlatform(tokenInfo);
    const isHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(launchpadPlatform);
    const openFourRuntime = (isHyperAltfun || !usesOpenFourRuntime(launchpadPlatform))
      ? null
      : await this.getOpenFourRuntimeState(client, input.chainId, tokenOut);
    const isInner = isHyperAltfun
      ? false
      : usesOpenFourRuntime(launchpadPlatform)
        ? !!openFourRuntime && openFourRuntime.phase === 1 && !openFourRuntime.paused
        : this.isInnerDisk(tokenInfo);
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId, openFourRuntime) : null;

    const bridgeToken = isHyperAltfun
      ? null
      : this.getLaunchpadQuoteRouterToken(input.chainId, tokenInfo, launchpadPlatform, openFourRuntime, {
        preferRuntimeQuote: isInner,
      });
    const rawQuoteToken = isHyperAltfun
      ? null
      : this.getLaunchpadRawQuoteToken(input.chainId, tokenInfo, launchpadPlatform, openFourRuntime, {
        preferRuntimeQuote: isInner,
      });
    const nativeToQuoteSwapEnabled = tokenInfo.nativeToQuoteSwapEnabled === true;
    const descs: SwapDescLike[] = [];
    let currentRouterToken: Address = baseTokenAddress;
    let currentAmount = amountIn;
    let minOut = 0n;

    if (isHyperAltfun) {
      const hyperState = await timeStep('hyper:state', () => getHyperTradeState(tokenOut, { force: runtimeOpts?.forceRefreshHyperState === true }));
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
        : await timeStep('quote:hyper:zap:buy', () => quoteHyperBuyFromUsdc(tokenOut, currentAmount));
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
      const isFlapStocks = this.isFlapStocksPlatform(launchpadPlatform, tokenInfo, input.chainId);
      const needsStocksQuoteRoute = !!rawQuoteToken && isFlapStocks && currentRouterToken.toLowerCase() !== rawQuoteToken.toLowerCase();
      const preferExactQuoteForStocks = false;
      const turboRouteMode = isTurbo && !preferExactQuoteForStocks;

      if (bridgeToken && currentRouterToken.toLowerCase() !== bridgeToken.toLowerCase()) {
        // Hop 1: [BaseToken] -> [Quote]
        const bridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken);
        const needAmountOut = !turboRouteMode;
        const q1 = await timeStep('quote:bridge', () =>
          resolveBridgeHopExactIn(
            input.chainId,
            currentRouterToken,
            bridgeToken,
            currentAmount,
            bridgePrefer,
            turboRouteMode,
            needAmountOut
          )
        );
        if (turboRouteMode) {
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
        currentAmount = turboRouteMode ? 1n : q1.amountOut;
      }

      // Hop 2: [BaseToken/Quote] -> Meme
      if (isInner && launchpadConfig) {
        const platform = launchpadPlatform;
        let dataForDesc: `0x${string}` = '0x';
        let feeForDesc = 0;
        let tickSpacingForDesc = 0;

        if (isFourMemePlatform(platform)) {
          const to = account.address as Address;
          const fundsForEstimate = currentRouterToken === ZERO_ADDRESS ? amountIn : currentAmount;
          let minAmount = 0n;
          if (!isTurbo) {
            try {
              const est = await timeStep('fourmeme:tryBuy', () =>
                tryFourMemeBuyEstimatedAmount(client, input.chainId, tokenOut, fundsForEstimate)
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
              token: tokenOut,
              to,
              funds: amountIn,
              minAmount,
            });
          } else {
            dataForDesc = encodeFourMemeUint256(minAmount);
          }
        }

        if (isOpenFourPlatform(platform)) {
          const openFourOptions = parseOpenFourOptions(input.openFourOptions);
          const openFourProof = input.openFourProof ?? '0x';
          if (!isTurbo) {
            const est = await timeStep('openfour:estimateBuyByBudget', () =>
              this.estimateOpenFourBuyByBudget(
                client,
                input.chainId,
                tokenOut,
                account.address as Address,
                currentAmount,
                openFourOptions,
                openFourProof
              )
            );
            if (!est || est.tokenAmount <= 0n) throw new Error('OpenFour 买入预估失败或当前不可交易');
            const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
            minOut = applySlippage(est.tokenAmount, slippageBps);
          }
          dataForDesc = encodeOpenFourSwapData(
            true,
            minOut,
            openFourOptions,
            openFourProof
          );
        }

        if (needsStocksQuoteRoute && !(currentRouterToken === ZERO_ADDRESS && nativeToQuoteSwapEnabled && !isFlapStocks)) {
          const shouldUseFixedStocksQuoteRoute = platform === 'flap' || platform === 'flap_stocks';
          if (turboRouteMode || shouldUseFixedStocksQuoteRoute) {
            const quoteRouteDescs = await timeStep('quote:flapstocks:buy:route', () =>
              this.buildFlapOuterBuyQuoteRoute({
                chainId: input.chainId,
                currentToken: currentRouterToken,
                targetToken: rawQuoteToken,
                debug: consoleLogsEnabled,
              })
            );
            if (!quoteRouteDescs?.length) {
              throw new Error(`找不到 ${baseTokenSymbol}/Flap Quote 的交易路径，当前 flap_stock 无法完成买入预处理`);
            }
            descs.push(...quoteRouteDescs);
            currentRouterToken = rawQuoteToken;
            currentAmount = 1n;
          } else {
            const quoteRoute = await timeStep('quote:flapstocks:buy', () =>
              this.resolveQuoteRouteToToken({
                chainId: input.chainId,
                currentToken: currentRouterToken,
                targetToken: rawQuoteToken,
                amountIn: currentAmount,
                isTurbo: false,
              })
            );
            if (!quoteRoute) {
              throw new Error(`找不到 ${baseTokenSymbol}/Flap Quote 的交易路径，当前 flap_stock 无法完成买入预处理`);
            }
            descs.push(...quoteRoute.descs);
            currentRouterToken = quoteRoute.finalToken;
            currentAmount = quoteRoute.amountOut;
          }
        }

        descs.push(getRouterSwapDesc({
          swapType: launchpadConfig.buyType,
          tokenIn: currentRouterToken,
          tokenOut,
          poolAddress: launchpadConfig.manager,
          fee: feeForDesc,
          tickSpacing: tickSpacingForDesc,
          data: dataForDesc,
        }));
      } else {
        if (needsStocksQuoteRoute) {
          this.logFlapStocksRoute(consoleLogsEnabled, 'buy.outer.start', {
            chainId: input.chainId,
            tokenAddress: tokenOut,
            baseTokenAddress: currentRouterToken,
            rawQuoteToken,
            launchpadPlatform,
            launchpadStatus: tokenInfo.launchpad_status ?? null,
            launchType: tokenInfo.tpool_launch_type ?? null,
            targetPoolPair: tokenInfo.pool_pair ?? null,
            targetBiggestPoolAddress: tokenInfo.biggest_pool_address ?? null,
            targetTpoolPoolAddress: tokenInfo.tpool_pool_address ?? null,
            executionMode,
          });
          const quoteRouteDescs = await timeStep('quote:flapstocks:outer:buy:route', () =>
            this.buildFlapOuterBuyQuoteRoute({
              chainId: input.chainId,
              currentToken: currentRouterToken,
              targetToken: rawQuoteToken,
              debug: consoleLogsEnabled,
            })
          );
          if (!quoteRouteDescs?.length) {
            throw new Error(`找不到 ${baseTokenSymbol}/Flap Quote 的交易路径，当前 flap_stock 无法完成买入预处理`);
          }
          descs.push(...quoteRouteDescs);
          currentRouterToken = rawQuoteToken;
          currentAmount = 1n;
        }

          const outerTargetPool = needsStocksQuoteRoute && rawQuoteToken
            ? await this.getPreferredFlapOuterTargetPool({
              chainId: input.chainId,
              tokenAddress: tokenOut,
              quoteTokenAddress: rawQuoteToken,
              tokenInfo,
              debug: consoleLogsEnabled,
              logEvent: 'buy.target_pool.selected',
            })
            : {
              poolAddress: this.getKnownDexPoolAddress(tokenInfo),
              preferHint: this.normalizeDexPrefer(tokenInfo.dex_type),
              fee: undefined as number | undefined,
            };
          const outerPoolPair = outerTargetPool.poolAddress;
          const outerPoolMeta = outerPoolPair
            ? await this.getKnownPoolRouteMeta(input.chainId, outerPoolPair, outerTargetPool.preferHint)
            : null;
          const poolVersion = outerPoolMeta?.prefer ?? outerTargetPool.preferHint ?? getDexPoolPrefer(tokenInfo.dex_type);
          const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
          const q2 = await timeStep('quote:token:hop2', () =>
            resolveDexExactIn(
              input.chainId,
              currentRouterToken,
              tokenOut,
              currentAmount,
              {
                v3Fee: outerTargetPool.fee ?? outerPoolMeta?.fee ?? input.poolFee,
                poolPair: outerPoolPair ?? undefined,
                prefer: poolVersion ?? (bridgePrefer ?? (turboRouteMode && !input.poolFee ? 'v2' : undefined)),
              },
              turboRouteMode
            )
          );

          if (turboRouteMode) {
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
          if (turboRouteMode) {
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
      gasLimit: getSwapGasLimitForLaunchpad(launchpadPlatform, isInner),
      trace,
      txSide: 'buy' as const,
      submitChannel: input.submitChannel,
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
    return {
      txHash,
      protectionMinOutWei: minOut.toString(),
      quotedOutWei: null,
      broadcastVia,
      broadcastUrl,
      isBundle,
    };
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
    const flowId = `buy-auto:${buildScopedTokenKey(input.chainId, input.tokenAddress)}:${Date.now().toString(36)}`;
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
          fromAddress: this.resolveOptionalEvmAddress(input.fromAddress, 'from address'),
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
          fromAddress: this.resolveOptionalEvmAddress(input.fromAddress, 'from address'),
          txSide: 'buy',
          submitChannel: input.submitChannel,
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
    if (!input.tokenInfo) {
      const settings = await SettingsService.get();
      const configuredBaseTokenAddress = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
      const baseTokenAddress = (typeof input.baseTokenAddress === 'string' && input.baseTokenAddress.trim())
        ? this.resolveBaseTokenAddress(input.chainId, input)
        : configuredBaseTokenAddress;
      const tokenInfo = await this.buildDexTokenInfoFromDexScreener({
        chainId: input.chainId,
        tokenAddress: this.resolveEvmAddress(input.tokenAddress, 'token address') as Address,
        baseTokenAddress,
        debug: settings.ui?.consoleLogsEnabled === true,
      });
      if (tokenInfo) {
        input.tokenInfo = tokenInfo;
      }
    }
    const flowId = `sell-auto:${buildScopedTokenKey(input.chainId, input.tokenAddress)}:${Date.now().toString(36)}`;
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
            if (!input.tokenInfo) break;
          allowanceRepaired = await this.repairSellAllowanceIfNeeded({
            chainId: input.chainId,
            tokenAddress: input.tokenAddress,
            tokenInfo: input.tokenInfo,
            timeoutMs,
            fromAddress: this.resolveOptionalEvmAddress(input.fromAddress, 'from address'),
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
          fromAddress: this.resolveOptionalEvmAddress(input.fromAddress, 'from address'),
          txSide: 'sell',
          submitChannel: input.submitChannel,
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
    opts?: { extraSpenders?: string[]; fromAddress?: `0x${string}`; submitChannel?: SubmitChannel }
  ) {
    const routerAddress = DeployAddress[chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');

    const account = await WalletService.getSigner(opts?.fromAddress);
    const client = await RpcService.getClient(chainId);

    const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const platform = resolveTradeLaunchpadPlatform(tokenInfo);
    const isInner = this.isInnerDisk(tokenInfo);
    const isInnerFourMeme = isInner && platform.includes('four');
    const resolvedRouteManager = await this.resolveSellRouteManagerForAllowance({
      chainId,
      tokenAddress: tokenAddress as Address,
      tokenInfo,
      owner: account.address,
      client,
    });
    const mergedExtraSpenders = resolvedRouteManager && resolvedRouteManager !== ZERO_ADDRESS
      ? [...(opts?.extraSpenders ?? []), resolvedRouteManager]
      : opts?.extraSpenders;

    const spenders = getSellSpenders({
      chainId,
      tokenInfo,
      routerAddress,
      extraSpenders: mergedExtraSpenders,
      getLaunchpadManager: (ti, cid) => {
        if (resolvedRouteManager && resolvedRouteManager !== ZERO_ADDRESS) return resolvedRouteManager;
        const platform = resolveTradeLaunchpadPlatform(ti);
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
        submitChannel: opts?.submitChannel,
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
        submitChannel: opts?.submitChannel,
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
    const resolvedRouteManager = await this.resolveSellRouteManagerForAllowance({
      chainId,
      tokenAddress: tokenAddress as Address,
      tokenInfo,
      owner: account.address,
      client,
    });
    const mergedExtraSpenders = resolvedRouteManager && resolvedRouteManager !== ZERO_ADDRESS
      ? [...(opts?.extraSpenders ?? []), resolvedRouteManager]
      : opts?.extraSpenders;
    return await hasInsufficientSellAllowance({
      chainId,
      tokenAddress,
      tokenInfo,
      owner: account.address,
      client,
      maxUint256,
      routerAddress,
      extraSpenders: mergedExtraSpenders,
      getLaunchpadManager: (ti, cid) => {
        if (resolvedRouteManager && resolvedRouteManager !== ZERO_ADDRESS) return resolvedRouteManager;
        const platform = resolveTradeLaunchpadPlatform(ti);
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
    const sellFrom = input.fromAddress ? normalizeWalletAddressKey(input.fromAddress) : 'default';
    const sellLockKey = `${buildScopedTokenKey(input.chainId, input.tokenAddress)}:${sellFrom}`;
    if (this.sellInFlightByToken.has(sellLockKey)) {
      throw new Error('SELL_IN_FLIGHT');
    }
    this.sellInFlightByToken.add(sellLockKey);
    const run = async () => {
      const settings = await SettingsService.get();
      const routerAddress = DeployAddress[input.chainId as ChainId]?.DagobangRouter?.address;
      if (!routerAddress) throw new Error('Router address not set');

      const fromAddress = this.resolveOptionalEvmAddress(input.fromAddress, 'from address');
      const account = await WalletService.getSigner(fromAddress);
      const client = await RpcService.getClient(input.chainId);

      let amountIn = BigInt(input.tokenAmountWei);
      const configuredBaseTokenAddress = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
      const baseTokenAddress = (typeof input.baseTokenAddress === 'string' && input.baseTokenAddress.trim())
        ? this.resolveBaseTokenAddress(input.chainId, input)
        : configuredBaseTokenAddress;
        let tokenInfo: TokenInfo | null | undefined = input.tokenInfo;
      if (!tokenInfo) {
        tokenInfo = await this.buildDexTokenInfoFromDexScreener({
          chainId: input.chainId,
          tokenAddress: this.resolveEvmAddress(input.tokenAddress, 'token address') as Address,
          baseTokenAddress,
          debug: settings.ui?.consoleLogsEnabled === true,
        });
        if (tokenInfo) {
          input.tokenInfo = tokenInfo;
        }
      }
      if (!tokenInfo) throw new Error('Token info required');

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

      const sellToken = this.resolveEvmAddress(input.tokenAddress, 'token address') as Address;
      const platformLower = resolveTradeLaunchpadPlatform(tokenInfo);
      const isHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(platformLower);
      const openFourRuntime = (isHyperAltfun || !usesOpenFourRuntime(platformLower))
        ? null
        : await this.getOpenFourRuntimeState(client, input.chainId, sellToken);
      const isInner = isHyperAltfun
        ? false
        : usesOpenFourRuntime(platformLower)
          ? !!openFourRuntime && openFourRuntime.phase === 1 && !openFourRuntime.paused
          : this.isInnerDisk(tokenInfo);
      const isInnerFourMeme = isInner && isFourMemePlatform(platformLower);
      const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId, openFourRuntime) : null;
      const bridgeToken = isHyperAltfun ? null : this.getLaunchpadQuoteRouterToken(input.chainId as ChainId, tokenInfo, platformLower, openFourRuntime, {
        preferRuntimeQuote: isInner,
      });
      const rawQuoteToken = isHyperAltfun ? null : this.getLaunchpadRawQuoteToken(input.chainId as ChainId, tokenInfo, platformLower, openFourRuntime, {
        preferRuntimeQuote: isInner,
      });
      const hasBridgeRouteToken = !!bridgeToken;
      const needsBridgeHop2 = !!bridgeToken && bridgeToken.toLowerCase() !== ZERO_ADDRESS.toLowerCase();
      const bridgePrefer = needsBridgeHop2 ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      const isFlapStocks = this.isFlapStocksPlatform(platformLower, tokenInfo, input.chainId);
      const needsStocksQuoteRoute = !!rawQuoteToken && isFlapStocks && rawQuoteToken.toLowerCase() !== baseTokenAddress.toLowerCase();
      console.log('sell input.tokenInfo', tokenInfo, isInner, launchpadConfig)
      console.log('sell bridgeToken', bridgeToken, bridgePrefer, 'rawQuoteToken', rawQuoteToken);
      const descs: SwapDescLike[] = [];
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
        const platform = resolveTradeLaunchpadPlatform(tokenInfo);
        const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
        let minFunds = 0n;
        let dataForSell: `0x${string}` = '0x';
        let feeForSellDesc = 0;
        let tickSpacingForSellDesc = 0;

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
                if (!needsBridgeHop2) {
                  estimatedOut = netFunds;
                }
              }
            }
          } catch (ex) {
            console.log('fourmeme sell error', ex);
          }
        }

        if (isOpenFourPlatform(platform)) {
          const openFourOptions = parseOpenFourOptions(input.openFourOptions);
          const openFourProof = input.openFourProof ?? '0x';
          if (!isTurbo) {
            const est = await timeStep('openfour:estimateSell', () =>
              this.estimateOpenFourSell(
                client,
                input.chainId,
                sellToken,
                account.address as Address,
                amountIn,
                openFourOptions,
                openFourProof
              )
            );
            if (!est || est.userReceives <= 0n) throw new Error('OpenFour 卖出预估失败或当前不可交易');
            minFunds = applySlippage(est.userReceives, slippageBps);
            minFundsForSell = minFunds;
            if (!needsBridgeHop2) {
              estimatedOut = est.userReceives;
            }
          }
          dataForSell = encodeOpenFourSwapData(
            false,
            minFunds,
            openFourOptions,
            openFourProof
          );
        }

        const innerTokenOut = needsStocksQuoteRoute
          ? rawQuoteToken
          : hasBridgeRouteToken
            ? bridgeToken
            : baseTokenAddress;
        descs.push(getRouterSwapDesc({
          swapType: launchpadConfig.sellType,
          tokenIn: sellToken,
          tokenOut: innerTokenOut,
          poolAddress: sellManagerForRoute,
          fee: feeForSellDesc,
          tickSpacing: tickSpacingForSellDesc,
          data: dataForSell,
        }));

        if (needsStocksQuoteRoute) {
          const quoteRouteDescs = await timeStep('quote:flapstocks:sell:route', () =>
            this.buildFlapOuterSellQuoteRoute({
              chainId: input.chainId,
              currentToken: innerTokenOut,
              targetToken: baseTokenAddress,
              debug: settings.ui?.consoleLogsEnabled === true,
            })
          );
          if (!quoteRouteDescs?.length) {
            throw new Error(`找不到 Flap Quote/${baseTokenSymbol} 的交易路径，当前 flap_stock 无法完成卖出回收`);
          }
          descs.push(...quoteRouteDescs);
        } else if (needsBridgeHop2) {
          const hop2AmountIn = isTurbo ? 1n : (minFunds > 0n ? minFunds : 1n);
          const hop2 = await timeStep('quote:bridge:hop2', () =>
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
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          descs.push(getRouterSwapDesc({
            swapType: hop2.swapType,
            tokenIn: innerTokenOut,
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
        const preferExactQuoteForStocks = isTurbo && needsStocksQuoteRoute;
        const turboRouteMode = isTurbo && !preferExactQuoteForStocks;
        // hop1
        const hop1RouterOut = needsStocksQuoteRoute
          ? rawQuoteToken
          : hasBridgeRouteToken
            ? bridgeToken
            : baseTokenAddress;
        const hop1NeedAmountOut = !turboRouteMode && (needsBridgeHop2 || needsStocksQuoteRoute);
        const outerTargetPool = needsStocksQuoteRoute && rawQuoteToken
          ? await this.getPreferredFlapOuterTargetPool({
            chainId: input.chainId,
            tokenAddress: sellToken,
            quoteTokenAddress: rawQuoteToken,
            tokenInfo,
            debug: settings.ui?.consoleLogsEnabled === true,
            logEvent: 'sell.target_pool.selected',
          })
          : {
            poolAddress: this.getKnownDexPoolAddress(tokenInfo),
            preferHint: this.normalizeDexPrefer(tokenInfo.dex_type),
            fee: undefined as number | undefined,
          };
        const outerPoolPair = outerTargetPool.poolAddress;
        const outerPoolMeta = outerPoolPair
          ? await this.getKnownPoolRouteMeta(input.chainId, outerPoolPair, outerTargetPool.preferHint)
          : null;
        const poolVersion = outerPoolMeta?.prefer ?? outerTargetPool.preferHint ?? this.normalizeDexPrefer(tokenInfo.dex_type);
        let hop1AmountOut = 0n;

        if (needsStocksQuoteRoute) {
          if (!outerPoolPair) {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
          descs.push(await this.resolveKnownPoolRouteDesc({
            chainId: input.chainId,
            tokenIn: sellToken,
            tokenOut: hop1RouterOut,
            poolAddress: outerPoolPair,
            preferHint: poolVersion,
          }));
        } else {
          const hop1 = await timeStep('quote:token', () =>
            resolveDexExactIn(
              input.chainId,
              sellToken,
              hop1RouterOut,
              amountInForQuote,
              {
                v3Fee: outerTargetPool.fee ?? outerPoolMeta?.fee ?? input.poolFee,
                poolPair: outerPoolPair ?? undefined,
                prefer: poolVersion ?? (bridgePrefer ?? (turboRouteMode && !input.poolFee ? 'v2' : undefined)),
              },
              turboRouteMode,
              hop1NeedAmountOut
            )
          );
          if (turboRouteMode && !hop1NeedAmountOut) {
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
          if (!turboRouteMode && hop1.amountOut <= 0n) {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
          hop1AmountOut = hop1.amountOut;
          descs.push(getRouterSwapDesc({
            swapType: hop1.swapType,
            tokenIn: sellToken,
            tokenOut: hop1RouterOut,
            poolAddress: hop1.poolAddress,
            fee: getV3FeeForDesc(hop1, input.poolFee ?? baseFee),
          }));
        }

        // hop2
        if (needsStocksQuoteRoute) {
          this.logFlapStocksRoute(settings.ui?.consoleLogsEnabled === true, 'sell.outer.start', {
            chainId: input.chainId,
            tokenAddress: sellToken,
            baseTokenAddress,
            rawQuoteToken,
            launchpadPlatform: platformLower,
            launchpadStatus: tokenInfo.launchpad_status ?? null,
            launchType: tokenInfo.tpool_launch_type ?? null,
            targetPoolPair: tokenInfo.pool_pair ?? null,
            targetBiggestPoolAddress: tokenInfo.biggest_pool_address ?? null,
            targetTpoolPoolAddress: tokenInfo.tpool_pool_address ?? null,
            executionMode,
          });
          const quoteRouteDescs = await timeStep('quote:flapstocks:outer:sell:route', () =>
            this.buildFlapOuterSellQuoteRoute({
              chainId: input.chainId,
              currentToken: hop1RouterOut,
              targetToken: baseTokenAddress,
              debug: settings.ui?.consoleLogsEnabled === true,
            })
          );
          if (!quoteRouteDescs?.length) {
            throw new Error(`找不到 Flap Quote/${baseTokenSymbol} 的交易路径，当前 flap_stock 无法完成卖出预处理`);
          }
          descs.push(...quoteRouteDescs);
          estimatedOut = 0n;
        } else if (!needsBridgeHop2) {
          estimatedOut = turboRouteMode ? 0n : hop1AmountOut;
        } else {
          if (!turboRouteMode && hop1AmountOut <= 0n) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          const hop2AmountIn = turboRouteMode ? 1n : hop1AmountOut;
          const hop2 = await timeStep('quote:bridge:hop2', () =>
            resolveBridgeHopExactIn(
              input.chainId,
              bridgeToken,
              baseTokenAddress,
              hop2AmountIn,
              bridgePrefer,
              turboRouteMode,
              !turboRouteMode
            )
          );
          if (turboRouteMode) {
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
          if (!turboRouteMode && hop2.amountOut <= 0n) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          descs.push(getRouterSwapDesc({
            swapType: hop2.swapType,
            tokenIn: bridgeToken,
            tokenOut: baseTokenAddress,
            poolAddress: hop2.poolAddress,
            fee: getV3FeeForDesc(hop2, getDefaultBridgeV3Fee(input.chainId)),
          }));
          estimatedOut = turboRouteMode ? 0n : hop2.amountOut;
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
        gasLimit: getSwapGasLimitForLaunchpad(platformLower, isInner),
        trace,
        txSide: 'sell' as const,
        submitChannel: input.submitChannel,
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
            const platform = resolveTradeLaunchpadPlatform(ti);
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
          submitChannel: input.submitChannel,
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
    fromAddress?: `0x${string}`,
    _submitChannel?: SubmitChannel,
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
      {
        skipEstimateGas: true,
        gasLimit: 900000n,
        feeMode: gasPriceMode,
        gasPreset,
        // Approval should not inherit the trade submit channel.
        // Use all protected RPC routes concurrently to reduce confirmation lag.
        submitStrategy: 'allProtected',
      }
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
    opts?: { nonce?: number; skipEstimateGas?: boolean; gasLimit?: bigint; trace?: (label: string, ms: number) => void; txSide?: 'buy' | 'sell'; submitChannel?: SubmitChannel; submitStrategy?: 'selected' | 'allProtected'; priorityFeeBnbOverride?: string; feeMode?: 'fixed' | 'dynamic'; gasPreset?: GasPreset }
  ) {
    return await sendTransaction(client, account, to, data, value, gasPriceWei, chainId, opts);
  }
}
