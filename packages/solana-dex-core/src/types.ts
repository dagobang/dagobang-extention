import { VersionedTransaction } from '@solana/web3.js';
import type { Connection, Keypair } from '@solana/web3.js';

export type SolanaTradeSide = 'buy' | 'sell';

export type SolanaExecutionMode = 'auto' | 'aggregator' | 'direct';

export type SolanaTradeSource =
  | 'jupiter'
  | 'pumpfun'
  | 'pumpswap'
  | 'bonk'
  | 'raydium'
  | 'meteora'
  | 'believe'
  | 'bags'
  | 'orca';

export type SolanaSourceCapability = {
  source: SolanaTradeSource;
  mode: Exclude<SolanaExecutionMode, 'auto'>;
  supportsBuy: boolean;
  supportsSell: boolean;
  platforms?: string[];
};

export type SolanaDexTokenInfo = {
  decimals?: number;
  launchpad?: string | null;
  launchpad_platform?: string | null;
  launchpad_status?: number | null;
  pool_pair?: string | null;
  biggest_pool_address?: string | null;
  dex_type?: string | null;
  tpool_exchange?: string | null;
  tpool_launch_type?: string | null;
  tpool_pool_address?: string | null;
  quote_token_address?: string | null;
};

export type SolanaDexRawInput = {
  priorityFeeNative?: string;
  priorityFeeBnb?: string;
};

export type SolanaDexRuntime = {
  getConnection(): Promise<Connection>;
};

export type SolanaTradeRequest = {
  side: SolanaTradeSide;
  chainId: number;
  ownerAddress: string;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  fromAddress?: string;
  tokenInfo?: SolanaDexTokenInfo;
  rawInput?: SolanaDexRawInput;
  runtime: SolanaDexRuntime;
};

export type SolanaTradePlan = {
  source: SolanaTradeSource;
  mode: Exclude<SolanaExecutionMode, 'auto'>;
  reason: string;
};

export type SolanaBuiltTransaction = {
  source: SolanaTradeSource;
  transaction: VersionedTransaction;
  tokenMinOutWei: string;
  plannerReason?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  quote?: unknown;
};

export type SolanaSubmittedTrade = {
  source: SolanaTradeSource;
  txHash: string;
  tokenMinOutWei: string;
  broadcastVia: string;
  broadcastUrl?: string;
  confirmUrl?: string;
  isBundle?: boolean;
  plannerReason?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
};

export type SolanaSignerContext = {
  signer: Keypair;
  address: string;
};

export interface SolanaTradeAdapter {
  readonly capability: SolanaSourceCapability;
  supportsTrade(input: SolanaTradeRequest): Promise<boolean> | boolean;
  build(input: SolanaTradeRequest): Promise<SolanaBuiltTransaction>;
}
