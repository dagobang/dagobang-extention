import type { ChainAddress } from '@/types/chain';
import { TradeService } from '@/services/trade';
import type { TradeExecutor } from '../types';

export class EvmTradeExecutor implements TradeExecutor {
  async prewarmTurbo(input: {
    chainId: number;
    tokenAddress: ChainAddress;
    tokenInfo?: import('@/types/token').TokenInfo;
    fromAddress?: ChainAddress;
    submitChannel?: import('@/types/extention').SubmitChannel;
  }) {
    await TradeService.prewarmTurbo({
      ...input,
      tokenAddress: input.tokenAddress as `0x${string}`,
      fromAddress: input.fromAddress as `0x${string}` | undefined,
    });
  }

  async refreshNonce(input: {
    chainId: number;
    fromAddress?: `0x${string}`;
    txSide?: 'buy' | 'sell';
    submitChannel?: import('@/types/extention').SubmitChannel;
    error?: any;
  }) {
    return await TradeService.refreshNonce(input);
  }

  async buy(
    input: import('@/types/extention').TxBuyInput,
    runtimeOpts?: {
      forceRefreshHyperState?: boolean;
    }
  ) {
    return await TradeService.buy(input, runtimeOpts);
  }

  async buyWithReceiptAndNonceRecovery(
    input: import('@/types/extention').TxBuyInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: { side: 'buy'; attempt: number; reason: 'nonce' }) => void | Promise<void>;
      onSubmitted?: (ctx: { side: 'buy'; txHash: `0x${string}`; submitElapsedMs: number }) => void | Promise<void>;
    }
  ) {
    return await TradeService.buyWithReceiptAndNonceRecovery(input, opts);
  }

  async sell(
    input: import('@/types/extention').TxSellInput,
    runtimeOpts?: {
      forceRefreshHyperState?: boolean;
      traceId?: string;
      attempt?: number;
      onAllowanceRepairStart?: (ctx: { chainId: number; tokenAddress: string }) => void | Promise<void>;
    }
  ) {
    return await TradeService.sell(input, runtimeOpts);
  }

  async sellWithReceiptAndAutoRecovery(
    input: import('@/types/extention').TxSellInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: { side: 'sell'; attempt: number; nonceLike: boolean; allowanceRepaired: boolean }) => void | Promise<void>;
      onSubmitted?: (ctx: { side: 'sell'; txHash: `0x${string}`; submitElapsedMs: number }) => void | Promise<void>;
    }
  ) {
    return await TradeService.sellWithReceiptAndAutoRecovery(input, opts);
  }

  async approve(
    chainId: number,
    tokenAddress: `0x${string}`,
    spender: `0x${string}`,
    amountWei: string,
    fromAddress?: `0x${string}`,
    submitChannel?: import('@/types/extention').SubmitChannel,
  ) {
    return await TradeService.approve(chainId, tokenAddress, spender, amountWei, fromAddress, submitChannel);
  }

  async wrapNative(chainId: number, amountWei: string, fromAddress?: `0x${string}`) {
    return await TradeService.wrapNative(chainId, amountWei, fromAddress);
  }

  async unwrapWrapped(chainId: number, amountWei: string, fromAddress?: `0x${string}`) {
    return await TradeService.unwrapWrapped(chainId, amountWei, fromAddress);
  }

  async approveMaxForSellIfNeeded(
    chainId: number,
    tokenAddress: string,
    tokenInfo: import('@/types/token').TokenInfo,
    opts?: { extraSpenders?: string[]; fromAddress?: `0x${string}`; submitChannel?: import('@/types/extention').SubmitChannel }
  ) {
    return await TradeService.approveMaxForSellIfNeeded(chainId, tokenAddress, tokenInfo, opts);
  }

  async checkSellAllowanceInsufficient(
    chainId: number,
    tokenAddress: string,
    tokenInfo: import('@/types/token').TokenInfo,
    opts?: { extraSpenders?: string[]; fromAddress?: `0x${string}` }
  ) {
    return await TradeService.checkSellAllowanceInsufficient(chainId, tokenAddress, tokenInfo, opts);
  }
}

export const evmTradeExecutor = new EvmTradeExecutor();
