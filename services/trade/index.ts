import { decodeAbiParameters, decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseAbiParameters } from 'viem';
import { RpcService } from '../rpc';
import { WalletService } from '../wallet';
import { SettingsService } from '../settings';
import type { GasPreset, QuickTradeRouteHop, QuickTradeRoutePreview, SubmitChannel, TxBuyInput, TxSellInput } from '../../types/extention';
import type { FlapTokenStateV7, TokenInfo } from '../../types/token';
import { ContractNames } from '../../constants/contracts/names';
import { DeployAddress } from '../../constants/contracts/address';
import { ChainId } from '../../constants/chains/chainId';
import { allTokens, getBridgeTokenAddresses, getBridgeTokenDexPreference } from '../../constants/tokens/allTokens';
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
import { OPENFOUR_4STOCK_QUOTE_FALLBACK } from '@/constants/openfour';
import FlapAPI from '@/hooks/FlapAPI';
import DexScreenerAPI, { type DexScreenerPair, type DexScreenerTokenRef } from '@/hooks/DexScreenerAPI';

const erc20TransferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
import { GmgnAPI } from '@/hooks/GmgnAPI';
import { classifyFlapRoute, hasConfirmedFlapLaunchpadIdentity, hasConfirmedFlapOuterRoute, isUsableFlapDexPoolAddress, resolveFlapPlatform, resolveFlapPlatformByQuoteLineage } from '@/utils/flap';
import { resolveTokenLaunchpadPlatform } from '@/utils/launchpadFamily';
import { buildFastQuickTradeRoutePreview, planEvmTradeRoute, resolveEvmTradeQuoteToken, type EvmTradeRoutePlan } from '@/utils/quickTradeRoutePreview';
import { preferRouteTokenSymbol, resolveRouteTokenLabel } from '@/utils/quoteTokenLabels';
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

export type FlapStocksQuoteTopology = {
  rawQuoteToken: Address;
  terminalQuoteToken: Address;
  rawQuotePoolAddress: Address;
  rawQuotePoolPrefer: 'v2' | 'v3' | null;
};

type DexScreenerQuoteHop = {
  poolAddress: Address;
  counterparty: Address;
  preferHint: 'v2' | 'v3' | null;
  liquidityUsd: number;
};

const FLAP_OUTER_QUOTE_ROUTE_MAX_DEPTH = 6;
const FLAP_DEXSCREENER_MIN_LIQUIDITY_USD = 1;
const FLAP_DEXSCREENER_MAX_HOP_CANDIDATES = 3;
const FLAP_ROUTE_PROBE_NATIVE_IN = 10n ** 16n;
const OFFICIAL_LAUNCHPAD_QUOTE_CACHE_MS = 30_000;

type LaunchpadRouteClassification = {
  platform: string;
  isHyperAltfun: boolean;
  isFlap: boolean;
  isFlapStocks: boolean;
  isInner: boolean;
  rawLaunchpadStatus: number | null;
  hasConfirmedOuterRoute: boolean;
};

const DEFAULT_SWAP_GAS_LIMIT = 2000000n;
const OPEN_FOUR_SWAP_GAS_LIMIT = 2500000n;

function resolveLaunchpadPlatform(platform: string | undefined): string {
  return normalizeLaunchpadPlatform(platform) ?? String(platform || '').trim().toLowerCase();
}

function resolveTradeLaunchpadPlatform(tokenInfo: Pick<TokenInfo, 'launchpad' | 'launchpad_platform'> & Partial<Pick<TokenInfo, 'address'>>): string {
  const launchpad = resolveLaunchpadPlatform(tokenInfo.launchpad);
  if (launchpad === 'openfour') return 'openfour';
  return resolveTokenLaunchpadPlatform({
    address: tokenInfo.address,
    launchpad: tokenInfo.launchpad,
    launchpad_platform: tokenInfo.launchpad_platform,
  });
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

type PreparedEvmTradeRoute = {
  descs: SwapDescLike[];
  preview: QuickTradeRoutePreview;
};

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
  private static readonly flapKnownPoolMetaCache = new Map<string, Promise<{ prefer: 'v2' | 'v3'; fee?: number; v3Factory?: Address } | null>>();
  private static readonly flapOuterQuoteRouteMaxDepth = FLAP_OUTER_QUOTE_ROUTE_MAX_DEPTH;
  private static readonly flapOuterBuyQuoteRouteCacheMs = 30_000;
  private static readonly flapOuterBuyQuoteRouteCache = new Map<string, { ts: number; value: SwapDescLike[] | null }>();
  private static readonly flapOuterBuyQuoteRouteInFlight = new Map<string, Promise<SwapDescLike[] | null>>();
  private static readonly flapOuterSellQuoteRouteCache = new Map<string, { ts: number; value: SwapDescLike[] | null }>();
  private static readonly flapOuterSellQuoteRouteInFlight = new Map<string, Promise<SwapDescLike[] | null>>();
  private static readonly flapPoolCounterpartyCache = new Map<string, Address | null>();
  private static readonly flapPoolCounterpartyInFlight = new Map<string, Promise<Address | null>>();
  private static readonly officialLaunchpadQuoteCache = new Map<string, { ts: number; value: Address | null }>();
  private static readonly officialLaunchpadQuoteInFlight = new Map<string, Promise<Address | null>>();
  private static readonly preparedEvmTradeRouteCacheMs = 30_000;
  private static readonly preparedEvmTradeRouteCache = new Map<string, { ts: number; value: PreparedEvmTradeRoute | null }>();
  private static readonly preparedEvmTradeRouteInFlight = new Map<string, Promise<PreparedEvmTradeRoute | null>>();

  private static makeApproveKey(chainId: number, owner: string, token: string, spender: string) {
    return `${chainId}:${owner.toLowerCase()}:${token.toLowerCase()}:${spender.toLowerCase()}`;
  }

  private static getTurboWarmFingerprint(chainId: number, tokenInfo: TokenInfo) {
    const rawPlatform = resolveTradeLaunchpadPlatform(tokenInfo);
    const effectivePlatform = rawPlatform.startsWith('flap')
      ? resolveFlapPlatform(chainId, tokenInfo)
      : rawPlatform;
    return [
      effectivePlatform,
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
      this.getTurboWarmFingerprint(input.chainId, input.tokenInfo),
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

  static async prewarmTurbo(input: { chainId: number; tokenAddress: Address; tokenInfo?: TokenInfo; fromAddress?: `0x${string}`; submitChannel?: SubmitChannel; baseTokenAddress?: Address }) {
    const settings = await SettingsService.get();
    const consoleLogsEnabled = settings.ui?.consoleLogsEnabled === true;
    const startedAt = Date.now();
    let tokenInfo = input.tokenInfo;
    if (!tokenInfo) return;
    tokenInfo = await this.ensureFlapTradeTokenInfo(input.chainId, tokenInfo, consoleLogsEnabled);
    input.tokenInfo = tokenInfo;

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
      const criticalWarmTasks: Array<Promise<unknown>> = [
        prewarmNonce(client, input.chainId, account.address, { submitChannel: input.submitChannel }).catch(() => null),
      ];
      const backgroundWarmTasks: Array<Promise<unknown>> = [];

        const token = input.tokenAddress;
        const launchpadRoute = this.classifyLaunchpadRoute(input.chainId, tokenInfo);
        const launchpadPlatform = launchpadRoute.platform;
        const openFourRuntime = usesOpenFourRuntime(launchpadPlatform)
          ? await this.getOpenFourRuntimeState(client, input.chainId, token).catch(() => null)
          : null;
        const classifiedRoute = this.classifyLaunchpadRoute(input.chainId, tokenInfo, openFourRuntime);
        const rawQuoteToken = await this.resolveTradeRouteQuoteToken({
          chainId: input.chainId,
          tokenAddress: token,
          tokenInfo,
          platform: classifiedRoute.platform,
          isInner: classifiedRoute.isInner,
          openFourRuntime,
          debug: consoleLogsEnabled,
        });
        const configuredBaseToken = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
        const baseTokenAddress = (input.baseTokenAddress && isAddressLike(input.baseTokenAddress)
          ? input.baseTokenAddress
          : configuredBaseToken) as Address;
        const needsNonTerminalQuoteRoute = this.needsNonTerminalQuoteRoute(input.chainId, baseTokenAddress, rawQuoteToken);
        const bridgeToken = needsNonTerminalQuoteRoute
          ? rawQuoteToken
          : getBridgeToken(input.chainId as ChainId, tokenInfo.address, tokenInfo.quote_token_address);
        const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
        const dexPrefer = getDexPoolPrefer(tokenInfo.dex_type);
        const tokenPrefer = dexPrefer === 'v2' || dexPrefer === 'v3' ? dexPrefer : (bridgePrefer ?? 'v2');

      criticalWarmTasks.push(
        this.prepareEvmTradeRoute({
          chainId: input.chainId,
          tokenAddress: token,
          tokenInfo,
          baseTokenAddress,
        }).catch(() => null)
      );

      const amountIn = 0n;

      if (tokenInfo.pool_pair && tokenPrefer === 'v2') {
        criticalWarmTasks.push(resolveDexExactIn(input.chainId, ZERO_ADDRESS, token, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v2' }, true, false).catch(() => null));
        backgroundWarmTasks.push(resolveDexExactIn(input.chainId, token, ZERO_ADDRESS, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v2' }, true, false).catch(() => null));
      }

      if (tokenInfo.pool_pair && tokenPrefer === 'v3') {
        criticalWarmTasks.push(
          resolveDexExactIn(
            input.chainId,
            ZERO_ADDRESS,
            token,
            amountIn,
            { poolPair: tokenInfo.pool_pair, prefer: 'v3' },
            true,
            false
          ).catch(() => null)
        );
        backgroundWarmTasks.push(
          resolveDexExactIn(
            input.chainId,
            token,
            ZERO_ADDRESS,
            amountIn,
            { poolPair: tokenInfo.pool_pair, prefer: 'v3' },
            true,
            false
          ).catch(() => null)
        );
      }

      if (bridgeToken) {
        criticalWarmTasks.push(resolveBridgeHopExactIn(
          input.chainId,
          ZERO_ADDRESS,
          bridgeToken,
          amountIn,
          bridgePrefer,
          true,
          false,
        ).catch(() => null));
        backgroundWarmTasks.push(resolveBridgeHopExactIn(
          input.chainId,
          bridgeToken,
          ZERO_ADDRESS,
          amountIn,
          bridgePrefer,
          true,
          false,
        ).catch(() => null));
      }

      if (bridgeToken && tokenInfo.pool_pair && tokenPrefer === 'v3') {
        criticalWarmTasks.push(resolveDexExactIn(input.chainId, bridgeToken, token, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v3' }, true, false).catch(() => null));
        backgroundWarmTasks.push(resolveDexExactIn(input.chainId, token, bridgeToken, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v3' }, true, false).catch(() => null));
      }

      if (needsNonTerminalQuoteRoute && rawQuoteToken) {
        const outerTargetPoolTask = this.getPreferredFlapOuterTargetPool({
          chainId: input.chainId,
          tokenAddress: token,
          quoteTokenAddress: rawQuoteToken,
          tokenInfo,
          preferOnchainPool: true,
          debug: consoleLogsEnabled,
          logEvent: 'prewarm.target_pool.selected',
        }).catch(() => ({ poolAddress: null, preferHint: null as 'v2' | 'v3' | null, fee: undefined }));
        const quoteTopologyTask = this.resolveFlapStocksQuoteTopology({
          chainId: input.chainId,
          rawQuoteToken,
          anchorToken: token,
          debug: consoleLogsEnabled,
          logEvent: 'prewarm.quote_topology',
        }).catch(() => null);

        criticalWarmTasks.push((async () => {
          const topology = await quoteTopologyTask;
          if (!topology) return null;
          if (topology.terminalQuoteToken.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return null;
          const topologyBridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, topology.terminalQuoteToken) ?? null;
          return await resolveBridgeHopExactIn(
            input.chainId,
            ZERO_ADDRESS,
            topology.terminalQuoteToken,
            amountIn,
            topologyBridgePrefer,
            true,
            false,
          );
        })().catch(() => null));
        backgroundWarmTasks.push(
          this.buildFlapOuterSellQuoteRoute({
            chainId: input.chainId,
            currentToken: rawQuoteToken,
            targetToken: baseTokenAddress,
            debug: consoleLogsEnabled,
          }).catch(() => null)
        );
        criticalWarmTasks.push((async () => {
          const outerTargetPool = await outerTargetPoolTask;
          if (!outerTargetPool.poolAddress) return null;
          return await this.getKnownPoolRouteMeta(
            input.chainId,
            outerTargetPool.poolAddress,
            outerTargetPool.preferHint,
          );
        })().catch(() => null));
      }

      await Promise.allSettled(criticalWarmTasks);
      if (backgroundWarmTasks.length > 0) {
        void Promise.allSettled(backgroundWarmTasks).then(() => {
          const backgroundElapsedMs = Date.now() - startedAt;
          if (consoleLogsEnabled && backgroundElapsedMs >= 600) {
            console.info('[trade.buy.prewarm.background]', {
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              fromAddress: account.address,
              backgroundTaskCount: backgroundWarmTasks.length,
              elapsedMs: backgroundElapsedMs,
              warmKey,
            });
          }
        });
      }
      const elapsedMs = Date.now() - startedAt;
      if (consoleLogsEnabled || elapsedMs >= 600) {
        console.info('[trade.buy.prewarm]', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          fromAddress: account.address,
          warmTaskCount: criticalWarmTasks.length + backgroundWarmTasks.length,
          criticalWarmTaskCount: criticalWarmTasks.length,
          backgroundWarmTaskCount: backgroundWarmTasks.length,
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
    if (receipt.status === 'success') return receipt;
    let revertReason: string | null = null;
    try {
      const client = await RpcService.getClient(chainId);
      revertReason = await tryGetReceiptRevertReason(client, txHash, receipt.blockNumber);
    } catch {
    }
    throw new Error(revertReason || `${txSide} receipt reverted`);
  }

  private static resolveActualBuyTokenOutWeiFromReceipt(input: {
    receipt: any;
    tokenAddress: string;
    walletAddress?: string;
  }): string | null {
    const walletAddress = this.resolveOptionalEvmAddress(input.walletAddress, 'wallet address');
    if (!walletAddress) return null;
    const tokenAddress = this.resolveEvmAddress(input.tokenAddress, 'token address').toLowerCase();
    let totalOutWei = 0n;
    for (const log of Array.isArray(input.receipt?.logs) ? input.receipt.logs : []) {
      if (String(log?.address || '').toLowerCase() !== tokenAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: erc20TransferAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== 'Transfer') continue;
        const to = String((decoded as any)?.args?.to || '').toLowerCase();
        if (to !== walletAddress.toLowerCase()) continue;
        const value = BigInt((decoded as any)?.args?.value ?? 0);
        if (value > 0n) totalOutWei += value;
      } catch {
      }
    }
    return totalOutWei > 0n ? totalOutWei.toString() : null;
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
        : this.isInnerDisk(input.tokenInfo, input.chainId, openFourRuntime);
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

  private static classifyLaunchpadRoute(
    chainId: number,
    tokenInfo: TokenInfo,
    openFourRuntime?: OpenFourRuntimeState | null,
  ): LaunchpadRouteClassification {
    const rawPlatform = resolveTradeLaunchpadPlatform(tokenInfo);
    const isHyperAltfun = chainId === ChainId.HYPER && isHyperAltfunPlatform(rawPlatform);
    const isFlap = rawPlatform.startsWith('flap');
    const flapRoute = isFlap ? classifyFlapRoute(chainId, tokenInfo) : null;
    const isFlapStocks = !!flapRoute?.isFlapStocks;
    const platform = isFlap ? flapRoute?.platform || 'flap' : rawPlatform;
    const normalizedLaunchpadStatus = flapRoute?.rawLaunchpadStatus ?? null;
    const hasConfirmedOuterRoute = !!flapRoute?.hasConfirmedOuterRoute;
    const isInner = isHyperAltfun
      ? false
      : usesOpenFourRuntime(platform)
        ? openFourRuntime
          ? openFourRuntime.phase === 1 && !openFourRuntime.paused
          : tokenInfo.launchpad_status !== 1
        : isFlap
          ? !!flapRoute?.isInner
          : INNER_LAUNCHPAD_PLATFORMS.has(platform) && tokenInfo.launchpad_status !== 1;

    return {
      platform,
      isHyperAltfun,
      isFlap,
      isFlapStocks,
      isInner,
      rawLaunchpadStatus: normalizedLaunchpadStatus,
      hasConfirmedOuterRoute,
    };
  }

  private static isInnerDisk(tokenInfo: TokenInfo, chainId: number, openFourRuntime?: OpenFourRuntimeState | null): boolean {
    return this.classifyLaunchpadRoute(chainId, tokenInfo, openFourRuntime).isInner;
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
    const resolvedQuote = isAddressLike(quoteAsset) ? quoteAsset : ZERO_ADDRESS;
    if (!exists && resolvedQuote === ZERO_ADDRESS) return null;
    let phase = 0;
    if (isAddressLike(vault)) {
      try {
        phase = Number(await client.readContract({
          address: vault,
          abi: openFourVaultAbi,
          functionName: 'phase',
        }));
      } catch {
        phase = 0;
      }
    }
    return {
      core: contracts.core,
      tools: contracts.tools,
      quoteAsset: resolvedQuote,
      vault: isAddressLike(vault) ? vault : ZERO_ADDRESS,
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
      if (runtimeToken && this.isNonTerminalQuoteToken(chainId, runtimeToken)) return runtimeToken;
    }
    if (!isOpenFourPlatform(platform)) return getBridgeToken(chainId, tokenInfo.address, tokenInfo.quote_token_address);
    const raw = typeof tokenInfo.quote_token_address === 'string' ? tokenInfo.quote_token_address.trim() : '';
    if (this.isLikelySentinelFlapQuoteToken(raw)) return null;
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
    if (this.isLikelySentinelFlapQuoteToken(raw)) return null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    const normalized = raw.toLowerCase();
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (normalized === ZERO_ADDRESS.toLowerCase() || normalized === wrappedNative) return ZERO_ADDRESS;
    return raw as Address;
  }

  private static needsNonTerminalQuoteRoute(
    chainId: number,
    currentToken: Address,
    rawQuoteToken: Address | null,
  ): boolean {
    if (!rawQuoteToken) return false;
    if (this.isFlapOuterRouteTerminalToken(chainId, rawQuoteToken)) return false;
    return currentToken.toLowerCase() !== rawQuoteToken.toLowerCase();
  }

  private static isNonTerminalQuoteToken(
    chainId: number,
    tokenAddress: Address | null | undefined,
    selfToken?: Address,
  ): boolean {
    if (!tokenAddress) return false;
    if (selfToken && tokenAddress.toLowerCase() === selfToken.toLowerCase()) return false;
    return !this.isFlapOuterRouteTerminalToken(chainId, tokenAddress);
  }

  private static async resolveTradeRouteQuoteToken(input: {
    chainId: number;
    tokenAddress: Address;
    tokenInfo: TokenInfo;
    platform: string;
    isInner: boolean;
    openFourRuntime?: OpenFourRuntimeState | null;
    debug?: boolean;
  }): Promise<Address | null> {
    const plannedQuote = resolveEvmTradeQuoteToken(input.chainId, input.tokenInfo);
    if (plannedQuote && this.isNonTerminalQuoteToken(input.chainId, plannedQuote, input.tokenAddress)) {
      this.logFlapStocksRoute(input.debug, 'route.quote.planned', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        platform: input.platform,
        plannedQuote,
      });
      return plannedQuote;
    }
    const runtimeQuote = usesOpenFourRuntime(input.platform)
      ? getOpenFourQuoteRouterToken(input.chainId, input.openFourRuntime)
      : null;
    const metadataQuote = this.getLaunchpadRawQuoteToken(
      input.chainId,
      input.tokenInfo,
      input.platform,
      input.openFourRuntime,
      { preferRuntimeQuote: false },
    );
    const shouldReadFlapOfficial = input.platform.startsWith('flap')
      || hasConfirmedFlapLaunchpadIdentity(input.chainId, input.tokenInfo);
    const officialQuote = shouldReadFlapOfficial
      ? await this.resolveOfficialLaunchpadQuote(input.chainId, input.tokenAddress, input.debug)
      : null;
    const resolvedQuote = this.pickTradeRouteQuoteToken(input.chainId, {
      runtimeQuote,
      officialQuote,
      metadataQuote,
      platform: input.platform,
      isInner: input.isInner,
    });

    this.logFlapStocksRoute(input.debug, 'route.quote.resolved', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      platform: input.platform,
      isInner: input.isInner,
      runtimeQuote,
      metadataQuote,
      officialQuote,
      resolvedQuote,
      nonTerminal: resolvedQuote ? !this.isFlapOuterRouteTerminalToken(input.chainId, resolvedQuote) : false,
    });
    return resolvedQuote;
  }

  private static pickTradeRouteQuoteToken(
    chainId: number,
    input: {
      runtimeQuote: Address | null;
      officialQuote: Address | null;
      metadataQuote: Address | null;
      platform: string;
      isInner: boolean;
    },
  ): Address | null {
    const ranked = [input.runtimeQuote, input.officialQuote, input.metadataQuote].filter(
      (token): token is Address => !!token,
    );
    const nonTerminal = ranked.find((token) => this.isNonTerminalQuoteToken(chainId, token));
    if (nonTerminal) return nonTerminal;
    if (
      input.isInner
      || isFourMemePlatform(input.platform)
      || isOpenFourPlatform(input.platform)
    ) {
      return input.metadataQuote ?? input.runtimeQuote ?? input.officialQuote;
    }
    return input.runtimeQuote ?? input.officialQuote ?? input.metadataQuote;
  }

  private static getMarketHomeTerminals(chainId: number, targetToken?: Address): Address[] {
    if (targetToken && this.isKnownOpenFourQuoteToken(chainId, targetToken)) {
      const usdt = (USDT[chainId as ChainId]?.address ?? (chainId === ChainId.BNB ? bscTokens.usdt.address : null)) as Address | null;
      return usdt ? [usdt] : [ZERO_ADDRESS];
    }
    const terminals: Address[] = [ZERO_ADDRESS];
    const usdt = USDT[chainId as ChainId]?.address as Address | undefined;
    if (usdt) terminals.unshift(usdt);
    else if (chainId === ChainId.BNB) terminals.unshift(bscTokens.usdt.address as Address);
    return terminals;
  }

  private static isKnownOpenFourQuoteToken(chainId: number, tokenAddress?: string | null): boolean {
    if (chainId !== ChainId.BNB || !tokenAddress) return false;
    return tokenAddress.toLowerCase() === OPENFOUR_4STOCK_QUOTE_FALLBACK.address.toLowerCase();
  }

  private static async resolveOfficialLaunchpadQuote(
    chainId: number,
    tokenAddress: Address,
    debug?: boolean,
  ): Promise<Address | null> {
    if (this.isFlapOuterRouteTerminalToken(chainId, tokenAddress)) return null;
    const key = `${chainId}:${tokenAddress.toLowerCase()}`;
    const cached = this.officialLaunchpadQuoteCache.get(key);
    if (cached && Date.now() - cached.ts < OFFICIAL_LAUNCHPAD_QUOTE_CACHE_MS) return cached.value;
    const inflight = this.officialLaunchpadQuoteInFlight.get(key);
    if (inflight) return await inflight;

    const task = (async () => {
      const identity = await this.getFlapTokenIdentityInfo(chainId, tokenAddress);
      if (!hasConfirmedFlapLaunchpadIdentity(chainId, { ...identity, address: tokenAddress })) {
        this.logFlapStocksRoute(debug, 'official.quote.none', {
          chainId,
          tokenAddress,
          tokenVersion: identity?.tokenVersion ?? null,
        });
        return null;
      }
      const quote = this.normalizeFlapPoolCounterpartyToken(
        chainId,
        this.sanitizeFlapQuoteTokenAddress(tokenAddress, identity?.quote_token_address) ?? undefined,
      );
      if (!quote || this.isEquivalentFlapRouteToken(chainId, quote, tokenAddress)) return null;
      this.logFlapStocksRoute(debug, 'official.quote.resolved', {
        chainId,
        tokenAddress,
        officialQuote: quote,
        tokenVersion: identity?.tokenVersion ?? null,
        launchpadStatus: identity?.launchpad_status ?? null,
      });
      return quote;
    })()
      .then((value) => {
        this.officialLaunchpadQuoteCache.set(key, { ts: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.officialLaunchpadQuoteInFlight.delete(key);
      });

    this.officialLaunchpadQuoteInFlight.set(key, task);
    return await task;
  }

  private static sanitizeFlapQuoteTokenAddress(tokenAddress: Address, quoteTokenAddress?: string | null): Address | null {
    const raw = typeof quoteTokenAddress === 'string' ? quoteTokenAddress.trim() : '';
    if (this.isLikelySentinelFlapQuoteToken(raw)) return null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    if (raw.toLowerCase() === tokenAddress.toLowerCase()) return null;
    return raw as Address;
  }

  private static isLikelySentinelFlapQuoteToken(quoteTokenAddress?: string | null): boolean {
    const raw = String(quoteTokenAddress || '').trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(raw) || raw === ZERO_ADDRESS.toLowerCase()) return false;
    try {
      return BigInt(raw) <= 0xffffn;
    } catch {
      return false;
    }
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

  private static getFlapStocksTerminalQuoteCandidates(input: {
    chainId: number;
    rawQuoteToken: Address;
    anchorToken: Address;
    metadataQuote?: Address | null;
  }): Address[] {
    const out: Address[] = [];
    const seen = new Set<string>();
    const add = (token?: Address | null) => {
      const normalized = this.normalizeFlapPoolCounterpartyToken(input.chainId, token) ?? (
        isAddressLike(token) ? token as Address : null
      );
      if (!normalized) return;
      if (normalized.toLowerCase() === input.rawQuoteToken.toLowerCase()) return;
      const isTerminal = this.isFlapOuterRouteTerminalToken(input.chainId, normalized)
        || this.isEquivalentFlapRouteToken(input.chainId, normalized, input.anchorToken);
      if (!isTerminal) return;
      const lowered = normalized.toLowerCase();
      if (seen.has(lowered)) return;
      seen.add(lowered);
      out.push(normalized);
    };

    add(input.metadataQuote);
    add(this.getDefaultFlapStocksBridgeToken(input.chainId));
    add(input.anchorToken);
    for (const token of this.getPreferredDexCounterpartyCandidates(input.chainId, input.anchorToken)) {
      add(token);
    }
    for (const token of this.getQuoteBridgeCandidates(input.chainId, input.rawQuoteToken, ZERO_ADDRESS)) {
      add(token);
    }
    return out;
  }

  private static async resolveFlapStocksQuoteTopology(input: {
    chainId: number;
    rawQuoteToken: Address;
    anchorToken: Address;
    debug?: boolean;
    logEvent?: string;
  }): Promise<FlapStocksQuoteTopology | null> {
    if (this.isFlapOuterRouteTerminalToken(input.chainId, input.rawQuoteToken)) return null;

    const startToken = this.isFlapOuterRouteTerminalToken(input.chainId, input.anchorToken)
      ? input.anchorToken
      : ZERO_ADDRESS;
    const route = await this.buildFlapOuterBuyQuoteRoute({
      chainId: input.chainId,
      currentToken: startToken,
      targetToken: input.rawQuoteToken,
      debug: input.debug,
    });
    const lastHop = route?.length ? route[route.length - 1] : null;
    if (!lastHop?.poolAddress || lastHop.poolAddress === ZERO_ADDRESS) {
      this.logRoutePool(input.debug, 'topology.missing_route', {
        chainId: input.chainId,
        rawQuoteToken: input.rawQuoteToken,
        anchorToken: input.anchorToken,
        source: input.logEvent ?? 'quote.topology',
      });
      return null;
    }

    const terminalQuoteToken = lastHop.tokenIn;
    const rawQuotePoolPrefer = lastHop.swapType === SwapType.V3_EXACT_IN
      ? 'v3' as const
      : lastHop.swapType === SwapType.V2_EXACT_IN
        ? 'v2' as const
        : null;
    this.logFlapStocksRoute(input.debug, `${input.logEvent ?? 'quote.topology'}.resolved`, {
      chainId: input.chainId,
      rawQuoteToken: input.rawQuoteToken,
      anchorToken: input.anchorToken,
      terminalQuoteToken,
      rawQuotePoolAddress: lastHop.poolAddress,
      rawQuotePoolPrefer,
      source: 'route_to',
    });
    this.logRoutePool(input.debug, 'topology.route_to', {
      chainId: input.chainId,
      rawQuoteToken: input.rawQuoteToken,
      anchorToken: input.anchorToken,
      source: input.logEvent ?? 'quote.topology',
      pool: lastHop.poolAddress,
      preferHint: rawQuotePoolPrefer,
      terminalQuoteToken,
      hops: this.summarizeRouteDescs(route ?? []),
    });
    return {
      rawQuoteToken: input.rawQuoteToken,
      terminalQuoteToken,
      rawQuotePoolAddress: lastHop.poolAddress,
      rawQuotePoolPrefer,
    };
  }

  static async resolveFlapStocksPricingTopology(input: {
    chainId: number;
    rawQuoteToken: Address;
    anchorToken: Address;
    debug?: boolean;
  }): Promise<FlapStocksQuoteTopology | null> {
    return await this.resolveFlapStocksQuoteTopology({
      chainId: input.chainId,
      rawQuoteToken: input.rawQuoteToken,
      anchorToken: input.anchorToken,
      debug: input.debug,
      logEvent: 'price.topology',
    });
  }

  static async buildFlapOuterSellPricingRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    debug?: boolean;
  }): Promise<SwapDescLike[] | null> {
    return await this.buildFlapOuterSellQuoteRoute({
      chainId: input.chainId,
      currentToken: input.currentToken,
      targetToken: input.targetToken,
      debug: input.debug,
    });
  }

  static async previewQuickTradeRoute(input: {
    chainId: number;
    tokenAddress: Address;
    tokenInfo?: TokenInfo;
    baseTokenAddress?: Address;
  }): Promise<QuickTradeRoutePreview | null> {
    if (!input.tokenInfo) return null;
    const prepared = await this.prepareEvmTradeRoute(input);
    return prepared?.preview ?? buildFastQuickTradeRoutePreview({
      chainId: input.chainId,
      tokenInfo: input.tokenInfo,
      tokenAddress: input.tokenAddress,
      baseTokenAddress: input.baseTokenAddress,
    });
  }

  private static makePreparedEvmTradeRouteKey(input: {
    chainId: number;
    tokenAddress: string;
    tokenInfo: TokenInfo;
    baseTokenAddress?: string;
  }): string {
    return [
      input.chainId,
      String(input.tokenAddress || input.tokenInfo.address || '').toLowerCase(),
      String(input.baseTokenAddress || ZERO_ADDRESS).toLowerCase(),
      String(input.tokenInfo.quote_token_address || '').toLowerCase(),
      String(input.tokenInfo.launchpad_platform || ''),
      String(input.tokenInfo.launchpad_status ?? ''),
      String(input.tokenInfo.pool_pair || ''),
    ].join(':');
  }

  private static async prepareEvmTradeRoute(input: {
    chainId: number;
    tokenAddress: Address;
    tokenInfo?: TokenInfo;
    baseTokenAddress?: Address;
  }): Promise<PreparedEvmTradeRoute | null> {
    try {
      if (input.chainId === ChainId.SOL || input.chainId === ChainId.HYPER) return null;
      const tokenInfo = input.tokenInfo ?? null;
      if (!tokenInfo) return null;
      const cacheKey = this.makePreparedEvmTradeRouteKey({
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        tokenInfo,
        baseTokenAddress: input.baseTokenAddress,
      });
      const cached = this.preparedEvmTradeRouteCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.preparedEvmTradeRouteCacheMs) {
        return cached.value
          ? { descs: this.cloneSwapDescLikeArray(cached.value.descs) ?? [], preview: cached.value.preview }
          : null;
      }
      const inflight = this.preparedEvmTradeRouteInFlight.get(cacheKey);
      if (inflight) {
        const value = await inflight;
        return value
          ? { descs: this.cloneSwapDescLikeArray(value.descs) ?? [], preview: value.preview }
          : null;
      }
      const task = this.buildPreparedEvmTradeRoute(input.chainId, tokenInfo, input.tokenAddress, input.baseTokenAddress)
        .then((value) => {
          this.preparedEvmTradeRouteCache.set(cacheKey, { ts: Date.now(), value });
          return value;
        })
        .finally(() => {
          this.preparedEvmTradeRouteInFlight.delete(cacheKey);
        });
      this.preparedEvmTradeRouteInFlight.set(cacheKey, task);
      const value = await task;
      return value
        ? { descs: this.cloneSwapDescLikeArray(value.descs) ?? [], preview: value.preview }
        : null;
    } catch {
      return null;
    }
  }

  private static splitPreparedBuyRoute(prepared: PreparedEvmTradeRoute | null, tokenAddress: Address) {
    if (!prepared?.descs.length) return null;
    const last = prepared.descs[prepared.descs.length - 1];
    if (last.tokenOut.toLowerCase() !== tokenAddress.toLowerCase()) return null;
    return {
      quoteDescs: this.cloneSwapDescLikeArray(prepared.descs.slice(0, -1)) ?? [],
      lastHop: { ...last },
    };
  }

  private static preferHintFromDesc(desc: SwapDescLike | null | undefined): 'v2' | 'v3' | null {
    if (!desc) return null;
    if (desc.swapType === SwapType.V3_EXACT_IN) return 'v3';
    if (desc.swapType === SwapType.V2_EXACT_IN) return 'v2';
    return null;
  }

  private static async buildPreparedEvmTradeRoute(
    chainId: number,
    tokenInfo: TokenInfo,
    rawTokenAddress?: Address,
    rawBaseTokenAddress?: Address,
  ): Promise<PreparedEvmTradeRoute | null> {
    try {
      const plan = planEvmTradeRoute({
        chainId,
        tokenInfo,
        tokenAddress: rawTokenAddress,
        baseTokenAddress: rawBaseTokenAddress,
      });
      if (!plan?.hops.length) return null;
      const materialized = await this.materializeEvmTradeRoutePlan(chainId, tokenInfo, plan);
      if (!materialized.descs.length) return null;
      return {
        descs: materialized.descs,
        preview: this.toQuickTradeRoutePreview(
          chainId,
          tokenInfo,
          materialized.descs,
          materialized.liquidityUsd,
          materialized.symbols,
        ),
      };
    } catch {
      return null;
    }
  }

  private static collectDexScreenerPairSymbols(
    chainId: number,
    pair?: DexScreenerPair | null,
  ): Record<string, string> {
    const symbols: Record<string, string> = {};
    const add = (token?: { address?: string; symbol?: string; name?: string } | null) => {
      const address = this.normalizeFlapPoolCounterpartyToken(chainId, token?.address) ?? token?.address;
      const symbol = preferRouteTokenSymbol(token?.symbol, token?.name);
      if (!address || !symbol) return;
      symbols[address.toLowerCase()] = symbol;
      if (token?.address) symbols[token.address.toLowerCase()] = symbol;
    };
    add(pair?.baseToken);
    add(pair?.quoteToken);
    return symbols;
  }

  private static async peekDexScreenerPairMeta(
    chainId: number,
    tokenA: Address,
    tokenB: Address,
  ): Promise<{ liquidityUsd: number | null; symbols: Record<string, string> }> {
    const chain = String(chainNames[chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return { liquidityUsd: null, symbols: {} };
    const left = this.toDexScreenerPairToken(chainId, tokenA) ?? tokenA;
    const right = this.toDexScreenerPairToken(chainId, tokenB) ?? tokenB;
    const pair = await DexScreenerAPI.getBestPairBetweenTokens(chain, left, right).catch(() => null);
    const liquidityUsd = Number(pair?.liquidity?.usd ?? 0);
    return {
      liquidityUsd: Number.isFinite(liquidityUsd) && liquidityUsd > 0 ? liquidityUsd : null,
      symbols: this.collectDexScreenerPairSymbols(chainId, pair),
    };
  }

  private static async materializeEvmTradeRoutePlan(
    chainId: number,
    tokenInfo: TokenInfo,
    plan: EvmTradeRoutePlan,
  ): Promise<{ descs: SwapDescLike[]; liquidityUsd: Array<number | null>; symbols: Array<Record<string, string>> }> {
    const launchpadConfig = plan.inner ? this.getLaunchpadConfig(tokenInfo, chainId) : null;
    const hops = await Promise.all(plan.hops.map(async (hop) => {
      const tokenIn = hop.tokenIn as Address;
      const tokenOut = hop.tokenOut as Address;
      if (hop.kind === 'launchpad' && launchpadConfig) {
        return {
          desc: getRouterSwapDesc({
            swapType: launchpadConfig.buyType,
            tokenIn,
            tokenOut,
            poolAddress: launchpadConfig.manager,
            fee: 0,
          }),
          liquidityUsd: null,
          symbols: {} as Record<string, string>,
        };
      }
      const pairMeta = await this.peekDexScreenerPairMeta(chainId, tokenIn, tokenOut);
      if (hop.poolAddress && isAddressLike(hop.poolAddress) && hop.kind === 'bridge') {
        return {
          desc: getRouterSwapDesc({
            swapType: hop.dexLabel === 'V3' ? SwapType.V3_EXACT_IN : SwapType.V2_EXACT_IN,
            tokenIn,
            tokenOut,
            poolAddress: hop.poolAddress as Address,
            fee: hop.fee ?? 0,
          }),
          liquidityUsd: pairMeta.liquidityUsd,
          symbols: pairMeta.symbols,
        };
      }
      const knownPool = hop.poolAddress && isAddressLike(hop.poolAddress)
        ? hop.poolAddress as Address
        : null;
      const pool = knownPool
        ? {
          poolAddress: knownPool,
          preferHint: hop.dexLabel === 'V3' ? 'v3' as const : hop.dexLabel === 'V2' ? 'v2' as const : null,
          fee: hop.fee ?? undefined,
          liquidityUsd: pairMeta.liquidityUsd ?? undefined,
          symbols: pairMeta.symbols,
        }
        : await this.getPreferredFlapOuterTargetPool({
          chainId,
          tokenAddress: tokenOut,
          quoteTokenAddress: tokenIn,
          tokenInfo,
          pairOnly: true,
        });
      return {
        desc: getRouterSwapDesc({
          swapType: pool.preferHint === 'v3' || hop.dexLabel === 'V3' ? SwapType.V3_EXACT_IN : SwapType.V2_EXACT_IN,
          tokenIn,
          tokenOut,
          poolAddress: (pool.poolAddress ?? knownPool ?? ZERO_ADDRESS) as Address,
          fee: pool.preferHint === 'v3' ? (pool.fee ?? hop.fee ?? getDefaultBridgeV3Fee(chainId)) : (hop.fee ?? 0),
        }),
        liquidityUsd: typeof pool.liquidityUsd === 'number' && pool.liquidityUsd > 0
          ? pool.liquidityUsd
          : pairMeta.liquidityUsd,
        symbols: {
          ...pairMeta.symbols,
          ...(pool.symbols ?? {}),
        },
      };
    }));
    return {
      descs: hops.map((item) => item.desc),
      liquidityUsd: hops.map((item) => item.liquidityUsd),
      symbols: hops.map((item) => item.symbols),
    };
  }

  private static labelQuickTradeRouteToken(
    chainId: number,
    tokenAddress: Address,
    tokenInfo: TokenInfo,
    fallbackSymbol?: string | null,
  ): string {
    return resolveRouteTokenLabel({
      chainId,
      address: tokenAddress,
      tokenInfo,
      fallbackSymbol,
    });
  }

  private static labelQuickTradeDex(swapType: number): string {
    if (swapType === SwapType.V3_EXACT_IN) return 'V3';
    if (swapType === SwapType.V4_EXACT_IN || swapType === SwapType.PANCAKE_INFINITY_EXACT_IN) return 'V4';
    if (swapType === SwapType.FOUR_MEME_BUY_AMAP || swapType === SwapType.FOUR_MEME_SELL) return 'four.meme';
    if (swapType === SwapType.FLAP_EXACT_INPUT) return 'Flap';
    if (swapType === SwapType.OPEN_FOUR_EXACT_IN) return 'OpenFour';
    if (swapType === SwapType.V2_EXACT_IN) return 'V2';
    return 'DEX';
  }

  private static toQuickTradeRoutePreview(
    chainId: number,
    tokenInfo: TokenInfo,
    descs: SwapDescLike[],
    liquidityUsd?: Array<number | null>,
    hopSymbols?: Array<Record<string, string>>,
  ): QuickTradeRoutePreview {
    const hops: QuickTradeRouteHop[] = descs.map((desc, index) => ({
      tokenIn: desc.tokenIn,
      tokenOut: desc.tokenOut,
      tokenInSymbol: this.labelQuickTradeRouteToken(
        chainId,
        desc.tokenIn,
        tokenInfo,
        hopSymbols?.[index]?.[desc.tokenIn.toLowerCase()],
      ),
      tokenOutSymbol: this.labelQuickTradeRouteToken(
        chainId,
        desc.tokenOut,
        tokenInfo,
        hopSymbols?.[index]?.[desc.tokenOut.toLowerCase()],
      ),
      dexLabel: this.labelQuickTradeDex(desc.swapType),
      poolAddress: desc.poolAddress && desc.poolAddress !== ZERO_ADDRESS ? desc.poolAddress : null,
      fee: typeof desc.fee === 'number' && desc.fee > 0 ? desc.fee : null,
      liquidityUsd: typeof liquidityUsd?.[index] === 'number' && (liquidityUsd?.[index] ?? 0) > 0
        ? liquidityUsd[index]
        : null,
    }));
    const symbols = [hops[0]?.tokenInSymbol, ...hops.map((hop) => hop.tokenOutSymbol)].filter(Boolean);
    const buyLabel = symbols.join(' → ');
    const sellLabel = [...symbols].reverse().join(' → ');
    return { buyLabel, sellLabel, hops };
  }

  private static async buildDeterministicFlapStocksBuyQuoteRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    debug?: boolean;
    depth?: number;
  }): Promise<SwapDescLike[] | null> {
    const topology = await this.resolveFlapStocksQuoteTopology({
      chainId: input.chainId,
      rawQuoteToken: input.targetToken,
      anchorToken: input.currentToken,
      debug: input.debug,
      logEvent: 'buy.route.fixed',
    });
    if (!topology) return null;

    const descs: SwapDescLike[] = [];
    let routeCurrentToken = input.currentToken;
    if (routeCurrentToken.toLowerCase() !== topology.terminalQuoteToken.toLowerCase()) {
      descs.push(await this.resolveRouteHopDesc({
        chainId: input.chainId,
        tokenIn: routeCurrentToken,
        tokenOut: topology.terminalQuoteToken,
        prefer: getBridgeTokenDexPreference(input.chainId as ChainId, topology.terminalQuoteToken) ?? null,
      }));
      routeCurrentToken = topology.terminalQuoteToken;
    }

    this.logFlapStocksRoute(input.debug, 'buy.route.fixed.apply', {
      chainId: input.chainId,
      depth: input.depth ?? 0,
      currentToken: input.currentToken,
      targetToken: input.targetToken,
      terminalQuoteToken: topology.terminalQuoteToken,
      rawQuotePoolAddress: topology.rawQuotePoolAddress,
      rawQuotePoolPrefer: topology.rawQuotePoolPrefer ?? null,
    });
    this.logRoutePool(input.debug, 'buy.fixed.apply', {
      chainId: input.chainId,
      currentToken: input.currentToken,
      targetToken: input.targetToken,
      terminalQuoteToken: topology.terminalQuoteToken,
      pool: topology.rawQuotePoolAddress,
      preferHint: topology.rawQuotePoolPrefer ?? null,
    });
    descs.push(await this.resolveKnownPoolRouteDesc({
      chainId: input.chainId,
      tokenIn: routeCurrentToken,
      tokenOut: input.targetToken,
      poolAddress: topology.rawQuotePoolAddress,
      preferHint: topology.rawQuotePoolPrefer,
      debug: input.debug,
    }));
    return descs;
  }

  private static buildKnownLaunchpadBuyRouteDesc(input: {
    chainId: number;
    tokenIn: Address;
    tokenInfo: TokenInfo;
  }): SwapDescLike | null {
    const classification = this.classifyLaunchpadRoute(input.chainId, input.tokenInfo);
    const platform = classification.platform;
    if (!INNER_LAUNCHPAD_PLATFORMS.has(platform) || !classification.isInner) return null;
    if (classification.isFlap && !hasConfirmedFlapLaunchpadIdentity(input.chainId, input.tokenInfo)) {
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
    visited?: Set<string>;
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
        const prefix = await this.buildFlapOuterBuyQuoteRoute({
          chainId: input.chainId,
          currentToken: input.currentToken,
          targetToken: routeQuoteToken,
          visited: this.cloneVisitedRouteTokens(input.visited, [input.currentToken, input.targetToken]),
          debug: input.debug,
          depth: (input.depth ?? 0) + 1,
        });
        if (!prefix?.length) {
          this.logFlapStocksRoute(input.debug, 'buy.route.v4_non_terminal_quote', {
            chainId: input.chainId,
            depth: input.depth ?? 0,
            currentToken: input.currentToken,
            targetToken: input.targetToken,
            routeQuoteToken,
          });
          return null;
        }
        descs.push(...prefix);
        routeCurrentToken = routeQuoteToken;
      } else {
        descs.push(await this.resolveRouteHopDesc({
          chainId: input.chainId,
          tokenIn: routeCurrentToken,
          tokenOut: routeQuoteToken,
          prefer: getBridgeTokenDexPreference(input.chainId as ChainId, routeQuoteToken) ?? null,
        }));
        routeCurrentToken = routeQuoteToken;
      }
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

  private static mergeFlapTradeTokenInfo(base: TokenInfo, enriched: TokenInfo): TokenInfo {
    return {
      ...base,
      ...enriched,
      chain: base.chain || enriched.chain,
      address: base.address || enriched.address,
      name: base.name || enriched.name,
      symbol: base.symbol || enriched.symbol,
      decimals: base.decimals || enriched.decimals,
      logo: base.logo || enriched.logo,
      website: base.website || enriched.website,
      twitterUrl: base.twitterUrl || enriched.twitterUrl,
      gmgnUrl: base.gmgnUrl || enriched.gmgnUrl,
      launchpad: base.launchpad || enriched.launchpad,
      launchpad_platform: enriched.launchpad_platform || base.launchpad_platform,
      launchpad_status: enriched.launchpad_status ?? base.launchpad_status,
      launchpad_progress: enriched.launchpad_progress ?? base.launchpad_progress,
      quote_token: enriched.quote_token || base.quote_token,
      quote_token_address: enriched.quote_token_address || base.quote_token_address,
      pool_pair: enriched.pool_pair || base.pool_pair,
      biggest_pool_address: enriched.biggest_pool_address || base.biggest_pool_address,
      tpool_pool_address: enriched.tpool_pool_address || base.tpool_pool_address,
      dex_type: enriched.dex_type || base.dex_type,
      nativeToQuoteSwapEnabled: enriched.nativeToQuoteSwapEnabled ?? base.nativeToQuoteSwapEnabled,
      tokenVersion: enriched.tokenVersion ?? base.tokenVersion,
      extensionID: enriched.extensionID ?? base.extensionID,
      dexId: enriched.dexId ?? base.dexId,
      flap_lp_fee_profile: enriched.flap_lp_fee_profile ?? base.flap_lp_fee_profile,
      flap_pool_model: enriched.flap_pool_model ?? base.flap_pool_model,
      flap_pool_compat_address: enriched.flap_pool_compat_address ?? base.flap_pool_compat_address,
      flap_cl_pool_id: enriched.flap_cl_pool_id ?? base.flap_cl_pool_id,
      flap_v4_fee: enriched.flap_v4_fee ?? base.flap_v4_fee,
      flap_v4_tick_spacing: enriched.flap_v4_tick_spacing ?? base.flap_v4_tick_spacing,
      flap_v4_hooks: enriched.flap_v4_hooks ?? base.flap_v4_hooks,
      flap_dividend_token: enriched.flap_dividend_token || base.flap_dividend_token,
      flap_vault_address: enriched.flap_vault_address || base.flap_vault_address,
      flap_vault_factory: enriched.flap_vault_factory || base.flap_vault_factory,
      flap_vault_is_official: enriched.flap_vault_is_official ?? base.flap_vault_is_official,
      flap_vault_is_vault: enriched.flap_vault_is_vault ?? base.flap_vault_is_vault,
      flap_vault_is_ai_consumer: enriched.flap_vault_is_ai_consumer ?? base.flap_vault_is_ai_consumer,
      flap_stocks_vault_version: enriched.flap_stocks_vault_version ?? base.flap_stocks_vault_version,
      flap_outer_quote_is_stocks: enriched.flap_outer_quote_is_stocks ?? base.flap_outer_quote_is_stocks,
      flap_basket_token: enriched.flap_basket_token || base.flap_basket_token,
      flap_supported_assets: enriched.flap_supported_assets ?? base.flap_supported_assets,
      tokenPrice: base.tokenPrice ?? enriched.tokenPrice,
    };
  }

  private static async ensureFlapTradeTokenInfo(chainId: number, tokenInfo: TokenInfo, debug?: boolean): Promise<TokenInfo> {
    const platform = resolveTradeLaunchpadPlatform(tokenInfo);
    if (!platform.startsWith('flap')) return tokenInfo;
    const rawStatus = Number(tokenInfo.launchpad_status ?? Number.NaN);
    const isOuter = Number.isFinite(rawStatus)
      ? rawStatus === 1
      : hasConfirmedFlapOuterRoute(tokenInfo);
    if (!isOuter) return tokenInfo;
    const tokenAddress = this.resolveEvmAddress(tokenInfo.address, 'token address') as Address;
    const enriched = await this.getFlapOuterQuoteTokenInfo(chainId, tokenAddress, debug).catch(() => null);
    if (!enriched) return tokenInfo;
    return this.mergeFlapTradeTokenInfo(tokenInfo, enriched);
  }

  private static async getFlapTokenIdentityInfo(chainId: number, tokenAddress: Address): Promise<Partial<TokenInfo> | null> {
    try {
      const res = await call({
        type: 'token:getTokenInfo:flap',
        chainId,
        tokenAddress,
      } as const);
      if ((res as any)?.ok === false) return null;
      const state = res as unknown as FlapTokenStateV7;
      return {
        address: tokenAddress,
        launchpad: 'flap',
        launchpad_status: Number.isFinite(Number(state?.status ?? Number.NaN))
          ? Number(state?.status)
          : undefined,
        quote_token_address: typeof state?.quoteTokenAddress === 'string' ? state.quoteTokenAddress : undefined,
        pool_pair: isUsableFlapDexPoolAddress(tokenAddress, state?.pool) ? state.pool : undefined,
        nativeToQuoteSwapEnabled: state?.nativeToQuoteSwapEnabled,
        tokenVersion: state?.tokenVersion,
        extensionID: state?.extensionID,
        flap_dividend_token: state?.dividendToken,
        flap_vault_address: state?.vaultAddress,
        flap_vault_factory: state?.vaultFactory,
        flap_vault_is_official: state?.vaultIsOfficial,
        flap_vault_is_vault: state?.vaultIsVault,
        flap_vault_is_ai_consumer: state?.vaultIsAIConsumer,
        flap_stocks_vault_version: state?.stocksVaultVersion,
        flap_basket_token: state?.basketToken,
        flap_supported_assets: state?.supportedAssets,
      };
    } catch {
      return null;
    }
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
          && isUsableFlapDexPoolAddress(tokenAddress, onchain.pool)
          ? onchain.pool
          : undefined;
        const hasKnownPoolAddress = (info?: Pick<TokenInfo, 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null) =>
          !!(info?.pool_pair || info?.biggest_pool_address || info?.tpool_pool_address);
        const hasRouteMinimum = (info?: Pick<TokenInfo, 'quote_token_address' | 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null) =>
          !!(info?.quote_token_address && hasKnownPoolAddress(info));

        let officialInfo: TokenInfo | null = null;
        let tradeInfo: TokenInfo | null = null;
        if (!onchainPoolPair || !onchainQuoteTokenAddress) {
          tradeInfo = await GmgnAPI.getTokenTradeInfo(chain, tokenAddress).catch(() => null);
          if (!hasRouteMinimum(tradeInfo) || (!tradeInfo?.quote_token_address && !onchainQuoteTokenAddress)) {
            officialInfo = await FlapAPI.getTokenInfo(chain, tokenAddress).catch(() => null);
          }
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
          const mergedVaultIsVault = onchain?.vaultIsVault;
        const mergedVaultIsAIConsumer = onchain?.vaultIsAIConsumer;
        const mergedStocksVaultVersion = onchain?.stocksVaultVersion;
        const mergedBasketToken = onchain?.basketToken;
        const mergedSupportedAssets = onchain?.supportedAssets;
          const rawOnchainLaunchpadStatus = Number(onchain?.status ?? Number.NaN);
          const onchainHasOuterPool = hasConfirmedFlapOuterRoute({
            address: tokenAddress,
            flap_pool_model: mergedPoolModel,
            flap_pool_compat_address: mergedPoolCompatAddress,
            flap_cl_pool_id: mergedClPoolId,
            flap_v4_fee: mergedV4Fee,
            flap_v4_tick_spacing: mergedV4TickSpacing,
            pool_pair: onchainPoolPair,
          });
          const onchainLaunchpadStatus = Number.isFinite(rawOnchainLaunchpadStatus)
            ? rawOnchainLaunchpadStatus
            : null;
        const officialLaunchpadStatus = Number(officialInfo?.launchpad_status ?? Number.NaN);
        const tradeLaunchpadStatus = Number(tradeInfo?.launchpad_status ?? Number.NaN);
        const mergedLaunchpad = officialInfo?.launchpad || tradeInfo?.launchpad || 'flap';
          const directLaunchpadPlatform = resolveFlapPlatform(chainId, {
            address: tokenAddress,
            launchpad_platform: officialInfo?.launchpad_platform || tradeInfo?.launchpad_platform || mergedLaunchpad,
            launchpad_status: onchainLaunchpadStatus != null
              ? onchainLaunchpadStatus
              : Number.isFinite(officialLaunchpadStatus)
                ? officialLaunchpadStatus
                : Number.isFinite(tradeLaunchpadStatus)
                  ? tradeLaunchpadStatus
                  : undefined,
            quote_token_address: mergedQuoteTokenAddress,
            pool_pair: mergedPoolPair,
            biggest_pool_address: officialInfo?.biggest_pool_address || tradeInfo?.biggest_pool_address,
            tpool_pool_address: officialInfo?.tpool_pool_address || tradeInfo?.tpool_pool_address,
            flap_pool_model: mergedPoolModel,
            flap_pool_compat_address: mergedPoolCompatAddress,
            flap_cl_pool_id: mergedClPoolId,
            flap_v4_fee: mergedV4Fee,
            flap_v4_tick_spacing: mergedV4TickSpacing,
            flap_stocks_vault_version: mergedStocksVaultVersion,
            flap_dividend_token: mergedDividendToken,
            flap_vault_address: mergedVaultAddress,
            flap_vault_factory: mergedVaultFactory,
            flap_vault_is_official: mergedVaultIsOfficial,
            flap_vault_is_vault: mergedVaultIsVault,
            flap_basket_token: mergedBasketToken,
            flap_supported_assets: mergedSupportedAssets,
          }, officialInfo?.launchpad_platform || tradeInfo?.launchpad_platform || mergedLaunchpad);
          const mergedLaunchpadPlatform = await resolveFlapPlatformByQuoteLineage(
            chainId,
            {
              address: tokenAddress,
              launchpad_platform: officialInfo?.launchpad_platform || tradeInfo?.launchpad_platform || mergedLaunchpad,
                launchpad_status: onchainLaunchpadStatus != null
                  ? onchainLaunchpadStatus
                  : Number.isFinite(officialLaunchpadStatus)
                    ? officialLaunchpadStatus
                    : Number.isFinite(tradeLaunchpadStatus)
                      ? tradeLaunchpadStatus
                      : undefined,
              quote_token_address: mergedQuoteTokenAddress,
              pool_pair: mergedPoolPair,
              biggest_pool_address: officialInfo?.biggest_pool_address || tradeInfo?.biggest_pool_address,
              tpool_pool_address: officialInfo?.tpool_pool_address || tradeInfo?.tpool_pool_address,
              flap_pool_model: mergedPoolModel,
              flap_pool_compat_address: mergedPoolCompatAddress,
              flap_cl_pool_id: mergedClPoolId,
              flap_v4_fee: mergedV4Fee,
              flap_v4_tick_spacing: mergedV4TickSpacing,
              flap_stocks_vault_version: mergedStocksVaultVersion,
              flap_dividend_token: mergedDividendToken,
              flap_vault_address: mergedVaultAddress,
              flap_vault_factory: mergedVaultFactory,
              flap_vault_is_official: mergedVaultIsOfficial,
              flap_vault_is_vault: mergedVaultIsVault,
              flap_basket_token: mergedBasketToken,
              flap_supported_assets: mergedSupportedAssets,
            },
            officialInfo?.launchpad_platform || tradeInfo?.launchpad_platform || mergedLaunchpad,
            async (quoteTokenAddress) => {
              if (quoteTokenAddress.toLowerCase() === tokenAddress.toLowerCase()) return null;
              return await this.getFlapTokenIdentityInfo(chainId, quoteTokenAddress);
            },
          );
          const mergedOuterQuoteIsStocks = directLaunchpadPlatform !== 'flap_stocks' && mergedLaunchpadPlatform === 'flap_stocks';
          const mergedLaunchpadStatus = onchainLaunchpadStatus != null
            ? onchainLaunchpadStatus
            : Number.isFinite(officialLaunchpadStatus)
            ? officialLaunchpadStatus
            : Number.isFinite(tradeLaunchpadStatus)
              ? tradeLaunchpadStatus
              : null;
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
              flap_vault_is_vault: mergedVaultIsVault,
            flap_vault_is_ai_consumer: mergedVaultIsAIConsumer,
            flap_stocks_vault_version: mergedStocksVaultVersion,
            flap_outer_quote_is_stocks: mergedOuterQuoteIsStocks || undefined,
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
            mergedOuterQuoteIsStocks: mergedInfo.flap_outer_quote_is_stocks ?? null,
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

  private static getAllowedRouterV3Factories(chainId: number): Address[] {
    const deploys = DeployAddress[chainId as ChainId] ?? {};
    return [
      deploys[ContractNames.PancakeFactoryV3]?.address,
      deploys[ContractNames.UniswapFactoryV3]?.address,
    ].filter((value): value is Address => !!value && isAddressLike(value));
  }

  private static isAllowedRouterV3Factory(chainId: number, factory?: Address | null): factory is Address {
    if (!factory || !isAddressLike(factory)) return false;
    const lower = factory.toLowerCase();
    return this.getAllowedRouterV3Factories(chainId).some((item) => item.toLowerCase() === lower);
  }

  private static async getKnownPoolRouteMeta(
    chainId: number,
    poolAddress: Address,
    preferHint?: 'v2' | 'v3' | null
  ): Promise<{ prefer: 'v2' | 'v3'; fee?: number; v3Factory?: Address } | null> {
    const key = `${chainId}:${poolAddress.toLowerCase()}:${preferHint ?? 'auto'}`;
    let task = this.flapKnownPoolMetaCache.get(key);
    if (!task) {
      task = (async () => {
        const client = await RpcService.getClient(chainId);
        try {
          const [feeRaw, factoryRaw] = await Promise.all([
            client.readContract({
              address: poolAddress,
              abi: poolV3Abi,
              functionName: 'fee',
            }),
            client.readContract({
              address: poolAddress,
              abi: poolV3Abi,
              functionName: 'factory',
            }).catch(() => ZERO_ADDRESS),
          ]);
          const fee = Number(feeRaw);
          const v3Factory = isAddressLike(factoryRaw) && factoryRaw !== ZERO_ADDRESS
            ? factoryRaw as Address
            : undefined;
          if (Number.isFinite(fee) && fee > 0) {
            return { prefer: 'v3' as const, fee, v3Factory };
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
    debug?: boolean;
  }): Promise<SwapDescLike> {
    const meta = await this.getKnownPoolRouteMeta(input.chainId, input.poolAddress, input.preferHint);
    if (!meta) {
      throw new Error(`找不到 ${input.tokenIn}/${input.tokenOut} 的交易池`);
    }
    if (meta.prefer === 'v3' && meta.v3Factory && !this.isAllowedRouterV3Factory(input.chainId, meta.v3Factory)) {
      this.logRoutePool(input.debug, 'pool.desc.reject_factory', {
        chainId: input.chainId,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        pool: input.poolAddress,
        preferHint: input.preferHint ?? null,
        fee: meta.fee ?? null,
        factory: meta.v3Factory,
      });
      throw new Error(`找不到 ${input.tokenIn}/${input.tokenOut} 的 Pancake/Uniswap V3 交易池`);
    }
    const desc = getRouterSwapDesc({
      swapType: meta.prefer === 'v3' ? SwapType.V3_EXACT_IN : SwapType.V2_EXACT_IN,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      poolAddress: input.poolAddress,
      fee: meta.prefer === 'v3' ? (meta.fee ?? getDefaultBridgeV3Fee(input.chainId)) : 0,
      poolManager: meta.prefer === 'v3' && this.isAllowedRouterV3Factory(input.chainId, meta.v3Factory)
        ? meta.v3Factory
        : ZERO_ADDRESS,
    });
    this.logRoutePool(input.debug, 'pool.desc', {
      chainId: input.chainId,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      pool: desc.poolAddress,
      preferHint: input.preferHint ?? null,
      metaPrefer: meta.prefer,
      fee: desc.fee,
      factory: desc.poolManager,
      swapType: desc.swapType,
    });
    return desc;
  }

  private static async attachV3FactoriesToDescs(chainId: number, descs: SwapDescLike[]): Promise<SwapDescLike[]> {
    return await Promise.all(descs.map(async (desc) => {
      if (desc.swapType !== SwapType.V3_EXACT_IN) return desc;
      if (!desc.poolAddress || desc.poolAddress === ZERO_ADDRESS) return desc;
      if (desc.poolManager && desc.poolManager !== ZERO_ADDRESS) {
        if (!this.isAllowedRouterV3Factory(chainId, desc.poolManager)) {
          throw new Error('该 V3 池不属于 Pancake/Uniswap，当前路由无法成交');
        }
        return desc;
      }
      const meta = await this.getKnownPoolRouteMeta(chainId, desc.poolAddress, 'v3');
      const factory = meta?.v3Factory;
      if (!factory) return desc;
      if (!this.isAllowedRouterV3Factory(chainId, factory)) {
        throw new Error('该 V3 池不属于 Pancake/Uniswap，当前路由无法成交');
      }
      return { ...desc, poolManager: factory };
    }));
  }

  private static isFlapOuterRouteTerminalToken(chainId: number, tokenAddress: Address): boolean {
    const lower = tokenAddress.toLowerCase();
    if (lower === ZERO_ADDRESS.toLowerCase()) return true;
    if (lower === getChainRuntime(chainId).wrappedNativeAddress.toLowerCase()) return true;
    return getBridgeTokenAddresses(chainId as ChainId).some((x) => x.toLowerCase() === lower);
  }

  private static normalizeFlapQuoteTokenAddress(chainId: number, quoteTokenAddress?: string): Address | null {
    const raw = typeof quoteTokenAddress === 'string' ? quoteTokenAddress.trim() : '';
    if (this.isLikelySentinelFlapQuoteToken(raw)) return null;
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
    const dex = String(pair.dexId || '').toLowerCase();
    const raw = [
      dex,
      Array.isArray(pair.labels) ? pair.labels.join(' ') : '',
      String(pair.url || ''),
    ].join(' ').toLowerCase();
    const isV3 = raw.includes('v3') || raw.includes('clmm') || /(^|[^a-z])cl([^a-z]|$)/.test(raw);
    if (dex.includes('uniswap')) return isV3 ? 'UNISWAP_V3' : 'UNISWAP';
    if (isV3) return 'PANCAKE_SWAP_V3';
    return 'PANCAKE_SWAP';
  }

  private static isDexScreenerAmmPair(pair: DexScreenerPair): boolean {
    const dex = String(pair.dexId || '').toLowerCase();
    if (!dex) return false;
    return !/(fourmeme|flapsh|pumpfun|moonshot|virtuals|clanker|sunpump)/.test(dex);
  }

  private static isRouterSupportedDexScreenerPair(chainId: number, pair: DexScreenerPair): boolean {
    if (!this.isDexScreenerAmmPair(pair)) return false;
    const dex = String(pair.dexId || '').toLowerCase();
    if (chainId === ChainId.BNB) return dex.includes('pancake') || dex.includes('uniswap');
    if (chainId === ChainId.ETH) return dex.includes('uniswap');
    if (chainId === ChainId.HYPER) return dex.includes('uniswap') || dex.includes('hyperswap') || dex.includes('prjx');
    return true;
  }

  private static getDexScreenerCounterpartyToken(pair: DexScreenerPair, tokenAddress: Address): Address | null {
    const tokenLower = tokenAddress.toLowerCase();
    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;
    if (isAddressLike(base) && base.toLowerCase() !== tokenLower) return base as Address;
    if (isAddressLike(quote) && quote.toLowerCase() !== tokenLower) return quote as Address;
    return null;
  }

  private static toDexScreenerPairToken(chainId: number, token?: string | null): Address | null {
    if (!isAddressLike(token)) return null;
    const normalized = this.normalizeFlapPoolCounterpartyToken(chainId, token);
    if (!normalized) return token as Address;
    if (normalized.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
      return getChainRuntime(chainId).wrappedNativeAddress as Address;
    }
    return normalized;
  }

  private static async resolveBestDexScreenerPairBetweenTokens(input: {
    chainId: number;
    chain: string;
    tokenAddress: Address;
    counterparty: Address;
  }): Promise<{
    pair: DexScreenerPair;
    counterparty: Address;
    liquidityUsd: number;
    preferHint: 'v2' | 'v3' | null;
  } | null> {
    const queryCounterparty = this.toDexScreenerPairToken(input.chainId, input.counterparty);
    if (!queryCounterparty) return null;
    if (queryCounterparty.toLowerCase() === input.tokenAddress.toLowerCase()) return null;
    const pair = await DexScreenerAPI.getBestPairBetweenTokens(input.chain, input.tokenAddress, queryCounterparty).catch(() => null);
    if (!pair?.pairAddress || !isAddressLike(pair.pairAddress)) return null;
    if (!this.isRouterSupportedDexScreenerPair(input.chainId, pair)) return null;
    const rawCounterparty = this.getDexScreenerCounterpartyToken(pair, input.tokenAddress);
    if (!rawCounterparty) return null;
    const counterparty = this.normalizeFlapPoolCounterpartyToken(input.chainId, rawCounterparty) ?? rawCounterparty;
    const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
    if (liquidityUsd < FLAP_DEXSCREENER_MIN_LIQUIDITY_USD) return null;
    return {
      pair,
      counterparty,
      liquidityUsd,
      preferHint: this.normalizeDexPrefer(this.mapDexScreenerPairDexType(pair)),
    };
  }

  private static isEquivalentFlapRouteToken(chainId: number, left?: string | null, right?: string | null): boolean {
    const normalizedLeft = this.normalizeFlapPoolCounterpartyToken(chainId, left);
    const normalizedRight = this.normalizeFlapPoolCounterpartyToken(chainId, right);
    if (normalizedLeft && normalizedRight) {
      return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
    }
    const rawLeft = String(left || '').trim().toLowerCase();
    const rawRight = String(right || '').trim().toLowerCase();
    return !!rawLeft && rawLeft === rawRight;
  }

  private static cloneVisitedRouteTokens(visited: Set<string> | undefined, extra: Array<string | null | undefined>): Set<string> {
    const next = new Set(visited ?? []);
    for (const token of extra) {
      const lowered = String(token || '').trim().toLowerCase();
      if (lowered) next.add(lowered);
    }
    return next;
  }

  private static async selectDexScreenerQuoteHops(input: {
    chainId: number;
    tokenAddress: Address;
    currentToken?: Address | null;
    excludeTokens?: Set<string>;
    preferTerminalOnly?: boolean;
    debug?: boolean;
  }): Promise<DexScreenerQuoteHop[]> {
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return [];

    const tokenLower = input.tokenAddress.toLowerCase();
    const pairs = await DexScreenerAPI.getPairsByToken(chain, input.tokenAddress).catch(() => []);
    const counterparties: Address[] = [];
    const seenCounterparties = new Set<string>();
    const addCounterparty = (token?: string | null) => {
      const queryToken = this.toDexScreenerPairToken(input.chainId, token);
      if (!queryToken) return;
      if (queryToken.toLowerCase() === tokenLower) return;
      const routeToken = this.normalizeFlapPoolCounterpartyToken(input.chainId, queryToken) ?? queryToken;
      const routeLower = routeToken.toLowerCase();
      if (input.excludeTokens?.has(routeLower) || input.excludeTokens?.has(queryToken.toLowerCase())) return;
      if (seenCounterparties.has(queryToken.toLowerCase())) return;
      seenCounterparties.add(queryToken.toLowerCase());
      counterparties.push(queryToken);
    };

    addCounterparty(input.currentToken);
    for (const token of this.getPreferredDexCounterpartyCandidates(input.chainId, input.currentToken ?? ZERO_ADDRESS)) {
      addCounterparty(token);
    }
    for (const pair of pairs) {
      addCounterparty(this.getDexScreenerCounterpartyToken(pair, input.tokenAddress));
    }

    const resolved = (await Promise.all(counterparties.map(async (counterparty) => {
      const best = await this.resolveBestDexScreenerPairBetweenTokens({
        chainId: input.chainId,
        chain,
        tokenAddress: input.tokenAddress,
        counterparty,
      });
      if (!best) return null;
      const isCurrent = this.isEquivalentFlapRouteToken(input.chainId, best.counterparty, input.currentToken);
      const isTerminal = this.isFlapOuterRouteTerminalToken(input.chainId, best.counterparty);
      if (input.preferTerminalOnly && !isCurrent && !isTerminal) return null;
      return {
        poolAddress: best.pair.pairAddress as Address,
        counterparty: best.counterparty,
        preferHint: best.preferHint,
        liquidityUsd: best.liquidityUsd,
        rank: isCurrent ? 0 : isTerminal ? 1 : 2,
        dexId: best.pair.dexId,
        labels: best.pair.labels ?? [],
      };
    }))).filter(Boolean) as Array<DexScreenerQuoteHop & { rank: number; dexId?: string; labels: string[] }>;

    resolved.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.liquidityUsd !== b.liquidityUsd) return b.liquidityUsd - a.liquidityUsd;
      return 0;
    });

    const unique: DexScreenerQuoteHop[] = [];
    const seenHops = new Set<string>();
    for (const hop of resolved) {
      const key = `${hop.poolAddress.toLowerCase()}:${hop.counterparty.toLowerCase()}`;
      if (seenHops.has(key)) continue;
      seenHops.add(key);
      unique.push({
        poolAddress: hop.poolAddress,
        counterparty: hop.counterparty,
        preferHint: hop.preferHint,
        liquidityUsd: hop.liquidityUsd,
      });
      if (unique.length >= FLAP_DEXSCREENER_MAX_HOP_CANDIDATES) break;
    }

    this.logRoutePool(input.debug, 'dex.hops', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      currentToken: input.currentToken ?? null,
      preferTerminalOnly: input.preferTerminalOnly === true,
      method: 'best_pair_between_tokens',
      counterpartyCount: counterparties.length,
      consideredHopCount: resolved.length,
      keptHopCount: unique.length,
      counterparties,
      consideredHops: resolved.slice(0, 10).map((hop) => ({
        pool: hop.poolAddress,
        counterparty: hop.counterparty,
        preferHint: hop.preferHint,
        liquidityUsd: hop.liquidityUsd,
        rank: hop.rank,
        dexId: hop.dexId ?? null,
        labels: hop.labels,
      })),
      keptHops: unique.map((hop) => ({
        pool: hop.poolAddress,
        counterparty: hop.counterparty,
        preferHint: hop.preferHint,
        liquidityUsd: hop.liquidityUsd,
      })),
    });
    if (unique.length) {
      this.logFlapStocksRoute(input.debug, 'dex.route.hops', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        currentToken: input.currentToken ?? null,
        preferTerminalOnly: input.preferTerminalOnly === true,
        hopCount: unique.length,
        topCounterparty: unique[0]?.counterparty ?? null,
        topPool: unique[0]?.poolAddress ?? null,
        topLiquidityUsd: unique[0]?.liquidityUsd ?? null,
        consideredPairCount: resolved.length,
      });
    } else if (input.currentToken) {
      this.logFlapStocksRoute(input.debug, 'dex.route.no_hops', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        currentToken: input.currentToken ?? null,
        pairCount: pairs.length,
      });
    }
    return unique;
  }

  private static async assembleBuyRouteViaDexHop(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    hop: DexScreenerQuoteHop;
    visited?: Set<string>;
    debug?: boolean;
    depth?: number;
  }): Promise<SwapDescLike[] | null> {
    const descs: SwapDescLike[] = [];
    const viaToken = input.hop.counterparty;
    if (!this.isEquivalentFlapRouteToken(input.chainId, input.currentToken, viaToken)) {
      if (this.isFlapOuterRouteTerminalToken(input.chainId, viaToken)) {
        descs.push(await this.resolveRouteHopDesc({
          chainId: input.chainId,
          tokenIn: input.currentToken,
          tokenOut: viaToken,
          prefer: getBridgeTokenDexPreference(input.chainId as ChainId, viaToken) ?? null,
        }));
      } else {
        const prefix = await this.buildFlapOuterBuyQuoteRoute({
          chainId: input.chainId,
          currentToken: input.currentToken,
          targetToken: viaToken,
          visited: this.cloneVisitedRouteTokens(input.visited, [input.currentToken, input.targetToken]),
          debug: input.debug,
          depth: (input.depth ?? 0) + 1,
        });
        if (!prefix?.length) return null;
        descs.push(...prefix);
      }
    }

    const hopTokenIn = this.isEquivalentFlapRouteToken(input.chainId, input.currentToken, viaToken)
      ? input.currentToken
      : viaToken;
    descs.push(await this.resolveKnownPoolRouteDesc({
      chainId: input.chainId,
      tokenIn: hopTokenIn,
      tokenOut: input.targetToken,
      poolAddress: input.hop.poolAddress,
      preferHint: input.hop.preferHint,
      debug: input.debug,
    }));
    return descs;
  }

  private static async getDexScreenerOuterQuoteFallback(input: {
    chain: string;
    chainId: number;
    tokenAddress: Address;
    preferredQuoteToken?: Address | null;
  }): Promise<{ quoteTokenAddress?: Address; poolPair?: Address; dexType?: string } | null> {
    if (input.chainId !== ChainId.BNB) return null;

    const candidates: Address[] = [];
    const seenCandidates = new Set<string>();
    for (const value of [
      input.preferredQuoteToken ?? null,
      this.getDefaultFlapStocksBridgeToken(input.chainId),
      ...this.getQuoteBridgeCandidates(input.chainId, input.tokenAddress, ZERO_ADDRESS),
    ]) {
      const queryToken = this.toDexScreenerPairToken(input.chainId, value);
      if (!queryToken) continue;
      const lowered = queryToken.toLowerCase();
      if (lowered === input.tokenAddress.toLowerCase() || seenCandidates.has(lowered)) continue;
      seenCandidates.add(lowered);
      candidates.push(queryToken);
    }

    const pairs = (await Promise.all(candidates.map(async (quoteTokenAddress) => {
      const pair = await DexScreenerAPI.getBestPairBetweenTokens(input.chain, input.tokenAddress, quoteTokenAddress).catch(() => null);
      if (!pair?.pairAddress || !isAddressLike(pair.pairAddress)) return null;
      if (!this.isRouterSupportedDexScreenerPair(input.chainId, pair)) return null;
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
    tokenInfo?: Pick<TokenInfo, 'address' | 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address' | 'dex_type'> | null;
    preferOnchainPool?: boolean;
    pairOnly?: boolean;
    debug?: boolean;
    logEvent?: string;
  }): Promise<{ poolAddress: Address | null; preferHint: 'v2' | 'v3' | null; fee?: number; liquidityUsd?: number; symbols?: Record<string, string> }> {
    const fallbackPool = input.pairOnly ? null : this.getKnownDexPoolAddress(input.tokenInfo);
    const fallbackPrefer = input.pairOnly ? null : this.normalizeDexPrefer(input.tokenInfo?.dex_type);
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();

    if (input.preferOnchainPool && fallbackPool) {
      const counterparty = await this.primeKnownPoolCounterpartyToken(
        input.chainId,
        fallbackPool,
        input.tokenAddress,
        input.debug,
      );
      if (counterparty && this.isEquivalentFlapRouteToken(input.chainId, counterparty, input.quoteTokenAddress)) {
        const fallbackMeta = await this.getKnownPoolRouteMeta(input.chainId, fallbackPool, fallbackPrefer);
        this.logRoutePool(input.debug, 'preferred_pool.selected', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          quoteTokenAddress: input.quoteTokenAddress,
          source: input.logEvent ?? 'target.pool.selected',
          pickedFrom: 'onchain_official',
          pool: fallbackPool,
          preferHint: fallbackMeta?.prefer ?? fallbackPrefer ?? null,
          fee: fallbackMeta?.fee ?? null,
        });
        return {
          poolAddress: fallbackPool,
          preferHint: fallbackMeta?.prefer ?? fallbackPrefer,
          fee: fallbackMeta?.fee,
        };
      }
    }

    if (chain) {
      const queryQuoteToken = this.toDexScreenerPairToken(input.chainId, input.quoteTokenAddress) ?? input.quoteTokenAddress;
      const dexPair = await DexScreenerAPI.getBestPairBetweenTokens(chain, input.tokenAddress, queryQuoteToken).catch(() => null);
      const pairAddress = dexPair?.pairAddress && isAddressLike(dexPair.pairAddress)
        ? (dexPair.pairAddress as Address)
        : null;
      const supported = !!dexPair && this.isRouterSupportedDexScreenerPair(input.chainId, dexPair);
      this.logRoutePool(input.debug, 'preferred_pool.dexscreener', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        quoteTokenAddress: input.quoteTokenAddress,
        source: input.logEvent ?? 'target.pool.selected',
        pool: pairAddress,
        dexId: dexPair?.dexId ?? null,
        labels: dexPair?.labels ?? [],
        liquidityUsd: Number(dexPair?.liquidity?.usd ?? 0),
        supported,
        fallbackPool: fallbackPool ?? null,
        fallbackPrefer: fallbackPrefer ?? null,
      });
      const pairCounterparty = dexPair
        ? this.getDexScreenerCounterpartyToken(dexPair, input.tokenAddress)
        : null;
      const pairMatchesQuote = !!pairCounterparty
        && this.isEquivalentFlapRouteToken(input.chainId, pairCounterparty, input.quoteTokenAddress);
      if (pairAddress && supported && dexPair && pairMatchesQuote) {
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
        this.logRoutePool(input.debug, 'preferred_pool.selected', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          quoteTokenAddress: input.quoteTokenAddress,
          source: input.logEvent ?? 'target.pool.selected',
          pickedFrom: 'dexscreener',
          pool: pairAddress,
          preferHint: pairMeta?.prefer ?? pairPrefer ?? null,
          fee: pairMeta?.fee ?? null,
          factory: pairMeta?.v3Factory ?? null,
        });
        return {
          poolAddress: pairAddress,
          preferHint: pairMeta?.prefer ?? pairPrefer,
          fee: pairMeta?.fee,
          liquidityUsd: Number(dexPair.liquidity?.usd ?? 0) || undefined,
          symbols: this.collectDexScreenerPairSymbols(input.chainId, dexPair),
        };
      }
    }

    const fallbackMeta = fallbackPool
      ? await this.getKnownPoolRouteMeta(input.chainId, fallbackPool, fallbackPrefer)
      : null;
    const fallbackCounterparty = fallbackPool
      ? await this.primeKnownPoolCounterpartyToken(input.chainId, fallbackPool, input.tokenAddress, input.debug)
      : null;
    const fallbackMatchesQuote = !!fallbackCounterparty
      && this.isEquivalentFlapRouteToken(input.chainId, fallbackCounterparty, input.quoteTokenAddress);
    this.logFlapStocksRoute(input.debug, input.logEvent ?? 'target.pool.selected', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      quoteTokenAddress: input.quoteTokenAddress,
      source: fallbackMatchesQuote ? 'token_info' : 'none',
      poolAddress: fallbackMatchesQuote ? fallbackPool : null,
      prefer: fallbackMatchesQuote ? (fallbackMeta?.prefer ?? fallbackPrefer ?? null) : null,
      fee: fallbackMatchesQuote ? (fallbackMeta?.fee ?? null) : null,
      fallbackPool: fallbackPool ?? null,
      fallbackPrefer: fallbackPrefer ?? null,
      fallbackCounterparty: fallbackCounterparty ?? null,
    });
    this.logRoutePool(input.debug, 'preferred_pool.selected', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      quoteTokenAddress: input.quoteTokenAddress,
      source: input.logEvent ?? 'target.pool.selected',
      pickedFrom: fallbackMatchesQuote ? 'token_info' : 'none',
      pool: fallbackMatchesQuote ? fallbackPool : null,
      preferHint: fallbackMatchesQuote ? (fallbackMeta?.prefer ?? fallbackPrefer ?? null) : null,
      fee: fallbackMatchesQuote ? (fallbackMeta?.fee ?? null) : null,
      factory: fallbackMatchesQuote ? (fallbackMeta?.v3Factory ?? null) : null,
      fallbackPool: fallbackPool ?? null,
      fallbackCounterparty: fallbackCounterparty ?? null,
    });
    if (!fallbackMatchesQuote) {
      return {
        poolAddress: null,
        preferHint: null,
        fee: undefined,
      };
    }
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

    const counterparties: Address[] = [];
    const seenCounterparties = new Set<string>();
    const addCounterparty = (token?: string | null) => {
      const queryToken = this.toDexScreenerPairToken(input.chainId, token);
      if (!queryToken || queryToken.toLowerCase() === tokenLower) return;
      if (seenCounterparties.has(queryToken.toLowerCase())) return;
      seenCounterparties.add(queryToken.toLowerCase());
      counterparties.push(queryToken);
    };
    for (const token of preferredCounterparties) addCounterparty(token);
    for (const pair of pairs) addCounterparty(this.getDexScreenerCounterpartyToken(pair, input.tokenAddress));

    const candidates = (await Promise.all(counterparties.map(async (counterparty) => {
      const best = await this.resolveBestDexScreenerPairBetweenTokens({
        chainId: input.chainId,
        chain,
        tokenAddress: input.tokenAddress,
        counterparty,
      });
      if (!best) return null;
      const routeCounterparty = this.toDexScreenerPairToken(input.chainId, best.counterparty) ?? best.counterparty;
      const preferredIndex = preferredCounterparties.findIndex((item) => item.toLowerCase() === routeCounterparty.toLowerCase());
      const baseAddr = String(best.pair.baseToken?.address || '').toLowerCase();
      const quoteAddr = String(best.pair.quoteToken?.address || '').toLowerCase();
      const tokenRef = baseAddr === tokenLower ? best.pair.baseToken : quoteAddr === tokenLower ? best.pair.quoteToken : null;
      if (!tokenRef) return null;
      return {
        pair: best.pair,
        counterparty: best.counterparty,
        tokenRef,
        priority: preferredIndex >= 0 ? preferredIndex : Number.MAX_SAFE_INTEGER,
        liquidity: best.liquidityUsd,
      };
    }))).filter(Boolean) as Array<{
      pair: DexScreenerPair;
      counterparty: Address;
      tokenRef: DexScreenerTokenRef;
      priority: number;
      liquidity: number;
    }>;

    const selected = [...candidates].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.liquidity - a.liquidity;
    })[0];

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
    this.logRoutePool(input.debug, 'dex.token_info.selected', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      method: 'best_pair_between_tokens',
      pool: selected.pair.pairAddress,
      counterparty: selected.counterparty,
      liquidityUsd: selected.liquidity,
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

  private static getKnownDexPoolAddress(tokenInfo?: Partial<Pick<TokenInfo, 'address' | 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address' | 'launchpad' | 'launchpad_platform' | 'launchpad_status'>> | null): Address | null {
    const launchpadPlatform = tokenInfo ? resolveTradeLaunchpadPlatform(tokenInfo as TokenInfo) : '';
    const preferBiggestFirst = Number(tokenInfo?.launchpad_status ?? 0) === 1
      && typeof launchpadPlatform === 'string'
      && launchpadPlatform.toLowerCase().startsWith('flap');
    const tokenAddress = typeof tokenInfo?.address === 'string' ? tokenInfo.address : undefined;
    const candidates = preferBiggestFirst
      ? [
        tokenInfo?.biggest_pool_address,
        tokenInfo?.pool_pair,
        tokenInfo?.tpool_pool_address,
      ]
      : [
        tokenInfo?.pool_pair,
        tokenInfo?.biggest_pool_address,
        tokenInfo?.tpool_pool_address,
      ];
    const picked = (() => {
      for (const candidate of candidates) {
        if (this.isFlapCompatPoolAddress(candidate)) continue;
        if (tokenAddress) {
          if (isUsableFlapDexPoolAddress(tokenAddress, candidate)) return candidate as Address;
          continue;
        }
        if (isAddressLike(candidate)) return candidate as Address;
      }
      return null;
    })();
    return picked;
  }

  private static logFlapStocksRoute(debug: boolean | undefined, event: string, payload: Record<string, unknown>) {
    if (!debug) return;
    console.info(`[trade.flapstocks.route][${event}]`, payload);
  }

  private static logRoutePool(debug: boolean | undefined, event: string, payload: Record<string, unknown>) {
    if (!debug) return;
    console.info(`[trade.route.pool][${event}]`, payload);
  }

  private static summarizeRouteDescs(descs: SwapDescLike[]) {
    return descs.map((desc, i) => ({
      i,
      swapType: desc.swapType,
      tokenIn: desc.tokenIn,
      tokenOut: desc.tokenOut,
      pool: desc.poolAddress,
      fee: desc.fee,
      poolManager: desc.poolManager,
    }));
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

  private static reverseSwapType(swapType: number): number {
    if (swapType === SwapType.FOUR_MEME_BUY_AMAP) return SwapType.FOUR_MEME_SELL;
    if (swapType === SwapType.FOUR_MEME_SELL) return SwapType.FOUR_MEME_BUY_AMAP;
    return swapType;
  }

  private static reverseOpenFourSwapData(data: `0x${string}` | undefined): `0x${string}` {
    if (!data || data === '0x') return data ?? '0x';
    try {
      const decoded = decodeAbiParameters(
        parseAbiParameters('bool isBuy, uint256 minAmountOut, uint256 options, bytes proof'),
        data,
      );
      return encodeOpenFourSwapData(!decoded[0], 0n, decoded[2], decoded[3] as `0x${string}`);
    } catch {
      return data;
    }
  }

  private static reverseSwapDescLike(desc: SwapDescLike): SwapDescLike {
    const swapType = this.reverseSwapType(desc.swapType);
    let data = desc.data;
    if (desc.swapType === SwapType.OPEN_FOUR_EXACT_IN) {
      data = this.reverseOpenFourSwapData(desc.data);
    } else if (desc.swapType === SwapType.FOUR_MEME_BUY_AMAP || desc.swapType === SwapType.FOUR_MEME_SELL) {
      data = '0x';
    }
    return {
      ...desc,
      swapType,
      tokenIn: desc.tokenOut,
      tokenOut: desc.tokenIn,
      data,
    };
  }

  private static reverseSwapDescRoute(descs: SwapDescLike[] | null): SwapDescLike[] | null {
    if (!descs) return null;
    return descs.map((desc) => this.reverseSwapDescLike(desc)).reverse();
  }

  private static makeFlapPoolCounterpartyCacheKey(chainId: number, poolAddress: Address, tokenAddress: Address) {
    return [
      chainId,
      poolAddress.toLowerCase(),
      tokenAddress.toLowerCase(),
    ].join(':');
  }

  private static async buildOfficialQuoteLineageRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    officialQuote: Address;
    visited?: Set<string>;
    debug?: boolean;
    depth?: number;
    amountIn?: bigint;
  }): Promise<SwapDescLike[] | null> {
    const { chainId, currentToken, targetToken, officialQuote, debug } = input;
    const depth = input.depth ?? 0;
    const descs: SwapDescLike[] = [];
    let routeCurrentToken = currentToken;
    if (!this.isEquivalentFlapRouteToken(chainId, routeCurrentToken, officialQuote)) {
      if (this.isFlapOuterRouteTerminalToken(chainId, officialQuote)) {
        descs.push(await this.resolveRouteHopDesc({
          chainId,
          tokenIn: routeCurrentToken,
          tokenOut: officialQuote,
          prefer: getBridgeTokenDexPreference(chainId as ChainId, officialQuote) ?? null,
        }));
      } else {
        const prefix = await this.buildFlapOuterBuyQuoteRoute({
          chainId,
          currentToken,
          targetToken: officialQuote,
          visited: this.cloneVisitedRouteTokens(input.visited, [currentToken, targetToken]),
          debug,
          depth: depth + 1,
          amountIn: input.amountIn,
        });
        if (!prefix?.length) return null;
        descs.push(...prefix);
      }
      routeCurrentToken = officialQuote;
    }

    const identity = await this.getFlapTokenIdentityInfo(chainId, targetToken);
    const officialPool = await this.getPreferredFlapOuterTargetPool({
      chainId,
      tokenAddress: targetToken,
      quoteTokenAddress: officialQuote,
      tokenInfo: identity ? { ...identity, address: targetToken } as TokenInfo : null,
      preferOnchainPool: true,
      debug,
      logEvent: 'buy.official_pool.selected',
    });
    if (officialPool.poolAddress) {
      descs.push(await this.resolveKnownPoolRouteDesc({
        chainId,
        tokenIn: routeCurrentToken,
        tokenOut: targetToken,
        poolAddress: officialPool.poolAddress,
        preferHint: officialPool.preferHint,
        debug,
      }));
      return descs;
    }

    const targetInfo = await this.getFlapOuterQuoteTokenInfo(chainId, targetToken, debug);
    if (targetInfo) {
      const v4Meta = this.getKnownFlapOuterV4Meta({ chainId, tokenInfo: targetInfo });
      if (v4Meta) {
        descs.push(this.buildKnownFlapOuterV4Desc({
          tokenIn: routeCurrentToken,
          tokenOut: targetToken,
          fee: v4Meta.fee,
          tickSpacing: v4Meta.tickSpacing,
          hooks: v4Meta.hooks,
        }));
        return descs;
      }
      const innerLaunchpadDesc = this.buildKnownLaunchpadBuyRouteDesc({
        chainId,
        tokenIn: routeCurrentToken,
        tokenInfo: targetInfo,
      });
      if (innerLaunchpadDesc) {
        descs.push({
          ...innerLaunchpadDesc,
          tokenIn: routeCurrentToken,
        });
        return descs;
      }
    }
    return null;
  }

  private static async buildMarketTokenHomeRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    debug?: boolean;
    amountIn?: bigint;
  }): Promise<SwapDescLike[] | null> {
    const { chainId, currentToken, targetToken, debug } = input;
    const probeIn = input.amountIn && input.amountIn > 0n ? input.amountIn : 0n;
    const terminals = this.getMarketHomeTerminals(chainId, targetToken);
    const rankByQuote = probeIn > 0n;

    const candidates = (await Promise.all(terminals.map(async (terminal) => {
      if (this.isEquivalentFlapRouteToken(chainId, targetToken, terminal)) return null;
      const pool = await this.getPreferredFlapOuterTargetPool({
        chainId,
        tokenAddress: targetToken,
        quoteTokenAddress: terminal,
        pairOnly: true,
        debug,
        logEvent: 'buy.market_pool.selected',
      });
      if (!pool.poolAddress) return null;
      if (!rankByQuote) {
        return { terminal, pool, quotedOut: BigInt(terminals.length - terminals.indexOf(terminal)) };
      }

      let quotedOut = 0n;
      try {
        if (this.isEquivalentFlapRouteToken(chainId, currentToken, terminal)) {
          const hop = await resolveDexExactIn(
            chainId,
            currentToken,
            targetToken,
            probeIn,
            {
              poolPair: pool.poolAddress,
              prefer: pool.preferHint ?? undefined,
              v3Fee: pool.fee,
            },
            false,
            true,
          );
          quotedOut = hop.amountOut;
        } else {
          const bridge = await resolveBridgeHopExactIn(
            chainId,
            currentToken,
            terminal,
            probeIn,
            getBridgeTokenDexPreference(chainId as ChainId, terminal) ?? null,
            false,
            true,
          );
          if (!bridge.amountOut || bridge.amountOut <= 0n) return null;
          const hop = await resolveDexExactIn(
            chainId,
            terminal,
            targetToken,
            bridge.amountOut,
            {
              poolPair: pool.poolAddress,
              prefer: pool.preferHint ?? undefined,
              v3Fee: pool.fee,
            },
            false,
            true,
          );
          quotedOut = hop.amountOut;
        }
      } catch (error) {
        this.logRoutePool(debug, 'buy.market.quote_failed', {
          chainId,
          currentToken,
          targetToken,
          terminal,
          pool: pool.poolAddress,
          error: collectErrorText(error),
        });
        return null;
      }
      if (quotedOut <= 0n) return null;
      return { terminal, pool, quotedOut };
    }))).filter(Boolean) as Array<{
      terminal: Address;
      pool: { poolAddress: Address | null; preferHint: 'v2' | 'v3' | null; fee?: number };
      quotedOut: bigint;
    }>;

    const best = candidates.sort((a, b) => (a.quotedOut === b.quotedOut ? 0 : a.quotedOut > b.quotedOut ? -1 : 1))[0];
    if (!best?.pool.poolAddress) {
      this.logRoutePool(debug, 'buy.market.no_quote', {
        chainId,
        currentToken,
        targetToken,
        terminals,
      });
      return null;
    }

    this.logRoutePool(debug, 'buy.market.picked', {
      chainId,
      currentToken,
      targetToken,
      terminal: best.terminal,
      pool: best.pool.poolAddress,
      preferHint: best.pool.preferHint,
      quotedOut: best.quotedOut.toString(),
      candidateCount: candidates.length,
    });

    const descs: SwapDescLike[] = [];
    let routeCurrentToken = currentToken;
    if (!this.isEquivalentFlapRouteToken(chainId, routeCurrentToken, best.terminal)) {
      descs.push(await this.resolveRouteHopDesc({
        chainId,
        tokenIn: routeCurrentToken,
        tokenOut: best.terminal,
        prefer: getBridgeTokenDexPreference(chainId as ChainId, best.terminal) ?? null,
      }));
      routeCurrentToken = best.terminal;
    }
    descs.push(await this.resolveKnownPoolRouteDesc({
      chainId,
      tokenIn: routeCurrentToken,
      tokenOut: targetToken,
      poolAddress: best.pool.poolAddress,
      preferHint: best.pool.preferHint,
      debug,
    }));
    return descs;
  }

  private static async buildFlapOuterBuyQuoteRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    visited?: Set<string>;
    debug?: boolean;
    depth?: number;
    skipCache?: boolean;
    amountIn?: bigint;
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
    if (depth > this.flapOuterQuoteRouteMaxDepth) {
      this.logFlapStocksRoute(debug, 'buy.route.max_depth', {
        chainId,
        depth,
        currentToken,
        targetToken,
      });
      return null;
    }
    const visited = input.visited ?? new Set<string>();
    if (visited.has(targetToken.toLowerCase())) {
      this.logFlapStocksRoute(debug, 'buy.route.cycle', {
        chainId,
        depth,
        currentToken,
        targetToken,
      });
      return null;
    }
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

    const officialQuote = await this.resolveOfficialLaunchpadQuote(chainId, targetToken, debug);
    if (officialQuote) {
      const officialRoute = await this.buildOfficialQuoteLineageRoute({
        chainId,
        currentToken,
        targetToken,
        officialQuote,
        visited,
        debug,
        depth,
        amountIn: input.amountIn,
      });
      if (officialRoute?.length) {
        this.logRoutePool(debug, 'buy.branch', {
          chainId,
          currentToken,
          targetToken,
          branch: 'official_lineage',
          officialQuote,
          hops: this.summarizeRouteDescs(officialRoute),
        });
        return officialRoute;
      }
      this.logRoutePool(debug, 'buy.official.miss', {
        chainId,
        currentToken,
        targetToken,
        officialQuote,
      });
      return null;
    }

    const marketRoute = await this.buildMarketTokenHomeRoute({
      chainId,
      currentToken,
      targetToken,
      debug,
      amountIn: input.amountIn,
    });
    if (marketRoute?.length) {
      this.logRoutePool(debug, 'buy.branch', {
        chainId,
        currentToken,
        targetToken,
        branch: 'market_home',
        hops: this.summarizeRouteDescs(marketRoute),
      });
      return marketRoute;
    }
    this.logRoutePool(debug, 'buy.market.miss', {
      chainId,
      currentToken,
      targetToken,
    });
    return null;
  }

  private static async buildFlapOuterSellQuoteRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    debug?: boolean;
    visited?: Set<string>;
    depth?: number;
    skipCache?: boolean;
  }): Promise<SwapDescLike[] | null> {
    const { chainId, currentToken, targetToken } = input;
    const debug = input.debug === true;
    const depth = input.depth ?? 0;
    const useCache = input.skipCache !== true && !input.visited && depth === 0;
    if (useCache) {
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
      const task = this.buildFlapOuterSellQuoteRoute({
        ...input,
        skipCache: true,
      }).then((result) => {
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

    if (currentToken.toLowerCase() === targetToken.toLowerCase()) return [];

    const buyRoute = await this.buildFlapOuterBuyQuoteRoute({
      chainId,
      currentToken: targetToken,
      targetToken: currentToken,
      debug,
    });
    const sellRoute = this.reverseSwapDescRoute(buyRoute);
    this.logFlapStocksRoute(debug, 'sell.route.reverse_buy', {
      chainId,
      currentToken,
      targetToken,
      buyHops: buyRoute?.map((desc) => `${desc.tokenIn}->${desc.tokenOut}:${desc.swapType}`) ?? null,
      sellHops: sellRoute?.map((desc) => `${desc.tokenIn}->${desc.tokenOut}:${desc.swapType}`) ?? null,
    });
    this.logRoutePool(debug, 'sell.reverse_buy', {
      chainId,
      currentToken,
      targetToken,
      buyHops: buyRoute ? this.summarizeRouteDescs(buyRoute) : null,
      sellHops: sellRoute ? this.summarizeRouteDescs(sellRoute) : null,
    });
    return this.cloneSwapDescLikeArray(sellRoute);
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
    tokenInfo = await this.ensureFlapTradeTokenInfo(input.chainId, tokenInfo, settings.ui?.consoleLogsEnabled === true);
    input.tokenInfo = tokenInfo;
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
      const initialPlatform = resolveTradeLaunchpadPlatform(tokenInfo);
      const initialIsHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(initialPlatform);
      const openFourRuntime = (initialIsHyperAltfun || !usesOpenFourRuntime(initialPlatform))
      ? null
      : await this.getOpenFourRuntimeState(client, input.chainId, tokenOut);
      const launchpadRoute = this.classifyLaunchpadRoute(input.chainId, tokenInfo, openFourRuntime);
      const launchpadPlatform = launchpadRoute.platform;
      const isHyperAltfun = launchpadRoute.isHyperAltfun;
      const isInner = launchpadRoute.isInner;
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId, openFourRuntime) : null;

    const bridgeToken = isHyperAltfun
      ? null
      : this.getLaunchpadQuoteRouterToken(input.chainId, tokenInfo, launchpadPlatform, openFourRuntime, {
        preferRuntimeQuote: usesOpenFourRuntime(launchpadPlatform),
      });
    const rawQuoteToken = isHyperAltfun
      ? null
      : await this.resolveTradeRouteQuoteToken({
        chainId: input.chainId,
        tokenAddress: tokenOut,
        tokenInfo,
        platform: launchpadPlatform,
        isInner,
        openFourRuntime,
        debug: consoleLogsEnabled,
      });
    const nativeToQuoteSwapEnabled = tokenInfo.nativeToQuoteSwapEnabled === true;
    if (!isHyperAltfun && !planEvmTradeRoute({
      chainId: input.chainId,
      tokenInfo,
      tokenAddress: tokenOut,
      baseTokenAddress,
    })) {
      throw new Error('官方报价路径尚未就绪，请稍后再试');
    }
    const preparedRoute = isHyperAltfun
      ? null
      : await timeStep('route:prepare', () => this.prepareEvmTradeRoute({
        chainId: input.chainId,
        tokenAddress: tokenOut,
        tokenInfo,
        baseTokenAddress,
      }));
    const preparedSplit = this.splitPreparedBuyRoute(preparedRoute, tokenOut);
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
        const isFlapStocks = launchpadRoute.isFlapStocks;
      const needsStocksQuoteRoute = this.needsNonTerminalQuoteRoute(input.chainId, currentRouterToken, rawQuoteToken);
      const preferExactQuoteForStocks = false;
      const turboRouteMode = isTurbo && !preferExactQuoteForStocks;

      if (bridgeToken && currentRouterToken.toLowerCase() !== bridgeToken.toLowerCase() && !needsStocksQuoteRoute) {
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

        const skipNativeQuoteShortcut = currentRouterToken === ZERO_ADDRESS
          && nativeToQuoteSwapEnabled
          && !isFlapStocks
          && !isOpenFourPlatform(platform);
        if (needsStocksQuoteRoute && rawQuoteToken && !skipNativeQuoteShortcut) {
            const quoteRouteDescs = preparedSplit?.quoteDescs.length
              ? preparedSplit.quoteDescs
              : await timeStep('quote:flapstocks:buy:route', () =>
                this.buildFlapOuterBuyQuoteRoute({
                  chainId: input.chainId,
                  currentToken: currentRouterToken,
                  targetToken: rawQuoteToken,
                  debug: consoleLogsEnabled,
                  amountIn: currentAmount,
                })
              );
            if (!quoteRouteDescs?.length) {
              throw new Error(`找不到 ${baseTokenSymbol}/Quote 的交易路径，无法完成买入预处理`);
            }
            descs.push(...quoteRouteDescs);
            currentRouterToken = rawQuoteToken;
            currentAmount = 1n;
        }

        descs.push(getRouterSwapDesc({
          swapType: launchpadConfig.buyType,
          tokenIn: rawQuoteToken ?? currentRouterToken,
          tokenOut,
          poolAddress: launchpadConfig.manager,
          fee: feeForDesc,
          tickSpacing: tickSpacingForDesc,
          data: dataForDesc,
        }));
      } else {
        if (needsStocksQuoteRoute && rawQuoteToken) {
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
          const quoteRouteDescs = preparedSplit?.quoteDescs.length
            ? preparedSplit.quoteDescs
            : await timeStep('quote:flapstocks:outer:buy:route', () =>
              this.buildFlapOuterBuyQuoteRoute({
                chainId: input.chainId,
                currentToken: currentRouterToken,
                targetToken: rawQuoteToken,
                debug: consoleLogsEnabled,
                amountIn: currentAmount,
              })
            );
          if (!quoteRouteDescs?.length) {
            throw new Error(`找不到 ${baseTokenSymbol}/Flap Quote 的交易路径，当前 flap_stock 无法完成买入预处理`);
          }
          descs.push(...quoteRouteDescs);
          currentRouterToken = rawQuoteToken;
          currentAmount = 1n;
        }

          const outerTargetPool = preparedSplit?.lastHop.poolAddress && preparedSplit.lastHop.poolAddress !== ZERO_ADDRESS
            ? {
              poolAddress: preparedSplit.lastHop.poolAddress,
              preferHint: this.preferHintFromDesc(preparedSplit.lastHop),
              fee: preparedSplit.lastHop.fee || undefined,
            }
            : needsStocksQuoteRoute && rawQuoteToken
            ? await this.getPreferredFlapOuterTargetPool({
              chainId: input.chainId,
              tokenAddress: tokenOut,
              quoteTokenAddress: rawQuoteToken,
              tokenInfo,
              preferOnchainPool: true,
              debug: consoleLogsEnabled,
              logEvent: 'buy.target_pool.selected',
            })
            : {
              poolAddress: this.getKnownDexPoolAddress(tokenInfo),
              preferHint: this.normalizeDexPrefer(tokenInfo.dex_type),
              fee: undefined as number | undefined,
            };
          const outerPoolPair = outerTargetPool.poolAddress;
          this.logRoutePool(consoleLogsEnabled, 'buy.last_hop.pool', {
            chainId: input.chainId,
            tokenIn: currentRouterToken,
            tokenOut,
            pool: outerPoolPair,
            preferHint: outerTargetPool.preferHint ?? null,
            fee: outerTargetPool.fee ?? null,
            needsStocksQuoteRoute,
            rawQuoteToken: rawQuoteToken ?? null,
            tokenInfoPoolPair: tokenInfo.pool_pair ?? null,
            tokenInfoBiggestPool: tokenInfo.biggest_pool_address ?? null,
          });
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
    const routedDescs = await this.attachV3FactoriesToDescs(input.chainId, descs);

    const data = encodeFunctionData({
      abi: dagobangAbi,
      functionName: 'swap',
      args: [
        routedDescs,
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
    this.logRoutePool(consoleLogsEnabled, 'buy.submit', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      baseTokenAddress,
      amountIn: amountIn.toString(),
      minOut: minOut.toString(),
      hops: this.summarizeRouteDescs(routedDescs),
    });
    console.log('[trade.buy.submit]', {
      chainId: input.chainId,
      from: account.address,
      tokenAddress: input.tokenAddress,
      baseTokenAddress,
      amountIn: amountIn.toString(),
      txValue: txValue.toString(),
      routeCount: descs.length,
      route: routedDescs.map((d) => ({
        swapType: d.swapType,
        tokenIn: d.tokenIn,
        tokenOut: d.tokenOut,
        poolAddress: d.poolAddress,
        poolManager: d.poolManager,
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
        const receipt = await this.ensureTxSuccess(rsp.txHash, input.chainId, 'buy', timeoutMs);
        const receiptElapsedMs = Date.now() - receiptStart;
        const totalElapsedMs = Date.now() - attemptStart;
        const actualTokenOutWei = this.resolveActualBuyTokenOutWeiFromReceipt({
          receipt,
          tokenAddress: input.tokenAddress,
          walletAddress: input.fromAddress,
        });
        console.log('[trade.buy.auto][attempt.success]', {
          flowId,
          attempt: attemptNo,
          txHash: rsp.txHash,
          elapsedMs: totalElapsedMs,
          totalElapsedMs: Date.now() - flowStart,
          submitElapsedMs,
          receiptElapsedMs,
          actualTokenOutWei,
        });
        return {
          ...rsp,
          actualTokenOutWei,
          submitElapsedMs,
          receiptElapsedMs,
          totalElapsedMs,
        };
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
      const classification = this.classifyLaunchpadRoute(chainId, tokenInfo);
      const platform = classification.platform;
      const isInner = classification.isInner;
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
        isInnerDisk: (ti) => this.isInnerDisk(ti, chainId),
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
      const sellDebug = settings.ui?.consoleLogsEnabled === true;
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
      tokenInfo = await this.ensureFlapTradeTokenInfo(input.chainId, tokenInfo, settings.ui?.consoleLogsEnabled === true);
      input.tokenInfo = tokenInfo;

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
        const initialPlatform = resolveTradeLaunchpadPlatform(tokenInfo);
        const initialIsHyperAltfun = input.chainId === ChainId.HYPER && isHyperAltfunPlatform(initialPlatform);
        const openFourRuntime = (initialIsHyperAltfun || !usesOpenFourRuntime(initialPlatform))
        ? null
        : await this.getOpenFourRuntimeState(client, input.chainId, sellToken);
        const launchpadRoute = this.classifyLaunchpadRoute(input.chainId, tokenInfo, openFourRuntime);
        const platformLower = launchpadRoute.platform;
        const isHyperAltfun = launchpadRoute.isHyperAltfun;
        const isInner = launchpadRoute.isInner;
      const isInnerFourMeme = isInner && isFourMemePlatform(platformLower);
      const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId, openFourRuntime) : null;
      const bridgeToken = isHyperAltfun ? null : this.getLaunchpadQuoteRouterToken(input.chainId as ChainId, tokenInfo, platformLower, openFourRuntime, {
        preferRuntimeQuote: usesOpenFourRuntime(platformLower),
      });
      const rawQuoteToken = isHyperAltfun ? null : await this.resolveTradeRouteQuoteToken({
        chainId: input.chainId as ChainId,
        tokenAddress: sellToken,
        tokenInfo,
        platform: platformLower,
        isInner,
        openFourRuntime,
        debug: settings.ui?.consoleLogsEnabled === true,
      });
      const hasBridgeRouteToken = !!bridgeToken;
      const needsBridgeHop2 = !!bridgeToken && bridgeToken.toLowerCase() !== ZERO_ADDRESS.toLowerCase();
      const bridgePrefer = needsBridgeHop2 ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      const needsStocksQuoteRoute = this.needsNonTerminalQuoteRoute(input.chainId, baseTokenAddress, rawQuoteToken);
      if (!isHyperAltfun && !planEvmTradeRoute({
        chainId: input.chainId,
        tokenInfo,
        tokenAddress: sellToken,
        baseTokenAddress,
      })) {
        throw new Error('官方报价路径尚未就绪，请稍后再试');
      }
      const preparedRoute = isHyperAltfun
        ? null
        : await timeStep('route:prepare', () => this.prepareEvmTradeRoute({
          chainId: input.chainId,
          tokenAddress: sellToken,
          tokenInfo,
          baseTokenAddress,
        }));
      const preparedSplit = this.splitPreparedBuyRoute(preparedRoute, sellToken);
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

        const innerTokenOut = needsStocksQuoteRoute && rawQuoteToken
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

        if (needsStocksQuoteRoute && rawQuoteToken) {
          const quoteRouteDescs = preparedSplit?.quoteDescs.length
            ? this.reverseSwapDescRoute(preparedSplit.quoteDescs)
            : await timeStep('quote:flapstocks:sell:route', () =>
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
        const hop1RouterOut = needsStocksQuoteRoute && rawQuoteToken
          ? rawQuoteToken
          : hasBridgeRouteToken
            ? bridgeToken
            : baseTokenAddress;
        const hop1NeedAmountOut = !turboRouteMode && (needsBridgeHop2 || needsStocksQuoteRoute);
        const outerTargetPool = preparedSplit?.lastHop.poolAddress && preparedSplit.lastHop.poolAddress !== ZERO_ADDRESS
          ? {
            poolAddress: preparedSplit.lastHop.poolAddress,
            preferHint: this.preferHintFromDesc(preparedSplit.lastHop),
            fee: preparedSplit.lastHop.fee || undefined,
          }
          : needsStocksQuoteRoute && rawQuoteToken
          ? await this.getPreferredFlapOuterTargetPool({
            chainId: input.chainId,
            tokenAddress: sellToken,
            quoteTokenAddress: rawQuoteToken,
            tokenInfo,
            preferOnchainPool: true,
            debug: sellDebug,
            logEvent: 'sell.target_pool.selected',
          })
          : {
            poolAddress: this.getKnownDexPoolAddress(tokenInfo),
            preferHint: this.normalizeDexPrefer(tokenInfo.dex_type),
            fee: undefined as number | undefined,
          };
        const outerPoolPair = outerTargetPool.poolAddress;
        this.logRoutePool(sellDebug, 'sell.first_hop.pool', {
          chainId: input.chainId,
          tokenIn: sellToken,
          tokenOut: hop1RouterOut,
          pool: outerPoolPair,
          preferHint: outerTargetPool.preferHint ?? null,
          fee: outerTargetPool.fee ?? null,
          needsStocksQuoteRoute,
          rawQuoteToken: rawQuoteToken ?? null,
          tokenInfoPoolPair: tokenInfo.pool_pair ?? null,
          tokenInfoBiggestPool: tokenInfo.biggest_pool_address ?? null,
        });
        const outerPoolMeta = outerPoolPair
          ? await this.getKnownPoolRouteMeta(input.chainId, outerPoolPair, outerTargetPool.preferHint)
          : null;
        const poolVersion = outerPoolMeta?.prefer ?? outerTargetPool.preferHint ?? this.normalizeDexPrefer(tokenInfo.dex_type);
        let hop1AmountOut = 0n;

        if (needsStocksQuoteRoute && rawQuoteToken) {
          if (!outerPoolPair) {
            throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
          descs.push(await this.resolveKnownPoolRouteDesc({
            chainId: input.chainId,
            tokenIn: sellToken,
            tokenOut: hop1RouterOut,
            poolAddress: outerPoolPair,
            preferHint: poolVersion,
            debug: sellDebug,
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
        if (needsStocksQuoteRoute && rawQuoteToken) {
          this.logFlapStocksRoute(sellDebug, 'sell.outer.start', {
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
          const quoteRouteDescs = preparedSplit?.quoteDescs.length
            ? this.reverseSwapDescRoute(preparedSplit.quoteDescs)
            : await timeStep('quote:flapstocks:outer:sell:route', () =>
              this.buildFlapOuterSellQuoteRoute({
                chainId: input.chainId,
                currentToken: hop1RouterOut,
                targetToken: baseTokenAddress,
                debug: sellDebug,
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
      const routedDescs = await this.attachV3FactoriesToDescs(input.chainId, descs);
      const data = isTurbo
        ? encodeFunctionData({
          abi: dagobangAbi,
          functionName: 'swapPercent',
          args: [
            routedDescs,
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
            routedDescs,
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
      this.logRoutePool(sellDebug, 'sell.submit', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        isTurbo,
        hops: this.summarizeRouteDescs(routedDescs),
      });
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
        isInnerDisk: (ti) => this.isInnerDisk(ti, input.chainId),
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
