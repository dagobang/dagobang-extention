import type { TxBuyInput, TxSellInput, SubmitChannel } from '@/types/extention';
import type { ChainAddress, EvmAddress } from '@/types/chain';
import type { TokenInfo } from '@/types/token';

export type BuySubmittedContext = {
  side: 'buy';
  txHash: string;
  submitElapsedMs: number;
  broadcastVia?: string;
  broadcastUrl?: string;
};

export type BuyRetryContext = {
  side: 'buy';
  attempt: number;
  reason: 'nonce';
};

export type SellSubmittedContext = {
  side: 'sell';
  txHash: string;
  submitElapsedMs: number;
  broadcastVia?: string;
  broadcastUrl?: string;
};

export type SellRetryContext = {
  side: 'sell';
  attempt: number;
  nonceLike: boolean;
  allowanceRepaired: boolean;
};

export type WalletStatus = {
  locked: boolean;
  hasWallet: boolean;
  address: ChainAddress | null;
  accounts: Array<{ address: ChainAddress; name: string; type: 'mnemonic' | 'imported' }>;
  expiresAt: number | null | undefined;
};

export type TradeBuyResult = {
  txHash: string;
  tokenMinOutWei: string;
  broadcastVia?: string;
  broadcastUrl?: string;
  confirmUrl?: string;
  isBundle?: boolean;
};

export type TradeSellResult = {
  txHash: string;
  broadcastVia?: string;
  broadcastUrl?: string;
  confirmUrl?: string;
  isBundle?: boolean;
  allowanceRetried?: boolean;
};

export type TradeTimedBuyResult = TradeBuyResult & {
  submitElapsedMs: number;
  receiptElapsedMs: number;
  totalElapsedMs: number;
};

export type TradeTimedSellResult = TradeSellResult & {
  submitElapsedMs: number;
  receiptElapsedMs: number;
  totalElapsedMs: number;
};

export interface WalletAdapter {
  getStatus(): Promise<WalletStatus>;
  create(password: string): Promise<{ address: ChainAddress; mnemonic?: string }>;
  importWallet(password: string, input: { privateKey?: string; mnemonic?: string }): Promise<{ address: ChainAddress; mnemonic?: string }>;
  unlock(password: string): Promise<{ address: ChainAddress }>;
  lock(): Promise<void>;
  wipe(): Promise<void>;
  addAccount(name: string | undefined, password: string, privateKey?: string): Promise<{ address: ChainAddress }>;
  removeAccount(password: string, address: ChainAddress): Promise<{ removedAddress: ChainAddress; nextSelectedAddress: ChainAddress }>;
  switchAccount(address: ChainAddress): Promise<void>;
  updatePassword(oldPassword: string, newPassword: string): Promise<void>;
  exportPrivateKey(password: string): Promise<string>;
  exportAccountPrivateKey(password: string, address: ChainAddress): Promise<string>;
  exportMnemonic(password: string): Promise<string>;
  getSigner(address?: ChainAddress): Promise<any>;
}

export interface TradeExecutor {
  prewarmTurbo(input: {
    chainId: number;
    tokenAddress: ChainAddress;
    tokenInfo?: TokenInfo;
    fromAddress?: ChainAddress;
    submitChannel?: SubmitChannel;
    platform?: string;
  }): Promise<void>;
  refreshNonce(input: {
    chainId: number;
    fromAddress?: EvmAddress;
    txSide?: 'buy' | 'sell';
    submitChannel?: SubmitChannel;
    error?: any;
  }): Promise<number>;
  buy(
    input: TxBuyInput,
    runtimeOpts?: {
      forceRefreshHyperState?: boolean;
    }
  ): Promise<TradeBuyResult>;
  buyWithReceiptAndNonceRecovery(
    input: TxBuyInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: BuyRetryContext) => void | Promise<void>;
      onSubmitted?: (ctx: BuySubmittedContext) => void | Promise<void>;
    }
  ): Promise<TradeTimedBuyResult>;
  sell(
    input: TxSellInput,
    runtimeOpts?: {
      forceRefreshHyperState?: boolean;
      traceId?: string;
      attempt?: number;
      onAllowanceRepairStart?: (ctx: { chainId: number; tokenAddress: string }) => void | Promise<void>;
    }
  ): Promise<TradeSellResult>;
  sellWithReceiptAndAutoRecovery(
    input: TxSellInput,
    opts?: {
      timeoutMs?: number;
      maxRetry?: number;
      onRetry?: (ctx: SellRetryContext) => void | Promise<void>;
      onSubmitted?: (ctx: SellSubmittedContext) => void | Promise<void>;
    }
  ): Promise<TradeTimedSellResult>;
  approve(
    chainId: number,
    tokenAddress: EvmAddress,
    spender: EvmAddress,
    amountWei: string,
    fromAddress?: EvmAddress,
    submitChannel?: SubmitChannel,
  ): Promise<EvmAddress>;
  wrapNative(chainId: number, amountWei: string, fromAddress?: EvmAddress): Promise<Awaited<ReturnType<typeof import('@/services/trade').TradeService.wrapNative>>>;
  unwrapWrapped(chainId: number, amountWei: string, fromAddress?: EvmAddress): Promise<Awaited<ReturnType<typeof import('@/services/trade').TradeService.unwrapWrapped>>>;
  approveMaxForSellIfNeeded(
    chainId: number,
    tokenAddress: string,
    tokenInfo: TokenInfo,
    opts?: { extraSpenders?: string[]; fromAddress?: EvmAddress; submitChannel?: SubmitChannel }
  ): Promise<EvmAddress | null>;
  checkSellAllowanceInsufficient(
    chainId: number,
    tokenAddress: string,
    tokenInfo: TokenInfo,
    opts?: { extraSpenders?: string[]; fromAddress?: EvmAddress }
  ): Promise<Awaited<ReturnType<typeof import('@/services/trade').TradeService.checkSellAllowanceInsufficient>>>;
}
