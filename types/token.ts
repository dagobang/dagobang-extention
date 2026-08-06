// API Response Interfaces
export interface TokenStat {
  chain: string;
  token: string;
  price: number;
  timestamp: number;
}

export interface TokenInfo {
  chain: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logo: string;
  description?: string;
  website?: string;
  gmgnUrl?: string;
  geckoTerminalUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  discordUrl?: string;
  githubUrl?: string;
  youtubeUrl?: string;
  mediumUrl?: string;
  redditUrl?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  tiktokUrl?: string;
  bitbucketUrl?: string;
  farcasterUrl?: string;
  launchpad: string;
  launchpad_progress: number;
  launchpad_platform: string;
  launchpad_status: number;
  quote_token: string;
  quote_token_address?: string;
  pool_pair?: string;
  biggest_pool_address?: string;
  tpool_exchange?: string;
  tpool_launch_type?: string;
  tpool_pool_address?: string;
  dex_type?: string;
  tokenPrice?: {
    price: string;
    marketCap: string;
    liquidity?: string;
    timestamp: number;
  };
  // Normalized human-readable supply, not raw on-chain units.
  totalSupply?: string;
  aiCreator?: boolean;
  nativeToQuoteSwapEnabled?: boolean;
  tokenVersion?: number;
  extensionID?: string;
  dexId?: number;
  flap_lp_fee_profile?: number;
  flap_pool_model?: 'classic' | 'v4_cl' | 'infinity_cl';
  flap_pool_compat_address?: string;
  flap_cl_pool_id?: string;
  flap_v4_fee?: number;
  flap_v4_tick_spacing?: number;
  flap_v4_hooks?: string;
  flap_dividend_token?: string;
  flap_vault_address?: string;
  flap_vault_factory?: string;
  flap_vault_is_official?: boolean;
  flap_vault_is_ai_consumer?: boolean;
  flap_stocks_vault_version?: 1 | 2 | 3;
  flap_basket_token?: string;
  flap_supported_assets?: string[];
}

export interface FourmemeTokenInfo {
  version: number;
  tokenManager: string;
  quote: string;
  lastPrice: number;
  tradingFeeRate: number;
  minTradingFee: number;
  launchTime: number;
  offers: number;
  maxOffers: number;
  funds: number;
  maxFunds: number;
  liquidityAdded: boolean;
  aiCreator?: boolean;
}

export interface FlapTokenStateV7 {
  symbol: string;
  decimals: number;
  status: number;
  reserve: string;
  circulatingSupply: string;
  price: string;
  tokenVersion: number;
  r: string;
  h: string;
  k: string;
  dexSupplyThresh: string;
  quoteTokenAddress: string;
  nativeToQuoteSwapEnabled: boolean;
  extensionID: string;
  taxRate: string;
  buyTaxRate?: string;
  sellTaxRate?: string;
  pool: string;
  progress: string;
  lpFeeProfile: number;
  dexId: number;
  poolModel?: 'classic' | 'v4_cl' | 'infinity_cl';
  poolCompatAddress?: string;
  clPoolId?: string;
  v4Fee?: number;
  v4TickSpacing?: number;
  v4Hooks?: string;
  dividendToken?: string;
  vaultAddress?: string;
  vaultFactory?: string;
  vaultIsOfficial?: boolean;
  vaultIsAIConsumer?: boolean;
  stocksVaultVersion?: 1 | 2 | 3;
  basketToken?: string;
  supportedAssets?: string[];
}
