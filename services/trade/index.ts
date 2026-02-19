import { encodeFunctionData, erc20Abi } from 'viem';
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
import { assertDexQuoteOk, getBridgeToken, quoteBestExactIn as quoteBestExactInDex, resolveDexExactIn } from './tradeDex';
import { getGasPriceWei, prewarmNonce, sendTransaction } from './tradeTx';
import { formatBroadcastProvider } from '@/utils/format';

export class TradeService {
  static async quoteBestExactIn(
    chainId: number,
    tokenIn: `0x${string}`,
    tokenOut: `0x${string}`,
    amountIn: bigint,
    opts?: { v3Fee?: number; v2HintPair?: string; prefer?: 'v2' | 'v3' }
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
    const memePrefer = bridgePrefer ?? 'v2';

    const bridgeOpts = bridgePrefer === 'v2'
      ? { prefer: 'v2' as const }
      : bridgePrefer === 'v3'
        ? { v3Fee: 500, prefer: 'v3' as const }
        : { v3Fee: 500 };

    const amountIn = 1n;
    const warmTasks: Array<Promise<unknown>> = [];

    if (memePrefer === 'v3') {
      warmTasks.push(
        resolveDexExactIn(
          input.chainId,
          ZERO_ADDRESS,
          token,
          amountIn,
          { v2HintPair: tokenInfo.pool_pair, prefer: memePrefer },
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
          { v2HintPair: tokenInfo.pool_pair, prefer: memePrefer },
          true,
          false
        )
      );
    }

    if (bridgeToken && bridgePrefer !== 'v2') {
      warmTasks.push(resolveDexExactIn(input.chainId, ZERO_ADDRESS, bridgeToken, amountIn, bridgeOpts, true, false));
      warmTasks.push(resolveDexExactIn(input.chainId, bridgeToken, ZERO_ADDRESS, amountIn, bridgeOpts, true, false));
    }

    if (bridgeToken && memePrefer === 'v3') {
      warmTasks.push(resolveDexExactIn(input.chainId, token, bridgeToken, amountIn, { v2HintPair: tokenInfo.pool_pair, prefer: memePrefer }, true, false));
      warmTasks.push(resolveDexExactIn(input.chainId, bridgeToken, token, amountIn, { v2HintPair: tokenInfo.pool_pair, prefer: memePrefer }, true, false));
    }

    await Promise.allSettled(warmTasks);
  }

  private static isInnerDisk(tokenInfo: TokenInfo): boolean {
    if (tokenInfo.launchpad) {
      // Assuming 'status' 1 means Trading (Outer), anything else (0/2?) is Inner/Launchpad
      // Or checking if platform is known launchpad
      if (['fourmeme', 'bn_fourmeme', 'flap'].includes(tokenInfo.launchpad_platform?.toLowerCase() || '')) {
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

    if (platform === 'fourmeme' || platform === 'bn_fourmeme') {
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
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'buy');

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
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId) : null;

    const bridgeToken = getBridgeToken(input.chainId, tokenInfo.quote_token_address);
    console.log('input.tokenInfo', tokenInfo, isInner, launchpadConfig)
    console.log('bridgeToken', bridgeToken);
    const descs: SwapDescLike[] = [];
    let currentRouterToken: Address = ZERO_ADDRESS;
    let currentAmount = amountIn;

    if (bridgeToken) {
      const bridgePrefer = getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken);
      const q1 = await timeStep('quote:bridge', () =>
        resolveDexExactIn(
          input.chainId,
          ZERO_ADDRESS,
          bridgeToken,
          currentAmount,
          bridgePrefer === 'v2' ? { prefer: 'v2' } : bridgePrefer === 'v3' ? { v3Fee: 500, prefer: 'v3' } : { v3Fee: 500 },
          isTurbo,
          true
        )
      );
      try {
        assertDexQuoteOk(q1);
      } catch {
        throw new Error('找不到 BNB/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
      }
      if (q1.amountOut <= 0n) {
        throw new Error('找不到 BNB/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
      }
      descs.push(getRouterSwapDesc({
        swapType: q1.swapType,
        tokenIn: ZERO_ADDRESS,
        tokenOut: bridgeToken,
        poolAddress: q1.poolAddress,
        fee: getV3FeeForDesc(q1, 500),
      }));
      currentRouterToken = bridgeToken;
      currentAmount = q1.amountOut;
    }

    // Hop 2: [BNB/USD1] -> Meme
    const tokenOut = input.tokenAddress;
    let minOut = 0n;

    if (isInner && launchpadConfig) {
      descs.push(getRouterSwapDesc({
        swapType: launchpadConfig.buyType,
        tokenIn: currentRouterToken,
        tokenOut,
        poolAddress: launchpadConfig.manager,
        fee: 0,
        data: '0x',
      }));
    } else {
      const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      const q2 = await timeStep('quote:token', () =>
        resolveDexExactIn(
          input.chainId,
          currentRouterToken,
          tokenOut,
          currentAmount,
          {
            v3Fee: input.poolFee,
            v2HintPair: tokenInfo.pool_pair,
            prefer: bridgePrefer ?? (isTurbo && !input.poolFee ? 'v2' : undefined)
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

    const txOpts = isTurbo ? { skipEstimateGas: true, gasLimit: 900000n, trace } : undefined;
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

    return lastTxHash;
  }

  static async sell(input: TxSellInput) {
    const settings = await SettingsService.get();
    const routerAddress = DeployAddress[input.chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');
    if (!input.tokenInfo) throw new Error('Token info required');
    const tokenInfo = input.tokenInfo;

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();

    const amountIn = BigInt(input.tokenAmountWei);
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
    const launchpadConfig = isInner ? this.getLaunchpadConfig(tokenInfo, input.chainId) : null;
    const bridgeToken = getBridgeToken(input.chainId, tokenInfo.quote_token_address);

    const descs: SwapDescLike[] = [];
    const sellToken: Address = input.tokenAddress;

    if (isInner && launchpadConfig) {
      descs.push(getRouterSwapDesc({
        swapType: launchpadConfig.sellType,
        tokenIn: sellToken,
        tokenOut: ZERO_ADDRESS,
        poolAddress: launchpadConfig.manager,
        fee: 0,
      }));
    }

    let amountInForQuote = amountIn;
    if (isTurbo) {
      if (percentBps <= 0 || percentBps > 10000) throw new Error('Invalid percent');
      const baseBal = input.expectedTokenInWei ? BigInt(input.expectedTokenInWei) : 0n;
      amountInForQuote = baseBal > 0n ? (baseBal * BigInt(percentBps)) / 10000n : 1n;
    }

    let estimatedOut = 0n;
    if (!isInner) {
      const hop1RouterOut = bridgeToken ? bridgeToken : ZERO_ADDRESS;
      const hop1NeedAmountOut = !!bridgeToken && !isTurbo;
      const bridgePrefer = bridgeToken ? getBridgeTokenDexPreference(input.chainId as ChainId, bridgeToken) : null;
      const hop1 = await timeStep('quote:token', () =>
        resolveDexExactIn(
          input.chainId,
          sellToken,
          hop1RouterOut,
          amountInForQuote,
          {
            v3Fee: input.poolFee,
            v2HintPair: tokenInfo.pool_pair,
            prefer: bridgePrefer ?? (isTurbo && !input.poolFee ? 'v2' : undefined)
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

      if (!bridgeToken) {
        estimatedOut = isTurbo ? 0n : hop1.amountOut;
      } else {
        if (!isTurbo && hop1.amountOut <= 0n) {
          throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        const hop2AmountIn = isTurbo ? 1n : hop1.amountOut;
        const hop2 = await timeStep('quote:bridge', () =>
          resolveDexExactIn(
            input.chainId,
            bridgeToken,
            ZERO_ADDRESS,
            hop2AmountIn,
            bridgePrefer === 'v2' ? { prefer: 'v2' } : bridgePrefer === 'v3' ? { v3Fee: 500, prefer: 'v3' } : { v3Fee: 500 },
            isTurbo
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

    let minOut = 0n;
    if (estimatedOut > 0n) {
      const slippageBps = getSlippageBps(settings, input.chainId, input.slippageBps);
      minOut = applySlippage(estimatedOut, slippageBps);
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

    const txOpts = isTurbo ? { skipEstimateGas: true, gasLimit: 900000n, trace } : undefined;
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
  }

  static async approve(chainId: number, tokenAddress: string, spender: string, amountWei: string) {
    const settings = await SettingsService.get();
    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();
    const chainSettings = settings.chains[chainId];
    const gasPreset = chainSettings.sellGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');

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
