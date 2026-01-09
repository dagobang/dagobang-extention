import { erc20Abi, pairV2Abi } from '@/constants/contracts/abi/swapAbi';

import { RpcService } from './rpc';

export class TokenService {
  private static poolPairCache = new Map<string, { token0: `0x${string}`; token1: `0x${string}` }>();

  static async getMeta(tokenAddress: string) {
    const client = await RpcService.getClient();
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { symbol, decimals };
  }

  static async getBalance(tokenAddress: string, owner: string) {
    const client = await RpcService.getClient();
    const balance = await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`],
    });
    return balance.toString();
  }

  static async getNativeBalance(owner: string) {
    const client = await RpcService.getClient();
    const balance = await client.getBalance({ address: owner as `0x${string}` });
    return balance.toString();
  }

  static async getPoolPair(pair: string) {
    const key = pair.toLowerCase();
    const cached = this.poolPairCache.get(key);
    if (cached) {
      return cached;
    }

    const client = await RpcService.getClient();
    const [token0, token1] = await Promise.all([
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'token0',
      }) as Promise<`0x${string}`>,
      client.readContract({
        address: pair as `0x${string}`,
        abi: pairV2Abi,
        functionName: 'token1',
      }) as Promise<`0x${string}`>
    ]);
    const result = { token0, token1 };
    this.poolPairCache.set(key, result);
    return result;
  }

}
