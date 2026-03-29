import { encodeAbiParameters, encodeFunctionData, erc20Abi, parseAbi, parseAbiParameters } from 'viem';
import { RpcService } from '../rpc';
import { WalletService } from '../wallet';
import { SettingsService } from '../settings';
import type { TxBuyInput, TxSellInput } from '../../types/extention';
import { TokenInfo } from '../../types/token';
import { ContractNames } from '../../constants/contracts/names';
import { DeployAddress } from '../../constants/contracts/address';
import { ChainId } from '../../constants/chains/chainId';
import { getBridgeTokenDexPreference } from '../../constants/tokens/allTokens';
import { dagobangAbi } from '@/constants/contracts/abi';
import { Address, SwapDescLike, SwapType, ZERO_ADDRESS, applySlippage, getDeadline, getRouterSwapDesc, getSlippageBps, getV3FeeForDesc } from './tradeTypes';
import { assertDexQuoteOk, getBridgeToken, quoteBestExactIn as quoteBestExactInDex, resolveBridgeHopExactIn, resolveDexExactIn } from './tradeDex';
import { getGasPriceWei, prewarmNonce, sendTransaction } from './tradeTx';
import { formatBroadcastProvider } from '@/utils/format';
import { getDexPoolPrefer } from '@/utils/dexUtils';

function parseGweiToWei(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const intPart = match[1] || '0';
  const fracPartRaw = match[2] || '';
  const fracPadded = (fracPartRaw + '000000000').slice(0, 9);
  const intBig = BigInt(intPart);
  const fracBig = BigInt(fracPadded);
  return intBig * 1000000000n + fracBig;
}

const tokenManagerHelper3Abi = parseAbi([
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
]);

const abiParamsUint256 = parseAbiParameters('uint256');
const abiParamsFourMemeBuyTokenParams = parseAbiParameters(
  'uint256 origin, address token, address to, uint256 amount, uint256 maxFunds, uint256 funds, uint256 minAmount'
);
const abiParamsFourMemeBuyTokenWrapper = parseAbiParameters('bytes args, uint256 time, bytes signature');

export class TradeService {
  private static sellInFlightByToken = new Set<string>();

  static async quoteBestExactIn(
    chainId: number,
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    amountIn: bigint,
    opts?: { v3Fee?: number; poolPair?: string; prefer?: 'v2' | 'v3' }
  ): Promise<{ amountOut: bigint; swapType: number; fee?: number; poolAddress: string }> {
    return await quoteBestExactInDex(chainId, tokenIn, tokenOut, amountIn, opts);
  }

  static async prewarmTurbo(input: { chainId: number; tokenAddress: Address; tokenInfo?: TokenInfo }) {
    const settings = await SettingsService.get();
    const chainSettings = settings.chains[input.chainId];
    const executionMode = chainSettings?.executionMode ?? 'default';
    if (executionMode !== 'turbo') return;
    const tokenInfo = input.tokenInfo;
    if (!tokenInfo) return;

    const client = await RpcService.getClient();
    const account = await WalletService.getSigner();
    await prewarmNonce(client, input.chainId, account.address);

    const token = input.tokenAddress;
    const bridgeToken = getBridgeToken(input.chainId, tokenInfo.quote_token_address);
    const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
    const dexPrefer = getDexPoolPrefer(tokenInfo.dex_type);
    const tokenPrefer = dexPrefer === 'v2' || dexPrefer === 'v3' ? dexPrefer : (bridgePrefer ?? 'v2');

    const bridgeOpts = bridgePrefer === 'v2'
      ? { prefer: 'v2' as const }
      : bridgePrefer === 'v3'
        ? { v3Fee: 500, prefer: 'v3' as const }
        : { v3Fee: 500 };

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

    if (bridgeToken && bridgePrefer !== 'v2') {
      warmTasks.push(resolveDexExactIn(input.chainId, ZERO_ADDRESS, bridgeToken, amountIn, bridgeOpts, true, false));
      warmTasks.push(resolveDexExactIn(input.chainId, bridgeToken, ZERO_ADDRESS, amountIn, bridgeOpts, true, false));
    }

    if (bridgeToken && tokenInfo.pool_pair && tokenPrefer === 'v3') {
      warmTasks.push(resolveDexExactIn(input.chainId, token, bridgeToken, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v3' }, true, false));
      warmTasks.push(resolveDexExactIn(input.chainId, bridgeToken, token, amountIn, { poolPair: tokenInfo.pool_pair, prefer: 'v3' }, true, false));
    }

    await Promise.allSettled(warmTasks);
  }

  private static isInnerDisk(tokenInfo: TokenInfo): boolean {
    if (tokenInfo.launchpad) {
      // Assuming 'status' 1 means Trading (Outer), anything else (0/2?) is Inner/Launchpad
      // Or checking if platform is known launchpad
      if (['fourmeme', 'bn_fourmeme', 'fourmeme_agent', 'flap'].includes(tokenInfo.launchpad_platform?.toLowerCase() || '')) {
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

    if (platform.includes('fourmeme')) {
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

  private static getTokenManagerHelper3Address(chainId: number): Address {
    const contracts = DeployAddress[chainId as ChainId] || {};
    return (contracts[ContractNames.TokenManagerHelper3]?.address || ZERO_ADDRESS) as Address;
  }

  private static async tryFourMemeBuyEstimatedAmount(client: any, chainId: number, token: Address, funds: bigint) {
    const helperAddress = this.getTokenManagerHelper3Address(chainId);
    if (helperAddress === ZERO_ADDRESS) return null;
    const res = await client.readContract({
      address: helperAddress,
      abi: tokenManagerHelper3Abi,
      functionName: 'tryBuy',
      args: [token, 0n, funds],
    });
    const estimatedAmount = res[2] as bigint;
    return { estimatedAmount };
  }

  private static async tryFourMemeSellEstimatedFunds(client: any, chainId: number, token: Address, amount: bigint) {
    const helperAddress = this.getTokenManagerHelper3Address(chainId);
    if (helperAddress === ZERO_ADDRESS) return null;
    const res = await client.readContract({
      address: helperAddress,
      abi: tokenManagerHelper3Abi,
      functionName: 'trySell',
      args: [token, amount],
    });
    const tokenManager = res[0] as Address;
    const funds = res[2] as bigint;
    const fee = res[3] as bigint;
    return { tokenManager, funds, fee };
  }

  private static encodeFourMemeUint256(value: bigint) {
    return encodeAbiParameters(abiParamsUint256, [value]) as `0x${string}`;
  }

  private static encodeFourMemeBuyTokenData(input: {
    token: Address;
    to: Address;
    funds: bigint;
    minAmount: bigint;
  }) {
    const args = encodeAbiParameters(abiParamsFourMemeBuyTokenParams, [
      0n,
      input.token,
      input.to,
      0n,
      0n,
      input.funds,
      input.minAmount,
    ]);
    return encodeAbiParameters(abiParamsFourMemeBuyTokenWrapper, [args, 0n, '0x']) as `0x${string}`;
  }

  static async buy(input: TxBuyInput) {
    const settings = await SettingsService.get();
    const routerAddress = DeployAddress[input.chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');
    if (!input.tokenInfo) throw new Error('Token info required');
    const tokenInfo = input.tokenInfo;

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();

    const amountIn = BigInt(input.bnbAmountWei);
    const baseFee = input.poolFee ?? 2500;
    const executionMode = settings.chains[input.chainId]?.executionMode ?? 'default';
    const isTurbo = executionMode === 'turbo';
    const chainSettings = settings.chains[input.chainId];
    const gasPreset = input.gasPreset ?? chainSettings.buyGasPreset ?? chainSettings.gasPreset;
    const gasPriceFromInput = typeof input.gasPriceGwei === 'string' ? parseGweiToWei(input.gasPriceGwei) : 0n;
    const gasPriceWei = gasPriceFromInput > 0n
      ? gasPriceFromInput
      : getGasPriceWei(chainSettings, gasPreset, 'buy');

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

    const isInner = this.isInnerDisk(tokenInfo);
    const platformLower = tokenInfo.launchpad_platform?.toLowerCase() || '';
    const isInnerFourMeme = isInner && platformLower.includes('fourmeme');
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId) : null;

    const bridgeToken = getBridgeToken(input.chainId, tokenInfo.quote_token_address);
    console.log('input.tokenInfo', tokenInfo, isInner, launchpadConfig)
    console.log('bridgeToken', bridgeToken);
    const descs: SwapDescLike[] = [];
    let currentRouterToken: Address = ZERO_ADDRESS;
    let currentAmount = amountIn;

    if (bridgeToken) {
      // Hop 1: [BNB] -> [Quote]
      const bridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken);
      const needAmountOut = !isTurbo;
      const q1 = await timeStep('quote:bridge', () =>  
        resolveBridgeHopExactIn(
          input.chainId,
          ZERO_ADDRESS,
          bridgeToken,
          currentAmount,
          bridgePrefer,
          isTurbo,
          needAmountOut
        )
      );
      if (isTurbo) {
        if (!q1.poolAddress || q1.poolAddress === ZERO_ADDRESS) {
          throw new Error('找不到 BNB/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
      } else {
        try {
          assertDexQuoteOk(q1);
        } catch {
          throw new Error('找不到 BNB/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        if (q1.amountOut <= 0n) {
          throw new Error('找不到 BNB/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
      }
      descs.push(getRouterSwapDesc({
        swapType: q1.swapType,
        tokenIn: ZERO_ADDRESS,
        tokenOut: bridgeToken,
        poolAddress: q1.poolAddress,
        fee: getV3FeeForDesc(q1, 500),
      }));
      currentRouterToken = bridgeToken;
      currentAmount = isTurbo ? 1n : q1.amountOut;
    }

    // Hop 2: [BNB/USD1] -> Meme
    const tokenOut = input.tokenAddress;
    let minOut = 0n;

    if (isInner && launchpadConfig) {
      const platform = tokenInfo.launchpad_platform?.toLowerCase() || '';
      let dataForDesc: `0x${string}` = '0x';

      if (platform.includes('fourmeme')) {
        const to = account.address as Address;
        const fundsForEstimate = currentRouterToken === ZERO_ADDRESS ? amountIn : currentAmount;
        let minAmount = 0n;
        if (!isTurbo) {
          try {
            const est = await timeStep('fourmeme:tryBuy', () =>
              this.tryFourMemeBuyEstimatedAmount(client, input.chainId, tokenOut as Address, fundsForEstimate)
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
          dataForDesc = this.encodeFourMemeBuyTokenData({
            token: tokenOut as Address,
            to,
            funds: amountIn,
            minAmount,
          });
        } else {
          dataForDesc = this.encodeFourMemeUint256(minAmount);
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

    const deadline = getDeadline(settings, input.chainId, input.deadlineSeconds);

    const data = encodeFunctionData({
      abi: dagobangAbi,
      functionName: 'swap',
      args: [
        descs,
        ZERO_ADDRESS, // feeToken
        amountIn,     // amountIn (BNB)
        minOut,       // minReturn
        deadline
      ]
    });

    const txOpts = { skipEstimateGas: true, gasLimit: 900000n, trace };
    const { txHash, broadcastVia, broadcastUrl } = await timeStep('sendTransaction', () =>
      this.sendTransaction(client, account, routerAddress, data, amountIn, gasPriceWei, input.chainId, txOpts)
    );
    if (perfEnabled) {
      const totalMs = Date.now() - perfStart;
      console.log('[trade.buy.turbo] timing ms', {
        total: totalMs, steps: perfSteps,
        broadcastProvider: formatBroadcastProvider(broadcastVia, broadcastUrl)
      });
    }
    return { txHash, tokenMinOutWei: minOut.toString(), broadcastVia, broadcastUrl };
  }

  static async approveMaxForSellIfNeeded(chainId: number, tokenAddress: string, tokenInfo: TokenInfo) {
    const routerAddress = DeployAddress[chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();

    const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const platform = tokenInfo.launchpad_platform?.toLowerCase();
    const launchpadConfig = platform ? this.getLaunchpadConfig(tokenInfo, chainId) : null;

    const spenders: string[] = [routerAddress];
    if (launchpadConfig?.manager && launchpadConfig.manager !== ZERO_ADDRESS && launchpadConfig.manager.toLowerCase() !== routerAddress.toLowerCase()) {
      spenders.push(launchpadConfig.manager);
    }

    let lastTxHash: `0x${string}` | null = null;
    for (const spender of spenders) {
      const allowance = await client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, spender as `0x${string}`]
      });
      if (allowance >= maxUint256 / 2n) continue;
      lastTxHash = await this.approve(chainId, tokenAddress, spender, maxUint256.toString());
    }

    const isInner = this.isInnerDisk(tokenInfo);
    const isInnerFourMeme = isInner && platform.includes('fourmeme');
    const bridgeToken = isInnerFourMeme ? getBridgeToken(chainId, tokenInfo.quote_token_address) : null;
    if (bridgeToken && bridgeToken !== ZERO_ADDRESS) {
      const allowance = await client.readContract({
        address: bridgeToken as `0x${string}`,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, routerAddress as `0x${string}`]
      });
      if (allowance < maxUint256 / 2n) {
        lastTxHash = await this.approve(chainId, bridgeToken, routerAddress, maxUint256.toString());
      }
    }

    return lastTxHash;
  }

  static async sell(input: TxSellInput) {
    const sellLockKey = `${input.chainId}:${input.tokenAddress.toLowerCase()}`;
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

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();

    let amountIn = BigInt(input.tokenAmountWei);
    const baseFee = input.poolFee ?? 2500;
    const executionMode = settings.chains[input.chainId]?.executionMode ?? 'default';
    const isTurbo = executionMode === 'turbo';
    const percentBps = isTurbo ? (input.sellPercentBps ?? 0) : 0;
    if (!isTurbo && amountIn <= 0n) throw new Error('Invalid amount');
    const chainSettings = settings.chains[input.chainId];
    const gasPreset = input.gasPreset ?? chainSettings.sellGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');

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

    const isInner = this.isInnerDisk(tokenInfo);
    const platformLower = tokenInfo.launchpad_platform?.toLowerCase() || '';
    const isInnerFourMeme = isInner && platformLower.includes('fourmeme');
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId) : null;
    const bridgeToken = getBridgeToken(input.chainId, tokenInfo.quote_token_address);
    const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
    console.log('sell input.tokenInfo', tokenInfo, isInner, launchpadConfig)
    console.log('sell bridgeToken', bridgeToken, bridgePrefer);
    const descs: SwapDescLike[] = [];
    const sellToken: Address = input.tokenAddress;
    let estimatedOut = 0n;
    let minFundsForSell = 0n;
    let sellTokenManager: Address | null = null;

    if (isInner && launchpadConfig) {
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
            this.tryFourMemeSellEstimatedFunds(client, input.chainId, sellToken, amountIn)
          );
          if (est && est.funds > 0n) {
            sellTokenManager = est.tokenManager ?? null;
            const netFunds = est.funds > est.fee ? (est.funds - est.fee) : 0n;
            if (netFunds > 0n) {
              minFunds = applySlippage(netFunds, slippageBps);
              if (minFunds > 0n) {
                dataForSell = this.encodeFourMemeUint256(minFunds);
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

      const innerTokenOut = bridgeToken ?? ZERO_ADDRESS;
      descs.push(getRouterSwapDesc({
        swapType: launchpadConfig.sellType,
        tokenIn: sellToken,
        tokenOut: innerTokenOut,
        poolAddress: launchpadConfig.manager,
        fee: 0,
        data: dataForSell,
      }));

      if (innerTokenOut !== ZERO_ADDRESS && bridgeToken) {
        const hop2AmountIn = isTurbo ? 1n : (minFunds > 0n ? minFunds : 1n);
        const hop2 = await timeStep('quote:bridge:hop2', () =>
          resolveBridgeHopExactIn(
            input.chainId,
            bridgeToken,
            ZERO_ADDRESS,
            hop2AmountIn,
            bridgePrefer,
            isTurbo,
            !isTurbo
          )
        );
        if (!hop2.poolAddress || hop2.poolAddress === ZERO_ADDRESS) {
          throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        descs.push(getRouterSwapDesc({
          swapType: hop2.swapType,
          tokenIn: bridgeToken,
          tokenOut: ZERO_ADDRESS,
          poolAddress: hop2.poolAddress,
          fee: getV3FeeForDesc(hop2, 500),
        }));
        if (!isTurbo && hop2.amountOut > 0n) {
          estimatedOut = hop2.amountOut;
        }
      }
    }

    let amountInForQuote = amountIn;
    if (isTurbo) {
      if (percentBps <= 0 || percentBps > 10000) throw new Error('Invalid percent');
      const baseBal = input.expectedTokenInWei ? BigInt(input.expectedTokenInWei) : 0n;
      amountInForQuote = baseBal > 0n ? (baseBal * BigInt(percentBps)) / 10000n : 1n;
    }

    if (!isInner) {
      // hop1
      const hop1RouterOut = bridgeToken ? bridgeToken : ZERO_ADDRESS;
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
          throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        const hop2AmountIn = isTurbo ? 1n : hop1.amountOut;
        const hop2 = await timeStep('quote:bridge:hop2', () =>
          resolveBridgeHopExactIn(
            input.chainId,
            bridgeToken,
            ZERO_ADDRESS,
            hop2AmountIn,
            bridgePrefer,
            isTurbo,
            !isTurbo
          )
        );
        if (isTurbo) {
          if (!hop2.poolAddress || hop2.poolAddress === ZERO_ADDRESS) {
            throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
        } else {
          try {
            assertDexQuoteOk(hop2);
          } catch {
            throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
          }
        }
        if (!isTurbo && hop2.amountOut <= 0n) {
          throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        descs.push(getRouterSwapDesc({
          swapType: hop2.swapType,
          tokenIn: bridgeToken,
          tokenOut: ZERO_ADDRESS,
          poolAddress: hop2.poolAddress,
          fee: getV3FeeForDesc(hop2, 500),
        }));
        estimatedOut = isTurbo ? 0n : hop2.amountOut;
      }
    }

    const lastTokenOut = descs.length > 0 ? descs[descs.length - 1]!.tokenOut : ZERO_ADDRESS;
    let minOut = 0n;
    if (estimatedOut > 0n) {
      const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
      minOut = applySlippage(estimatedOut, slippageBps);
    }
    if (isInnerFourMeme && !bridgeToken && minFundsForSell > 0n) {
      const v2Manager = (DeployAddress[input.chainId as ChainId]?.[ContractNames.FourMemeTokenManagerV2]?.address || ZERO_ADDRESS) as Address;
      const isV2 = sellTokenManager && v2Manager !== ZERO_ADDRESS && sellTokenManager.toLowerCase() === v2Manager.toLowerCase();
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

    const txOpts = { skipEstimateGas: true, gasLimit: 900000n, trace };
    const { txHash, broadcastVia, broadcastUrl } = await timeStep('sendTransaction', () =>
      this.sendTransaction(client, account, routerAddress, data, 0n, gasPriceWei, input.chainId, txOpts)
    );
    if (perfEnabled) {
      const totalMs = Date.now() - perfStart;
      console.log('[trade.sell.turbo] timing ms', {
        total: totalMs, steps: perfSteps,
        broadcastProvider: formatBroadcastProvider(broadcastVia, broadcastUrl)
      });
    }
    return { txHash, broadcastVia, broadcastUrl };
    };
    try {
      return await run();
    } finally {
      this.sellInFlightByToken.delete(sellLockKey);
    }
  }

  static async approve(chainId: number, tokenAddress: string, spender: string, amountWei: string) {
    const settings = await SettingsService.get();
    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();
    const chainSettings = settings.chains[chainId];
    const approveGasGwei = chainSettings.approveGasGwei ?? '0.06';
    let gasPriceWei = parseGweiToWei(approveGasGwei);
    if (gasPriceWei <= 0n) gasPriceWei = parseGweiToWei('0.06');

    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender as `0x${string}`, BigInt(amountWei)]
    });

    const { txHash } = await this.sendTransaction(client, account, tokenAddress, data, 0n, gasPriceWei, chainId);
    return txHash;
  }

  static async sendTransaction(
    client: any,
    account: any,
    to: string,
    data: any,
    value: bigint,
    gasPriceWei: bigint,
    chainId: number,
    opts?: { nonce?: number; skipEstimateGas?: boolean; gasLimit?: bigint; trace?: (label: string, ms: number) => void }
  ) {
    return await sendTransaction(client, account, to, data, value, gasPriceWei, chainId, opts);
  }
}
