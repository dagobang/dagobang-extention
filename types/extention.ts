import { FlapTokenStateV7, FourmemeTokenInfo, TokenInfo } from "./token";

export type GasPreset = 'slow' | 'standard' | 'fast' | 'turbo';

export type ExecutionMode = 'default' | 'turbo';

export const SLIPPAGE_BPS_OPTIONS = [3000, 4000, 5000, 9000] as const;
export type SlippageBpsOption = (typeof SLIPPAGE_BPS_OPTIONS)[number];

export type GasGweiConfig = {
  slow: string;
  standard: string;
  fast: string;
  turbo: string;
};

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
  buyGasGwei: GasGweiConfig;
  sellGasGwei: GasGweiConfig;
  buyGasPreset: GasPreset;
  sellGasPreset: GasPreset;
};

export type AutoTradeConfig = {
  enabled: boolean;
  buyAmountBnb: string;
  maxMarketCapUsd: string;
  minLiquidityUsd: string;
  minHolders: string;
  maxTokenAgeMinutes: string;
  maxDevHoldPercent: string;
  blockIfDevSell: boolean;
  autoSellEnabled: boolean;
  takeProfitMultiple: string;
  stopLossMultiple: string;
  maxHoldMinutes: string;
};

export type AdvancedAutoSellRuleType = 'take_profit' | 'stop_loss';

export type AdvancedAutoSellRule = {
  id: string;
  type: AdvancedAutoSellRuleType;
  triggerPercent: number;
  sellPercent: number;
};

export type AdvancedAutoSellTrailingStop = {
  enabled: boolean;
  callbackPercent: number;
  activationMode?: 'immediate' | 'after_first_take_profit' | 'after_last_take_profit';
};

export type AdvancedAutoSellConfig = {
  enabled: boolean;
  rules: AdvancedAutoSellRule[];
  trailingStop?: AdvancedAutoSellTrailingStop;
};

export type Settings = {
  chainId: 56;
  chains: Record<number, ChainSettings>;
  autoLockSeconds: number;
  lastSelectedAddress?: `0x${string}`;
  locale: 'zh_CN' | 'zh_TW' | 'en';
  accountAliases?: Record<string, string>;
  toastPosition?: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  seedreamApiKey?: string;
  bloxrouteAuthHeader?: string;
  gmgnQuickBuy1Bnb?: string;
  gmgnQuickBuy2Bnb?: string;
  limitOrderScanIntervalMs?: number;
  autoTrade: AutoTradeConfig;
  advancedAutoSell: AdvancedAutoSellConfig;
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
  expectedTokenInWei?: string;
  poolFee?: number;
  slippageBps?: number;
  gasPreset?: GasPreset;
  deadlineSeconds?: number;
  tokenInfo?: TokenInfo;
};

export type LimitOrderSide = 'buy' | 'sell';

export type LimitOrderType = 'take_profit_sell' | 'stop_loss_sell' | 'trailing_stop_sell' | 'low_buy' | 'high_buy';

export type LimitOrderStatus = 'open' | 'triggered' | 'executed' | 'failed' | 'cancelled';

export type LimitOrder = {
  id: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string | null;
  side: LimitOrderSide;
  orderType?: LimitOrderType;
  triggerPriceUsd: number;
  trailingStopBps?: number;
  trailingPeakPriceUsd?: number;
  buyBnbAmountWei?: string;
  sellPercentBps?: number;
  sellTokenAmountWei?: string;
  createdAtMs: number;
  status: LimitOrderStatus;
  txHash?: `0x${string}`;
  lastError?: string;
  tokenInfo?: TokenInfo;
};

export type LimitOrderCreateInput = {
  chainId: number;
  tokenAddress: `0x${string}`;
  tokenSymbol?: string | null;
  side: LimitOrderSide;
  orderType?: LimitOrderType;
  triggerPriceUsd: number;
  trailingStopBps?: number;
  trailingPeakPriceUsd?: number;
  buyBnbAmountWei?: string;
  sellPercentBps?: number;
  sellTokenAmountWei?: string;
  tokenInfo?: TokenInfo;
};

export type LimitOrderScanStatus = {
  intervalMs: number;
  running: boolean;
  lastScanAtMs: number;
  lastScanOk: boolean;
  lastScanError: string | null;
  totalOrders: number;
  openOrders: number;
  pricesByTokenKey?: Record<string, { priceUsd: number; ts: number }>;
};

export type TxWaitForReceiptError = {
  name?: string;
  message: string;
  shortMessage?: string;
  details?: string;
  meta?: string[];
  cause?: string;
  code?: string | number;
  data?: unknown;
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
  | { type: 'token:getPriceUsd'; chainId: number; tokenAddress: `0x${string}`; tokenInfo?: TokenInfo | null }
  | { type: 'token:getTokenInfo:fourmeme'; chainId: number; tokenAddress: `0x${string}` }
  | { type: 'token:getTokenInfo:flap'; chainId: number; tokenAddress: `0x${string}` }
  | { type: 'token:getTokenInfo:fourmemeHttp'; platform: string; chain: string; address: `0x${string}` }
  | { type: 'token:createFourmeme'; input: { name: string; shortName: string; desc: string; imgUrl: string; webUrl?: string; twitterUrl?: string; telegramUrl?: string; preSale: string; onlyMPC: boolean } }
  | { type: 'ai:generateLogo'; prompt: string; size?: string; apiKey: string }
  | { type: 'tx:buy'; input: TxBuyInput }
  | { type: 'tx:sell'; input: TxSellInput }
  | { type: 'tx:approve'; chainId: number; tokenAddress: `0x${string}`; spender: `0x${string}`; amountWei: string }
  | { type: 'tx:waitForReceipt'; hash: `0x${string}`; chainId: number }
  | { type: 'tx:approveMaxForSellIfNeeded'; chainId: number; tokenAddress: `0x${string}`; tokenInfo: TokenInfo }
  | { type: 'tx:bloxroutePrivate'; chainId: number; signedTx: `0x${string}` }
  | { type: 'autotrade:ws'; payload: any }
  | { type: 'limitOrder:list'; chainId: number; tokenAddress?: `0x${string}` }
  | { type: 'limitOrder:create'; input: LimitOrderCreateInput }
  | { type: 'limitOrder:cancel'; id: string }
  | { type: 'limitOrder:cancelAll'; chainId: number; tokenAddress?: `0x${string}` }
  | { type: 'limitOrder:scanStatus'; chainId: number }
  | { type: 'limitOrder:tick'; chainId: number; tokenAddress: `0x${string}`; priceUsd: number };

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
  : T extends { type: 'token:getPriceUsd' }
  ? { ok: true; priceUsd: number }
  : T extends { type: 'token:getTokenInfo:fourmeme' }
  ? ({ ok: true } & FourmemeTokenInfo)
  : T extends { type: 'token:getTokenInfo:flap' }
  ? ({ ok: true } & FlapTokenStateV7)
  : T extends { type: 'token:getTokenInfo:fourmemeHttp' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'token:createFourmeme' }
  ? { ok: true; data?: any }
  : T extends { type: 'ai:generateLogo' }
  ? { ok: true; imageUrl: string }
  : T extends { type: 'tx:approve' }
  ? { ok: true; txHash: `0x${string}` }
  : T extends { type: 'tx:buy' }
  ? (
      | { ok: true; txHash: `0x${string}`; tokenMinOutWei: string; broadcastVia?: 'bloxroute' | 'rpc'; broadcastUrl?: string }
      | { ok: false; revertReason?: string; error?: TxWaitForReceiptError }
    )
  : T extends { type: 'tx:sell' }
  ? (
      | { ok: true; txHash: `0x${string}`; broadcastVia?: 'bloxroute' | 'rpc'; broadcastUrl?: string }
      | { ok: false; revertReason?: string; error?: TxWaitForReceiptError }
    )
  : T extends { type: 'tx:waitForReceipt' }
  ? {
      ok: boolean;
      txHash: `0x${string}`;
      blockNumber?: number;
      status?: 'success' | 'reverted';
      revertReason?: string;
      error?: TxWaitForReceiptError;
    }
  : T extends { type: 'tx:approveMaxForSellIfNeeded' }
  ? { ok: true; txHash?: `0x${string}` }
  : T extends { type: 'tx:bloxroutePrivate' }
  ? { ok: true; txHash?: `0x${string}` }
  : T extends { type: 'autotrade:ws' }
  ? { ok: true }
  : T extends { type: 'limitOrder:list' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:create' }
  ? { ok: true; order: LimitOrder }
  : T extends { type: 'limitOrder:cancel' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:cancelAll' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:scanStatus' }
  ? ({ ok: true } & LimitOrderScanStatus)
  : T extends { type: 'limitOrder:tick' }
  ? { ok: true; triggered?: string[]; executed?: string[]; failed?: Array<{ id: string; error: string }> }
  : never;
