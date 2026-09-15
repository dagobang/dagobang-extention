import { concat, decodeAbiParameters, decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, isAddress, keccak256, pad, parseAbi, parseAbiItem, parseAbiParameters, toHex } from 'viem';
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
import { dagobangAbi, pairV2Abi, poolV3Abi } from '@/constants/contracts/abi';
import { Address, DexExactInQuote, HyperSwapType, RhSwapType, SwapDescLike, SwapType, ZERO_ADDRESS, applySlippage, getDeadline, getRouterSwapDesc, getSlippageBps, getV3FeeForDesc, toHyperDexSwapType, toRhDexSwapType } from './tradeTypes';
import { assertDexQuoteOk, getBridgeToken, quoteBestExactIn as quoteBestExactInDex, resolveBridgeHopExactIn, resolveDexExactIn } from './tradeDex';
import { getGasPriceWei, prewarmNonce, sendTransaction } from './tradeTx';
import { getSellSpenders, hasInsufficientSellAllowance, getSellQuotePullbackTokens, type SellAllowanceCheckResult } from './sellAllowance';
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
import {
  buildPonsBuyDesc,
  buildPonsSellDesc,
  getConfiguredPonsMemeHook,
  getConfiguredPonsV4PoolManager,
  getPonsTradeState,
  isPonsPlatform,
  quotePonsBuy,
  quotePonsSell,
} from './tradePons';
import { formatBroadcastProvider } from '@/utils/format';
import { getDexPoolPrefer, parseGweiToWei } from '@/utils/dexUtils';
import { classifyBroadcastError, collectErrorText, getNonceErrorKindFromText, isAllowanceLikeText, isInFlightLimitLikeText } from '@/utils/txErrorClassify';
import { tryGetReceiptRevertReason } from '@/services/tx/errors';
import { getNativeSymbol } from '@/constants/chains';
import { chainNames } from '@/constants/chains';
import { getChainRuntime } from '@/constants/chains/runtime';
import { isLongLaunchpadPlatform, isO1LaunchpadPlatform, normalizeLaunchpadPlatform } from '@/constants/launchpad';
import { getO1LaunchState, O1_RH_SUITES } from './tradeO1';
import { getLongLaunchState, LONG_RH_REHYPE_HOOK } from './tradeLong';
import { OpenFourInnerLaunchpadManager, OpenFourRegistryAddress } from '@/constants/contracts/address';
import { OPENFOUR_4STOCK_QUOTE_FALLBACK } from '@/constants/openfour';
import FlapAPI from '@/hooks/FlapAPI';
import DexScreenerAPI, { type DexScreenerPair, type DexScreenerTokenRef } from '@/hooks/DexScreenerAPI';
import { recoverUniswapV4PoolKey } from '@/utils/uniswapV4PoolKey';
import { fetchGmgnTokenPoolFeeInfoPreferPage } from '@/services/gmgn/tokenPoolFeeInfoBridge';

const erc20TransferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const poolManagerExtsloadAbi = parseAbi([
  'function extsload(bytes32 slot) view returns (bytes32 value)',
]);
/** Uniswap v4 PoolManager.pools mapping slot (StateLibrary.POOLS_SLOT). */
const UNISWAP_V4_POOLS_SLOT = 6n;
/** Known Doppler hook used on RH tokenized / stock pools. */
const RH_DOPPLER_HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544' as Address;
/** Common RH Uniswap v4 hook (e.g. STANDARD / meme V4 pools). */
const RH_STANDARD_V4_HOOK = '0xf1Ee073811b14359d850825E48d200483200EdCd' as Address;
const uniswapV4InitializeEvent = parseAbiItem(
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
);
import { GmgnAPI } from '@/hooks/GmgnAPI';
import { classifyFlapRoute, hasConfirmedFlapLaunchpadIdentity, hasConfirmedFlapOuterRoute, isUsableFlapDexPoolAddress, resolveFlapPlatform, resolveFlapPlatformByQuoteLineage } from '@/utils/flap';
import { resolveTokenLaunchpadPlatform } from '@/utils/launchpadFamily';
import { planEvmTradeRoute, resolveEvmTradeQuoteToken, type EvmTradeRoutePlan, type EvmTradeRoutePlanHop } from '@/utils/quickTradeRoutePreview';
import { resolveQuoteFromDexScreenerPool } from '@/utils/officialPoolQuote';
import { getTradeRouteStableAddresses, isTradeRouteNativeToken, isTradeRouteTerminalQuote } from '@/utils/tradeRouteTerminals';
import {
  clearOuterMarketRouteInFlight,
  getOuterMarketRouteInFlight,
  setOuterMarketRoute,
  setOuterMarketRouteInFlight,
  sliceOuterMarketRoute,
} from './outerMarketRouteCache';
import { preferRouteTokenSymbol, resolveRouteTokenLabel, getKnownQuoteTokenSymbol } from '@/utils/quoteTokenLabels';
import { TokenFlapService } from '@/services/token/flap';
import { call } from '@/utils/messaging';

function getDefaultBridgeV3Fee(chainId: number): number {
  if (chainId === ChainId.HYPER) return 3000;
  return 500;
}

const fourmemeHelperGetTokenInfoAbi = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)',
]);

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
  'pons',
  'pons_v1',
  'pons_v2',
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
  isPons: boolean;
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

function isPoolRefLike(value: string | undefined | null): boolean {
  const raw = String(value || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(raw) || /^0x[a-fA-F0-9]{64}$/.test(raw);
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
  private static readonly turboPrewarmInFlight = new Map<string, Promise<QuickTradeRoutePreview | null>>();
  private static readonly openFourNetworkCache = new Map<number, OpenFourNetworkContracts>();
  private static readonly flapOuterQuoteInfoCache = new Map<string, Promise<TokenInfo | null>>();
  private static readonly flapKnownPoolMetaCache = new Map<string, Promise<{ prefer: 'v2' | 'v3'; fee?: number; v3Factory?: Address } | null>>();
  private static readonly flapOuterQuoteRouteMaxDepth = FLAP_OUTER_QUOTE_ROUTE_MAX_DEPTH;
  private static readonly flapOuterBuyQuoteRouteCacheMs = 30_000;
  private static readonly flapOuterSellQuoteRouteCache = new Map<string, { ts: number; value: SwapDescLike[] | null }>();
  private static readonly flapOuterSellQuoteRouteInFlight = new Map<string, Promise<SwapDescLike[] | null>>();
  private static readonly flapPoolCounterpartyCache = new Map<string, Address | null>();
  private static readonly flapPoolCounterpartyInFlight = new Map<string, Promise<Address | null>>();
  private static readonly officialLaunchpadQuoteCache = new Map<string, { ts: number; value: Address | null }>();
  private static readonly officialLaunchpadQuoteInFlight = new Map<string, Promise<Address | null>>();
  private static readonly preparedEvmTradeRouteCacheMs = 30_000;
  private static readonly preparedEvmTradeRouteCache = new Map<string, { ts: number; value: PreparedEvmTradeRoute | null }>();
  private static readonly preparedEvmTradeRouteInFlight = new Map<string, Promise<PreparedEvmTradeRoute | null>>();
  private static readonly rhV4PoolKeyCache = new Map<string, Promise<{ fee: number; tickSpacing: number; hooks: Address } | null>>();
  /** Runtime lpFee (or static display fee) keyed by poolId — preview only, never overwrite PoolKey.fee. */
  private static readonly rhV4DisplayFeeByPoolId = new Map<string, number>();
  /** Authoritative PoolKey from Initialize(poolId) — permanent once found. */
  private static readonly rhV4InitializeKeyCache = new Map<string, { fee: number; tickSpacing: number; hooks: Address } | null>();
  private static readonly rhV4InitializeKeyInFlight = new Map<string, Promise<{ fee: number; tickSpacing: number; hooks: Address } | null>>();

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
    force?: boolean;
  }): Promise<`0x${string}` | null> {
    const allowance = await input.client.readContract({
      address: input.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [input.owner, input.spender as `0x${string}`]
    }) as bigint;
    if (!input.force && allowance >= input.maxUint256 / 2n) return null;

    const key = this.makeApproveKey(input.chainId, input.owner, input.tokenAddress, input.spender);
    const inFlight = this.approveInFlightByKey.get(key);
    if (inFlight) return await inFlight;

    const task = (async () => {
      // USDT / some tax tokens reject approve(max) when current allowance != 0.
      // On force repair, always reset first — covers dust allowance and flaky reads.
      const shouldReset = input.force === true
        ? allowance > 0n
        : (allowance > 0n && allowance < input.maxUint256 / 2n);
      if (shouldReset) {
        try {
          await this.approve(
            input.chainId,
            input.tokenAddress,
            input.spender,
            '0',
            input.owner,
            input.submitChannel,
          );
        } catch {
        }
      }
      return await this.approve(
        input.chainId,
        input.tokenAddress,
        input.spender,
        input.maxUint256.toString(),
        input.owner,
        input.submitChannel,
      );
    })();
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

  static async prewarmTurbo(input: { chainId: number; tokenAddress: Address; tokenInfo?: TokenInfo; fromAddress?: `0x${string}`; submitChannel?: SubmitChannel; baseTokenAddress?: Address }): Promise<QuickTradeRoutePreview | null> {
    const settings = await SettingsService.get();
    const consoleLogsEnabled = settings.ui?.consoleLogsEnabled === true;
    const startedAt = Date.now();
    let tokenInfo = input.tokenInfo;
    if (!tokenInfo) return null;
    tokenInfo = await this.ensureFlapTradeTokenInfo(input.chainId, tokenInfo, consoleLogsEnabled);
    input.tokenInfo = tokenInfo;

    const configuredBaseToken = this.resolveConfiguredBaseTokenAddress(input.chainId, settings);
    const baseTokenAddress = (input.baseTokenAddress && isAddressLike(input.baseTokenAddress)
      ? input.baseTokenAddress
      : configuredBaseToken) as Address;
    const routeTask = this.prepareEvmTradeRoute({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenInfo,
      baseTokenAddress,
    }).catch(() => null);

    void this.warmTurboWalletState({
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      tokenInfo,
      baseTokenAddress,
      fromAddress: input.fromAddress,
      submitChannel: input.submitChannel,
      routeTask,
      startedAt,
      consoleLogsEnabled,
    });

    const prepared = await routeTask;
    return prepared?.preview ?? null;
  }

  private static warmTurboWalletState(input: {
    chainId: number;
    tokenAddress: Address;
    tokenInfo: TokenInfo;
    baseTokenAddress: Address;
    fromAddress?: `0x${string}`;
    submitChannel?: SubmitChannel;
    routeTask: Promise<PreparedEvmTradeRoute | null>;
    startedAt: number;
    consoleLogsEnabled: boolean;
  }): void {
    const warmTask = (async () => {
      const client = await RpcService.getClient(input.chainId);
      let account: Awaited<ReturnType<typeof WalletService.getSigner>> | null = null;
      try {
        const fromAddress = this.resolveOptionalEvmAddress(input.fromAddress, 'from address');
        account = await WalletService.getSigner(fromAddress);
      } catch {
        return;
      }
      if (!account) return;

      const signer = account;
      const tokenInfo = input.tokenInfo;
      const warmKey = this.makeTurboWarmKey({
        chainId: input.chainId,
        owner: signer.address,
        tokenAddress: input.tokenAddress,
        tokenInfo,
      });
      const existing = this.turboPrewarmInFlight.get(warmKey);
      if (existing) {
        await existing.catch(() => null);
        return;
      }

      const task = (async (): Promise<QuickTradeRoutePreview | null> => {
      const criticalWarmTasks: Array<Promise<unknown>> = [
        prewarmNonce(client, input.chainId, signer.address, { submitChannel: input.submitChannel }).catch(() => null),
        input.routeTask,
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
          debug: input.consoleLogsEnabled,
        });
        const needsNonTerminalQuoteRoute = this.needsNonTerminalQuoteRoute(input.chainId, input.baseTokenAddress, rawQuoteToken);
        const bridgeToken = needsNonTerminalQuoteRoute
          ? rawQuoteToken
          : getBridgeToken(input.chainId as ChainId, tokenInfo.address, tokenInfo.quote_token_address);
        const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
        const dexPrefer = getDexPoolPrefer(tokenInfo.dex_type);
        const tokenPrefer = dexPrefer === 'v2' || dexPrefer === 'v3' ? dexPrefer : (bridgePrefer ?? 'v2');

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
        const quoteTopologyTask = this.resolveFlapStocksQuoteTopology({
          chainId: input.chainId,
          rawQuoteToken,
          anchorToken: token,
          debug: input.consoleLogsEnabled,
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
            targetToken: input.baseTokenAddress,
            debug: input.consoleLogsEnabled,
          }).catch(() => null)
        );
      }

      await Promise.allSettled(criticalWarmTasks);
      if (backgroundWarmTasks.length > 0) {
        void Promise.allSettled(backgroundWarmTasks).then(() => {
          const backgroundElapsedMs = Date.now() - input.startedAt;
          if (input.consoleLogsEnabled && backgroundElapsedMs >= 600) {
            console.info('[trade.buy.prewarm.background]', {
              chainId: input.chainId,
              tokenAddress: input.tokenAddress,
              fromAddress: signer.address,
              backgroundTaskCount: backgroundWarmTasks.length,
              elapsedMs: backgroundElapsedMs,
              warmKey,
            });
          }
        });
      }
      const elapsedMs = Date.now() - input.startedAt;
      if (input.consoleLogsEnabled || elapsedMs >= 600) {
        console.info('[trade.buy.prewarm]', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          fromAddress: signer.address,
          warmTaskCount: criticalWarmTasks.length + backgroundWarmTasks.length,
          criticalWarmTaskCount: criticalWarmTasks.length,
          backgroundWarmTaskCount: backgroundWarmTasks.length,
          hasBridgeToken: !!bridgeToken,
          tokenPrefer,
          elapsedMs,
          warmKey,
        });
      }
      const prepared = await input.routeTask;
      return prepared?.preview ?? null;
    })().finally(() => {
      const current = this.turboPrewarmInFlight.get(warmKey);
      if (current === task) this.turboPrewarmInFlight.delete(warmKey);
    });

      this.turboPrewarmInFlight.set(warmKey, task);
      await task.catch(() => null);
    })();
    void warmTask;
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
    /** When true (e.g. after ERC20InsufficientAllowance), always re-approve even if check says OK. */
    force?: boolean;
  }): Promise<boolean> {
    if (!input.force) {
      const allowanceCheck = await this.checkSellAllowanceInsufficient(input.chainId, input.tokenAddress, input.tokenInfo, {
        fromAddress: input.fromAddress,
      });
      if (!allowanceCheck.insufficient) return false;
    }
    const approveTx = await this.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, input.tokenInfo, {
      fromAddress: input.fromAddress,
      force: input.force === true,
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
    const isPons = isPonsPlatform(platform);
    const openFourRuntime = (isHyperAltfun || isPons || !usesOpenFourRuntime(platform))
      ? null
      : await this.getOpenFourRuntimeState(input.client, input.chainId, input.tokenAddress);
    const isInner = isHyperAltfun || isO1LaunchpadPlatform(platform) || isLongLaunchpadPlatform(platform)
      ? false
      : isPons
        ? input.tokenInfo.launchpad_status !== 1
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
    const isPons = isPonsPlatform(rawPlatform);
    const isFlap = rawPlatform.startsWith('flap');
    const flapRoute = isFlap ? classifyFlapRoute(chainId, tokenInfo) : null;
    const isFlapStocks = !!flapRoute?.isFlapStocks;
    const platform = isFlap ? flapRoute?.platform || 'flap' : rawPlatform;
    const normalizedLaunchpadStatus = flapRoute?.rawLaunchpadStatus ?? null;
    const hasConfirmedOuterRoute = !!flapRoute?.hasConfirmedOuterRoute;
    const isO1 = isO1LaunchpadPlatform(rawPlatform);
    const isLong = isLongLaunchpadPlatform(rawPlatform);
    const isInner = isHyperAltfun || isO1 || isLong
      ? false
      : isPons
        ? tokenInfo.launchpad_status !== 1
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
      isPons,
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

    if (isPonsPlatform(platform) && tokenInfo.launchpad_status !== 1) {
      if (platform === 'pons_v1') {
        return {
          buyType: RhSwapType.PONS_V1_EXACT_IN,
          sellType: RhSwapType.PONS_V1_EXACT_IN,
          manager: routeAddress,
        };
      }
      return {
        buyType: RhSwapType.PONS_V2_BUY,
        sellType: RhSwapType.PONS_V2_SELL,
        manager: routeAddress,
      };
    }

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
    if (isTradeRouteTerminalQuote(chainId, rawQuoteToken)) return false;
    return currentToken.toLowerCase() !== rawQuoteToken.toLowerCase();
  }

  private static isNonTerminalQuoteToken(
    chainId: number,
    tokenAddress: Address | null | undefined,
    selfToken?: Address,
  ): boolean {
    if (!tokenAddress) return false;
    if (selfToken && tokenAddress.toLowerCase() === selfToken.toLowerCase()) return false;
    return !isTradeRouteTerminalQuote(chainId, tokenAddress);
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
    const stables = getTradeRouteStableAddresses(chainId)
      .filter((item) => !targetToken || item.toLowerCase() !== targetToken.toLowerCase()) as Address[];
    return [...stables, ZERO_ADDRESS];
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
    const route = await this.buildOuterMarketBuyQuoteRoute({
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
    return prepared?.preview ?? null;
  }

  private static makePreparedEvmTradeRouteKey(input: {
    chainId: number;
    tokenAddress: string;
    tokenInfo: TokenInfo;
    baseTokenAddress?: string;
  }): string {
    return [
      'official-quote-v4',
      input.chainId,
      String(input.tokenAddress || input.tokenInfo.address || '').toLowerCase(),
      String(input.baseTokenAddress || ZERO_ADDRESS).toLowerCase(),
      String(input.tokenInfo.quote_token_address || '').toLowerCase(),
      String(input.tokenInfo.launchpad_platform || ''),
      String(input.tokenInfo.launchpad_status ?? ''),
      String(input.tokenInfo.pool_pair || ''),
      String(input.tokenInfo.biggest_pool_address || ''),
      String(input.tokenInfo.tpool_pool_address || ''),
    ].join(':');
  }

  private static isUsableRhV4PoolKey(
    key?: { fee: number; tickSpacing: number; hooks?: Address } | null,
  ): key is { fee: number; tickSpacing: number; hooks: Address } {
    if (!key) return false;
    if (!Number.isFinite(key.fee) || key.fee < 0) return false;
    if (!Number.isFinite(key.tickSpacing) || key.tickSpacing <= 0) return false;
    // fee=0 is valid on RH hook launchpads (o1 / many V4 hook pools). Do not treat as "not ready".
    return true;
  }

  private static hasUnusableRhV4Fee(descs?: SwapDescLike[] | null): boolean {
    if (!Array.isArray(descs) || !descs.length) return false;
    return descs.some((desc) => {
      if (!desc) return false;
      if (!(desc.swapType === RhSwapType.V4_EXACT_IN || desc.swapType === SwapType.V4_EXACT_IN)) return false;
      // Incomplete key only: missing/invalid tickSpacing, or negative fee.
      if (!(typeof desc.tickSpacing === 'number' && desc.tickSpacing > 0)) return true;
      if (!(typeof desc.fee === 'number' && Number.isFinite(desc.fee) && desc.fee >= 0)) return true;
      return false;
    });
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
        if (cached.value && this.hasUnusableRhV4Fee(cached.value.descs)) {
          this.preparedEvmTradeRouteCache.delete(cacheKey);
        } else {
          return cached.value
            ? { descs: this.cloneSwapDescLikeArray(cached.value.descs) ?? [], preview: cached.value.preview }
            : null;
        }
      }
      const inflight = this.preparedEvmTradeRouteInFlight.get(cacheKey);
      if (inflight) {
        const value = await inflight;
        return value
          ? { descs: this.cloneSwapDescLikeArray(value.descs) ?? [], preview: value.preview }
          : null;
      }
      const buildTask = this.buildPreparedEvmTradeRoute(
        input.chainId,
        tokenInfo,
        input.tokenAddress,
        input.baseTokenAddress,
      ).then((value) => {
        this.preparedEvmTradeRouteCache.set(cacheKey, { ts: Date.now(), value });
        return value;
      }).finally(() => {
        this.preparedEvmTradeRouteInFlight.delete(cacheKey);
      });
      this.preparedEvmTradeRouteInFlight.set(cacheKey, buildTask);
      // Hard cap so UI never spins forever. Fee resolve uses page-bridge ≤900ms + PoolManager lpFee.
      const value = await Promise.race([
        buildTask,
        new Promise<PreparedEvmTradeRoute | null>((resolve) => {
          setTimeout(() => resolve(null), 1_200);
        }),
      ]);
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

  private static async readFourmemeOfficialQuote(
    chainId: number,
    tokenAddress: Address,
  ): Promise<Address | null> {
    if (chainId !== ChainId.BNB) return null;
    const helper = DeployAddress[ChainId.BNB]?.[ContractNames.TokenManagerHelper3]?.address;
    if (!helper || helper === ZERO_ADDRESS) return null;
    try {
      const client = await RpcService.getClient(chainId);
      const result = await client.readContract({
        address: helper as Address,
        abi: fourmemeHelperGetTokenInfoAbi,
        functionName: 'getTokenInfo',
        args: [tokenAddress],
      });
      const version = Number(result[0] ?? 0);
      const quote = result[2] as Address;
      if (!(version > 0) || !isAddressLike(quote) || quote === ZERO_ADDRESS) return null;
      if (!this.isNonTerminalQuoteToken(chainId, quote, tokenAddress)) return null;
      return quote;
    } catch {
      return null;
    }
  }

  private static async resolvePreparedRouteTokenInfo(
    chainId: number,
    tokenInfo: TokenInfo,
    tokenAddress: Address,
  ): Promise<TokenInfo> {
    const declaredQuote = resolveEvmTradeQuoteToken(chainId, tokenInfo);
    const canReadOuterPool = chainId === ChainId.BNB
      && Number(tokenInfo.launchpad_status ?? 0) === 1
      && tokenInfo.flap_pool_model !== 'v4_cl';
    const poolQuote = canReadOuterPool
      ? await this.resolveQuoteFromOfficialPool({
        chainId,
        tokenAddress,
        tokenInfo,
      })
      : null;
    if (declaredQuote) {
      if (
        !poolQuote
        || this.isEquivalentFlapRouteToken(chainId, declaredQuote, poolQuote.quoteTokenAddress)
      ) {
        return tokenInfo;
      }
      return {
        ...tokenInfo,
        quote_token_address: poolQuote.quoteTokenAddress,
        quote_token: poolQuote.quoteSymbol || tokenInfo.quote_token,
        dex_type: tokenInfo.dex_type || poolQuote.dexType,
      };
    }
    if (poolQuote) {
      return {
        ...tokenInfo,
        quote_token_address: poolQuote.quoteTokenAddress,
        quote_token: poolQuote.quoteSymbol || tokenInfo.quote_token,
        dex_type: tokenInfo.dex_type || poolQuote.dexType,
      };
    }
    const officialQuote = await this.readFourmemeOfficialQuote(chainId, tokenAddress);
    if (officialQuote) {
      return {
        ...tokenInfo,
        quote_token_address: officialQuote,
      };
    }
    return tokenInfo;
  }

  private static async buildPreparedEvmTradeRoute(
    chainId: number,
    tokenInfo: TokenInfo,
    rawTokenAddress?: Address,
    rawBaseTokenAddress?: Address,
  ): Promise<PreparedEvmTradeRoute | null> {
    try {
      const tokenAddress = this.resolveEvmAddress(
        rawTokenAddress || tokenInfo.address,
        'token address',
      ) as Address;
      const routedInfo = await this.resolvePreparedRouteTokenInfo(chainId, tokenInfo, tokenAddress);
      const plan = planEvmTradeRoute({
        chainId,
        tokenInfo: routedInfo,
        tokenAddress,
        baseTokenAddress: rawBaseTokenAddress,
      });
      if (!plan?.hops.length) return null;
      const lastHop = plan.hops[plan.hops.length - 1];
      const quote = lastHop.tokenIn as Address;
      const start = (
        this.normalizeFlapPoolCounterpartyToken(chainId, rawBaseTokenAddress)
        ?? ZERO_ADDRESS
      ) as Address;
      const finishPrepared = (
        descs: SwapDescLike[],
        liquidityUsd: Array<number | null>,
        symbols: Array<Record<string, string>>,
        displayPools: Array<string | null>,
      ): PreparedEvmTradeRoute => ({
        descs,
        preview: this.toQuickTradeRoutePreview(
          chainId,
          routedInfo,
          descs,
          liquidityUsd,
          symbols,
          displayPools,
        ),
      });
      const concatPrefixLast = async (prefixDescs: SwapDescLike[]) => {
        const lastPlan: EvmTradeRoutePlan = {
          ...plan,
          hops: [{ ...lastHop, tokenIn: quote }],
        };
        const lastHopRoute = await this.materializeEvmTradeRoutePlan(chainId, routedInfo, lastPlan);
        if (!lastHopRoute.descs.length) return null;
        return finishPrepared(
          [...prefixDescs, ...lastHopRoute.descs],
          [...prefixDescs.map(() => null), ...lastHopRoute.liquidityUsd],
          [...prefixDescs.map(() => ({}) as Record<string, string>), ...lastHopRoute.symbols],
          [
            ...prefixDescs.map((desc) => (
              desc.poolAddress && desc.poolAddress !== ZERO_ADDRESS ? desc.poolAddress : null
            )),
            ...lastHopRoute.displayPools,
          ],
        );
      };

      const needsPrefix = !this.isEquivalentFlapRouteToken(chainId, start, quote);
      if (needsPrefix) {
        // Always resolve pay→quote via outer-market pipeline (cache / DexScreener).
        // Never invent a direct hop from the topology planner.
        const via = await this.buildOuterMarketBuyQuoteRoute({
          chainId,
          currentToken: start,
          targetToken: quote,
        }).catch(() => null);
        if (
          !via?.length
          || !this.isEquivalentFlapRouteToken(chainId, via[via.length - 1]?.tokenOut, quote)
        ) {
          return null;
        }
        return await concatPrefixLast(via);
      }

      const materialized = await this.materializeEvmTradeRoutePlan(chainId, routedInfo, plan);
      if (!materialized.descs.length) return null;
      return finishPrepared(
        materialized.descs,
        materialized.liquidityUsd,
        materialized.symbols,
        materialized.displayPools,
      );
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

  private static parseDexScreenerSwapFee(pair?: DexScreenerPair | null): number | null {
    const raw = [
      ...(Array.isArray(pair?.labels) ? pair.labels : []),
      String(pair?.url || ''),
    ].join(' ');
    const match = raw.match(/(\d+(?:\.\d+)?)\s*%/);
    if (!match) return null;
    const pct = Number(match[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
    return Math.round(pct * 10_000);
  }

  private static v4TickSpacingForFee(fee: number): number {
    if (fee <= 100) return 1;
    if (fee <= 500) return 10;
    if (fee <= 3000) return 60;
    return 200;
  }

  private static async peekDexScreenerPairMeta(
    chainId: number,
    tokenA: Address,
    tokenB: Address,
  ): Promise<{
    liquidityUsd: number | null;
    symbols: Record<string, string>;
    poolAddress: Address | null;
    displayPool: string | null;
    preferHint: 'v2' | 'v3' | 'v4' | null;
    fee?: number;
    tickSpacing?: number;
  }> {
    const chain = String(chainNames[chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return { liquidityUsd: null, symbols: {}, poolAddress: null, displayPool: null, preferHint: null };
    const left = this.toDexScreenerPairToken(chainId, tokenA) ?? tokenA;
    const right = this.toDexScreenerPairToken(chainId, tokenB) ?? tokenB;
    const pair = await DexScreenerAPI.getBestPairBetweenTokens(chain, left, right).catch(() => null);
    const liquidityUsd = DexScreenerAPI.effectiveLiquidityUsd(pair);
    const pairAddress = String(pair?.pairAddress || '').trim();
    const poolAddress = isAddressLike(pairAddress) ? pairAddress as Address : null;
    const dexType = this.mapDexScreenerPairDexType(pair);
    const preferHint = String(dexType || '').toLowerCase().includes('v4')
      ? 'v4' as const
      : this.normalizeDexPrefer(dexType);
    const fee = this.parseDexScreenerSwapFee(pair);
    const tickSpacing = fee ? this.v4TickSpacingForFee(fee) : undefined;
    return {
      liquidityUsd: Number.isFinite(liquidityUsd) && liquidityUsd > 0 ? liquidityUsd : null,
      symbols: this.collectDexScreenerPairSymbols(chainId, pair),
      poolAddress,
      displayPool: isPoolRefLike(pairAddress) ? pairAddress : null,
      preferHint,
      ...(fee ? { fee, tickSpacing } : {}),
    };
  }

  private static toPreviewDexSwapType(
    chainId: number,
    hop: { dexLabel?: string | null },
    preferHint?: 'v2' | 'v3' | 'v4' | null,
  ): number {
    const wantV4 = preferHint === 'v4';
    const wantV3 = preferHint === 'v3'
      || (!preferHint && (hop.dexLabel === 'V3' || (chainId === ChainId.RH && hop.dexLabel !== 'V2')));
    if (chainId === ChainId.RH) {
      if (wantV4) return RhSwapType.V4_EXACT_IN;
      if (wantV3) return RhSwapType.V3_EXACT_IN;
      return RhSwapType.V2_EXACT_IN;
    }
    if (wantV4) return SwapType.V4_EXACT_IN;
    if (wantV3) return SwapType.V3_EXACT_IN;
    return SwapType.V2_EXACT_IN;
  }

  private static previewPoolAddress(desc: SwapDescLike, displayPool?: string | null): string | null {
    const candidates = [displayPool, desc.poolAddress, desc.poolManager, desc.hooks];
    for (const item of candidates) {
      if (item && item !== ZERO_ADDRESS && isPoolRefLike(item)) return item;
    }
    return null;
  }

  private static rhV4PoolManager(): Address {
    try {
      return getConfiguredPonsV4PoolManager();
    } catch {
      return ZERO_ADDRESS;
    }
  }

  private static rhUsdgAddress(): Address | null {
    const address = USDC[ChainId.RH]?.address;
    return isAddressLike(address) ? address as Address : null;
  }

  private static isRhNativeRouterToken(chainId: number, token: Address): boolean {
    if (chainId !== ChainId.RH) return false;
    const lower = token.toLowerCase();
    if (lower === ZERO_ADDRESS.toLowerCase()) return true;
    return lower === getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
  }

  private static rhNeedsUsdgBridge(chainId: number, tokenIn: Address, tokenOut: Address): boolean {
    if (chainId !== ChainId.RH) return false;
    const usdg = this.rhUsdgAddress();
    if (!usdg) return false;
    const usdgLower = usdg.toLowerCase();
    if (tokenIn.toLowerCase() === usdgLower || tokenOut.toLowerCase() === usdgLower) return false;
    const inNative = this.isRhNativeRouterToken(chainId, tokenIn);
    const outNative = this.isRhNativeRouterToken(chainId, tokenOut);
    return (inNative && !outNative) || (outNative && !inNative);
  }

  private static isV4ExactInDesc(desc: SwapDescLike | null | undefined): boolean {
    return !!desc && desc.swapType === SwapType.V4_EXACT_IN;
  }

  private static takePreparedV4LastHop(
    preparedSplit: { lastHop: SwapDescLike } | null,
    reverse = false,
    _chainId?: number,
  ): SwapDescLike | null {
    if (!preparedSplit || !this.isV4ExactInDesc(preparedSplit.lastHop)) return null;
    return reverse ? this.reverseSwapDescLike(preparedSplit.lastHop) : { ...preparedSplit.lastHop };
  }

  private static isRhV4PoolId(value?: string | null): value is `0x${string}` {
    return /^0x[a-fA-F0-9]{64}$/.test(String(value || '').trim());
  }

  private static pickRhV4Fee(...candidates: Array<number | null | undefined>): number {
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
    return 3000;
  }

  private static rhV4PoolIdFromTokenInfo(
    tokenInfo: TokenInfo,
    hopPool?: string | null,
    displayPool?: string | null,
  ): string | null {
    for (const candidate of [
      hopPool,
      tokenInfo.biggest_pool_address,
      tokenInfo.tpool_pool_address,
      tokenInfo.pool_pair,
      displayPool,
    ]) {
      if (this.isRhV4PoolId(candidate)) return String(candidate).trim().toLowerCase();
    }
    return displayPool && isPoolRefLike(displayPool) ? displayPool : null;
  }

  private static buildRhV4MarketDesc(input: {
    tokenIn: Address;
    tokenOut: Address;
    fee?: number | null;
    tickSpacing?: number | null;
    hooks?: Address | null;
  }): SwapDescLike {
    const fee = this.pickRhV4Fee(input.fee);
    const tickSpacing = input.tickSpacing && input.tickSpacing > 0
      ? input.tickSpacing
      : this.v4TickSpacingForFee(fee);
    return getRouterSwapDesc({
      swapType: RhSwapType.V4_EXACT_IN,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      poolAddress: ZERO_ADDRESS,
      fee,
      tickSpacing,
      hooks: input.hooks ?? ZERO_ADDRESS,
      poolManager: this.rhV4PoolManager(),
    });
  }

  private static rhV4CurrencyCandidates(token: Address): Address[] {
    const normalized = this.normalizeFlapPoolCounterpartyToken(ChainId.RH, token) ?? token;
    const wrapped = getChainRuntime(ChainId.RH).wrappedNativeAddress as Address;
    const out = new Set<string>([token.toLowerCase(), normalized.toLowerCase()]);
    if (this.isRhNativeRouterToken(ChainId.RH, normalized) || this.isRhNativeRouterToken(ChainId.RH, token)) {
      out.add(ZERO_ADDRESS);
      out.add(wrapped.toLowerCase());
    }
    return [...out].map((item) => item as Address);
  }

  private static async readRhV4LpFeeFromPoolManager(poolId: string): Promise<number | null> {
    const id = String(poolId || '').trim().toLowerCase();
    if (!this.isRhV4PoolId(id)) return null;
    const poolManager = this.rhV4PoolManager();
    if (!poolManager || poolManager === ZERO_ADDRESS) return null;
    try {
      const stateSlot = keccak256(
        concat([
          id as `0x${string}`,
          pad(toHex(UNISWAP_V4_POOLS_SLOT), { size: 32 }),
        ]),
      );
      const data = await RpcService.withBalancedReadClient({
        chainId: ChainId.RH,
        caller: 'trade.v4.lpFee',
        run: async (client) => await client.readContract({
          address: poolManager,
          abi: poolManagerExtsloadAbi,
          functionName: 'extsload',
          args: [stateSlot],
        }) as `0x${string}`,
      });
      const lpFee = Number((BigInt(data) >> 208n) & 0xffffffn);
      // Runtime lpFee can be 0 for uninitialized / dynamic-before-swap; treat as miss.
      return Number.isFinite(lpFee) && lpFee > 0 ? lpFee : null;
    } catch {
      return null;
    }
  }

  private static rhV4KnownHooks(): Address[] {
    const hooks: Address[] = [
      ZERO_ADDRESS,
      RH_DOPPLER_HOOK,
      LONG_RH_REHYPE_HOOK,
      RH_STANDARD_V4_HOOK,
    ];
    try {
      hooks.push(getConfiguredPonsMemeHook());
    } catch {
    }
    for (const suite of O1_RH_SUITES) {
      hooks.push(suite.hook);
    }
    return hooks;
  }

  /**
   * Targeted Initialize(poolId) lookup — topic-filtered, not a full-chain scan.
   * Needed when hooks are unknown (GMGN fee_info has no hooks field).
   */
  private static async readRhV4PoolKeyFromInitialize(
    poolId: string,
  ): Promise<{ fee: number; tickSpacing: number; hooks: Address } | null> {
    const id = String(poolId || '').trim().toLowerCase();
    if (!this.isRhV4PoolId(id)) return null;
    if (this.rhV4InitializeKeyCache.has(id)) {
      return this.rhV4InitializeKeyCache.get(id) ?? null;
    }
    const inflight = this.rhV4InitializeKeyInFlight.get(id);
    if (inflight) return await inflight;

    const task = (async () => {
      const poolManager = this.rhV4PoolManager();
      if (!poolManager || poolManager === ZERO_ADDRESS) {
        this.rhV4InitializeKeyCache.set(id, null);
        return null;
      }
      try {
        const latest = await RpcService.withBalancedReadClient({
          chainId: ChainId.RH,
          caller: 'trade.v4.initialize.blockNumber',
          run: async (client) => await client.getBlockNumber(),
        });
        // Expand windows newest-first; indexed topic1=poolId keeps each query light.
        const windows = [100_000n, 1_000_000n, 10_000_000n, latest];
        for (const window of windows) {
          const fromBlock = window >= latest ? 0n : (latest > window ? latest - window : 0n);
          try {
            const logs = await RpcService.withBalancedReadClient({
              chainId: ChainId.RH,
              caller: 'trade.v4.initialize.getLogs',
              run: async (client) => await client.getLogs({
                address: poolManager,
                event: uniswapV4InitializeEvent,
                args: { id: id as `0x${string}` },
                fromBlock,
                toBlock: 'latest',
              }),
            });
            const log = logs?.[0];
            if (!log) continue;
            const fee = Number((log as any).args?.fee ?? 0);
            const tickSpacing = Number((log as any).args?.tickSpacing ?? 0);
            const hooksRaw = String((log as any).args?.hooks || '').trim();
            const hooks = (isAddressLike(hooksRaw) ? hooksRaw : ZERO_ADDRESS) as Address;
            if (!(fee >= 0) || !(tickSpacing > 0)) continue;
            const value = { fee, tickSpacing, hooks };
            this.rhV4InitializeKeyCache.set(id, value);
            if (fee > 0 && (fee & ~0x800000) > 0) {
              this.rhV4DisplayFeeByPoolId.set(id, fee & ~0x800000);
            } else if (fee > 0) {
              // dynamic — keep prior lpFee display if any
            }
            return value;
          } catch {
            // RPC may reject oversized ranges; try next window.
          }
        }
        this.rhV4InitializeKeyCache.set(id, null);
        return null;
      } catch {
        this.rhV4InitializeKeyCache.set(id, null);
        return null;
      } finally {
        this.rhV4InitializeKeyInFlight.delete(id);
      }
    })();

    this.rhV4InitializeKeyInFlight.set(id, task);
    return await task;
  }

  private static async resolveRhV4PoolKeyFromSources(input: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    poolId?: string | null;
    feeHint?: number | null;
  }): Promise<{ fee: number; tickSpacing: number; hooks: Address } | null> {
    const poolId = String(input.poolId || '').trim().toLowerCase();
    if (!this.isRhV4PoolId(poolId)) return null;
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase() || 'robinhood';
    const tokens = [input.tokenOut, input.tokenIn].filter((token, index, all) => {
      if (!token || !isAddressLike(token)) return false;
      if (token.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return false;
      return all.findIndex((item) => item.toLowerCase() === token.toLowerCase()) === index;
    });

    // Parallel: GMGN fee + PoolManager lpFee + targeted Initialize(poolId) for hooks.
    const [gmgnLists, lpFee, fromInit] = await Promise.all([
      tokens.length
        ? Promise.all(
          tokens.map((token) => fetchGmgnTokenPoolFeeInfoPreferPage(chain, token, { timeoutMs: 800 }).catch(() => [])),
        )
        : Promise.resolve([] as Awaited<ReturnType<typeof fetchGmgnTokenPoolFeeInfoPreferPage>>[]),
      this.readRhV4LpFeeFromPoolManager(poolId),
      this.readRhV4PoolKeyFromInitialize(poolId),
    ]);

    // Initialize is authoritative (fee + tickSpacing + hooks).
    if (fromInit && fromInit.tickSpacing > 0 && fromInit.fee >= 0) {
      const display = (fromInit.fee & ~0x800000) > 0
        ? (fromInit.fee & ~0x800000)
        : (lpFee && lpFee > 0 ? lpFee : null);
      if (display && display > 0) this.rhV4DisplayFeeByPoolId.set(poolId, display);
      return fromInit;
    }

    let gmgnFee: number | null = null;
    for (const list of gmgnLists) {
      const hit = GmgnAPI.findTokenPoolFeeInfo(list, poolId);
      if (!hit) continue;
      const feeFromRatio = GmgnAPI.feeRatioToUniswapFee(
        Number(hit.fee_ratio),
        hit.is_dynamic_fee === true,
      );
      if (typeof feeFromRatio === 'number' && feeFromRatio >= 0) {
        gmgnFee = feeFromRatio;
        break;
      }
    }

    // fee=0 is valid (o1 / many RH V4 hook pools); do not drop it like an "unknown" fee.
    const feeHint = typeof input.feeHint === 'number' && Number.isFinite(input.feeHint) && input.feeHint >= 0
      ? input.feeHint
      : null;
    const feeCandidates = [...new Set(
      [gmgnFee, lpFee, feeHint]
        .filter((fee): fee is number => typeof fee === 'number' && Number.isFinite(fee) && fee >= 0),
    )];
    // Always try fee=0 when recovering hook pools (Initialize miss / lpFee unread).
    if (!feeCandidates.includes(0)) feeCandidates.push(0);
    if (!feeCandidates.length) return null;

    const displayFee = (lpFee && lpFee > 0)
      ? lpFee
      : (gmgnFee && (gmgnFee & ~0x800000) > 0 ? (gmgnFee & ~0x800000) : null);
    if (displayFee && displayFee > 0) {
      this.rhV4DisplayFeeByPoolId.set(poolId, displayFee);
    }

    const currencies = [
      ...this.rhV4CurrencyCandidates(input.tokenIn),
      ...this.rhV4CurrencyCandidates(input.tokenOut),
    ];
    const tickHints = [
      ...feeCandidates.map((fee) => {
        const staticFee = fee & ~0x800000;
        return this.v4TickSpacingForFee(staticFee > 0 ? staticFee : fee);
      }),
      1, 8, 10, 60, 200,
    ];

    const recovered = recoverUniswapV4PoolKey({
      poolId,
      currencies,
      hooks: this.rhV4KnownHooks(),
      fees: feeCandidates,
      tickSpacings: tickHints,
      strictFees: true,
    });
    if (recovered && recovered.tickSpacing > 0 && recovered.fee >= 0) {
      // Keep fee=0 when hash-verified (common for o1 / hook pools). Do not replace with lpFee.
      return {
        fee: recovered.fee,
        tickSpacing: recovered.tickSpacing,
        hooks: recovered.hooks,
      };
    }

    // Do NOT guess hooks=0 — that built "V4 1%" labels that still revert (e.g. STANDARD).
    return null;
  }

  private static async resolveRhV4PoolKey(input: {
    tokenIn: Address;
    tokenOut: Address;
    poolId?: string | null;
    feeHint?: number | null;
    chainId?: number;
  }): Promise<{ fee: number; tickSpacing: number; hooks: Address } | null> {
    const poolId = String(input.poolId || '').trim().toLowerCase();
    const cacheKey = [
      input.tokenIn.toLowerCase(),
      input.tokenOut.toLowerCase(),
      poolId,
      input.feeHint ?? '',
    ].join(':');
    const cached = this.rhV4PoolKeyCache.get(cacheKey);
    if (cached) return await cached;
    // Fee/hooks: Initialize(poolId) when needed, else GMGN/lpFee + hash verify on known hooks.
    // No full-chain getLogs scan / fee brute-force.
    const task = (async () => {
      if (this.isRhV4PoolId(poolId)) {
        return await this.resolveRhV4PoolKeyFromSources({
          chainId: input.chainId ?? ChainId.RH,
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          poolId,
          feeHint: input.feeHint,
        });
      }

      const pons = await getPonsTradeState(input.tokenOut).catch(() => null);
      if (pons?.tradeable && pons.isOuter && pons.poolFee > 0 && pons.tickSpacing > 0) {
        if (this.isEquivalentFlapRouteToken(ChainId.RH, pons.quoteRouterToken, input.tokenIn)) {
          return {
            fee: pons.poolFee,
            tickSpacing: pons.tickSpacing,
            hooks: pons.memeHook,
          };
        }
      }
      return null;
    })();
    this.rhV4PoolKeyCache.set(cacheKey, task);
    try {
      const result = await task;
      // Do not stick a miss forever (RPC blip / gmgn tab not open yet).
      if (!result) this.rhV4PoolKeyCache.delete(cacheKey);
      return result;
    } catch (error) {
      this.rhV4PoolKeyCache.delete(cacheKey);
      throw error;
    }
  }

  private static async resolveRhV4MarketHopDesc(input: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    sell?: boolean;
  }): Promise<SwapDescLike | null> {
    if (input.sell) {
      const ponsSell = await getPonsTradeState(input.tokenIn).catch(() => null);
      if (ponsSell?.tradeable && ponsSell.isOuter) {
        return buildPonsSellDesc({ state: ponsSell, tokenIn: input.tokenIn, minOut: 0n });
      }
    } else {
      const ponsBuy = await getPonsTradeState(input.tokenOut).catch(() => null);
      if (ponsBuy?.tradeable && ponsBuy.isOuter) {
        return buildPonsBuyDesc({ state: ponsBuy, tokenOut: input.tokenOut, minOut: 0n });
      }
    }
    const pairMeta = await this.peekDexScreenerPairMeta(input.chainId, input.tokenIn, input.tokenOut);
    if (pairMeta.preferHint !== 'v4') return null;
    const v4Key = await this.resolveRhV4PoolKey({
      chainId: input.chainId,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      poolId: pairMeta.displayPool,
      feeHint: pairMeta.fee,
    });
    if (!v4Key) return null;
    return this.buildRhV4MarketDesc({
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
      fee: v4Key.fee,
      tickSpacing: v4Key.tickSpacing,
      hooks: v4Key.hooks,
    });
  }

  private static async resolveRhRouterHopDesc(input: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    isTurbo: boolean;
  }): Promise<{ desc: SwapDescLike; amountOut: bigint }> {
    const prefer = getBridgeTokenDexPreference(input.chainId as ChainId, input.tokenOut)
      ?? getBridgeTokenDexPreference(input.chainId as ChainId, input.tokenIn);
    const quoted = await resolveBridgeHopExactIn(
      input.chainId,
      input.tokenIn,
      input.tokenOut,
      input.amountIn,
      prefer,
      input.isTurbo,
      !input.isTurbo,
    );
    let v2v3Ok = !!quoted.poolAddress && quoted.poolAddress !== ZERO_ADDRESS
      && (input.isTurbo || quoted.amountOut > 0n);
    if (v2v3Ok && !input.isTurbo) {
      try {
        assertDexQuoteOk(quoted);
      } catch {
        v2v3Ok = false;
      }
    }
    if (v2v3Ok) {
      return {
        desc: getRouterSwapDesc({
          swapType: toRhDexSwapType(quoted.swapType),
          tokenIn: input.tokenIn,
          tokenOut: input.tokenOut,
          poolAddress: quoted.poolAddress,
          fee: getV3FeeForDesc(quoted, getDefaultBridgeV3Fee(input.chainId)),
        }),
        amountOut: input.isTurbo ? 1n : quoted.amountOut,
      };
    }
    const v4Desc = await this.resolveRhV4MarketHopDesc({
      chainId: input.chainId,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
    });
    if (v4Desc) {
      return {
        desc: v4Desc,
        amountOut: input.isTurbo ? 1n : 0n,
      };
    }
    throw new Error('找不到 Robinhood 桥接交易池');
  }

  private static async appendRhRouterBridgeHops(input: {
    chainId: number;
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    isTurbo: boolean;
    descs: SwapDescLike[];
    timeStep: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  }): Promise<bigint> {
    const usdg = this.rhUsdgAddress();
    const hops: Array<{ from: Address; to: Address; label: string }> =
      usdg && this.rhNeedsUsdgBridge(input.chainId, input.tokenIn, input.tokenOut)
        ? [
          { from: input.tokenIn, to: usdg, label: 'quote:rh:usdg' },
          { from: usdg, to: input.tokenOut, label: 'quote:rh:rwa' },
        ]
        : [{ from: input.tokenIn, to: input.tokenOut, label: 'quote:rh:bridge' }];
    let amount = input.amountIn;
    for (const hop of hops) {
      const resolved = await input.timeStep(hop.label, () =>
        this.resolveRhRouterHopDesc({
          chainId: input.chainId,
          tokenIn: hop.from,
          tokenOut: hop.to,
          amountIn: amount,
          isTurbo: input.isTurbo,
        })
      );
      input.descs.push(resolved.desc);
      amount = resolved.amountOut > 0n ? resolved.amountOut : 1n;
    }
    return amount;
  }

  private static async materializeEvmTradeRoutePlan(
    chainId: number,
    tokenInfo: TokenInfo,
    plan: EvmTradeRoutePlan,
  ): Promise<{
    descs: SwapDescLike[];
    liquidityUsd: Array<number | null>;
    symbols: Array<Record<string, string>>;
    displayPools: Array<string | null>;
  }> {
    const launchpadConfig = plan.inner ? this.getLaunchpadConfig(tokenInfo, chainId) : null;
    const hops = await Promise.all(plan.hops.map(async (hop: EvmTradeRoutePlanHop) => {
      const tokenIn = hop.tokenIn as Address;
      const tokenOut = hop.tokenOut as Address;
      try {
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
            displayPool: launchpadConfig.manager !== ZERO_ADDRESS ? launchpadConfig.manager : null,
          };
        }
        if (chainId === ChainId.RH && isPonsPlatform(resolveTradeLaunchpadPlatform(tokenInfo))) {
          const finalOut = plan.hops[plan.hops.length - 1]?.tokenOut;
          if (finalOut && tokenOut.toLowerCase() === String(finalOut).toLowerCase()) {
            const ponsState = await getPonsTradeState(tokenOut).catch(() => null);
            if (ponsState?.tradeable && ponsState.isOuter) {
              const desc = buildPonsBuyDesc({ state: ponsState, tokenOut, minOut: 0n });
              return {
                desc,
                liquidityUsd: null,
                symbols: {} as Record<string, string>,
                displayPool: ponsState.version === 1 ? ponsState.v3Pool : ponsState.v4PoolManager,
              };
            }
          }
        }
        const knownHopPool = hop.poolAddress && isAddressLike(hop.poolAddress) && hop.dexLabel !== 'V4'
          ? hop.poolAddress as Address
          : null;
        if (knownHopPool && chainId !== ChainId.RH) {
          try {
            const desc = await this.resolveKnownPoolRouteDesc({
              chainId,
              tokenIn,
              tokenOut,
              poolAddress: knownHopPool,
              preferHint: hop.dexLabel === 'V3' ? 'v3' : hop.dexLabel === 'V2' ? 'v2' : null,
              fee: hop.fee,
            });
            return {
              desc,
              liquidityUsd: null,
              symbols: {} as Record<string, string>,
              displayPool: knownHopPool,
            };
          } catch {
          }
        }
        const isLastMarketHop = tokenOut.toLowerCase() === String(tokenInfo.address || '').toLowerCase();
        if (isLastMarketHop && chainId !== ChainId.RH) {
          const official = this.getKnownDexPoolAddress(tokenInfo);
          const lastPool = (official && isAddressLike(official)) ? official : knownHopPool;
          if (lastPool) {
            const desc = await this.resolveKnownPoolRouteDesc({
              chainId,
              tokenIn,
              tokenOut,
              poolAddress: lastPool,
              preferHint: (() => {
                const fromDex = this.normalizeDexPrefer(tokenInfo.dex_type);
                if (fromDex === 'v2' || fromDex === 'v3') return fromDex;
                if (hop.dexLabel === 'V3') return 'v3';
                if (hop.dexLabel === 'V2') return 'v2';
                return null;
              })(),
              fee: hop.fee,
              dexType: tokenInfo.dex_type,
            });
            return {
              desc,
              liquidityUsd: null,
              symbols: {} as Record<string, string>,
              displayPool: lastPool,
            };
          }
        }
        const platformNow = resolveTradeLaunchpadPlatform(tokenInfo);
        const isO1Hop = isLastMarketHop && isO1LaunchpadPlatform(platformNow);
        const isLongHop = isLastMarketHop && isLongLaunchpadPlatform(platformNow);
        const hopPoolIsV4 = chainId === ChainId.RH && this.isRhV4PoolId(hop.poolAddress);
        const rhWantV4 = chainId === ChainId.RH && (
          hop.dexLabel === 'V4'
          || hop.dexLabel === 'pons'
          || hopPoolIsV4
          || isO1Hop
          || isLongHop
        );
        if (rhWantV4) {
          const hintedPoolId = this.rhV4PoolIdFromTokenInfo(tokenInfo, hop.poolAddress, null);
          const o1State = isO1Hop
            ? await getO1LaunchState(tokenOut, {
                poolId: hintedPoolId,
                extraCurrencies: [tokenIn, hop.poolAddress],
              }).catch(() => null)
            : null;
          const longState = (!o1State && isLongHop)
            ? await getLongLaunchState(tokenOut, {
                poolId: hintedPoolId,
                extraCurrencies: [tokenIn, hop.poolAddress, tokenInfo.quote_token_address],
              }).catch(() => null)
            : null;
          const launchKey = o1State
            ? { fee: o1State.fee, tickSpacing: o1State.tickSpacing, hooks: o1State.hooks, poolId: o1State.poolId }
            : longState
              ? { fee: longState.fee, tickSpacing: longState.tickSpacing, hooks: longState.hooks, poolId: longState.poolId }
              : null;
          const v4Key = launchKey
            ? { fee: launchKey.fee, tickSpacing: launchKey.tickSpacing, hooks: launchKey.hooks }
            : await this.resolveRhV4PoolKey({
                chainId,
                tokenIn,
                tokenOut,
                poolId: hintedPoolId,
                feeHint: hop.fee,
              });
          // fee=0 and dynamic-fee flag are valid for RH hook pools. Require tickSpacing.
          if (this.isUsableRhV4PoolKey(v4Key)) {
            const fee = this.pickRhV4Fee(v4Key.fee, hop.fee);
            const tickSpacing = (v4Key.tickSpacing && v4Key.tickSpacing > 0)
              ? v4Key.tickSpacing
              : this.v4TickSpacingForFee(fee > 0 ? fee : 3000);
            const desc = this.buildRhV4MarketDesc({
              tokenIn,
              tokenOut,
              fee,
              tickSpacing,
              hooks: v4Key.hooks,
            });
            return {
              desc,
              liquidityUsd: null,
              symbols: {} as Record<string, string>,
              displayPool: launchKey?.poolId || hintedPoolId || hop.poolAddress || desc.poolManager,
            };
          }
        }
        // V4 poolIds are 32-byte refs; do not treat them as "known pool address" and skip
        // DexScreener — that path previously locked preferHint to the (often wrong) hop.dexLabel.
        const hopHasPoolRef = !!(hop.poolAddress && isAddressLike(hop.poolAddress));
        const pairMeta = hopHasPoolRef
          ? {
              liquidityUsd: null as number | null,
              symbols: {} as Record<string, string>,
              poolAddress: hop.poolAddress as Address,
              displayPool: hop.poolAddress || null,
              preferHint: (
                hop.dexLabel === 'V4' ? 'v4'
                  : hop.dexLabel === 'V3' ? 'v3'
                    : hop.dexLabel === 'V2' ? 'v2'
                      : null
              ) as 'v2' | 'v3' | 'v4' | null,
            }
          : await this.peekDexScreenerPairMeta(chainId, tokenIn, tokenOut);
        if (hop.poolAddress && isAddressLike(hop.poolAddress) && hop.kind === 'bridge') {
          return {
            desc: getRouterSwapDesc({
              swapType: this.toPreviewDexSwapType(chainId, hop, hop.dexLabel === 'V3' ? 'v3' : 'v2'),
              tokenIn,
              tokenOut,
              poolAddress: hop.poolAddress as Address,
              fee: hop.fee ?? 0,
            }),
            liquidityUsd: pairMeta.liquidityUsd,
            symbols: pairMeta.symbols,
            displayPool: pairMeta.displayPool || hop.poolAddress,
          };
        }
        const knownPool = hop.dexLabel === 'V4'
          ? pairMeta.poolAddress
          : hop.poolAddress && isAddressLike(hop.poolAddress)
            ? hop.poolAddress as Address
            : pairMeta.poolAddress;
        const preferred = (knownPool || !isLastMarketHop)
          ? null
          : await this.getPreferredFlapOuterTargetPool({
            chainId,
            tokenAddress: tokenOut,
            quoteTokenAddress: tokenIn,
            tokenInfo,
            pairOnly: true,
          }).catch(() => null);
        const preferHint = preferred?.preferHint
          ?? pairMeta.preferHint
          ?? (hop.dexLabel === 'V4' ? 'v4' as const
            : hop.dexLabel === 'V3' ? 'v3' as const
              : hop.dexLabel === 'V2' ? 'v2' as const
                : null);
        if (chainId === ChainId.RH && preferHint === 'v4') {
          const hintedPoolId = this.rhV4PoolIdFromTokenInfo(tokenInfo, hop.poolAddress, pairMeta.displayPool);
          const longFallback = isLongLaunchpadPlatform(resolveTradeLaunchpadPlatform(tokenInfo))
            ? await getLongLaunchState(tokenOut, {
                poolId: hintedPoolId,
                extraCurrencies: [tokenIn, hop.poolAddress, tokenInfo.quote_token_address],
              }).catch(() => null)
            : null;
          const v4Key = longFallback
            ? { fee: longFallback.fee, tickSpacing: longFallback.tickSpacing, hooks: longFallback.hooks }
            : await this.resolveRhV4PoolKey({
                chainId,
                tokenIn,
                tokenOut,
                poolId: hintedPoolId,
                feeHint: hop.fee ?? pairMeta.fee,
              });
          if (this.isUsableRhV4PoolKey(v4Key)) {
            const fee = this.pickRhV4Fee(v4Key.fee, hop.fee, pairMeta.fee);
            const tickSpacing = (v4Key.tickSpacing && v4Key.tickSpacing > 0)
              ? v4Key.tickSpacing
              : (pairMeta.tickSpacing && pairMeta.tickSpacing > 0)
                ? pairMeta.tickSpacing
                : this.v4TickSpacingForFee(fee > 0 ? fee : 3000);
            const desc = this.buildRhV4MarketDesc({
              tokenIn,
              tokenOut,
              fee,
              tickSpacing,
              hooks: v4Key.hooks,
            });
            return {
              desc,
              liquidityUsd: pairMeta.liquidityUsd,
              symbols: pairMeta.symbols,
              displayPool: longFallback?.poolId || pairMeta.displayPool || hintedPoolId || desc.poolManager,
            };
          }
        }
        const execPrefer = preferHint;
        const poolAddress = knownPool ?? preferred?.poolAddress ?? ZERO_ADDRESS;
        const hopLiquidityUsd = typeof preferred?.liquidityUsd === 'number' && preferred.liquidityUsd > 0
          ? preferred.liquidityUsd
          : pairMeta.liquidityUsd;
        const hopSymbols = {
          ...pairMeta.symbols,
          ...(preferred?.symbols ?? {}),
        };
        const hopDisplayPool = pairMeta.displayPool || (poolAddress !== ZERO_ADDRESS ? poolAddress : null);
        // Known V3/V2 pair address: resolve fee from the pool contract (all chains including RH).
        // RH previously skipped this and fell through to default fee=500 → POOL_NOT_FOUND.
        if (
          poolAddress !== ZERO_ADDRESS
          && isAddressLike(poolAddress)
          && !this.isRhV4PoolId(poolAddress)
          && execPrefer !== 'v4'
          && hop.dexLabel !== 'V4'
        ) {
          try {
            const desc = await this.resolveKnownPoolRouteDesc({
              chainId,
              tokenIn,
              tokenOut,
              poolAddress,
              // Do not invent preferHint here — getKnownPoolRouteMeta classifies on-chain.
              preferHint: execPrefer === 'v3' ? 'v3' : execPrefer === 'v2' ? 'v2' : null,
              fee: preferred?.fee ?? hop.fee ?? pairMeta.fee,
            });
            return {
              desc,
              liquidityUsd: hopLiquidityUsd,
              symbols: hopSymbols,
              displayPool: hopDisplayPool,
            };
          } catch {
          }
        }
        // RH V4 without a resolved fee must not fall into V3 defaults or fee=0 executable descs.
        if (
          chainId === ChainId.RH
          && (
            execPrefer === 'v4'
            || hop.dexLabel === 'V4'
            || this.isRhV4PoolId(hop.poolAddress)
            || this.isRhV4PoolId(pairMeta.displayPool)
          )
        ) {
          const v4Display = hopDisplayPool || hop.poolAddress || pairMeta.displayPool;
          const feeHint = preferred?.fee ?? hop.fee ?? pairMeta.fee;
          const v4Key = await this.resolveRhV4PoolKey({
            chainId,
            tokenIn,
            tokenOut,
            poolId: v4Display,
            feeHint,
          });
          if (this.isUsableRhV4PoolKey(v4Key)) {
            const fee = this.pickRhV4Fee(v4Key.fee, preferred?.fee, hop.fee, pairMeta.fee);
            const tickSpacing = v4Key.tickSpacing > 0
              ? v4Key.tickSpacing
              : this.v4TickSpacingForFee(fee > 0 ? fee : 3000);
            const desc = this.buildRhV4MarketDesc({
              tokenIn,
              tokenOut,
              fee,
              tickSpacing,
              hooks: v4Key.hooks,
            });
            return {
              desc,
              liquidityUsd: hopLiquidityUsd,
              symbols: hopSymbols,
              displayPool: v4Display || desc.poolManager,
            };
          }
          throw new Error(
            `RH Uniswap V4 pool fee 未就绪 (${tokenIn}/${tokenOut}, pool=${v4Display || 'unknown'})`,
          );
        }
        const wantV3 = execPrefer === 'v3' || hop.dexLabel === 'V3' || (chainId === ChainId.RH && !execPrefer);
        const v3Fee = wantV3
          ? (preferred?.fee ?? hop.fee ?? pairMeta.fee ?? getDefaultBridgeV3Fee(chainId))
          : (hop.fee ?? 0);
        return {
          desc: getRouterSwapDesc({
            swapType: this.toPreviewDexSwapType(chainId, hop, execPrefer),
            tokenIn,
            tokenOut,
            poolAddress,
            fee: v3Fee,
          }),
          liquidityUsd: hopLiquidityUsd,
          symbols: hopSymbols,
          displayPool: hopDisplayPool,
        };
      } catch {
        return {
          desc: getRouterSwapDesc({
            swapType: this.toPreviewDexSwapType(chainId, hop, hop.dexLabel === 'V3' ? 'v3' : hop.dexLabel === 'V4' ? 'v4' : null),
            tokenIn,
            tokenOut,
            poolAddress: (hop.poolAddress && isAddressLike(hop.poolAddress) ? hop.poolAddress : ZERO_ADDRESS) as Address,
            fee: hop.fee ?? 0,
          }),
          liquidityUsd: null,
          symbols: {} as Record<string, string>,
          displayPool: hop.poolAddress || null,
        };
      }
    }));
    return {
      descs: hops.map((item) => item.desc),
      liquidityUsd: hops.map((item) => item.liquidityUsd),
      symbols: hops.map((item) => item.symbols),
      displayPools: hops.map((item) => item.displayPool ?? null),
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

  private static labelQuickTradeDex(swapType: number, chainId?: number): string {
    if (chainId === ChainId.RH) {
      if (swapType === RhSwapType.PONS_V2_BUY || swapType === RhSwapType.PONS_V2_SELL) return 'pons';
      if (swapType === RhSwapType.PONS_V1_EXACT_IN || swapType === RhSwapType.V3_EXACT_IN) return 'V3';
      if (swapType === RhSwapType.V4_EXACT_IN) return 'V4';
      if (swapType === RhSwapType.V2_EXACT_IN) return 'V2';
    }
    if (swapType === SwapType.V3_EXACT_IN) return 'V3';
    if (swapType === SwapType.V4_EXACT_IN || swapType === SwapType.PANCAKE_INFINITY_EXACT_IN) return 'V4';
    if (swapType === SwapType.FOUR_MEME_BUY_AMAP || swapType === SwapType.FOUR_MEME_SELL) return 'four.meme';
    if (swapType === SwapType.FLAP_EXACT_INPUT) return 'Flap';
    if (swapType === SwapType.OPEN_FOUR_EXACT_IN) return 'OpenFour';
    if (swapType === SwapType.V2_EXACT_IN) return 'V2';
    return 'DEX';
  }

  private static previewFeeFromDesc(desc: SwapDescLike, displayPool?: string | null): number | null {
    const fee = typeof desc.fee === 'number' && Number.isFinite(desc.fee) ? desc.fee : null;
    if (fee == null || fee < 0) return null;
    const dynamic = 0x800000;
    const isPureDynamic = (fee & dynamic) !== 0 && (fee & ~dynamic) === 0;
    if (isPureDynamic) {
      const poolId = String(displayPool || '').trim().toLowerCase();
      const cached = poolId ? this.rhV4DisplayFeeByPoolId.get(poolId) : null;
      // Prefer runtime lpFee for the badge; keep a dynamic marker so UI can show「动态」if unknown.
      if (typeof cached === 'number' && cached > 0) return cached;
      return fee;
    }
    return fee > 0 ? fee : null;
  }

  private static toQuickTradeRoutePreview(
    chainId: number,
    tokenInfo: TokenInfo,
    descs: SwapDescLike[],
    liquidityUsd?: Array<number | null>,
    hopSymbols?: Array<Record<string, string>>,
    displayPools?: Array<string | null>,
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
      dexLabel: this.labelQuickTradeDex(desc.swapType, chainId),
      poolAddress: this.previewPoolAddress(desc, displayPools?.[index]),
      fee: this.previewFeeFromDesc(desc, displayPools?.[index]),
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
        const prefix = await this.buildOuterMarketBuyQuoteRoute({
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
    const hasQuote = isAddressLike(tokenInfo.quote_token_address);
    const hasPool = !!(tokenInfo.pool_pair || tokenInfo.biggest_pool_address || tokenInfo.tpool_pool_address || tokenInfo.flap_v4_fee);
    if (hasQuote && hasPool) return tokenInfo;
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
      // Direct service call — never browser.runtime.sendMessage from background
      // (self-messaging deadlocks the prewarm/prepare handler until timeout).
      const state = await TokenFlapService.getTokenInfo(chainId, tokenAddress);
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
          onchain = await TokenFlapService.getTokenInfo(chainId, tokenAddress);
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
        let mergedQuoteToken = officialInfo?.quote_token || tradeInfo?.quote_token || '';
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

        if (mergedPoolPair && !mergedQuoteTokenAddress) {
          const officialPoolQuote = await this.resolveQuoteFromOfficialPool({
            chainId,
            tokenAddress,
            poolAddress: mergedPoolPair,
            debug,
          });
          if (officialPoolQuote) {
            mergedQuoteTokenAddress = officialPoolQuote.quoteTokenAddress;
            mergedQuoteToken = officialPoolQuote.quoteSymbol || mergedQuoteToken;
            mergedDexType = officialPoolQuote.dexType || mergedDexType;
          }
        } else if (!mergedPoolPair && (!mergedQuoteTokenAddress || !mergedDexType)) {
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

  private static inferV3Factory(chainId: number, dexType?: string | null): Address | undefined {
    const deploys = DeployAddress[chainId as ChainId] ?? {};
    const pancake = deploys[ContractNames.PancakeFactoryV3]?.address;
    const uni = deploys[ContractNames.UniswapFactoryV3]?.address;
    const raw = String(dexType || '').toLowerCase();
    if (raw.includes('uniswap') && isAddressLike(uni)) return uni as Address;
    if (raw.includes('pancake') && isAddressLike(pancake)) return pancake as Address;
    if (chainId === ChainId.BNB && isAddressLike(pancake)) return pancake as Address;
    if (isAddressLike(uni)) return uni as Address;
    return isAddressLike(pancake) ? pancake as Address : undefined;
  }

  private static async getKnownPoolRouteMeta(
    chainId: number,
    poolAddress: Address,
    preferHint?: 'v2' | 'v3' | null,
    feeHint?: number | null,
    dexType?: string | null,
  ): Promise<{ prefer: 'v2' | 'v3'; fee?: number; v3Factory?: Address } | null> {
    // Cache by pool only — same address must not flip V2/V3 across preferHint variants.
    const key = `${chainId}:${poolAddress.toLowerCase()}`;
    let task = this.flapKnownPoolMetaCache.get(key);
    if (!task) {
      task = (async () => {
        const client = await RpcService.getClient(chainId);
        // On-chain type is authoritative. preferHint alone used to force V3 with default
        // fee=500 when fee() reverted on a V2 pair (e.g. 4Stock/BNC4) → label flip-flop.
        try {
          const feeRaw = await client.readContract({
            address: poolAddress,
            abi: poolV3Abi,
            functionName: 'fee',
          });
          const fee = Number(feeRaw);
          if (Number.isFinite(fee) && fee > 0 && fee <= 1_000_000) {
            return {
              prefer: 'v3' as const,
              fee,
              v3Factory: this.inferV3Factory(chainId, dexType),
            };
          }
        } catch {
        }
        try {
          await client.readContract({
            address: poolAddress,
            abi: pairV2Abi,
            functionName: 'getReserves',
          });
          return { prefer: 'v2' as const };
        } catch {
        }
        // Last resort only when chain probes both fail (rare / broken RPC).
        if (preferHint === 'v3') {
          const fee = typeof feeHint === 'number' && feeHint > 0
            ? feeHint
            : getDefaultBridgeV3Fee(chainId);
          return {
            prefer: 'v3' as const,
            fee,
            v3Factory: this.inferV3Factory(chainId, dexType),
          };
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
    fee?: number | null;
    dexType?: string | null;
    debug?: boolean;
  }): Promise<SwapDescLike> {
    const meta = await this.getKnownPoolRouteMeta(
      input.chainId,
      input.poolAddress,
      input.preferHint,
      input.fee,
      input.dexType,
    );
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
      swapType: input.chainId === ChainId.RH
        ? (meta.prefer === 'v3' ? RhSwapType.V3_EXACT_IN : RhSwapType.V2_EXACT_IN)
        : (meta.prefer === 'v3' ? SwapType.V3_EXACT_IN : SwapType.V2_EXACT_IN),
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
    if (chainId === ChainId.RH) return descs;
    return descs.map((desc) => {
      if (desc.swapType !== SwapType.V3_EXACT_IN) return desc;
      if (!desc.poolAddress || desc.poolAddress === ZERO_ADDRESS) return desc;
      if (desc.poolManager && desc.poolManager !== ZERO_ADDRESS) {
        if (!this.isAllowedRouterV3Factory(chainId, desc.poolManager)) {
          throw new Error('该 V3 池不属于 Pancake/Uniswap，当前路由无法成交');
        }
        return desc;
      }
      const factory = this.inferV3Factory(chainId);
      if (!factory) return desc;
      if (!this.isAllowedRouterV3Factory(chainId, factory)) {
        throw new Error('该 V3 池不属于 Pancake/Uniswap，当前路由无法成交');
      }
      return { ...desc, poolManager: factory };
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
    if (this.isLikelySentinelFlapQuoteToken(raw)) return null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
    const normalized = raw.toLowerCase();
    const wrappedNative = getChainRuntime(chainId).wrappedNativeAddress.toLowerCase();
    if (normalized === ZERO_ADDRESS.toLowerCase() || normalized === wrappedNative) return null;
    return raw as Address;
  }

  private static normalizeDexPrefer(dexType?: string): 'v2' | 'v3' | 'v4' | null {
    const prefer = dexType ? getDexPoolPrefer(dexType) : null;
    return prefer === 'v2' || prefer === 'v3' || prefer === 'v4' ? prefer : null;
  }

  private static mapDexScreenerPairDexType(pair: DexScreenerPair | null | undefined): string | undefined {
    if (!pair) return undefined;
    const dex = String(pair.dexId || '').toLowerCase();
    const raw = [
      dex,
      Array.isArray(pair.labels) ? pair.labels.join(' ') : '',
      String(pair.url || ''),
    ].join(' ').toLowerCase();
    const isV4 = raw.includes('v4');
    const isV3 = !isV4 && (raw.includes('v3') || raw.includes('clmm') || /(^|[^a-z])cl([^a-z]|$)/.test(raw));
    if (dex.includes('uniswap')) return isV4 ? 'UNISWAP_V4' : isV3 ? 'UNISWAP_V3' : 'UNISWAP';
    if (isV4) return 'UNISWAP_V4';
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
    if (chainId === ChainId.RH) return dex.includes('uniswap') || dex.includes('pons');
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
    const liquidityUsd = DexScreenerAPI.effectiveLiquidityUsd(pair);
    if (liquidityUsd < FLAP_DEXSCREENER_MIN_LIQUIDITY_USD) return null;
    const dexType = this.mapDexScreenerPairDexType(pair);
    if (String(dexType || '').toLowerCase().includes('v4')) return null;
    const fee = this.parseDexScreenerSwapFee(pair);
    const preferHint = this.normalizeDexPrefer(dexType) ?? (fee ? 'v3' : 'v2');
    return {
      pair,
      counterparty,
      liquidityUsd,
      preferHint,
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
    const resolved: Array<DexScreenerQuoteHop & { rank: number }> = [];
    for (const pair of pairs) {
      if (!pair?.pairAddress || !isAddressLike(pair.pairAddress)) continue;
      if (!this.isRouterSupportedDexScreenerPair(input.chainId, pair)) continue;
      const liquidityUsd = DexScreenerAPI.effectiveLiquidityUsd(pair);
      if (liquidityUsd <= 0) continue;
      const rawCounterparty = this.getDexScreenerCounterpartyToken(pair, input.tokenAddress);
      if (!rawCounterparty) continue;
      const counterparty = this.normalizeFlapPoolCounterpartyToken(input.chainId, rawCounterparty) ?? rawCounterparty;
      if (counterparty.toLowerCase() === tokenLower) continue;
      const routeLower = counterparty.toLowerCase();
      if (input.excludeTokens?.has(routeLower) || input.excludeTokens?.has(rawCounterparty.toLowerCase())) continue;
      const isCurrent = this.isEquivalentFlapRouteToken(input.chainId, counterparty, input.currentToken);
      const isTerminal = this.isFlapOuterRouteTerminalToken(input.chainId, counterparty);
      if (input.preferTerminalOnly && !isCurrent && !isTerminal) continue;
      const dexType = this.mapDexScreenerPairDexType(pair);
      if (String(dexType || '').toLowerCase().includes('v4')) continue;
      resolved.push({
        poolAddress: pair.pairAddress as Address,
        counterparty,
        preferHint: this.normalizeDexPrefer(dexType) ?? (this.parseDexScreenerSwapFee(pair) ? 'v3' : 'v2'),
        liquidityUsd,
        rank: isCurrent ? 0 : isTerminal ? 1 : 2,
      });
    }

    resolved.sort((a, b) => {
      if (a.liquidityUsd !== b.liquidityUsd) return b.liquidityUsd - a.liquidityUsd;
      if (a.rank !== b.rank) return a.rank - b.rank;
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
      method: 'token_pairs_liquidity_usd',
      pairCount: pairs.length,
      consideredHopCount: resolved.length,
      keptHopCount: unique.length,
      consideredHops: resolved.slice(0, 10).map((hop) => ({
        pool: hop.poolAddress,
        counterparty: hop.counterparty,
        preferHint: hop.preferHint,
        liquidityUsd: hop.liquidityUsd,
        rank: hop.rank,
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

  private static async resolveTokenDeepestDexHome(input: {
    chainId: number;
    tokenAddress: Address;
    debug?: boolean;
  }): Promise<DexScreenerQuoteHop | null> {
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return null;
    const pairs = await DexScreenerAPI.getPairsByToken(chain, input.tokenAddress).catch(() => []);
    if (!pairs.length) return null;

    const candidates: DexScreenerQuoteHop[] = [];
    for (const pair of pairs) {
      if (!pair?.pairAddress || !isAddressLike(pair.pairAddress)) continue;
      if (!this.isRouterSupportedDexScreenerPair(input.chainId, pair)) continue;
      const rawCounterparty = this.getDexScreenerCounterpartyToken(pair, input.tokenAddress);
      if (!rawCounterparty) continue;
      const counterparty = this.normalizeFlapPoolCounterpartyToken(input.chainId, rawCounterparty) ?? rawCounterparty;
      if (this.isEquivalentFlapRouteToken(input.chainId, counterparty, input.tokenAddress)) continue;
      const liquidityUsd = DexScreenerAPI.effectiveLiquidityUsd(pair);
      if (liquidityUsd < FLAP_DEXSCREENER_MIN_LIQUIDITY_USD) continue;
      candidates.push({
        poolAddress: pair.pairAddress as Address,
        counterparty,
        preferHint: this.normalizeDexPrefer(this.mapDexScreenerPairDexType(pair)),
        liquidityUsd,
      });
    }
    if (!candidates.length) return null;

    // Prefer stable terminals (USDT/USDC/…) over native/WBNB so catalog quotes like GMEB
    // resolve as BNB→USDT→GMEB instead of a thin direct BNB pair.
    const stableHomes = candidates.filter((item) => (
      isTradeRouteTerminalQuote(input.chainId, item.counterparty)
      && !isTradeRouteNativeToken(input.chainId, item.counterparty)
    ));
    const pool = (stableHomes.length ? stableHomes : candidates)
      .slice()
      .sort((a, b) => b.liquidityUsd - a.liquidityUsd)[0];
    if (!pool) return null;

    this.logRoutePool(input.debug, 'dex.home.selected', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      home: pool.counterparty,
      pool: pool.poolAddress,
      liquidityUsd: pool.liquidityUsd,
      homeIsTerminal: isTradeRouteTerminalQuote(input.chainId, pool.counterparty),
      preferredStableHome: stableHomes.length > 0,
    });
    return pool;
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
      if (isTradeRouteTerminalQuote(input.chainId, viaToken)) {
        descs.push(await this.resolveRouteHopDesc({
          chainId: input.chainId,
          tokenIn: input.currentToken,
          tokenOut: viaToken,
          prefer: getBridgeTokenDexPreference(input.chainId as ChainId, viaToken) ?? null,
        }));
      } else {
        const prefix = await this.buildOuterMarketBuyQuoteRoute({
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

  private static async resolveQuoteFromOfficialPool(input: {
    chainId: number;
    tokenAddress: Address;
    tokenInfo?: Pick<TokenInfo, 'pool_pair' | 'biggest_pool_address' | 'tpool_pool_address'> | null;
    poolAddress?: string | null;
    debug?: boolean;
  }): Promise<{ quoteTokenAddress: Address; quoteSymbol?: string; dexType?: string; poolAddress: Address } | null> {
    const knownPool = input.tokenInfo
      ? this.getKnownDexPoolAddress(input.tokenInfo)
      : null;
    const poolAddress = (
      (isAddressLike(input.poolAddress) ? input.poolAddress : null)
      || knownPool
    ) as Address | null;
    if (!poolAddress) return null;
    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();
    if (chain) {
      const fromDex = await resolveQuoteFromDexScreenerPool({
        chain,
        tokenAddress: input.tokenAddress,
        poolAddress,
      }).catch(() => null);
      if (fromDex?.quoteTokenAddress) {
        const quote = this.normalizeFlapPoolCounterpartyToken(input.chainId, fromDex.quoteTokenAddress)
          ?? fromDex.quoteTokenAddress;
        this.logRoutePool(input.debug, 'official_pool.quote', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          poolAddress,
          quoteTokenAddress: quote,
          source: 'dexscreener_pair',
        });
        return {
          quoteTokenAddress: quote,
          quoteSymbol: fromDex.quoteSymbol,
          dexType: fromDex.dexType,
          poolAddress,
        };
      }
    }
    const onchainQuote = await this.primeKnownPoolCounterpartyToken(
      input.chainId,
      poolAddress,
      input.tokenAddress,
      input.debug,
    );
    if (!onchainQuote) return null;
    this.logRoutePool(input.debug, 'official_pool.quote', {
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      poolAddress,
      quoteTokenAddress: onchainQuote,
      source: 'onchain_pair',
    });
    return {
      quoteTokenAddress: onchainQuote,
      poolAddress,
    };
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
      if (DexScreenerAPI.effectiveLiquidityUsd(pair) < FLAP_DEXSCREENER_MIN_LIQUIDITY_USD) return null;
      const counterparty = this.getDexScreenerCounterpartyToken(pair, input.tokenAddress);
      if (!counterparty) return null;
      return { pair, counterparty };
    }))).filter(Boolean) as Array<{ pair: DexScreenerPair; counterparty: Address }>;

    const best = pairs.sort((a, b) => (
      DexScreenerAPI.effectiveLiquidityUsd(b.pair) - DexScreenerAPI.effectiveLiquidityUsd(a.pair)
    ))[0];
    if (!best || DexScreenerAPI.effectiveLiquidityUsd(best.pair) < FLAP_DEXSCREENER_MIN_LIQUIDITY_USD) return null;

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
    const officialPool = input.pairOnly ? null : this.getKnownDexPoolAddress(input.tokenInfo);
    const officialPrefer = input.pairOnly ? null : this.normalizeDexPrefer(input.tokenInfo?.dex_type);
    if (officialPool) {
      this.logRoutePool(input.debug, 'preferred_pool.selected', {
        chainId: input.chainId,
        tokenAddress: input.tokenAddress,
        quoteTokenAddress: input.quoteTokenAddress,
        source: input.logEvent ?? 'target.pool.selected',
        pickedFrom: 'official_pool',
        pool: officialPool,
        preferHint: officialPrefer,
      });
      return {
        poolAddress: officialPool,
        preferHint: officialPrefer,
      };
    }

    const chain = String(chainNames[input.chainId as ChainId] || '').trim().toLowerCase();
    if (!chain) return { poolAddress: null, preferHint: null };
    const queryQuoteToken = this.toDexScreenerPairToken(input.chainId, input.quoteTokenAddress) ?? input.quoteTokenAddress;
    const dexPair = await DexScreenerAPI.getBestPairForToken({
      chain,
      tokenAddress: input.tokenAddress,
      quoteTokenAddress: queryQuoteToken,
    }).catch(() => null);
    const pairAddress = dexPair?.pairAddress && isAddressLike(dexPair.pairAddress)
      ? (dexPair.pairAddress as Address)
      : null;
    const pairLiquidityUsd = DexScreenerAPI.effectiveLiquidityUsd(dexPair);
    const pairCounterparty = dexPair
      ? this.getDexScreenerCounterpartyToken(dexPair, input.tokenAddress)
      : null;
    const pairMatchesQuote = !!pairCounterparty
      && this.isEquivalentFlapRouteToken(input.chainId, pairCounterparty, input.quoteTokenAddress);
    if (
      pairAddress
      && dexPair
      && this.isRouterSupportedDexScreenerPair(input.chainId, dexPair)
      && pairMatchesQuote
      && pairLiquidityUsd > 0
    ) {
      const dexType = this.mapDexScreenerPairDexType(dexPair);
      if (!String(dexType || '').toLowerCase().includes('v4')) {
        const pairFee = this.parseDexScreenerSwapFee(dexPair);
        const pairPrefer = this.normalizeDexPrefer(dexType) ?? (pairFee ? 'v3' : 'v2');
        this.logRoutePool(input.debug, 'preferred_pool.selected', {
          chainId: input.chainId,
          tokenAddress: input.tokenAddress,
          quoteTokenAddress: input.quoteTokenAddress,
          source: input.logEvent ?? 'target.pool.selected',
          pickedFrom: 'dexscreener',
          pool: pairAddress,
          preferHint: pairPrefer,
          fee: pairFee,
          liquidityUsd: pairLiquidityUsd,
        });
        return {
          poolAddress: pairAddress,
          preferHint: pairPrefer,
          fee: pairFee ?? undefined,
          liquidityUsd: pairLiquidityUsd || undefined,
          symbols: this.collectDexScreenerPairSymbols(input.chainId, dexPair),
        };
      }
    }
    return { poolAddress: null, preferHint: null };
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
    const flapManager = bnbContracts?.[ContractNames.FlapshTokenManager]?.address?.toLowerCase();
    return normalized === poolManager
      || normalized === infinityVault
      || normalized === flapManager;
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
        if (this.isRhV4PoolId(candidate)) return candidate as Address;
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
    if (swapType === RhSwapType.PONS_V2_BUY) return RhSwapType.PONS_V2_SELL;
    if (swapType === RhSwapType.PONS_V2_SELL) return RhSwapType.PONS_V2_BUY;
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
      if (isTradeRouteTerminalQuote(chainId, officialQuote)) {
        descs.push(await this.resolveRouteHopDesc({
          chainId,
          tokenIn: routeCurrentToken,
          tokenOut: officialQuote,
          prefer: getBridgeTokenDexPreference(chainId as ChainId, officialQuote) ?? null,
        }));
      } else {
        const prefix = await this.buildOuterMarketBuyQuoteRoute({
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
        fee: officialPool.fee,
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
      fee: best.pool.fee,
      debug,
    }));
    return descs;
  }

  private static async buildOuterMarketBuyQuoteRoute(input: {
    chainId: number;
    currentToken: Address;
    targetToken: Address;
    visited?: Set<string>;
    debug?: boolean;
    depth?: number;
    skipCache?: boolean;
    amountIn?: bigint;
  }): Promise<SwapDescLike[] | null> {
    // Native → quote for every outer-market token. Cached 24h, not Flap-only.
    const { chainId, currentToken, targetToken } = input;
    const debug = input.debug === true;
    const depth = input.depth ?? 0;
    if (this.isEquivalentFlapRouteToken(chainId, currentToken, targetToken)) return [];

    const sliced = sliceOuterMarketRoute(chainId, currentToken, targetToken);
    if (sliced) {
      this.logFlapStocksRoute(debug, 'buy.route.cache_hit', {
        chainId,
        currentToken,
        targetToken,
        cached: sliced.length,
      });
      return sliced;
    }

    const nativeCurrent = isTradeRouteNativeToken(chainId, currentToken);
    if (nativeCurrent && input.skipCache !== true) {
      const inflight = getOuterMarketRouteInFlight(chainId, targetToken);
      if (inflight) {
        this.logFlapStocksRoute(debug, 'buy.route.cache_await', {
          chainId,
          currentToken,
          targetToken,
        });
        const value = await inflight;
        return sliceOuterMarketRoute(chainId, currentToken, targetToken)
          ?? this.cloneSwapDescLikeArray(value);
      }
      const task = this.buildOuterMarketBuyQuoteRoute({
        ...input,
        skipCache: true,
      }).then((result) => {
        if (result?.length) setOuterMarketRoute(chainId, targetToken, result);
        return result;
      }).finally(() => {
        clearOuterMarketRouteInFlight(chainId, targetToken);
      });
      setOuterMarketRouteInFlight(chainId, targetToken, task);
      this.logFlapStocksRoute(debug, 'buy.route.cache_miss', {
        chainId,
        currentToken,
        targetToken,
      });
      return this.cloneSwapDescLikeArray(await task);
    }

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
    if (isTradeRouteTerminalQuote(chainId, targetToken)) {
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

    // Catalog quote assets (GMEB/ASTER/…) are outer-market hops — DexScreener home,
    // not Flap launchpad identity. Skipping identity avoids slow/wrong official lineage.
    const isCatalogQuoteAsset = !!getKnownQuoteTokenSymbol(chainId, targetToken);
    if (isCatalogQuoteAsset && isTradeRouteNativeToken(chainId, currentToken)) {
      const stables = getTradeRouteStableAddresses(chainId)
        .filter((item) => item.toLowerCase() !== targetToken.toLowerCase()) as Address[];
      for (const stable of stables) {
        const pairMeta = await this.peekDexScreenerPairMeta(chainId, targetToken, stable).catch(() => null);
        if (!pairMeta?.poolAddress || !(typeof pairMeta.liquidityUsd === 'number' && pairMeta.liquidityUsd > 0)) {
          continue;
        }
        try {
          const bridge = await this.resolveRouteHopDesc({
            chainId,
            tokenIn: currentToken,
            tokenOut: stable,
            prefer: getBridgeTokenDexPreference(chainId as ChainId, stable) ?? null,
          });
          const last = await this.resolveKnownPoolRouteDesc({
            chainId,
            tokenIn: stable,
            tokenOut: targetToken,
            poolAddress: pairMeta.poolAddress,
            preferHint: pairMeta.preferHint === 'v3' ? 'v3' : pairMeta.preferHint === 'v2' ? 'v2' : null,
            fee: pairMeta.fee,
            debug,
          });
          this.logRoutePool(debug, 'buy.branch', {
            chainId,
            currentToken,
            targetToken,
            branch: 'catalog_stable_home',
            home: stable,
            pool: pairMeta.poolAddress,
            liquidityUsd: pairMeta.liquidityUsd,
            hops: this.summarizeRouteDescs([bridge, last]),
          });
          return [bridge, last];
        } catch {
          continue;
        }
      }
    }

    const officialQuote = isCatalogQuoteAsset
      ? null
      : await this.resolveOfficialLaunchpadQuote(chainId, targetToken, debug);
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
      }).catch(() => null);
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
      // Fall through to DexScreener / market home — do not abort the whole prefix.
    }

    const dexHome = await this.resolveTokenDeepestDexHome({
      chainId,
      tokenAddress: targetToken,
      debug,
    });
    if (dexHome) {
      const dexHomeRoute = await this.assembleBuyRouteViaDexHop({
        chainId,
        currentToken,
        targetToken,
        hop: dexHome,
        visited,
        debug,
        depth,
      }).catch(() => null);
      if (dexHomeRoute?.length) {
        this.logRoutePool(debug, 'buy.branch', {
          chainId,
          currentToken,
          targetToken,
          branch: 'dex_home',
          home: dexHome.counterparty,
          pool: dexHome.poolAddress,
          liquidityUsd: dexHome.liquidityUsd,
          hops: this.summarizeRouteDescs(dexHomeRoute),
        });
        return dexHomeRoute;
      }
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

    const buyRoute = await this.buildOuterMarketBuyQuoteRoute({
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
    const usdcToken = USDC[chainId as keyof typeof USDC];
    if (usdcToken && baseTokenAddress.toLowerCase() === usdcToken.address.toLowerCase()) return usdcToken.symbol;
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
      const initialIsPons = isPonsPlatform(initialPlatform);
      const openFourRuntime = (initialIsHyperAltfun || initialIsPons || !usesOpenFourRuntime(initialPlatform))
      ? null
      : await this.getOpenFourRuntimeState(client, input.chainId, tokenOut);
      const launchpadRoute = this.classifyLaunchpadRoute(input.chainId, tokenInfo, openFourRuntime);
      const launchpadPlatform = launchpadRoute.platform;
      const isHyperAltfun = launchpadRoute.isHyperAltfun;
      const isPons = launchpadRoute.isPons;
      const isInner = launchpadRoute.isInner;
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId, openFourRuntime) : null;
    const isPonsInner = isPons && isInner;

    const bridgeToken = (isHyperAltfun || isPonsInner)
      ? null
      : this.getLaunchpadQuoteRouterToken(input.chainId, tokenInfo, launchpadPlatform, openFourRuntime, {
        preferRuntimeQuote: usesOpenFourRuntime(launchpadPlatform),
      });
    const rawQuoteToken = (isHyperAltfun || isPonsInner)
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
    const preparedRoute = (isHyperAltfun || isPonsInner)
      ? null
      : await timeStep('route:prepare', () => this.prepareEvmTradeRoute({
        chainId: input.chainId,
        tokenAddress: tokenOut,
        tokenInfo,
        baseTokenAddress,
      }));
    if (!isHyperAltfun && !isPonsInner && !preparedRoute?.descs.length) {
      throw new Error('官方报价路径尚未就绪，请稍后再试');
    }
    if (input.chainId === ChainId.RH && this.hasUnusableRhV4Fee(preparedRoute?.descs)) {
      throw new Error('RH Uniswap V4 pool fee 未就绪，请稍后重试');
    }
    const preparedSplit = this.splitPreparedBuyRoute(preparedRoute, tokenOut);
    const descs: SwapDescLike[] = [];
    let currentRouterToken: Address = baseTokenAddress;
    let currentAmount = amountIn;
    let minOut = 0n;

    if (isPonsInner) {
      const ponsState = await timeStep('pons:state', () => getPonsTradeState(tokenOut, { force: runtimeOpts?.forceRefreshHyperState === true }));
      if (!ponsState?.tradeable) throw new Error('该代币不是可交易的 pons 代币');

      const routeQuoteToken = ponsState.quoteRouterToken;
      if (currentRouterToken.toLowerCase() !== routeQuoteToken.toLowerCase()) {
        currentAmount = await this.appendRhRouterBridgeHops({
          chainId: input.chainId,
          tokenIn: currentRouterToken,
          tokenOut: routeQuoteToken,
          amountIn: currentAmount,
          isTurbo,
          descs,
          timeStep,
        });
        currentRouterToken = routeQuoteToken;
      }

      const estimatedOut = isTurbo
        ? 0n
        : await timeStep('quote:pons:buy', () => quotePonsBuy(tokenOut, currentAmount));
      const allowUnquotedOuter = ponsState.version === 2 && ponsState.isOuter;
      if (!isTurbo && estimatedOut <= 0n && !allowUnquotedOuter) throw new Error('pons 买入报价失败');
      if (estimatedOut > 0n) {
        const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
        minOut = applySlippage(estimatedOut, slippageBps);
      }
      descs.push(buildPonsBuyDesc({
        state: ponsState,
        tokenOut,
        minOut,
      }));
    } else if (isHyperAltfun) {
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
          swapType: input.chainId === ChainId.RH ? toRhDexSwapType(q1.swapType) : q1.swapType,
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
                this.buildOuterMarketBuyQuoteRoute({
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
              this.buildOuterMarketBuyQuoteRoute({
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

          const preparedV4LastHop = this.takePreparedV4LastHop(preparedSplit, false, input.chainId);
          if (preparedV4LastHop) {
            minOut = 0n;
            descs.push(preparedV4LastHop);
          } else if (preparedSplit?.lastHop) {
            const lastHop = { ...preparedSplit.lastHop };
            const hintPool = (lastHop.poolAddress && lastHop.poolAddress !== ZERO_ADDRESS)
              ? lastHop.poolAddress
              : this.getKnownDexPoolAddress(tokenInfo);
            if (!hintPool) {
              throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
            }
            this.logRoutePool(consoleLogsEnabled, 'buy.last_hop.pool', {
              chainId: input.chainId,
              tokenIn: currentRouterToken,
              tokenOut,
              pool: hintPool,
              preferHint: this.preferHintFromDesc(lastHop),
              fee: lastHop.fee || null,
              source: 'prepared',
            });
            if (!turboRouteMode) {
              const q2 = await timeStep('quote:token:hop2', () =>
                resolveDexExactIn(
                  input.chainId,
                  currentRouterToken,
                  tokenOut,
                  currentAmount,
                  {
                    v3Fee: lastHop.fee || input.poolFee,
                    poolPair: hintPool,
                    prefer: this.preferHintFromDesc(lastHop) ?? undefined,
                  },
                  false
                )
              );
              if (q2.amountOut > 0n) {
                const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
                minOut = applySlippage(q2.amountOut, slippageBps);
              } else {
                minOut = 0n;
              }
            } else {
              minOut = 0n;
            }
            lastHop.poolAddress = hintPool;
            descs.push(lastHop);
          } else {
            throw new Error('官方报价路径尚未就绪，请稍后再试');
          }
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
            // Some Flap/tax tokens lie on allowance() or leave dust that blocks approve(max).
            // After an on-chain insufficient-allowance revert, always force re-approve.
            force: allowanceLike,
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
    opts?: { extraSpenders?: string[]; fromAddress?: `0x${string}`; submitChannel?: SubmitChannel; force?: boolean }
  ) {
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
    // Router first: meme-token approve for router pull / UI consistency.
    const orderedSpenders = [
      routerAddress,
      ...spenders.filter((s) => s.toLowerCase() !== routerAddress.toLowerCase()),
    ];
    for (const spender of orderedSpenders) {
      const txHash = await this.approveMaxForSpenderIfNeeded({
        chainId,
        tokenAddress,
        owner: account.address,
        spender,
        maxUint256,
        client,
        submitChannel: opts?.submitChannel,
        force: opts?.force === true && spender.toLowerCase() === routerAddress.toLowerCase(),
      });
      if (txHash) lastTxHash = txHash;
    }

    // Four.meme multi-hop: after sellToToken, router transferFroms the quote token from the user.
    // Must approve quote→Router even when quote is not on the bridge allowlist (e.g. DJTB).
    const pullbackTokens = getSellQuotePullbackTokens({
      chainId,
      tokenAddress,
      tokenInfo,
      isInnerDisk: (ti) => this.isInnerDisk(ti, chainId),
    });
    for (const pullToken of pullbackTokens) {
      const txHash = await this.approveMaxForSpenderIfNeeded({
        chainId,
        tokenAddress: pullToken,
        owner: account.address,
        spender: routerAddress,
        maxUint256,
        client,
        submitChannel: opts?.submitChannel,
        force: opts?.force === true,
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
        const initialIsPons = isPonsPlatform(initialPlatform);
        const openFourRuntime = (initialIsHyperAltfun || initialIsPons || !usesOpenFourRuntime(initialPlatform))
        ? null
        : await this.getOpenFourRuntimeState(client, input.chainId, sellToken);
        const launchpadRoute = this.classifyLaunchpadRoute(input.chainId, tokenInfo, openFourRuntime);
        const platformLower = launchpadRoute.platform;
        const isHyperAltfun = launchpadRoute.isHyperAltfun;
        const isPons = launchpadRoute.isPons;
        const isInner = launchpadRoute.isInner;
      const isInnerFourMeme = isInner && isFourMemePlatform(platformLower);
      const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId, openFourRuntime) : null;
      const isPonsInner = isPons && isInner;
      const bridgeToken = (isHyperAltfun || isPonsInner) ? null : this.getLaunchpadQuoteRouterToken(input.chainId as ChainId, tokenInfo, platformLower, openFourRuntime, {
        preferRuntimeQuote: usesOpenFourRuntime(platformLower),
      });
      const rawQuoteToken = (isHyperAltfun || isPonsInner) ? null : await this.resolveTradeRouteQuoteToken({
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
      const preparedRoute = (isHyperAltfun || isPonsInner)
        ? null
        : await timeStep('route:prepare', () => this.prepareEvmTradeRoute({
          chainId: input.chainId,
          tokenAddress: sellToken,
          tokenInfo,
          baseTokenAddress,
        }));
      if (!isHyperAltfun && !isPonsInner && !preparedRoute?.descs.length) {
        throw new Error('官方报价路径尚未就绪，请稍后再试');
      }
      if (input.chainId === ChainId.RH && this.hasUnusableRhV4Fee(preparedRoute?.descs)) {
        throw new Error('RH Uniswap V4 pool fee 未就绪，请稍后重试');
      }
      const preparedSplit = this.splitPreparedBuyRoute(preparedRoute, sellToken);
      const descs: SwapDescLike[] = [];
      let estimatedOut = 0n;
      let minFundsForSell = 0n;
      let sellTokenManager: Address | null = null;
      let sellManagerForRoute: Address = (isHyperAltfun || isPonsInner) ? ZERO_ADDRESS : (launchpadConfig?.manager ?? ZERO_ADDRESS);
      let amountInForQuote = amountIn;
      if (isTurbo) {
        if (percentBps <= 0 || percentBps > 10000) throw new Error('Invalid percent');
        const baseBal = input.expectedTokenInWei ? BigInt(input.expectedTokenInWei) : 0n;
        amountInForQuote = baseBal > 0n ? (baseBal * BigInt(percentBps)) / 10000n : 1n;
      }

      if (isPonsInner) {
        const ponsState = await timeStep('pons:state', () => getPonsTradeState(sellToken, { force: runtimeOpts?.forceRefreshHyperState === true }));
        if (!ponsState?.tradeable) throw new Error('该代币不是可交易的 pons 代币');

        const innerTokenOut = ponsState.quoteRouterToken;
        let minQuoteOut = 0n;
        if (!isTurbo) {
          const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
          const estimatedQuote = await timeStep('quote:pons:sell', () => quotePonsSell(sellToken, amountIn));
          const allowUnquotedOuter = ponsState.version === 2 && ponsState.isOuter;
          if (estimatedQuote <= 0n && !allowUnquotedOuter) throw new Error('pons 卖出报价失败');
          minQuoteOut = estimatedQuote > 0n ? applySlippage(estimatedQuote, slippageBps) : 0n;
          if (baseTokenAddress.toLowerCase() === innerTokenOut.toLowerCase()) {
            estimatedOut = estimatedQuote;
          }
        }

        descs.push(buildPonsSellDesc({
          state: ponsState,
          tokenIn: sellToken,
          minOut: minQuoteOut,
        }));

        if (baseTokenAddress.toLowerCase() !== innerTokenOut.toLowerCase()) {
          const hop2AmountIn = isTurbo ? 1n : (minQuoteOut > 0n ? minQuoteOut : 1n);
          const bridgedOut = await this.appendRhRouterBridgeHops({
            chainId: input.chainId,
            tokenIn: innerTokenOut,
            tokenOut: baseTokenAddress,
            amountIn: hop2AmountIn,
            isTurbo,
            descs,
            timeStep,
          });
          if (!isTurbo) estimatedOut = bridgedOut;
        }
      } else if (isHyperAltfun) {
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
            swapType: input.chainId === ChainId.RH ? toRhDexSwapType(hop2.swapType) : hop2.swapType,
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
        const preparedV4FirstHop = this.takePreparedV4LastHop(preparedSplit, true, input.chainId);
        const lastHop = preparedSplit?.lastHop;
        const outerPoolPair = (lastHop?.poolAddress && lastHop.poolAddress !== ZERO_ADDRESS)
          ? lastHop.poolAddress
          : this.getKnownDexPoolAddress(tokenInfo);
        const preferHint = this.preferHintFromDesc(lastHop) ?? this.normalizeDexPrefer(tokenInfo.dex_type);
        const outerFee = lastHop?.fee || undefined;
        this.logRoutePool(sellDebug, 'sell.first_hop.pool', {
          chainId: input.chainId,
          tokenIn: sellToken,
          tokenOut: hop1RouterOut,
          pool: outerPoolPair,
          preferHint,
          fee: outerFee ?? null,
          source: 'prepared',
        });
        let hop1AmountOut = 0n;

        if (preparedV4FirstHop) {
          descs.push(preparedV4FirstHop);
        } else if (!outerPoolPair) {
          throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        } else if (needsStocksQuoteRoute && rawQuoteToken) {
          descs.push(await this.resolveKnownPoolRouteDesc({
            chainId: input.chainId,
            tokenIn: sellToken,
            tokenOut: hop1RouterOut,
            poolAddress: outerPoolPair,
            preferHint,
            fee: outerFee,
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
                v3Fee: outerFee ?? input.poolFee,
                poolPair: outerPoolPair,
                prefer: preferHint ?? undefined,
              },
              turboRouteMode,
              hop1NeedAmountOut
            )
          );
          hop1AmountOut = hop1.amountOut;
          descs.push(getRouterSwapDesc({
            swapType: input.chainId === ChainId.RH ? toRhDexSwapType(hop1.swapType) : hop1.swapType,
            tokenIn: sellToken,
            tokenOut: hop1RouterOut,
            poolAddress: outerPoolPair,
            fee: outerFee || getV3FeeForDesc(hop1, input.poolFee ?? baseFee),
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
          const hop2Unquoted = turboRouteMode || !!preparedV4FirstHop;
          if (!hop2Unquoted && hop1AmountOut <= 0n) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          const hop2AmountIn = hop2Unquoted ? 1n : hop1AmountOut;
          const hop2 = await timeStep('quote:bridge:hop2', () =>
            resolveBridgeHopExactIn(
              input.chainId,
              bridgeToken,
              baseTokenAddress,
              hop2AmountIn,
              bridgePrefer,
              hop2Unquoted,
              !hop2Unquoted
            )
          );
          if (hop2Unquoted) {
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
          if (!hop2Unquoted && hop2.amountOut <= 0n) {
            throw new Error(`找不到 Quote/${baseTokenSymbol} 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性`);
          }
          descs.push(getRouterSwapDesc({
            swapType: input.chainId === ChainId.RH ? toRhDexSwapType(hop2.swapType) : hop2.swapType,
            tokenIn: bridgeToken,
            tokenOut: baseTokenAddress,
            poolAddress: hop2.poolAddress,
            fee: getV3FeeForDesc(hop2, getDefaultBridgeV3Fee(input.chainId)),
          }));
          estimatedOut = hop2Unquoted ? 0n : hop2.amountOut;
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
          forceRepair: true,
        });
        // On-chain revert is authoritative. Do not bail out when allowance() still looks fine
        // (common with broken/tax tokens that report max but enforce 0 on transferFrom).
        const approveTx = await this.approveMaxForSellIfNeeded(input.chainId, input.tokenAddress, tokenInfo, {
          extraSpenders: allowanceExtraSpenders,
          submitChannel: input.submitChannel,
          fromAddress: account.address,
          force: true,
        });
        if (approveTx) {
          console.log('[trade.sell.retry.approve]', { chainId: input.chainId, token: input.tokenAddress, approveTx });
          await this.waitApproveFastForRetry(input.chainId, approveTx);
        } else if (!allowanceCheck.insufficient) {
          // Forced approve still skipped (lying allowance() + force path failed to send).
          // Surface original revert rather than silently retrying the same failure.
          console.warn('[trade.sell.allowance.repair.noop]', {
            chainId: input.chainId,
            token: input.tokenAddress,
            checked: allowanceCheck.checked,
          });
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
