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
  launchpad: string;
  launchpad_progress: number;
  launchpad_platform: string;
  launchpad_status: number;
  quote_token: string;
  quote_token_address?: string;
  pool_pair?: string;
  dex_type?: string;
  tokenPrice?: {
    price: string;
    marketCap: string;
    timestamp: number;
  };
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
  pool: string;
  progress: string;
  lpFeeProfile: number;
  dexId: number;
}
