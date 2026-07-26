import { ChainId } from '@/constants/chains/chainId';
import type { TradeTurboPrewarmInput } from '@/types/extention';
import { SOLANA_NATIVE_MINT, resolveSolanaTradeSource } from './constants';
import { prewarmSolanaTradePlan } from './planner';
import { SolanaRpcService } from '../rpc';
import { prewarmSolanaProtocolResources, type SolanaProtocolPrewarmSource } from '../../../../packages/solana-dex-core/src/prewarm';

export async function prewarmSolanaTurboTradeContext(input: TradeTurboPrewarmInput): Promise<void> {
  if (input.chainId !== ChainId.SOL) return;
  const tokenAddress = String(input.tokenAddress || '').trim();
  if (!tokenAddress) return;
  const { directSource } = resolveSolanaTradeSource({
    tokenInfo: input.tokenInfo,
    tokenAddress,
    platform: input.platform,
  });
  const runtime = {
    getConnection: () => SolanaRpcService.getConnection(),
    getLatestBlockhash: (commitment: 'processed' | 'confirmed' = 'confirmed') => SolanaRpcService.getLatestBlockhash({
      commitment,
      scope: 'public',
      timeoutMs: 1_500,
    }),
    getAccountInfo: (address: any, commitment: 'processed' | 'confirmed' = 'confirmed', queryClass = 'static') => SolanaRpcService.getAccountInfo(address, {
      commitment,
      scope: 'public',
      timeoutMs: queryClass === 'dynamic' ? 1_800 : 2_500,
    }),
    getMultipleAccountsInfo: (addresses: any, commitment: 'processed' | 'confirmed' = 'confirmed', queryClass = 'static') => SolanaRpcService.getMultipleAccountsInfo(addresses, {
      commitment,
      scope: 'public',
      timeoutMs: queryClass === 'dynamic' ? 2_200 : 3_000,
    }),
  };
  const planRequest = {
    side: 'buy' as const,
    chainId: input.chainId,
    ownerAddress: input.fromAddress || '11111111111111111111111111111111',
    inputMint: SOLANA_NATIVE_MINT,
    outputMint: tokenAddress,
    amount: '1',
    slippageBps: 100,
    tokenInfo: input.tokenInfo,
    rawInput: { executionModeOverride: 'turbo' } as any,
    runtime,
  };
  const tasks: Array<Promise<unknown>> = [
    prewarmSolanaTradePlan(planRequest),
  ];
  if (directSource === 'pumpfun'
    || directSource === 'pumpswap'
    || directSource === 'raydium'
    || directSource === 'bonk'
    || directSource === 'meteora'
    || directSource === 'bags') {
    tasks.unshift(prewarmSolanaProtocolResources({
      source: directSource as SolanaProtocolPrewarmSource,
      tokenAddress,
      ownerAddress: input.fromAddress,
      executionMode: 'turbo',
      tokenInfo: input.tokenInfo,
      runtime,
    }));
  }
  await Promise.all(tasks);
}
