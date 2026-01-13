import { parseAbi, encodeFunctionData, decodeEventLog } from 'viem';
import { RpcService } from './rpc';
import { WalletService } from './wallet';
import { SettingsService } from './settings';
import { TradeService } from './trade';
import type { GasPreset, ChainSettings } from '../types/extention';

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

function getGasPriceWei(chainSettings: ChainSettings, preset: GasPreset): bigint {
  const baseConfig = chainSettings.buyGasGwei;
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
import { FourmemeTokenInfo } from '@/types/token';
import { DeployAddress } from '../constants/contracts/address';
import { ChainId } from '../constants/chains/chainId';
import { ContractNames } from '../constants/contracts/names';

const tokenManagerHelper3Abi = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)'
]);

const fourMemeTokenManagerAbi = parseAbi([
  'function createToken(bytes createArg, bytes sign) returns (address token)',
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime)'
]);

export class TokenFourmemeService {
  private static getTokenManagerHelper3Address(chainId: number): string {
    const contracts = DeployAddress[chainId as ChainId] || {};
    return contracts[ContractNames.TokenManagerHelper3]?.address || '0x0000000000000000000000000000000000000000';
  }

  static async getTokenInfo(chainId: number, tokenAddress: string): Promise<FourmemeTokenInfo> {
    const client = await RpcService.getClient();
    const helperAddress = this.getTokenManagerHelper3Address(chainId);
    
    if (helperAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('TokenManagerHelper3 address not found for chain ' + chainId);
    }

    const result = await client.readContract({
      address: helperAddress as `0x${string}`,
      abi: tokenManagerHelper3Abi,
      functionName: 'getTokenInfo',
      args: [tokenAddress as `0x${string}`],
    });

    const [
      version,
      tokenManager,
      quote,
      lastPrice,
      tradingFeeRate,
      minTradingFee,
      launchTime,
      offers,
      maxOffers,
      funds,
      maxFunds,
      liquidityAdded
    ] = result;

    return {
      version: Number(version),
      tokenManager,
      quote,
      lastPrice: Number(lastPrice),
      tradingFeeRate: Number(tradingFeeRate),
      minTradingFee: Number(minTradingFee),
      launchTime: Number(launchTime),
      offers: Number(offers),
      maxOffers: Number(maxOffers),
      funds: Number(funds),
      maxFunds: Number(maxFunds),
      liquidityAdded
    };
  }

  static async createTokenOnChain(
    chainId: number,
    createArg: string,
    sign: string
  ): Promise<{ txHash: `0x${string}`; tokenAddress: `0x${string}` | null }> {
    const contracts = DeployAddress[chainId as ChainId] || {};
    const managerAddress = contracts[ContractNames.FourMemeTokenManagerV2]?.address;
    if (!managerAddress) {
      throw new Error('FourMemeTokenManagerV2 address not found for chain ' + chainId);
    }

    const account = await WalletService.getSigner();
    const client = await RpcService.getClient();
    const settings = await SettingsService.get();
    const chainSettings = settings.chains[chainId as ChainId] as ChainSettings;
    const gasPreset: GasPreset = chainSettings.buyGasPreset ?? chainSettings.gasPreset;

    const data = encodeFunctionData({
      abi: fourMemeTokenManagerAbi,
      functionName: 'createToken',
      args: [createArg as `0x${string}`, sign as `0x${string}`],
    });

    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset);

    const txHash = await TradeService.sendTransaction(
      client,
      account,
      managerAddress,
      data,
      0n,
      gasPriceWei,
      chainId
    );

    let tokenAddress: `0x${string}` | null = null;
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== managerAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: fourMemeTokenManagerAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'TokenCreate') {
            const args: any = decoded.args;
            if (args && args.token) {
              tokenAddress = args.token as `0x${string}`;
              break;
            }
          }
        } catch {
        }
      }
    } catch {
      tokenAddress = null;
    }

    return { txHash, tokenAddress };
  }
}
