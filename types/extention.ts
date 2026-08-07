import { FlapTokenStateV7, FourmemeTokenInfo, TokenInfo } from "./token";
import type { ChainAddress, ChainTxId, EvmAddress, ChainAccountKind } from "./chain";

export type GasPreset = 'slow' | 'standard' | 'fast' | 'turbo';
export type PriorityFeePreset = 'none' | 'slow' | 'standard' | 'fast';
export type TradeBaseToken = 'BNB' | 'WBNB' | 'USDT' | 'USDC';
export type SubmitChannel = 'blox' | 'blockrazor' | 'protectRpcs' | 'mixed';
export type SolanaSwqosProviderType =
  | 'jito'
  | 'nextblock'
  | 'blox'
  | 'temporal'
  | 'zeroslot'
  | 'node1'
  | 'flashblock'
  | 'blockrazor'
  | 'astralane';
export type SolanaSwqosStrategy = 'single' | 'concurrent';
export type SolanaSwqosRegion =
  | 'default'
  | 'newyork'
  | 'frankfurt'
  | 'amsterdam'
  | 'slc'
  | 'tokyo'
  | 'london'
  | 'losangeles';
export type SolanaSwqosProviderSettings = {
  type: SolanaSwqosProviderType;
  enabled: boolean;
  authKey?: string;
  endpoint?: string;
  weight?: number;
};
export type SolanaSwqosSettings = {
  enabled: boolean;
  strategy?: SolanaSwqosStrategy;
  timeoutMs?: number;
  region?: SolanaSwqosRegion;
  providers?: SolanaSwqosProviderSettings[];
};
export type SolanaFeeMode = 'pf' | 'tip' | 'pf_and_tip';

export type ExecutionMode = 'default' | 'turbo';
export type GasPriceMode = 'fixed' | 'dynamic';

export const SLIPPAGE_BPS_OPTIONS = [3000, 4000, 5000, 9000] as const;
export type SlippageBpsOption = (typeof SLIPPAGE_BPS_OPTIONS)[number];

export type GasGweiConfig = {
  slow: string;
  standard: string;
  fast: string;
  turbo: string;
};

export type PriorityFeePresetConfig = {
  none: string;
  slow: string;
  standard: string;
  fast: string;
};

export type QuickBuyPresetOverride = {
  gasPreset?: GasPreset;
  priorityFeePreset?: PriorityFeePreset;
};

export type ChainSettings = {
  rpcUrls: string[];
  protectedRpcUrls: string[];
  protectedRpcUrlsBuy?: string[];
  protectedRpcUrlsSell?: string[];
  submitChannel?: SubmitChannel;
  tradeBaseToken?: TradeBaseToken;
  antiMev: boolean;
  gasPreset: GasPreset;
  executionMode: ExecutionMode;
  gasPriceMode?: GasPriceMode;
  slippageBps: number;
  deadlineSeconds: number;
  buyPresets: string[];
  sellPresets: string[];
  buyGasGwei: GasGweiConfig;
  sellGasGwei: GasGweiConfig;
  approveGasGwei: string;
  buyGasPreset: GasPreset;
  sellGasPreset: GasPreset;
  buyPriorityFeePreset?: PriorityFeePreset;
  sellPriorityFeePreset?: PriorityFeePreset;
  buyPriorityFeePresets?: PriorityFeePresetConfig;
  sellPriorityFeePresets?: PriorityFeePresetConfig;
  buyTipPreset?: PriorityFeePreset;
  sellTipPreset?: PriorityFeePreset;
  buyTipPresets?: PriorityFeePresetConfig;
  sellTipPresets?: PriorityFeePresetConfig;
  quickBuyAdvancedEnabled?: boolean;
  quickBuyPresetOverrides?: QuickBuyPresetOverride[];
  bloxrouteBuyEnabled?: boolean;
  bloxrouteSellEnabled?: boolean;
  solanaSwqos?: SolanaSwqosSettings;
};

export type AutoTradeInteractionType = 'tweet' | 'reply' | 'quote' | 'retweet' | 'follow';
export type TokenSnipeTweetType = AutoTradeInteractionType | 'all';
export type TokenSnipeBuyMethod = 'all' | 'dagobang' | 'gmgn';

export type AutoTradeTriggerSound = {
  enabled: boolean;
  preset: TradeSuccessSoundPreset;
};

export type AutoTradeStrategyBase = {
  enabled: boolean;
  autoSellEnabled: boolean;
  buyAmountNative: string;
  buyAmountNativeByChain?: Partial<Record<number, string>>;
  buyNewCaCount: string;
  buyOgCount: string;
  minMarketCapUsd: string;
  maxMarketCapUsd: string;
  minHolders: string;
  maxHolders: string;
  minKol: string;
  maxKol: string;
  minTickerLen?: string;
  maxTickerLen?: string;
  minTokenAgeSeconds: string;
  maxTokenAgeSeconds: string;
  minTweetAgeSeconds?: string;
  maxTweetAgeSeconds?: string;
  minDevHoldPercent: string;
  maxDevHoldPercent: string;
  minDevMaxBuyPercent?: string;
  maxDevMaxBuyPercent?: string;
  minViewerCount?: string;
  maxViewerCount?: string;
  minDevCreatedTokenCount?: string;
  maxDevCreatedTokenCount?: string;
  blockIfDevSell: boolean;
};

export type AutoTradeTwitterSnipeRuntimeStrategy = AutoTradeStrategyBase & {
  platforms?: string[];
  walletAddress?: ChainAddress;
  dryRun?: boolean;
  dryRunBuyDelayMs?: string;
  dryRunSellDelayMs?: string;
  deleteTweetSellPercent?: string;
  deleteTweetPlaySound?: boolean;
  deleteTweetSoundPreset?: TradeSuccessSoundPreset;
  wsConfirmEnabled?: boolean;
  wsConfirmWindowMs?: string;
  wsConfirmMinMcapChangePct?: string;
  wsConfirmMaxMcapChangePct?: string;
  wsConfirmMinHoldersDelta?: string;
  wsConfirmMinBuySellRatio?: string;
  wsConfirmMinNetBuy24hUsd?: string;
  wsConfirmMinVol24hUsd?: string;
  wsConfirmMinVolMcapRatio?: string;
  wsConfirmMinNetBuyMcapRatio?: string;
  wsConfirmMinSmartMoney?: string;
  rapidExitEnabled?: boolean;
  rapidEvalStepSec?: string;
  rapidWatchdogSec?: string;
  rapidStopLossPct?: string;
  rapidTakeProfitTriggerPct?: string;
  rapidTakeProfitStepUpPct?: string;
  rapidTakeProfitBatchPct?: string;
  rapidProtectQuotaPct?: string;
  rapidTailSellPctOfRemaining?: string;
  rapidTakeProfitFloorPct?: string;
  targetUsers: string[];
  interactionTypes: AutoTradeInteractionType[];
};

export type AutoTradeTwitterSnipePreset = {
  id: string;
  name: string;
  strategy: Partial<AutoTradeTwitterSnipeRuntimeStrategy>;
};

export type AutoTradeTwitterSnipeStrategy = AutoTradeTwitterSnipeRuntimeStrategy & {
  presets?: AutoTradeTwitterSnipePreset[];
  activePresetId?: string;
};

export type UnifiedMarketSignalSource = 'new_pool' | 'near_complete' | 'complete' | 'token_update';

export type AutoTradeNewCoinSnipeConfig = Omit<
  AutoTradeTwitterSnipeRuntimeStrategy,
  | 'targetUsers'
  | 'interactionTypes'
  | 'deleteTweetSellPercent'
  | 'deleteTweetPlaySound'
  | 'deleteTweetSoundPreset'
> & {
  playSound?: boolean;
  soundPreset?: TradeSuccessSoundPreset;
  signalSources?: UnifiedMarketSignalSource[];
  platforms?: string[];
  taskModeEnabled?: boolean;
  autoTaskFromWsEnabled?: boolean;
  autoTaskAthMcapUsd?: string;
  autoTaskPlatforms?: string[];
  autoTaskMaxPerSignal?: string;
  autoTaskMinMarketCapUsd?: string;
  autoTaskMaxMarketCapUsd?: string;
  autoTaskMinTokenAgeSeconds?: string;
  autoTaskMaxTokenAgeSeconds?: string;
  autoTaskMinHolders?: string;
  autoTaskMaxHolders?: string;
  autoTaskMinKol?: string;
  autoTaskMaxKol?: string;
  buyGasGwei?: string;
  buyBribeBnb?: string;
  xmodeTasks?: NewCoinXmodeSnipeTask[];
};

export type NewCoinXmodeSnipeTask = {
  id: string;
  enabled?: boolean;
  taskName?: string;
  tokenAddress?: ChainAddress;
  keywords: string[];
  matchMode?: 'any' | 'all';
  maxTokenAgeSeconds?: string;
  buyAmountNative?: string;
  buyGasGwei?: string;
  buyBribeBnb?: string;
  autoSellEnabled?: boolean;
  createdAt: number;
};

export type TokenSnipeTask = {
  id: string;
  chain: number;
  tokenAddress: ChainAddress;
  tokenSymbol?: string;
  tokenName?: string;
  tweetType: TokenSnipeTweetType;
  tweetTypes?: AutoTradeInteractionType[];
  targetUrls: string[];
  keywords?: string[];
  autoBuy: boolean;
  buyAmountNative: string;
  buyGasGwei?: string;
  buyBribeBnb?: string;
  buyMethod?: TokenSnipeBuyMethod;
  autoSell: boolean;
  createdAt: number;
};

export type AutoTradeTokenSnipeConfig = {
  enabled: boolean;
  targetUsers: string[];
  playSound: boolean;
  soundPreset: TradeSuccessSoundPreset;
  tasks: TokenSnipeTask[];
};

export type AutoTradeConfig = {
  takeProfitMultiple: string;
  stopLossMultiple: string;
  maxHoldMinutes: string;
  wsMonitorEnabled: boolean;
  signalForwardWindowMs?: number;
  triggerSound: AutoTradeTriggerSound;
  twitterSnipe: AutoTradeTwitterSnipeStrategy;
  newCoinSnipe: AutoTradeNewCoinSnipeConfig;
  tokenSnipe: AutoTradeTokenSnipeConfig;
};

export type TokenSnipeTaskState = 'idle' | 'matched' | 'buying' | 'bought' | 'sell_order_created' | 'sold' | 'failed';

export type TokenSnipeTaskRuntimeStatus = {
  taskId: string;
  state: TokenSnipeTaskState;
  matchedAt?: number;
  boughtAt?: number;
  soldAt?: number;
  signalId?: string;
  tweetId?: string;
  quotedTweetId?: string;
  buyTxHash?: string;
  sellTxHash?: string;
  sellOrderIds?: string[];
  message?: string;
  updatedAt: number;
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
  mode?: 'trailing_stop' | 'rolling_take_profit';
  callbackPercent: number;
  sellPercent?: number;
  rollingSellPercent?: number;
  rollingStepPercent?: number;
  rollingFloorPercent?: number;
  activationMode?: 'immediate' | 'after_first_take_profit' | 'after_last_take_profit';
};

export type AdvancedAutoSellConfig = {
  enabled: boolean;
  rules: AdvancedAutoSellRule[];
  trailingStop?: AdvancedAutoSellTrailingStop;
};

export const TRADE_SUCCESS_SOUND_PRESETS = [
  'Bell',
  'Boom',
  'Cheer',
  'Coins',
  'Pop',
  'Handgun',
  'Kaching',
  'Nice',
  'Shotgun',
  'Sonumi',
  'Yes',
  'Alipay',
  'Wechat',
  'Mario-Collect',
  'Mario-Gameover',
  'Mario-Life',
  'Mario-Mushroom',
  'Mario-Start',
  'Animal-Cat',
  'Animal-Cow',
  'Animal-Dog',
  'Animal-Elephant',
  'Animal-Horse',
  'Animal-Frog',
  'Animal-Rooster',
  'Animal-Wolf',
] as const;

export type TradeSuccessSoundPreset = (typeof TRADE_SUCCESS_SOUND_PRESETS)[number];

export type SwitchSettings = {
  showToolbar: boolean;
  limitTradePanelOnlyOnTokenPage?: boolean;
  quickBuyEnabled?: boolean;
  quickCookingEnabled?: boolean;
  newPoolMonitorEnabled?: boolean;
  newCoinSniperEnabled?: boolean;
  consoleLogsEnabled?: boolean;
};

export type TelegramSettings = {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  userId?: string;
  enforceUserId?: boolean;
  chainId?: number;
  pollIntervalMs?: number;
  notifyTradeSubmitted?: boolean;
  notifyTradeSuccess?: boolean;
  notifyTradeRetrying?: boolean;
  notifyLimitOrder?: boolean;
  notifyQuickTrade?: boolean;
};

export type TelegramPollStatus = {
  enabled: boolean;
  running: boolean;
  lastPollAtMs: number | null;
  lastError?: string | null;
};

export type Settings = {
  chainId: number;
  chains: Record<number, ChainSettings>;
  autoLockSeconds: number;
  lastSelectedAddress?: `0x${string}`;
  selectedTradeWallets?: ChainAddress[];
  multiWalletBuyMode?: 'uniform' | 'child_custom';
  childWalletBuyAmountsBnb?: Record<string, string>;
  childWalletBuyPresetAmountsNative?: Record<string, string[]>;
  locale: 'zh_CN' | 'zh_TW' | 'en';
  accountAliases?: Record<string, string>;
  toastPosition?: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  seedreamApiKey?: string;
  bloxrouteAuthHeader?: string;
  quickBuy1Bnb?: string;
  quickBuy2Bnb?: string;
  // Legacy global field. New logic should prefer chains[chainId].tradeBaseToken.
  tradeBaseToken?: TradeBaseToken;
  keyboardShortcutsEnabled?: boolean;
  tradeSuccessSoundEnabled?: boolean;
  tradeSuccessSoundPresetBuy?: TradeSuccessSoundPreset;
  tradeSuccessSoundPresetSell?: TradeSuccessSoundPreset;
  tradeSuccessSoundVolume?: number;
  limitOrderScanIntervalMs?: number;
  tokenBalancePollIntervalMs?: number;
  ui?: SwitchSettings;
  telegram?: TelegramSettings;
  autoTrade: AutoTradeConfig;
  advancedAutoSell: AdvancedAutoSellConfig;
};

export type Account = {
  address: EvmAddress;
  name: string;
  type: 'mnemonic' | 'imported';
  index?: number;
  privateKey: EvmAddress;
};

export type WalletPayload = {
  mnemonic?: string;
  accounts: Account[];
  selectedAddress: EvmAddress;
};

export type MultiChainWalletGroup = {
  kind: ChainAccountKind;
  mnemonic?: string;
  accounts: UniversalAccount[];
  selectedAddress?: ChainAddress;
};

export type MultiChainWalletPayload = {
  version: 2;
  wallets: Partial<Record<ChainAccountKind, MultiChainWalletGroup>>;
  activeChainId?: number;
};

export type BgWalletState = {
  hasEncrypted: boolean;
  isUnlocked: boolean;
  address: EvmAddress | null;
  accounts: Array<{ address: EvmAddress; name: string; type: 'mnemonic' | 'imported' }>;
  unlockTtlSeconds: number | null;
};

export type UniversalBgWalletState = {
  hasEncrypted: boolean;
  isUnlocked: boolean;
  chainId?: number;
  address: ChainAddress | null;
  accounts: UniversalAccount[];
  unlockTtlSeconds: number | null;
};

export type UniversalAccount = {
  chainId: number;
  address: ChainAddress;
  name: string;
  type: 'mnemonic' | 'imported';
  index?: number;
  privateKey?: string;
};

export type UniversalTxRef = {
  chainId: number;
  txid: ChainTxId;
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
  chainId?: number;
};

export type WalletImportInput = {
  password: string;
  mnemonic?: string;
  privateKey?: string;
  chainId?: number;
};

export type WalletUnlockInput = {
  password: string;
  chainId?: number;
};

export type TxBuyInput = {
  chainId: number;
  tokenAddress: ChainAddress;
  nativeAmountWei?: string;
  bnbAmountWei?: string;
  baseTokenAddress?: ChainAddress;
  fromAddress?: ChainAddress;
  executionModeOverride?: 'default' | 'turbo';
  poolFee?: number;
  slippageBps?: number;
  gasPreset?: GasPreset;
  gasPriceGwei?: string;
  priorityFeeNative?: string;
  priorityFeeBnb?: string;
  solanaFeeMode?: SolanaFeeMode;
  solanaTipNative?: string;
  solanaTipProviderType?: SolanaSwqosProviderType;
  solanaTipRecipient?: string;
  submitChannel?: SubmitChannel;
  deadlineSeconds?: number;
  openFourOptions?: string;
  openFourProof?: `0x${string}`;
  tokenInfo?: TokenInfo;
};

export type TxSellInput = {
  chainId: number;
  tokenAddress: ChainAddress;
  tokenAmountWei: string;
  baseTokenAddress?: ChainAddress;
  fromAddress?: ChainAddress;
  executionModeOverride?: 'default' | 'turbo';
  sellPercentBps?: number;
  expectedTokenInWei?: string;
  poolFee?: number;
  slippageBps?: number;
  gasPreset?: GasPreset;
  priorityFeeNative?: string;
  priorityFeeBnb?: string;
  solanaFeeMode?: SolanaFeeMode;
  solanaTipNative?: string;
  solanaTipProviderType?: SolanaSwqosProviderType;
  solanaTipRecipient?: string;
  submitChannel?: SubmitChannel;
  deadlineSeconds?: number;
  openFourOptions?: string;
  openFourProof?: `0x${string}`;
  tokenInfo?: TokenInfo;
};

export type CookingAutoBuyWalletInput = {
  address: `0x${string}`;
  amountBnb: string;
};

export type LimitOrderSide = 'buy' | 'sell';

export type LimitOrderType = 'take_profit_sell' | 'stop_loss_sell' | 'trailing_stop_sell' | 'low_buy' | 'high_buy';

export type LimitOrderStatus = 'open' | 'triggered' | 'executed' | 'failed' | 'cancelled';

export type LimitOrder = {
  id: string;
  chainId: number;
  tokenAddress: ChainAddress;
  baseTokenAddress?: ChainAddress;
  fromAddress?: ChainAddress;
  tokenSymbol?: string | null;
  side: LimitOrderSide;
  orderType?: LimitOrderType;
  triggerPriceUsd: number;
  targetChangePercent?: number;
  trailingStopBps?: number;
  trailingPeakPriceUsd?: number;
  rollingStepPercent?: number;
  rollingFloorPercent?: number;
  rollingEntryPriceUsd?: number;
  rollingIsFloor?: boolean;
  buyNativeAmountWei?: string;
  buyBnbAmountWei?: string;
  sellPercentBps?: number;
  sellTokenAmountWei?: string;
  createdAtMs: number;
  status: LimitOrderStatus;
  txHash?: ChainTxId;
  lastError?: string;
  retryCount?: number;
  retryAtMs?: number;
  tokenInfo?: TokenInfo;
};

export type LimitOrderCreateInput = {
  chainId: number;
  tokenAddress: ChainAddress;
  baseTokenAddress?: ChainAddress;
  fromAddress?: ChainAddress;
  tokenSymbol?: string | null;
  side: LimitOrderSide;
  orderType?: LimitOrderType;
  triggerPriceUsd: number;
  targetChangePercent?: number;
  trailingStopBps?: number;
  trailingPeakPriceUsd?: number;
  rollingStepPercent?: number;
  rollingFloorPercent?: number;
  rollingEntryPriceUsd?: number;
  rollingIsFloor?: boolean;
  buyNativeAmountWei?: string;
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

export type TxTimingMetrics = {
  submitElapsedMs?: number;
  receiptElapsedMs?: number;
  totalElapsedMs?: number;
};

export type UnifiedSignalToken = {
  tokenAddress: string;
  chain?: string;
  launchpadPlatform?: string;
  tokenSymbol?: string;
  tokenName?: string;
  tokenLogo?: string;
  marketCapUsd?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  devAddress?: string;
  devHoldPercent?: number;
  devMaxBuyPercent?: number;
  viewerCount?: number;
  devCreatedTokenCount?: number;
  devHasSold?: boolean;
  top10HoldRatio?: number;
  devTokenStatus?: string;
  createdAtMs?: number;
  firstSeenAtMs: number;
  updatedAtMs: number;
};

export type UnifiedTwitterSignal = {
  id: string;
  site: 'gmgn' | 'axiom';
  channel: string;
  tweetType: 'tweet' | 'reply' | 'quote' | 'repost' | 'follow' | 'unfollow' | 'delete_post';
  sourceTweetType?: 'tweet' | 'reply' | 'quote' | 'repost' | 'follow' | 'unfollow';
  eventId?: string;
  tweetId?: string;
  userScreen?: string;
  userName?: string;
  userAvatar?: string;
  userFollowers?: number;
  text?: string;
  translatedText?: string;
  translationLang?: string;
  media?: Array<{ type: string; url: string }>;
  quotedTweetId?: string;
  quotedUserScreen?: string;
  quotedUserName?: string;
  quotedUserAvatar?: string;
  quotedText?: string;
  quotedMedia?: Array<{ type: string; url: string }>;
  followedUserScreen?: string;
  followedUserName?: string;
  followedUserAvatar?: string;
  followedUserBio?: string;
  followedUserFollowers?: number;

  tokens?: UnifiedSignalToken[];
  receivedAtMs: number;
  ts: number;
};

export type UnifiedMarketSignal = {
  id: string;
  site: 'gmgn' | 'axiom';
  channel: string;
  source: UnifiedMarketSignalSource;
  chain?: string;
  tokens: UnifiedSignalToken[];
  receivedAtMs: number;
  ts: number;
};

export type NewPoolMonitorUiDetail = {
  source: UnifiedMarketSignalSource;
  channel: string;
  tokenData: any;
  receivedAtMs: number;
};

export type GmgnTokenSnapshot = {
  tokenAddress: string;
  source?: UnifiedMarketSignalSource;
  channel?: string;
  chain?: string;
  launchpadPlatform?: string;
  totalSupply?: number;
  tokenSymbol?: string;
  tokenName?: string;
  tokenLogo?: string;
  marketCapUsd?: number;
  priceUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  devAddress?: string;
  devHoldPercent?: number;
  devMaxBuyPercent?: number;
  viewerCount?: number;
  devCreatedTokenCount?: number;
  devHasSold?: boolean;
  top10HoldRatio?: number;
  devTokenStatus?: string;
  createdAtMs?: number;
  receivedAtMs: number;
};

export type XSniperEvalPoint = {
  atMs: number;
  marketCapUsd?: number;
  holders?: number;
  pnlMcapPct?: number;
};

export type XSniperBuyRecord = {
  id: string;
  side?: 'buy' | 'sell';
  tsMs: number;
  buySubmittedAtMs?: number;
  tweetAtMs?: number;
  tweetUrl?: string;
  chainId: number;
  tokenAddress: string;
  walletAddress?: ChainAddress;
  tokenSymbol?: string;
  tokenName?: string;
  buyAmountNative?: number;
  sellPercent?: number;
  sellPercentOfOriginal?: number;
  sellPercentOfCurrent?: number;
  sellTokenAmountWei?: string;
  txHash?: string;
  entryPriceUsd?: number;
  dryRun?: boolean;
  marketCapUsd?: number;
  athMarketCapUsd?: number;
  liquidityUsd?: number;
  holders?: number;
  kol?: number;
  vol24hUsd?: number;
  netBuy24hUsd?: number;
  buyTx24h?: number;
  sellTx24h?: number;
  smartMoney?: number;
  createdAtMs?: number;
  devAddress?: string;
  devHoldPercent?: number;
  devMaxBuyPercent?: number;
  viewerCount?: number;
  devCreatedTokenCount?: number;
  devHasSold?: boolean;
  confirmWindowMs?: number;
  confirmMcapChangePct?: number;
  confirmHoldersDelta?: number;
  confirmBuySellRatio?: number;
  eval3s?: XSniperEvalPoint;
  eval5s?: XSniperEvalPoint;
  eval8s?: XSniperEvalPoint;
  eval10s?: XSniperEvalPoint;
  eval15s?: XSniperEvalPoint;
  eval20s?: XSniperEvalPoint;
  eval25s?: XSniperEvalPoint;
  eval30s?: XSniperEvalPoint;
  eval60s?: XSniperEvalPoint;
  userScreen?: string;
  userName?: string;
  tweetType?: string;
  channel?: string;
  signalId?: string;
  signalEventId?: string;
  signalTweetId?: string;
  launchpadPlatform?: string;
  strategyMode?: 'auto_filter' | 'xmode_task';
  taskId?: string;
  taskName?: string;
  matchKeywords?: string[];
  matchText?: string;
  triggerSource?: UnifiedMarketSignalSource;
  reason?: string;
};

export type TradeTurboPrewarmInput = {
  chainId: number;
  tokenAddress: ChainAddress;
  tokenInfo?: TokenInfo;
  fromAddress?: ChainAddress;
  submitChannel?: SubmitChannel;
  platform?: string;
};

export type BgRequest =
  | { type: 'bg:ping' }
  | { type: 'bg:openPopup' }
  | { type: 'bg:getState'; chainId?: number }
  | { type: 'bloxroute:probe'; authHeader?: string }
  | { type: 'solanaSwqos:probe'; providerType: SolanaSwqosProviderType; authKey?: string; endpoint?: string; region?: SolanaSwqosRegion; timeoutMs?: number }
  | { type: 'bloxroute:openCertPage' }
  | { type: 'settings:set'; settings: Settings }
  | { type: 'settings:setAccountAlias'; address: ChainAddress; alias: string }
  | { type: 'wallet:create'; input: WalletCreateInput }
  | { type: 'wallet:import'; input: WalletImportInput }
  | { type: 'wallet:unlock'; input: WalletUnlockInput }
  | { type: 'wallet:lock'; chainId?: number }
  | { type: 'wallet:wipe'; chainId?: number }
  | { type: 'wallet:addAccount'; name?: string; password: string; privateKey?: string; chainId?: number }
  | { type: 'wallet:removeAccount'; address: ChainAddress; password: string; chainId?: number }
  | { type: 'wallet:switchAccount'; address: ChainAddress; chainId?: number }
  | { type: 'wallet:updatePassword'; oldPassword: string; newPassword: string; chainId?: number }
  | { type: 'wallet:exportPrivateKey'; password: string; chainId?: number }
  | { type: 'wallet:exportAccountPrivateKey'; address: ChainAddress; password: string; chainId?: number }
  | { type: 'wallet:exportMnemonic'; password: string; chainId?: number }
  | { type: 'wallet:getEip7702Status'; address: `0x${string}`; chainId: number }
  | { type: 'wallet:revokeEip7702'; address: `0x${string}`; chainId: number }
  | { type: 'chain:getBalance'; address: ChainAddress; chainId: number }
  | { type: 'token:getMeta'; tokenAddress: ChainAddress; chainId: number }
  | { type: 'token:getBalance'; tokenAddress: ChainAddress; address: ChainAddress; chainId: number }
  | { type: 'token:getAllowance'; tokenAddress: `0x${string}`; owner: `0x${string}`; spender: `0x${string}`; chainId: number }
  | { type: 'token:getPoolPair'; pair: `0x${string}`; chainId: number }
  | { type: 'token:getPriceUsd'; chainId: number; tokenAddress: ChainAddress; tokenInfo?: TokenInfo | null }
  | { type: 'token:getTokenInfo:fourmeme'; chainId: number; tokenAddress: `0x${string}` }
  | { type: 'token:getTokenInfo:flap'; chainId: number; tokenAddress: `0x${string}` }
  | { type: 'token:getTokenInfo:altfun'; chainId: number; tokenAddress: `0x${string}` }
  | { type: 'token:getTokenInfo:fourmemeHttp'; platform: string; chain: string; address: ChainAddress }
  | { type: 'token:getTokenInfo:flapHttp'; platform: string; chain: string; address: ChainAddress }
  | {
    type: 'token:createFourmeme';
    input: {
      name: string;
      shortName: string;
      desc: string;
      imgUrl: string;
      imgFallbackUrls?: string[];
      launchTime?: number;
      label?: 'Meme' | 'AI' | 'Defi' | 'Games' | 'Infra' | 'De-Sci' | 'Social' | 'Depin' | 'Charity' | 'Others';
      lpTradingFee?: number;
      webUrl?: string;
      twitterUrl?: string;
      telegramUrl?: string;
      preSale: string;
      onlyMPC: boolean;
      feePlan?: boolean;
      tokenTaxInfo?: {
        burnRate: number;
        divideRate: number;
        feeRate: 1 | 3 | 5 | 10;
        liquidityRate: number;
        minSharing: number;
        recipientAddress: string;
        recipientRate: number;
      };
      fromAddress?: ChainAddress;
      autoBuy?: {
        bundleEnabled?: boolean;
        sniperEnabled?: boolean;
        wallets?: CookingAutoBuyWalletInput[];
        sniperMaxAttempts?: number;
        sniperRetryMs?: number;
      };
    };
  }
  | { type: 'ai:generateLogo'; prompt: string; size?: string; apiKey: string }
  | { type: 'google:imageSearch'; query: string; page?: number }
  | { type: 'rpc:prewarm'; input?: { urls?: string[]; force?: boolean; timeoutMs?: number } }
  | { type: 'rpc:measureLatencies'; chainId: number; urls: string[] }
  | { type: 'thirdParty:getTokenInfo'; platform: string; chain: string; address: string }
  | { type: 'rpc:readProfiles'; chainId: number; urls?: string[] }
  | { type: 'rpc:capacityProbe'; chainId: number; mode?: 'request' | 'force' }
  | { type: 'rpc:resetProfiles'; chainId: number; urls?: string[] }
  | { type: 'trade:prewarmTurbo'; input: TradeTurboPrewarmInput }
  | { type: 'trade:refreshNonce'; input: { chainId: number; fromAddress?: ChainAddress } }
  | { type: 'tx:buy'; input: TxBuyInput }
  | { type: 'tx:buyWithReceiptAuto'; input: TxBuyInput }
  | { type: 'tx:sell'; input: TxSellInput }
  | { type: 'tx:sellWithReceiptAuto'; input: TxSellInput }
  | { type: 'tx:approve'; chainId: number; tokenAddress: `0x${string}`; spender: `0x${string}`; amountWei: string; fromAddress?: `0x${string}`; submitChannel?: SubmitChannel }
  | { type: 'tx:wrapNative'; chainId: number; amountWei: string; fromAddress?: `0x${string}` }
  | { type: 'tx:unwrapWrapped'; chainId: number; amountWei: string; fromAddress?: `0x${string}` }
  | {
    type: 'tx:transferNative';
    chainId: number;
    fromAddress: ChainAddress;
    toAddress: ChainAddress;
    amountBnb?: string;
    useMax?: boolean;
    password: string;
  }
  | {
    type: 'tx:transferToken';
    chainId: number;
    tokenAddress: ChainAddress;
    fromAddress: ChainAddress;
    toAddress: ChainAddress;
    amount?: string;
    useMax?: boolean;
    password: string;
  }
  | { type: 'tx:waitForReceipt'; hash: ChainTxId; chainId: number }
  | { type: 'tx:approveMaxForSellIfNeeded'; chainId: number; tokenAddress: ChainAddress; tokenInfo: TokenInfo; fromAddress?: ChainAddress; submitChannel?: SubmitChannel }
  | { type: 'tx:checkSellAllowanceInsufficient'; chainId: number; tokenAddress: ChainAddress; tokenInfo: TokenInfo; fromAddress?: ChainAddress }
  | { type: 'tx:bloxroutePrivate'; chainId: number; signedTx: `0x${string}` }
  | { type: 'telegram:test' }
  | { type: 'telegram:getStatus' }
  | { type: 'telegram:quickBuy'; tokenAddress: ChainAddress; amountBnb: string }
  | { type: 'telegram:quickSell'; tokenAddress: ChainAddress; sellPercent: number }
  | {
    type: 'xsniper:manualPositionClosed';
    input: {
      chainId: number;
      tokenAddress: ChainAddress;
      sellPercent?: number;
      txHash?: ChainTxId;
    };
  }
  | {
    type: 'xsniper:manualPositionSold';
    input: {
      chainId: number;
      tokenAddress: ChainAddress;
      sellPercent: number;
      txHash?: ChainTxId;
    };
  }
  | { type: 'xsniper:clearRuntimeState' }
  | {
    type: 'newCoinSniper:manualPositionClosed';
    input: {
      chainId: number;
      tokenAddress: ChainAddress;
      sellPercent?: number;
      txHash?: ChainTxId;
    };
  }
  | {
    type: 'newCoinSniper:manualPositionSold';
    input: {
      chainId: number;
      tokenAddress: ChainAddress;
      sellPercent: number;
      txHash?: ChainTxId;
    };
  }
  | { type: 'newCoinSniper:clearRuntimeState' }
  | { type: 'twitter:signal'; payload: UnifiedTwitterSignal }
  | { type: 'market:signal'; payload: UnifiedMarketSignal }
  | { type: 'gmgn:tokenSnapshot:getAll' }
  | { type: 'gmgn:tokenSnapshot:upsertBatch'; payload: { items: GmgnTokenSnapshot[] } }
  | { type: 'newpool:getSnapshot' }
  | { type: 'newpool:upsertBatch'; payload: { items: NewPoolMonitorUiDetail[] } }
  | { type: 'newpool:clearCache' }
  | { type: 'limitOrder:list'; chainId: number; tokenAddress?: ChainAddress }
  | { type: 'limitOrder:create'; input: LimitOrderCreateInput }
  | { type: 'limitOrder:cancel'; id: string }
  | { type: 'limitOrder:cancelAll'; chainId: number; tokenAddress?: ChainAddress; fromAddress?: ChainAddress }
  | { type: 'limitOrder:clearExecuted'; chainId: number; tokenAddress?: ChainAddress }
  | { type: 'limitOrder:scanStatus'; chainId: number }
  | { type: 'limitOrder:trackPrice'; chainId: number; tokenAddress: ChainAddress; tokenInfo?: TokenInfo | null; active: boolean }
  | { type: 'limitOrder:tick'; chainId: number; tokenAddress: ChainAddress; priceUsd: number };

export type BgResponse<T extends BgRequest> = T extends { type: 'bg:ping' }
  ? { ok: true; time: number }
  : T extends { type: 'bg:getState' }
  ? BgGetStateResponse
  : T extends { type: 'bloxroute:probe' }
  ? { ok: true; status: 'reachable' | 'failed'; httpStatus?: number; message?: string; hasAuthHeader: boolean }
  : T extends { type: 'solanaSwqos:probe' }
  ? {
      ok: true;
      status: 'reachable' | 'failed';
      category: 'ok' | 'auth_required' | 'auth_failed' | 'bad_endpoint' | 'rate_limited' | 'payload_rejected' | 'server_error' | 'timeout' | 'network_error';
      providerType: SolanaSwqosProviderType;
      endpoint: string;
      submitUrl: string;
      httpStatus?: number;
      message?: string;
      hasAuthKey: boolean;
    }
  : T extends { type: 'bloxroute:openCertPage' }
  ? { ok: true }
  : T extends { type: 'settings:set' }
  ? { ok: true }
  : T extends { type: 'settings:setAccountAlias' }
  ? { ok: true }
  : T extends { type: 'wallet:create' }
  ? { ok: true; address: `0x${string}`; mnemonic?: string }
  : T extends { type: 'wallet:import' }
  ? { ok: true; address: `0x${string}`; mnemonic?: string }
  : T extends { type: 'wallet:unlock' }
  ? { ok: true; address: `0x${string}` }
  : T extends { type: 'wallet:lock' }
  ? { ok: true }
  : T extends { type: 'wallet:wipe' }
  ? { ok: true }
  : T extends { type: 'wallet:addAccount' }
  ? { ok: true; address: `0x${string}` }
  : T extends { type: 'wallet:removeAccount' }
  ? { ok: true; removedAddress: ChainAddress; nextSelectedAddress: ChainAddress }
  : T extends { type: 'wallet:updatePassword' }
  ? { ok: true }
  : T extends { type: 'wallet:exportPrivateKey' }
  ? { ok: true; privateKey: `0x${string}` }
  : T extends { type: 'wallet:exportAccountPrivateKey' }
  ? { ok: true; privateKey: `0x${string}` }
  : T extends { type: 'wallet:exportMnemonic' }
  ? { ok: true; mnemonic: string }
  : T extends { type: 'wallet:getEip7702Status' }
  ? { ok: true; delegated: boolean; delegateAddress?: `0x${string}`; code: `0x${string}` }
  : T extends { type: 'wallet:revokeEip7702' }
  ? { ok: true; txHash: `0x${string}`; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean }
  : T extends { type: 'chain:getBalance' }
  ? { ok: true; balanceWei: string }
  : T extends { type: 'token:getMeta' }
  ? { ok: true; symbol: string; decimals: number }
  : T extends { type: 'token:getBalance' }
  ? { ok: true; balanceWei: string }
  : T extends { type: 'token:getAllowance' }
  ? { ok: true; allowanceWei: string }
  : T extends { type: 'token:getPoolPair' }
  ? { ok: true; token0: `0x${string}`; token1: `0x${string}` }
  : T extends { type: 'token:getPriceUsd' }
  ? { ok: true; priceUsd: number }
  : T extends { type: 'token:getTokenInfo:fourmeme' }
  ? ({ ok: true } & FourmemeTokenInfo)
  : T extends { type: 'token:getTokenInfo:flap' }
  ? ({ ok: true } & FlapTokenStateV7)
  : T extends { type: 'token:getTokenInfo:altfun' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'token:getTokenInfo:fourmemeHttp' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'token:getTokenInfo:flapHttp' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'token:createFourmeme' }
  ? {
    ok: true;
    data?: any;
    autoBuy?: {
      bundleSuccess: number;
      bundleFailed: number;
      sniperSuccess: number;
      sniperFailed: number;
    };
  }
  : T extends { type: 'ai:generateLogo' }
  ? { ok: true; imageUrl: string }
  : T extends { type: 'google:imageSearch' }
  ? {
    ok: true;
    images: Array<{ url: string; thumbnail?: string; title?: string; source?: string }>;
  }
  : T extends { type: 'rpc:prewarm' }
  ? { ok: true }
  : T extends { type: 'rpc:measureLatencies' }
  ? {
    ok: true;
    results: Array<{
      url: string;
      latencyMs: number | null;
      ok: boolean;
      reason?: 'timeout' | 'rate_limit' | 'forbidden' | 'unauthorized' | 'rpc_error' | 'network' | 'unknown';
      error?: string;
    }>;
  }
  : T extends { type: 'thirdParty:getTokenInfo' }
  ? { ok: true; tokenInfo: TokenInfo | null }
  : T extends { type: 'rpc:readProfiles' }
  ? {
    ok: true;
    profiles: Array<{
      url: string;
      ewmaLatencyMs: number;
      learnedNodeConcurrency: number;
      inFlight: number;
      cooldownUntil: number;
      cooldownRemainingMs: number;
      consecutive429: number;
      total429Count: number;
      last429At: number;
      businessSuccessCount: number;
      businessFailCount: number;
      probeSuccessCount: number;
      probeFailCount: number;
      lastProbeAt: number;
      lastCapacityProbeAt: number;
    }>;
    probeRunning: boolean;
    capacityProbeRequested: boolean;
    dynamicGlobalLimit: number;
    globalInFlight: number;
  }
  : T extends { type: 'rpc:capacityProbe' }
  ? { ok: true; queued: boolean; mode: 'request' | 'force' }
  : T extends { type: 'rpc:resetProfiles' }
  ? { ok: true }
  : T extends { type: 'trade:prewarmTurbo' }
  ? { ok: true }
  : T extends { type: 'trade:refreshNonce' }
  ? { ok: true }
  : T extends { type: 'tx:approve' }
  ? { ok: true; txHash: `0x${string}` }
  : T extends { type: 'tx:wrapNative' }
  ? { ok: true; txHash: `0x${string}`; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean }
  : T extends { type: 'tx:unwrapWrapped' }
  ? { ok: true; txHash: `0x${string}`; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean }
  : T extends { type: 'tx:buy' }
  ? (
    | {
      ok: true;
      txHash: ChainTxId;
      protectionMinOutWei: string;
      quotedOutWei?: string | null;
      broadcastVia?: string;
      broadcastUrl?: string;
      isBundle?: boolean;
    }
    | { ok: false; revertReason?: string; error?: TxWaitForReceiptError }
  )
  : T extends { type: 'tx:buyWithReceiptAuto' }
  ? (
    | ({
      ok: true;
      txHash: ChainTxId;
      protectionMinOutWei: string;
      quotedOutWei?: string | null;
      broadcastVia?: string;
      broadcastUrl?: string;
      confirmUrl?: string;
      isBundle?: boolean;
      backgroundPending?: boolean;
    } & TxTimingMetrics)
    | { ok: false; revertReason?: string; error?: TxWaitForReceiptError }
  )
  : T extends { type: 'tx:sell' }
  ? (
    | { ok: true; txHash: ChainTxId; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean }
    | { ok: false; revertReason?: string; error?: TxWaitForReceiptError }
  )
  : T extends { type: 'tx:sellWithReceiptAuto' }
  ? (
    | ({ ok: true; txHash: ChainTxId; broadcastVia?: string; broadcastUrl?: string; confirmUrl?: string; isBundle?: boolean; backgroundPending?: boolean } & TxTimingMetrics)
    | { ok: false; revertReason?: string; error?: TxWaitForReceiptError }
  )
  : T extends { type: 'tx:transferNative' }
  ? { ok: true; txHash: string; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean }
  : T extends { type: 'tx:transferToken' }
  ? { ok: true; txHash: string; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean }
  : T extends { type: 'tx:waitForReceipt' }
  ? {
    ok: boolean;
    txHash: ChainTxId;
    blockNumber?: number;
    status?: 'success' | 'reverted';
    revertReason?: string;
    error?: TxWaitForReceiptError;
  }
  : T extends { type: 'tx:approveMaxForSellIfNeeded' }
  ? { ok: true; txHash?: ChainTxId }
  : T extends { type: 'tx:checkSellAllowanceInsufficient' }
  ? { ok: true; insufficient: boolean; checked?: Array<{ token: string; spender: string; allowance: string }> }
  : T extends { type: 'tx:bloxroutePrivate' }
  ? { ok: true; txHash?: `0x${string}` }
  : T extends { type: 'telegram:test' }
  ? { ok: true; sent: boolean }
  : T extends { type: 'telegram:getStatus' }
  ? ({ ok: true } & TelegramPollStatus)
  : T extends { type: 'telegram:quickBuy' }
  ? (
    | ({
      ok: true;
      txHash: ChainTxId;
      protectionMinOutWei: string;
      quotedOutWei?: string | null;
      broadcastVia?: string;
      broadcastUrl?: string;
      isBundle?: boolean;
    } & TxTimingMetrics)
    | { ok: false; error?: TxWaitForReceiptError | { message: string } }
  )
  : T extends { type: 'telegram:quickSell' }
  ? (
    | ({ ok: true; txHash: ChainTxId; broadcastVia?: string; broadcastUrl?: string; isBundle?: boolean } & TxTimingMetrics)
    | { ok: false; error?: TxWaitForReceiptError | { message: string } }
  )
  : T extends { type: 'xsniper:manualPositionClosed' }
  ? { ok: true; updated: boolean }
  : T extends { type: 'xsniper:manualPositionSold' }
  ? { ok: true; updated: boolean }
  : T extends { type: 'xsniper:clearRuntimeState' }
  ? { ok: true }
  : T extends { type: 'newCoinSniper:manualPositionClosed' }
  ? { ok: true; updated: boolean }
  : T extends { type: 'newCoinSniper:manualPositionSold' }
  ? { ok: true; updated: boolean }
  : T extends { type: 'newCoinSniper:clearRuntimeState' }
  ? { ok: true }
  : T extends { type: 'twitter:signal' }
  ? { ok: true }
  : T extends { type: 'market:signal' }
  ? { ok: true }
  : T extends { type: 'gmgn:tokenSnapshot:getAll' }
  ? { ok: true; items: GmgnTokenSnapshot[] }
  : T extends { type: 'gmgn:tokenSnapshot:upsertBatch' }
  ? { ok: true }
  : T extends { type: 'newpool:getSnapshot' }
  ? { ok: true; items: NewPoolMonitorUiDetail[] }
  : T extends { type: 'newpool:upsertBatch' }
  ? { ok: true }
  : T extends { type: 'newpool:clearCache' }
  ? { ok: true; clearedNewPoolCount: number; clearedSnapshotCount: number }
  : T extends { type: 'limitOrder:list' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:create' }
  ? { ok: true; order: LimitOrder }
  : T extends { type: 'limitOrder:cancel' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:cancelAll' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:clearExecuted' }
  ? { ok: true; orders: LimitOrder[] }
  : T extends { type: 'limitOrder:scanStatus' }
  ? ({ ok: true } & LimitOrderScanStatus)
  : T extends { type: 'limitOrder:trackPrice' }
  ? { ok: true; priceUsd: number | null }
  : T extends { type: 'limitOrder:tick' }
  ? { ok: true; triggered?: string[]; executed?: string[]; failed?: Array<{ id: string; error: string }> }
  : never;
