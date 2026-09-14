import { ChainId } from "./chainId";

export const chainNames: Record<ChainId | number, string> = {
  [ChainId.ETH]: "eth",
  [ChainId.BNB]: "bsc",
  [ChainId.HYPER]: "hyper",
  [ChainId.SOL]: "sol",
  [ChainId.RH]: "rh",
};

const CHAIN_NAME_ALIASES: Record<string, string> = {
  bnb: "bsc",
  robinhood: "rh",
  solana: "sol",
  hyperevm: "hyper",
};

export const chainNameToChainId = Object.entries(chainNames).reduce(
  (acc, [chainId, chainName]) => {
    acc[chainName.toLocaleLowerCase()] = Number(chainId) as ChainId;
    return acc;
  },
  {} as Record<string, ChainId>
);

export function normalizeChainName(name: string): string {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return "";
  return CHAIN_NAME_ALIASES[key] ?? key;
}

export const getChainIdByName = (name: string) => {
  return Number(chainNameToChainId[normalizeChainName(name)]);
};

export function isSupportedChainName(name: string): boolean {
  const id = getChainIdByName(name);
  return Number.isFinite(id) && id > 0 && Boolean(chainNames[id]);
}

/** GMGN URL/API slug. RH pages and endpoints use `robinhood`, not `rh`. */
export function toGmgnChainName(nameOrId: string | number): string {
  const id = typeof nameOrId === "number" ? nameOrId : getChainIdByName(nameOrId);
  if (id === ChainId.RH) return "robinhood";
  if (Number.isFinite(id) && chainNames[id]) return chainNames[id];
  const fallback = typeof nameOrId === "string" ? normalizeChainName(nameOrId) : "";
  return fallback || "bsc";
}

/** DexScreener URL/API slug. */
export function toDexScreenerChainName(nameOrId: string | number): string {
  const id = typeof nameOrId === "number" ? nameOrId : getChainIdByName(nameOrId);
  if (id === ChainId.RH) return "robinhood";
  if (Number.isFinite(id) && chainNames[id]) return chainNames[id];
  const fallback = typeof nameOrId === "string" ? normalizeChainName(nameOrId) : "";
  return fallback || "bsc";
}

export const SUPPORTED_CHAINS = ["eth", "bsc", "hyper", "sol", "rh"];
