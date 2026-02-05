import { ChainId } from "./chainId";

export const chainNames: Record<ChainId | number, string> = {
  [ChainId.BNB]: "bsc",
  [ChainId.SOL]: "sol",
};

export const chainNameToChainId = Object.entries(chainNames).reduce(
  (acc, [chainId, chainName]) => {
    return {
      [chainName.toLocaleLowerCase()]: chainId as unknown as ChainId,
      ...acc,
    };
  },
  {} as Record<string, ChainId>
);

export const getChainIdByName = (name: string) => {
  if (name == 'bnb') name = 'bsc'
  return Number(chainNameToChainId[name.toLocaleLowerCase()]);
};

export const SUPPORTED_CHAINS = ['bsc', 'sol']
