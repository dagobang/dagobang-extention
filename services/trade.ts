import { encodeFunctionData, erc20Abi, getAddress } from 'viem';
import { bsc } from 'viem/chains';
import { RpcService } from './rpc';
import { WalletService } from './wallet';
import { SettingsService } from './settings';
import type { TxBuyInput, TxSellInput, GasPreset, ChainSettings } from '../types/extention';
import { TokenInfo } from '../types/token';
import { ContractNames } from '../constants/contracts/names';
import { DeployAddress } from '../constants/contracts/address';
import { ChainId } from '../constants/chains/chainId';
import { getBridgeTokenAddresses } from '../constants/tokens/allTokens';
import { quoterV2Abi, pairV2Abi, factoryV2Abi, dagobangAbi } from '@/constants/contracts/abi';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x0000000000000000000000000000000000000000000000000000000000000000';


const QUOTER_V2_BSC = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';
const WBNB_BSC = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

enum SwapType {
  V2_EXACT_IN = 0,
  V3_EXACT_IN = 1,
  V4_EXACT_IN = 2,
  PANCAKE_INFINITY_EXACT_IN = 3,
  LUNA_LAUNCHPAD_V2 = 4,
  FOUR_MEME_BUY_AMAP = 5,
  FOUR_MEME_SELL = 6,
  FLAP_EXACT_INPUT = 7,
}

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

function getGasPriceWei(chainSettings: ChainSettings, preset: GasPreset, side: 'buy' | 'sell'): bigint {
  const baseConfig = side === 'buy' ? chainSettings.buyGasGwei : chainSettings.sellGasGwei;
  const fallbackConfig = {
    slow: '0.06',
    standard: '0.12',
    fast: '1',
    turbo: '5',
  };
  const cfg = baseConfig || fallbackConfig;
  let value = cfg.standard;
  if (preset === 'slow') value = cfg.slow;
  else if (preset === 'fast') value = cfg.fast;
  else if (preset === 'turbo') value = cfg.turbo;
  const wei = parseGweiToWei(value);
  if (wei <= 0n) {
    return parseGweiToWei(fallbackConfig.standard);
  }
  return wei;
}

export class TradeService {
  private static nonceLocked = new Set<string>();
  private static nonceLockQueue = new Map<string, Array<() => void>>();
  private static nonceState = new Map<string, { nextNonce: number; ts: number }>();

  private static async acquireNonceLock(key: string): Promise<() => void> {
    if (!this.nonceLocked.has(key)) {
      this.nonceLocked.add(key);
      return () => this.releaseNonceLock(key);
    }
    return await new Promise<() => void>((resolve) => {
      const q = this.nonceLockQueue.get(key) ?? [];
      q.push(() => resolve(() => this.releaseNonceLock(key)));
      this.nonceLockQueue.set(key, q);
    });
  }

  private static releaseNonceLock(key: string) {
    const q = this.nonceLockQueue.get(key);
    if (!q || q.length === 0) {
      this.nonceLocked.delete(key);
      this.nonceLockQueue.delete(key);
      return;
    }
    const next = q.shift();
    if (next) next();
    if (q.length === 0) {
      this.nonceLockQueue.delete(key);
    } else {
      this.nonceLockQueue.set(key, q);
    }
  }

  private static async reserveNonce(client: any, chainId: number, address: `0x${string}`): Promise<number> {
    const key = `${chainId}:${address.toLowerCase()}`;
    const release = await this.acquireNonceLock(key);
    try {
      const now = Date.now();
      const state = this.nonceState.get(key);
      if (state && now - state.ts < 20000) {
        const nonce = state.nextNonce;
        state.nextNonce += 1;
        state.ts = now;
        this.nonceState.set(key, state);
        return nonce;
      }
      const nonce = await client.getTransactionCount({ address, blockTag: 'pending' });
      this.nonceState.set(key, { nextNonce: nonce + 1, ts: now });
      return nonce;
    } finally {
      release();
    }
  }

  private static clearNonceState(chainId: number, address: `0x${string}`) {
    const key = `${chainId}:${address.toLowerCase()}`;
    this.nonceState.delete(key);
  }

  private static getWNative(chainId: number) {
    return WBNB_BSC;
  }

  private static getBridgeToken(chainId: number, quoteTokenAddress?: string): `0x${string}` | null {
    if (!quoteTokenAddress) return null;
    const trimmed = quoteTokenAddress.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
    let addr: `0x${string}`;
    try {
      addr = getAddress(trimmed as `0x${string}`);
    } catch {
      return null;
    }

    const wNative = this.getWNative(chainId);
    if (addr.toLowerCase() === wNative.toLowerCase()) return null;

    const allowlist = getBridgeTokenAddresses(chainId as ChainId);

    return allowlist.some((x) => x.toLowerCase() === addr.toLowerCase()) ? addr : null;
  }

  private static getQuoter(chainId: number) {
    return chainId === 56 ? QUOTER_V2_BSC : ZERO_ADDRESS;
  }

  static async getQuote(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint, fee: number) {
    const client = await RpcService.getClient();
    const quoter = this.getQuoter(chainId);

    if (quoter === ZERO_ADDRESS) {
      return 0n;
    }

    try {
      const { result } = await client.simulateContract({
        address: quoter as `0x${string}`,
        abi: quoterV2Abi,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      });

      return result[0];
    } catch (e) {
      console.warn('Quote failed', e);
      return 0n;
    }
  }

  private static async getBestV3Quote(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint, explicitFee?: number) {
    const fees = explicitFee !== undefined ? [explicitFee] : [2500, 500, 100, 10000];
    const attempts = fees.map((f) =>
      this.getQuote(chainId, tokenIn, tokenOut, amountIn, f).then((out) => {
        if (out > 0n) return { amountOut: out, fee: f };
        throw new Error('NO_QUOTE');
      })
    );
    try {
      return await Promise.any(attempts);
    } catch {
      return { amountOut: 0n, fee: undefined as number | undefined };
    }
  }

  private static getV2Factories(chainId: number) {
    const deploys = DeployAddress[chainId as ChainId] ?? {};
    const factories = [
      deploys[ContractNames.PancakeFactoryV2]?.address,
      deploys[ContractNames.UniswapFactoryV2]?.address,
    ].filter(Boolean) as string[];
    return factories;
  }

  private static async quoteV2ExactInByPair(pair: string, tokenIn: string, tokenOut: string, amountIn: bigint, feeBps: number) {
    const client = await RpcService.getClient();
    const tokenInAddr = getAddress(tokenIn as `0x${string}`);
    const tokenOutAddr = getAddress(tokenOut as `0x${string}`);

    const [token0, token1, reserves] = await Promise.all([
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'token0',
      }) as Promise<`0x${string}`>,
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'token1',
      }) as Promise<`0x${string}`>,
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'getReserves',
      }) as Promise<[bigint, bigint, number]>,
    ]);

    if (
      (token0.toLowerCase() !== tokenInAddr.toLowerCase() && token0.toLowerCase() !== tokenOutAddr.toLowerCase()) ||
      (token1.toLowerCase() !== tokenInAddr.toLowerCase() && token1.toLowerCase() !== tokenOutAddr.toLowerCase())
    ) {
      return 0n;
    }

    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    const isToken0In = token0.toLowerCase() === tokenInAddr.toLowerCase();
    const reserveIn = isToken0In ? reserve0 : reserve1;
    const reserveOut = isToken0In ? reserve1 : reserve0;
    if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

    const fee = BigInt(feeBps);
    const amountInWithFee = amountIn * (10000n - fee);
    const numerator = amountInWithFee * reserveOut;
    const denominator = reserveIn * 10000n + amountInWithFee;
    if (denominator === 0n) return 0n;
    return numerator / denominator;
  }

  private static async getBestV2Quote(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint, hintPair?: string) {
    const client = await RpcService.getClient();
    const feeBps = 25;

    const pairs: string[] = [];
    if (hintPair && hintPair !== ZERO_ADDRESS) {
      pairs.push(hintPair);
    }

    const factories = this.getV2Factories(chainId);
    const pairResults = await Promise.allSettled(
      factories.map((factory) =>
        client.readContract({
          address: factory as `0x${string}`,
          abi: factoryV2Abi,
          functionName: 'getPair',
          args: [tokenIn as `0x${string}`, tokenOut as `0x${string}`],
        }) as Promise<`0x${string}`>
      )
    );
    for (const r of pairResults) {
      if (r.status !== 'fulfilled') continue;
      if (r.value !== ZERO_ADDRESS) pairs.push(r.value);
    }

    let best: { amountOut: bigint; pair?: string } = { amountOut: 0n };
    const outResults = await Promise.allSettled(
      pairs.map((pair) => this.quoteV2ExactInByPair(pair, tokenIn, tokenOut, amountIn, feeBps).then((amountOut) => ({ pair, amountOut })))
    );
    for (const r of outResults) {
      if (r.status !== 'fulfilled') continue;
      if (r.value.amountOut > best.amountOut) best = { amountOut: r.value.amountOut, pair: r.value.pair };
    }

    return best.amountOut > 0n ? { amountOut: best.amountOut, pair: best.pair } : { amountOut: 0n, pair: undefined as string | undefined };
  }

  private static async getBestDexExactIn(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint, opts?: { v3Fee?: number; v2HintPair?: string }) {
    const v2Promise = this.getBestV2Quote(chainId, tokenIn, tokenOut, amountIn, opts?.v2HintPair);
    const v3Promise = this.getBestV3Quote(chainId, tokenIn, tokenOut, amountIn, opts?.v3Fee);

    const [{ amountOut: v3Out, fee }, v2] = await Promise.all([v3Promise, v2Promise]);
    const v2Out = v2.amountOut ?? 0n;

    if (v3Out > 0n && v3Out >= v2Out) {
      return { amountOut: v3Out, swapType: SwapType.V3_EXACT_IN, fee: fee ?? opts?.v3Fee, poolAddress: ZERO_ADDRESS };
    }
    if (v2Out > 0n && v2.pair) {
      return { amountOut: v2Out, swapType: SwapType.V2_EXACT_IN, fee: 0, poolAddress: v2.pair };
    }
    if (v3Out > 0n) {
      return { amountOut: v3Out, swapType: SwapType.V3_EXACT_IN, fee: fee ?? opts?.v3Fee, poolAddress: ZERO_ADDRESS };
    }

    return { amountOut: 0n, swapType: SwapType.V3_EXACT_IN, fee: undefined as number | undefined, poolAddress: ZERO_ADDRESS };
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
        manager: contracts[ContractNames.FourMemeTokenManagerV2]?.address || ZERO_ADDRESS
      };
    }

    if (platform === 'flap') {
      return {
        buyType: SwapType.FLAP_EXACT_INPUT,
        sellType: SwapType.FLAP_EXACT_INPUT, // Assuming same for sell
        manager: contracts[ContractNames.FlapshTokenManager]?.address || ZERO_ADDRESS
      };
    }
    return null;
  }

  static async buy(input: TxBuyInput) {
    const settings = await SettingsService.get();
    const routerAddress = DeployAddress[input.chainId as ChainId]?.DagobangRouter?.address;
    if (!routerAddress) throw new Error('Router address not set');
    if (!input.tokenInfo) throw new Error('Token info required');

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();

    const amountIn = BigInt(input.bnbAmountWei);
    const baseFee = input.poolFee ?? 2500;
    const executionMode = settings.chains[input.chainId]?.executionMode ?? 'default';
    const isTurbo = executionMode === 'turbo';
    const chainSettings = settings.chains[input.chainId];
    const gasPreset = input.gasPreset ?? chainSettings.buyGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'buy');

    const isInner = this.isInnerDisk(input.tokenInfo);
    const launchpadConfig = isInner ? this.getLaunchpadConfig(input.tokenInfo, input.chainId) : null;

    const bridgeToken = this.getBridgeToken(input.chainId, input.tokenInfo.quote_token_address);
    console.log('input.tokenInfo', input.tokenInfo, isInner, launchpadConfig)
    console.log('bridgeToken', bridgeToken);
    const descs: any[] = [];
    let currentToken = ZERO_ADDRESS; // BNB
    let currentAmount = amountIn;

    if (bridgeToken) {
      const wNative = this.getWNative(input.chainId);
      const q1 = await this.getBestDexExactIn(input.chainId, wNative, bridgeToken, currentAmount, { v3Fee: 500 });
      const out1 = q1.amountOut;
      if (out1 <= 0n) {
        throw new Error('找不到 BNB/Quote 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
      }

      descs.push({
        swapType: q1.swapType,
        tokenIn: ZERO_ADDRESS,
        tokenOut: bridgeToken,
        poolAddress: q1.poolAddress,
        fee: q1.swapType === SwapType.V3_EXACT_IN ? 500 : 0,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        hookData: '0x',
        poolManager: ZERO_ADDRESS,
        parameters: ZERO32,
        data: '0x'
      });

      currentToken = bridgeToken;
      currentAmount = out1;
    }

    // Hop 2: [BNB/USD1] -> Meme
    const tokenOut = input.tokenAddress;
    let minOut = 0n;

    if (isInner && launchpadConfig) {
      // Launchpad Buy
      descs.push({
        swapType: launchpadConfig.buyType,
        tokenIn: currentToken,
        tokenOut: tokenOut,
        poolAddress: launchpadConfig.manager,
        fee: 0,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        hookData: '0x',
        poolManager: ZERO_ADDRESS,
        parameters: ZERO32,
        data: '0x' // AMAP
      });
      // minOut stays 0 for AMAP
    } else {
      // DEX Buy
      const quoteInToken = currentToken === ZERO_ADDRESS ? this.getWNative(input.chainId) : currentToken;
      const q2 = await this.getBestDexExactIn(input.chainId, quoteInToken, tokenOut, currentAmount, { v3Fee: input.poolFee, v2HintPair: input.tokenInfo.pool_pair });
      const out = q2.amountOut;
      const usedFee = q2.swapType === SwapType.V3_EXACT_IN ? ((q2.fee ?? input.poolFee ?? baseFee) as number) : 0;
      if (out <= 0n) {
        throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
      }
      const slippageBps = BigInt(input.slippageBps ?? settings.chains[input.chainId].slippageBps ?? 4000);
      minOut = out * (10000n - slippageBps) / 10000n;

      descs.push({
        swapType: q2.swapType,
        tokenIn: currentToken,
        tokenOut: tokenOut,
        poolAddress: q2.poolAddress,
        fee: usedFee,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        hookData: '0x',
        poolManager: ZERO_ADDRESS,
        parameters: ZERO32,
        data: '0x'
      });
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + (input.deadlineSeconds ?? settings.chains[input.chainId].deadlineSeconds ?? 600));

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

    const txOpts = isTurbo ? { skipEstimateGas: true, gasLimit: 900000n } : undefined;
    const txHash = await this.sendTransaction(client, account, routerAddress, data, amountIn, gasPriceWei, input.chainId, txOpts);
    return { txHash, tokenMinOutWei: minOut.toString() };
  }

  static async approveMaxForSellIfNeeded(chainId: number, tokenAddress: string, tokenInfo: TokenInfo) {
    const settings = await SettingsService.get();
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

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();

    const amountIn = BigInt(input.tokenAmountWei);
    const baseFee = input.poolFee ?? 2500;
    const executionMode = settings.chains[input.chainId]?.executionMode ?? 'default';
    const isTurbo = executionMode === 'turbo';
    const percentBps = isTurbo ? (input.sellPercentBps ?? 0) : 0;
    const chainSettings = settings.chains[input.chainId];
    const gasPreset = input.gasPreset ?? chainSettings.sellGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'sell');

    const isInner = this.isInnerDisk(input.tokenInfo);
    const launchpadConfig = isInner ? this.getLaunchpadConfig(input.tokenInfo, input.chainId) : null;
    const bridgeToken = this.getBridgeToken(input.chainId, input.tokenInfo.quote_token_address);

    const descs: any[] = [];
    let currentToken = input.tokenAddress;

    if (isInner && launchpadConfig) {
      // Launchpad Sell: Always Meme -> BNB
      descs.push({
        swapType: launchpadConfig.sellType,
        tokenIn: currentToken,
        tokenOut: ZERO_ADDRESS, // Always sell to Native
        poolAddress: launchpadConfig.manager,
        fee: 0,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        hookData: '0x',
        poolManager: ZERO_ADDRESS,
        parameters: ZERO32,
        data: '0x'
      });
      // Result is BNB. Done.
    } else {
      currentToken = input.tokenAddress;
    }

    let amountInForQuote = amountIn;
    if (isTurbo) {
      if (percentBps <= 0 || percentBps > 10000) throw new Error('Invalid percent');
      let baseBal = 0n;
      try {
        baseBal = await client.readContract({
          address: input.tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account.address],
          blockTag: 'pending' as any,
        });
      } catch {
        baseBal = await client.readContract({
          address: input.tokenAddress as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account.address],
        });
      }

      if (baseBal === 0n && input.expectedTokenInWei) {
        baseBal = BigInt(input.expectedTokenInWei);
      }
      amountInForQuote = (baseBal * BigInt(percentBps)) / 10000n;
      if (amountInForQuote <= 0n) throw new Error('No balance');
    }

    const wNative = this.getWNative(input.chainId);
    let estimatedOut = 0n;
    if (!isInner) {
      const hop1TokenOut = bridgeToken ? bridgeToken : wNative;
      const hop1 = await this.getBestDexExactIn(input.chainId, input.tokenAddress, hop1TokenOut, amountInForQuote, { v3Fee: input.poolFee, v2HintPair: input.tokenInfo.pool_pair });
      if (hop1.amountOut <= 0n) {
        throw new Error('找不到该代币的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
      }

      descs.push({
        swapType: hop1.swapType,
        tokenIn: input.tokenAddress,
        tokenOut: bridgeToken ? bridgeToken : ZERO_ADDRESS,
        poolAddress: hop1.poolAddress,
        fee: hop1.swapType === SwapType.V3_EXACT_IN ? ((hop1.fee ?? input.poolFee ?? baseFee) as number) : 0,
        tickSpacing: 0,
        hooks: ZERO_ADDRESS,
        hookData: '0x',
        poolManager: ZERO_ADDRESS,
        parameters: ZERO32,
        data: '0x'
      });

      if (!bridgeToken) {
        estimatedOut = hop1.amountOut;
      } else {
        const hop2 = await this.getBestDexExactIn(input.chainId, bridgeToken, wNative, hop1.amountOut, { v3Fee: 500 });
        if (hop2.amountOut <= 0n) {
          throw new Error('找不到 Quote/BNB 的 V2/V3 交易池，可能还没有在 DEX 上创建流动性');
        }
        descs.push({
          swapType: hop2.swapType,
          tokenIn: bridgeToken,
          tokenOut: ZERO_ADDRESS,
          poolAddress: hop2.poolAddress,
          fee: hop2.swapType === SwapType.V3_EXACT_IN ? 500 : 0,
          tickSpacing: 0,
          hooks: ZERO_ADDRESS,
          hookData: '0x',
          poolManager: ZERO_ADDRESS,
          parameters: ZERO32,
          data: '0x'
        });
        estimatedOut = hop2.amountOut;
      }
    }

    let minOut = 0n;
    if (estimatedOut > 0n) {
      const slippageBps = BigInt(input.slippageBps ?? settings.chains[input.chainId].slippageBps ?? 4000);
      minOut = estimatedOut * (10000n - slippageBps) / 10000n;
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + (input.deadlineSeconds ?? settings.chains[input.chainId].deadlineSeconds ?? 600));

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

    const txOpts = isTurbo ? { skipEstimateGas: true, gasLimit: 900000n } : undefined;
    return this.sendTransaction(client, account, routerAddress, data, 0n, gasPriceWei, input.chainId, txOpts);
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

    return this.sendTransaction(client, account, tokenAddress, data, 0n, gasPriceWei, chainId);
  }

  static async sendTransaction(
    client: any,
    account: any,
    to: string,
    data: any,
    value: bigint,
    gasPriceWei: bigint,
    chainId: number,
    opts?: { nonce?: number; skipEstimateGas?: boolean; gasLimit?: bigint }
  ) {
    const noncePromise = opts?.nonce !== undefined
      ? Promise.resolve(opts.nonce)
      : this.reserveNonce(client, chainId, account.address);

    let gasLimit = opts?.gasLimit ?? 900000n;
    if (!opts?.skipEstimateGas && opts?.gasLimit === undefined) {
      try {
        gasLimit = await client.estimateGas({
          account,
          to: to as `0x${string}`,
          data,
          value,
        });
        gasLimit = gasLimit * 120n / 100n;
      } catch (e) {
        console.warn('Gas estimation failed, using default', e);
      }
    }

    const nonce = await noncePromise;

    try {
      const signed = await account.signTransaction({
        to: to as `0x${string}`,
        data,
        value,
        gas: gasLimit,
        gasPrice: gasPriceWei,
        chain: bsc,
        nonce,
      });

      return await RpcService.broadcastTx(signed);
    } catch (e) {
      this.clearNonceState(chainId, account.address);
      throw e;
    }
  }
}
