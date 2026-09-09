import type { Account } from '@/types/extention';
import type { ChainAddress } from '@/types/chain/address';
import type { TokenInfo } from '@/types/token';
import type { SiteInfo } from '@/utils/sites';
import type { OpenFourLaunchMode } from '@/constants/openfour';

export type CookingLaunchPlatform = 'fourmeme' | 'flap' | 'flap_stocks' | 'openfour';
export type FlapTaxMode = 'quote' | 'self' | 'custom' | 'stocks' | 'disabled';
export type AutoSellRule = { marketCapUsd: string; sellPercent: string };
export type LogoSearchImage = { url: string; thumbnail?: string; title?: string; source?: string };
export type LogoSearchTab = 'token' | 'google';

export type OpenFourTaxAlloc = {
  founder: number;
  burn: number;
  holder: number;
  liquidity: number;
};

export const OPENFOUR_DEFAULT_TAX_ALLOC: OpenFourTaxAlloc = {
  founder: 100,
  burn: 0,
  holder: 0,
  liquidity: 0,
};

export function sumOpenFourTaxAlloc(alloc: OpenFourTaxAlloc) {
  return alloc.founder + alloc.burn + alloc.holder + alloc.liquidity;
}

export type OpenFourCookingTemplate = {
  mode: OpenFourLaunchMode;
  templateId: string;
  name: string;
  tag: string;
  descr: string;
  quoteSymbol: string;
  quoteAddress: string;
  quoteDecimals: number;
  raisedAmount: string;
  saleAmount: string;
  totalSupply: string;
  createFee: string;
};

export type CookingPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  address: string | null;
  walletAccounts: Account[];
  activeWalletAddress: ChainAddress | null;
  siteInfo: SiteInfo | null;
  currentTokenName?: string | null;
  currentTokenSymbol?: string | null;
  currentTokenInfo?: TokenInfo | null;
  tokenInfoLoading?: boolean;
  onSellLaunchedToken?: (input: {
    pct: number;
    tokenAddress: ChainAddress;
    walletAddress: ChainAddress;
    tokenSymbol?: string | null;
    tokenInfo?: TokenInfo | null;
  }) => void | Promise<void>;
};
