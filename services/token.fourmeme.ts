import { parseAbi } from 'viem';
import { RpcService } from './rpc';
import { FourmemeTokenInfo } from '@/types/token';
import { DeployAddress } from '../constants/contracts/address';
import { ChainId } from '../constants/chains/chainId';
import { ContractNames } from '../constants/contracts/names';

const tokenManagerHelper3Abi = parseAbi([
  'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)'
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
}