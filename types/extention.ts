import { TokenInfo } from "./token";

export type GasPreset = 'slow' | 'standard' | 'fast' | 'turbo';

export type ExecutionMode = 'default' | 'turbo';

export const SLIPPAGE_BPS_OPTIONS = [3000, 4000, 5000, 9000] as const;
export type SlippageBpsOption = (typeof SLIPPAGE_BPS_OPTIONS)[number];

export type ChainSettings = {
  rpcUrls: string[];
  protectedRpcUrls: string[];
  antiMev: boolean;
  gasPreset: GasPreset;
  executionMode: ExecutionMode;
  slippageBps: number;
  deadlineSeconds: number;
  buyPresets: string[];
  sellPresets: string[];
};

export type Settings = {
  chainId: 56;
  chains: Record<number, ChainSettings>;
  autoLockSeconds: number;
  lastSelectedAddress?: `0x${string}`;
  locale: 'zh_CN' | 'zh_TW' | 'en';
  accountAliases?: Record<string, string>;
  toastPosition?: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
};

export type Account = {
  address: `0x${string}`;
  name: string;
  type: 'mnemonic' | 'imported';
  index?: number;
  privateKey: `0x${string}`;
};

export type WalletPayload = {
  mnemonic?: string;
  accounts: Account[];
  selectedAddress: `0x${string}`;
};

export type BgWalletState = {
  hasEncrypted: boolean;
  isUnlocked: boolean;
  address: `0x${string}` | null;
  accounts: Account[];
  unlockTtlSeconds: number | null;
};

export type BgGetStateResponse = {
  wallet: BgWalletState;
  settings: Settings;
  network: {
    chainId: number;
  };
};

export type WalletCreateInput = {
  password: string;
};

export type WalletImportInput = {
  password: string;
  mnemonic?: string;
  privateKey?: string;
};

export type WalletUnlockInput = {
  password: string;
};

export type TxBuyInput = {
  chainId: number;
  tokenAddress: `0x${string}`;
  bnbAmountWei: string;
  poolFee?: number;
  slippageBps?: number;
  gasPreset?: GasPreset;
  deadlineSeconds?: number;
  tokenInfo?: TokenInfo;
};

export type TxSellInput = {
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenAmountWei: string;
  sellPercentBps?: number;
  // Turbo 秒卖兜底：当买入未确认导致链上 balanceOf(pending)=0 时，用买入的 tokenMinOut 估算卖出 minReturn(BNB)。
  expectedTokenInWei?: string;
  poolFee?: number;
  slippageBps?: number;
  gasPreset?: GasPreset;
  deadlineSeconds?: number;
  tokenInfo?: TokenInfo;
};

export type BgRequest =
  | { type: 'bg:ping' }
  | { type: 'bg:openPopup' }
  | { type: 'bg:getState' }
  | { type: 'settings:set'; settings: Settings }
  | { type: 'settings:setAccountAlias'; address: `0x${string}`; alias: string }
  | { type: 'wallet:create'; input: WalletCreateInput }
  | { type: 'wallet:import'; input: WalletImportInput }
  | { type: 'wallet:unlock'; input: WalletUnlockInput }
  | { type: 'wallet:lock' }
  | { type: 'wallet:wipe' }
  | { type: 'wallet:addAccount'; name?: string; password: string; privateKey?: string }
  | { type: 'wallet:switchAccount'; address: `0x${string}` }
  | { type: 'wallet:updatePassword'; oldPassword: string; newPassword: string }
  | { type: 'wallet:exportPrivateKey'; password: string }
  | { type: 'wallet:exportAccountPrivateKey'; address: `0x${string}`; password: string }
  | { type: 'wallet:exportMnemonic'; password: string }
  | { type: 'chain:getBalance'; address: `0x${string}` }
  | { type: 'token:getMeta'; tokenAddress: `0x${string}` }
  | { type: 'token:getBalance'; tokenAddress: `0x${string}`; address: `0x${string}` }
  | { type: 'token:getPoolPair'; pair: `0x${string}` }
  | { type: 'token:getTokenInfo:fourmeme'; chainId: number; tokenAddress: `0x${string}` }
  | { type: 'token:getTokenInfo:fourmemeHttp'; platform: string; chain: string; address: `0x${string}` }
  | { type: 'token:getTokenInfo:flapHttp'; platform: string; chain: string; address: `0x${string}` }
  | { type: 'tx:buy'; input: TxBuyInput }
  | { type: 'tx:sell'; input: TxSellInput }
  | { type: 'tx:approve'; chainId: number; tokenAddress: `0x${string}`; spender: `0x${string}`; amountWei: string }
  | { type: 'tx:waitForReceipt'; hash: `0x${string}`; chainId: number }
  | { type: 'tx:approveMaxForSellIfNeeded'; chainId: number; tokenAddress: `0x${string}`; tokenInfo: TokenInfo };

export type BgResponse<T extends BgRequest> = T extends { type: 'bg:ping' }
  ? { ok: true; time: number }
  : T extends { type: 'bg:getState' }
  ? BgGetStateResponse
  : T extends { type: 'settings:set' }
  ? { ok: true }
  : T extends { type: 'settings:setAccountAlias' }
  ? { ok: true }
  : T extends { type: 'wallet:create' }
  ? { ok: true; address: `0x${string}`; mnemonic: string }
  : T extends { type: 'wallet:import' }
  ? { ok: true; address: `0x${string}`; mnemonic?: string }
  : T extends { type: 'wallet:unlock' }
  ? { ok: true; address: `0x${string}` }
  : T extends { type: 'wallet:lock' }
  ? { ok: true }
  : T extends { type: 'wallet:wipe' }
  ? { ok: true }
  : T extends { type: 'wallet:updatePassword' }
  ? { ok: true }
  : T extends { type: 'wallet:exportPrivateKey' }
  ? { ok: true; privateKey: `0x${string}` }
  : T extends { type: 'wallet:exportAccountPrivateKey' }
  ? { ok: true; privateKey: `0x${string}` }
  : T extends { type: 'wallet:exportMnemonic' }
  ? { ok: true; mnemonic: string }
  : T extends { type: 'chain:getBalance' }
  ? { ok: true; balanceWei: string }
  : T extends { type: 'token:getMeta' }
  ? { ok: true; symbol: string; decimals: number }
  : T extends { type: 'token:getBalance' }
  ? { ok: true; balanceWei: string }
  : T extends { type: 'token:getPoolPair' }
  ? { ok: true; token0: `0x${string}`; token1: `0x${string}` }
  : T extends { type: 'token:getTokenInfo:fourmemeHttp' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'token:getTokenInfo:flapHttp' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'tx:approve' }
  ? { ok: true; txHash: `0x${string}` }
  : T extends { type: 'tx:buy' }
  ? { ok: true; txHash: `0x${string}`; tokenMinOutWei: string }
  : T extends { type: 'tx:sell' }
  ? { ok: true; txHash: `0x${string}` }
  : T extends { type: 'tx:waitForReceipt' }
  ? { ok: true; blockNumber: number }
  : T extends { type: 'tx:approveMaxForSellIfNeeded' }
  ? { ok: true; txHash?: `0x${string}` }
  : never;
