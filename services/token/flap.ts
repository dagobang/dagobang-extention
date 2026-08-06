import { parseAbi } from 'viem';
import type { FlapTokenStateV7 } from '@/types/token';
import { erc20Abi } from '@/constants/contracts/abi/swapAbi';
import { FlapTaxTokenHelperAddress, getFlapStocksVaultVersion } from '@/constants/flap';
import { bscTokens } from '@/constants/tokens/chains/bsc';

import { RpcService } from '../rpc';
import { DeployAddress } from '../../constants/contracts/address';
import { ChainId } from '../../constants/chains/chainId';
import { ContractNames } from '../../constants/contracts/names';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const flapTokenManagerAbi = parseAbi([
  'function getTokenV7(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 taxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
  'function getTokenV8Safe(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
]);

const flapTaxTokenHelperAbi = parseAbi([
  'function getTaxTokenInfoV2(address taxToken) view returns ((address taxToken,address beneficiary,address beneficiary2,address dividendToken,address quoteToken,uint8 buyTaxType,uint16 buyTaxRate,uint8 sellTaxType,uint16 sellTaxRate,uint8 transferTaxType,uint16 transferTaxRate,uint256 minimumShareBalance,(address addr,address factory,uint8 riskLevel,bool isOfficialVault,bool isVault,bool isAIConsumer) vaultInfo) info)',
]);

const flapStocksVaultAbi = parseAbi([
  'function rwaAsset() view returns (address)',
  'function basketToken() view returns (address)',
  'function supportedAssets() view returns (address[])',
]);

const v4PoolManagerAbi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);

export class TokenFlapService {
  private static readonly TOKEN_INFO_CACHE_MS = 5 * 60_000;
  private static readonly tokenInfoCache = new Map<string, { ts: number; value: FlapTokenStateV7 }>();
  private static readonly tokenInfoInFlight = new Map<string, Promise<FlapTokenStateV7>>();

  private static getFlapTokenManagerAddress(chainId: number): string {
    const contracts = DeployAddress[chainId as ChainId] || {};
    return contracts[ContractNames.FlapshTokenManager]?.address || ZERO_ADDRESS;
  }

  private static getV4PoolManagerAddress(chainId: number): string {
    const contracts = DeployAddress[chainId as ChainId] || {};
    return contracts[ContractNames.PoolManager]?.address || ZERO_ADDRESS;
  }

  private static getPancakeInfinityVaultAddress(chainId: number): string {
    const contracts = DeployAddress[chainId as ChainId] || {};
    return contracts[ContractNames.PancakeInfinityVault]?.address || ZERO_ADDRESS;
  }

  private static getCacheKey(chainId: number, tokenAddress: string) {
    return `${chainId}:${tokenAddress.toLowerCase()}`;
  }

  private static isBridgeOrNativeQuote(chainId: number, tokenAddress?: string | null) {
    const key = String(tokenAddress || '').trim().toLowerCase();
    if (!key || key === ZERO_ADDRESS) return true;
    if (chainId !== ChainId.BNB) return false;
    return new Set([
      bscTokens.wbnb.address.toLowerCase(),
      bscTokens.usdt.address.toLowerCase(),
      bscTokens.busd.address.toLowerCase(),
      bscTokens.usdc.address.toLowerCase(),
      bscTokens.usd1.address.toLowerCase(),
    ]).has(key);
  }

  private static resolvePoolModel(chainId: number, poolAddress?: string | null): FlapTokenStateV7['poolModel'] {
    const pool = String(poolAddress || '').trim().toLowerCase();
    if (!pool || pool === ZERO_ADDRESS) return undefined;
    if (pool === this.getV4PoolManagerAddress(chainId).toLowerCase()) return 'v4_cl';
    if (pool === this.getPancakeInfinityVaultAddress(chainId).toLowerCase()) return 'infinity_cl';
    return 'classic';
  }

  private static normalizeQuoteTokenForPoolLookup(chainId: number, tokenAddress: string, quoteTokenAddress?: string | null): string | null {
    const token = String(tokenAddress || '').trim().toLowerCase();
    const quote = String(quoteTokenAddress || '').trim();
    if (!quote || quote.toLowerCase() === ZERO_ADDRESS) return null;
    if (quote.toLowerCase() === token) return null;
    if (chainId === ChainId.BNB && quote.toLowerCase() === bscTokens.wbnb.address.toLowerCase()) {
      return ZERO_ADDRESS;
    }
    return quote;
  }

  private static pickBestV4InitializeLog(input: {
    logs: Array<{
      args?: {
        id?: `0x${string}`;
        fee?: number;
        tickSpacing?: number;
        hooks?: `0x${string}`;
      };
      blockNumber?: bigint;
      logIndex?: number;
    }>;
    lpFeeProfile: number;
  }) {
    const profile = Number(input.lpFeeProfile ?? 0);
    const score = (fee: number, hooks: string) => {
      let value = hooks.toLowerCase() === ZERO_ADDRESS.toLowerCase() ? 10 : 0;
      if (profile === 1) {
        value += fee <= 1000 ? 5 : 0;
      } else if (profile === 2) {
        value += fee >= 5000 ? 5 : 0;
      } else {
        value += fee >= 2000 && fee <= 4000 ? 5 : 0;
      }
      return value;
    };

    return [...input.logs].sort((a, b) => {
      const feeA = Number(a.args?.fee ?? 0);
      const feeB = Number(b.args?.fee ?? 0);
      const hooksA = String(a.args?.hooks ?? ZERO_ADDRESS);
      const hooksB = String(b.args?.hooks ?? ZERO_ADDRESS);
      const scoreA = score(feeA, hooksA);
      const scoreB = score(feeB, hooksB);
      if (scoreA !== scoreB) return scoreB - scoreA;
      if ((a.blockNumber ?? 0n) !== (b.blockNumber ?? 0n)) {
        return Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n));
      }
      return Number((b.logIndex ?? 0) - (a.logIndex ?? 0));
    })[0];
  }

  private static async getV4PoolMetadata(input: {
    client: Awaited<ReturnType<typeof RpcService.getClient>>;
    chainId: number;
    tokenAddress: string;
    quoteTokenAddress?: string | null;
    lpFeeProfile: number;
  }): Promise<Pick<FlapTokenStateV7, 'clPoolId' | 'v4Fee' | 'v4TickSpacing' | 'v4Hooks'> | null> {
    if (input.chainId !== ChainId.BNB) return null;
    const poolManager = this.getV4PoolManagerAddress(input.chainId);
    if (!poolManager || poolManager === ZERO_ADDRESS) return null;

    const quoteToken = this.normalizeQuoteTokenForPoolLookup(input.chainId, input.tokenAddress, input.quoteTokenAddress);
    if (!quoteToken) return null;

    const tokenA = input.tokenAddress.toLowerCase();
    const tokenB = quoteToken.toLowerCase();
    const [currency0, currency1] = tokenA < tokenB
      ? [input.tokenAddress, quoteToken]
      : [quoteToken, input.tokenAddress];

    try {
      const logs = await input.client.getLogs({
        address: poolManager as `0x${string}`,
        event: v4PoolManagerAbi[0],
        args: {
          currency0: currency0 as `0x${string}`,
          currency1: currency1 as `0x${string}`,
        },
        fromBlock: 0n,
        toBlock: 'latest',
      });
      if (!logs.length) return null;

      const best = this.pickBestV4InitializeLog({
        logs: logs as Array<{
          args?: {
            id?: `0x${string}`;
            fee?: number;
            tickSpacing?: number;
            hooks?: `0x${string}`;
          };
          blockNumber?: bigint;
          logIndex?: number;
        }>,
        lpFeeProfile: input.lpFeeProfile,
      });
      if (!best?.args) return null;

      return {
        clPoolId: best.args.id,
        v4Fee: Number(best.args.fee ?? 0),
        v4TickSpacing: Number(best.args.tickSpacing ?? 0),
        v4Hooks: String(best.args.hooks ?? ZERO_ADDRESS),
      };
    } catch {
      return null;
    }
  }

  private static async getTaxTokenMetadata(client: Awaited<ReturnType<typeof RpcService.getClient>>, chainId: number, tokenAddress: string) {
    const helperAddress = FlapTaxTokenHelperAddress[chainId as ChainId];
    if (!helperAddress || chainId !== ChainId.BNB) return null;

    try {
      const info = await client.readContract({
        address: helperAddress,
        abi: flapTaxTokenHelperAbi,
        functionName: 'getTaxTokenInfoV2',
        args: [tokenAddress as `0x${string}`],
      }) as any;

      const dividendToken = String(info?.dividendToken ?? info?.[3] ?? ZERO_ADDRESS);
      const quoteToken = String(info?.quoteToken ?? info?.[4] ?? ZERO_ADDRESS);
      const vaultInfo = info?.vaultInfo ?? info?.[11];
      const vaultAddress = String(vaultInfo?.addr ?? vaultInfo?.[0] ?? ZERO_ADDRESS);
      const vaultFactory = String(vaultInfo?.factory ?? vaultInfo?.[1] ?? ZERO_ADDRESS);
      const vaultIsOfficial = Boolean(vaultInfo?.isOfficialVault ?? vaultInfo?.[3] ?? false);
      const vaultIsVault = Boolean(vaultInfo?.isVault ?? vaultInfo?.[4] ?? false);
      const vaultIsAIConsumer = Boolean(vaultInfo?.isAIConsumer ?? vaultInfo?.[5] ?? false);
      const stocksVaultVersion = getFlapStocksVaultVersion(chainId, vaultFactory) ?? undefined;

      let basketToken: string | undefined;
      let supportedAssets: string[] | undefined;
      if (vaultIsVault && vaultAddress !== ZERO_ADDRESS && stocksVaultVersion != null) {
        if (stocksVaultVersion === 3) {
          const [resolvedBasketToken, resolvedSupportedAssets] = await Promise.all([
            client.readContract({
              address: vaultAddress as `0x${string}`,
              abi: flapStocksVaultAbi,
              functionName: 'basketToken',
            }).catch(() => ZERO_ADDRESS),
            client.readContract({
              address: vaultAddress as `0x${string}`,
              abi: flapStocksVaultAbi,
              functionName: 'supportedAssets',
            }).catch(() => [] as string[]),
          ]);
          basketToken = String(resolvedBasketToken ?? ZERO_ADDRESS);
          supportedAssets = Array.isArray(resolvedSupportedAssets) ? resolvedSupportedAssets.map((item) => String(item)) : undefined;
        } else {
          const rwaAsset = await client.readContract({
            address: vaultAddress as `0x${string}`,
            abi: flapStocksVaultAbi,
            functionName: 'rwaAsset',
          }).catch(() => ZERO_ADDRESS);
          basketToken = String(rwaAsset ?? ZERO_ADDRESS);
        }
      }

      return {
        dividendToken,
        quoteToken,
        vaultAddress,
        vaultFactory,
        vaultIsOfficial,
        vaultIsVault,
        vaultIsAIConsumer,
        stocksVaultVersion,
        basketToken,
        supportedAssets,
      };
    } catch {
      return null;
    }
  }

  private static async getTokenInfoUncached(chainId: number, tokenAddress: string): Promise<FlapTokenStateV7> {
    const client = await RpcService.getClient(chainId);
    const managerAddress = this.getFlapTokenManagerAddress(chainId);
    const functionName = chainId === ChainId.BNB ? 'getTokenV8Safe' : 'getTokenV7';

    if (managerAddress === ZERO_ADDRESS) {
      throw new Error('FlapshTokenManager address not found for chain ' + chainId);
    }

      const [state, meta, taxInfo] = await Promise.all([
      client.readContract({
        address: managerAddress as `0x${string}`,
        abi: flapTokenManagerAbi,
          functionName,
        args: [tokenAddress as `0x${string}`],
      }) as Promise<any>,
      Promise.all([
        client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
      ]).then(([symbol, decimals]) => ({ symbol, decimals })),
        this.getTaxTokenMetadata(client, chainId, tokenAddress),
    ]);

    const status = state?.status ?? state?.[0];
    const reserve = state?.reserve ?? state?.[1];
    const circulatingSupply = state?.circulatingSupply ?? state?.[2];
    const price = state?.price ?? state?.[3];
    const tokenVersion = state?.tokenVersion ?? state?.[4];
    const r = state?.r ?? state?.[5];
    const h = state?.h ?? state?.[6];
    const k = state?.k ?? state?.[7];
    const dexSupplyThresh = state?.dexSupplyThresh ?? state?.[8];
    const quoteTokenAddress = state?.quoteTokenAddress ?? state?.[9];
    const nativeToQuoteSwapEnabled = state?.nativeToQuoteSwapEnabled ?? state?.[10];
    const extensionID = state?.extensionID ?? state?.[11];
      const buyTaxRate = state?.buyTaxRate ?? (functionName === 'getTokenV8Safe' ? state?.[12] : undefined);
      const sellTaxRate = state?.sellTaxRate ?? (functionName === 'getTokenV8Safe' ? state?.[13] : undefined);
      const taxRate = state?.taxRate
        ?? (buyTaxRate ?? sellTaxRate)
        ?? (functionName === 'getTokenV8Safe' ? state?.[12] : state?.[12]);
      const pool = state?.pool ?? (functionName === 'getTokenV8Safe' ? state?.[14] : state?.[13]);
      const progress = state?.progress ?? (functionName === 'getTokenV8Safe' ? state?.[15] : state?.[14]);
      const lpFeeProfile = state?.lpFeeProfile ?? (functionName === 'getTokenV8Safe' ? state?.[16] : state?.[15]);
      const dexId = state?.dexId ?? (functionName === 'getTokenV8Safe' ? state?.[17] : state?.[16]);
      const resolvedQuoteTokenAddress = String(
        quoteTokenAddress && String(quoteTokenAddress) !== ZERO_ADDRESS
          ? quoteTokenAddress
          : (taxInfo?.quoteToken ?? ZERO_ADDRESS)
      );
      const poolModel = this.resolvePoolModel(chainId, String(pool ?? ZERO_ADDRESS));
      const v4PoolMetadata = poolModel === 'v4_cl'
        ? await this.getV4PoolMetadata({
            client,
            chainId,
            tokenAddress,
            quoteTokenAddress: resolvedQuoteTokenAddress,
            lpFeeProfile: Number(lpFeeProfile ?? 0),
          })
        : null;

      return {
      symbol: String(meta?.symbol ?? ''),
      decimals: Number(meta?.decimals ?? 0),
      status: Number(status ?? 0),
      reserve: typeof reserve === 'bigint' ? reserve.toString() : String(reserve ?? '0'),
      circulatingSupply: typeof circulatingSupply === 'bigint' ? circulatingSupply.toString() : String(circulatingSupply ?? '0'),
      price: typeof price === 'bigint' ? price.toString() : String(price ?? '0'),
      tokenVersion: Number(tokenVersion ?? 0),
      r: typeof r === 'bigint' ? r.toString() : String(r ?? '0'),
      h: typeof h === 'bigint' ? h.toString() : String(h ?? '0'),
      k: typeof k === 'bigint' ? k.toString() : String(k ?? '0'),
      dexSupplyThresh: typeof dexSupplyThresh === 'bigint' ? dexSupplyThresh.toString() : String(dexSupplyThresh ?? '0'),
        quoteTokenAddress: resolvedQuoteTokenAddress,
      nativeToQuoteSwapEnabled: Boolean(nativeToQuoteSwapEnabled),
      extensionID: String(extensionID ?? '0x'),
      taxRate: typeof taxRate === 'bigint' ? taxRate.toString() : String(taxRate ?? '0'),
        buyTaxRate: typeof buyTaxRate === 'bigint' ? buyTaxRate.toString() : (buyTaxRate !== undefined ? String(buyTaxRate) : undefined),
        sellTaxRate: typeof sellTaxRate === 'bigint' ? sellTaxRate.toString() : (sellTaxRate !== undefined ? String(sellTaxRate) : undefined),
      pool: String(pool ?? ZERO_ADDRESS),
      progress: typeof progress === 'bigint' ? progress.toString() : String(progress ?? '0'),
      lpFeeProfile: Number(lpFeeProfile ?? 0),
      dexId: Number(dexId ?? 0),
        poolModel,
        poolCompatAddress: String(pool ?? ZERO_ADDRESS),
        clPoolId: v4PoolMetadata?.clPoolId,
        v4Fee: v4PoolMetadata?.v4Fee,
        v4TickSpacing: v4PoolMetadata?.v4TickSpacing,
        v4Hooks: v4PoolMetadata?.v4Hooks,
        dividendToken: taxInfo?.dividendToken,
        vaultAddress: taxInfo?.vaultAddress,
        vaultFactory: taxInfo?.vaultFactory,
        vaultIsOfficial: taxInfo?.vaultIsOfficial,
        vaultIsAIConsumer: taxInfo?.vaultIsAIConsumer,
        stocksVaultVersion: taxInfo?.stocksVaultVersion,
        basketToken: taxInfo?.basketToken,
        supportedAssets: taxInfo?.supportedAssets,
    };
  }

  private static async prefetchQuoteLineage(chainId: number, tokenAddress: string, visited: Set<string>): Promise<void> {
    const key = String(tokenAddress || '').trim().toLowerCase();
    if (!key || visited.has(key) || this.isBridgeOrNativeQuote(chainId, tokenAddress)) return;
    visited.add(key);

    try {
      const info = await this.getTokenInfo(chainId, tokenAddress);
      const next = String(info.quoteTokenAddress || '').trim().toLowerCase();
      if (!next || visited.has(next) || this.isBridgeOrNativeQuote(chainId, next)) return;
      void this.prefetchQuoteLineage(chainId, next, visited);
    } catch {
    }
  }

  static async getTokenInfo(chainId: number, tokenAddress: string): Promise<FlapTokenStateV7> {
    const key = this.getCacheKey(chainId, tokenAddress);
    const cached = this.tokenInfoCache.get(key);
    if (cached && Date.now() - cached.ts < this.TOKEN_INFO_CACHE_MS) {
      return cached.value;
    }

    const inFlight = this.tokenInfoInFlight.get(key);
    if (inFlight) return await inFlight;

    const task = this.getTokenInfoUncached(chainId, tokenAddress)
      .then((value) => {
        this.tokenInfoCache.set(key, { ts: Date.now(), value });
        const currentKey = tokenAddress.toLowerCase();
        const quoteTokenAddress = String(value.quoteTokenAddress || '').trim().toLowerCase();
        if (quoteTokenAddress && !this.isBridgeOrNativeQuote(chainId, quoteTokenAddress) && quoteTokenAddress !== currentKey) {
          void this.prefetchQuoteLineage(chainId, quoteTokenAddress, new Set([currentKey]));
        }
        return value;
      })
      .finally(() => {
        this.tokenInfoInFlight.delete(key);
      });

    this.tokenInfoInFlight.set(key, task);
    return await task;
}
}
