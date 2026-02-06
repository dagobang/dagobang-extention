import { parseAbi } from 'viem';
import type { FlapTokenStateV7 } from '@/types/token';
import { erc20Abi } from '@/constants/contracts/abi/swapAbi';

import { RpcService } from './rpc';
import { DeployAddress } from '../constants/contracts/address';
import { ChainId } from '../constants/chains/chainId';
import { ContractNames } from '../constants/contracts/names';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const flapTokenManagerAbi = parseAbi([
  'function getTokenV7(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 taxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
]);

export class TokenFlapService {
  private static getFlapTokenManagerAddress(chainId: number): string {
    const contracts = DeployAddress[chainId as ChainId] || {};
    return contracts[ContractNames.FlapshTokenManager]?.address || ZERO_ADDRESS;
  }

  static async getTokenInfo(chainId: number, tokenAddress: string): Promise<FlapTokenStateV7> {
    const client = await RpcService.getClient();
    const managerAddress = this.getFlapTokenManagerAddress(chainId);

    if (managerAddress === ZERO_ADDRESS) {
      throw new Error('FlapshTokenManager address not found for chain ' + chainId);
    }

    const [state, meta] = await Promise.all([
      client.readContract({
        address: managerAddress as `0x${string}`,
        abi: flapTokenManagerAbi,
        functionName: 'getTokenV7',
        args: [tokenAddress as `0x${string}`],
      }) as Promise<any>,
      Promise.all([
        client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
        client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
      ]).then(([symbol, decimals]) => ({ symbol, decimals })),
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
    const taxRate = state?.taxRate ?? state?.[12];
    const pool = state?.pool ?? state?.[13];
    const progress = state?.progress ?? state?.[14];
    const lpFeeProfile = state?.lpFeeProfile ?? state?.[15];
    const dexId = state?.dexId ?? state?.[16];

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
      quoteTokenAddress: String(quoteTokenAddress ?? ZERO_ADDRESS),
      nativeToQuoteSwapEnabled: Boolean(nativeToQuoteSwapEnabled),
      extensionID: String(extensionID ?? '0x'),
      taxRate: typeof taxRate === 'bigint' ? taxRate.toString() : String(taxRate ?? '0'),
      pool: String(pool ?? ZERO_ADDRESS),
      progress: typeof progress === 'bigint' ? progress.toString() : String(progress ?? '0'),
      lpFeeProfile: Number(lpFeeProfile ?? 0),
      dexId: Number(dexId ?? 0),
    };
  }
}
