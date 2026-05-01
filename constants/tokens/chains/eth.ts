import type { Address } from "viem";
import { ChainId } from "../../chains";
import { ERC20Token, WETH9 } from "./constants";

export const ethTokens = {
  weth: WETH9[ChainId.ETH]!,
  eth: new ERC20Token(
    ChainId.ETH,
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    18,
    "ETH",
    "Ether",
    "https://ethereum.org/"
  ),
  usdt: new ERC20Token(
    ChainId.ETH,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    6,
    "USDT",
    "Tether USD",
    "https://tether.to/"
  ),
  usdc: new ERC20Token(
    ChainId.ETH,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    6,
    "USDC",
    "USD Coin",
    "https://www.circle.com/usdc"
  ),
};

export const ethBridgeTokenAddresses = [
  ethTokens.weth.address,
  ethTokens.usdt.address,
  ethTokens.usdc.address,
] as const;

export type EthNativeBridgePoolConfig =
  | { kind: "v2"; poolAddress: Address }
  | { kind: "v3"; poolAddress: Address; fee: number };

export const ethEthBridgePoolConfigByTokenAddress: Record<string, EthNativeBridgePoolConfig> = {
  [ethTokens.usdt.address.toLowerCase()]: {
    kind: "v2",
    poolAddress: "0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852",
  },
  [ethTokens.usdc.address.toLowerCase()]: {
    kind: "v3",
    fee: 500,
    poolAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
  },
};
