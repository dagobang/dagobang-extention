import { parseAbi, encodeFunctionData, decodeEventLog } from 'viem';
import { RpcService } from './rpc';
import { WalletService } from './wallet';
import { SettingsService } from './settings';
import { TradeService } from './trade';
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
    const gasPreset = settings.chains[chainId as ChainId].gasPreset;

    const data = encodeFunctionData({
      abi: fourMemeTokenManagerAbi,
      functionName: 'createToken',
      args: [createArg as `0x${string}`, sign as `0x${string}`],
    });

    const txHash = await TradeService.sendTransaction(
      client,
      account,
      managerAddress,
      data,
      0n,
      gasPreset,
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
