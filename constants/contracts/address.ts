import { ChainId } from "@/constants/chains/chainId";
import { ContractNames } from "./names";
import { ContractAddress } from "@/hooks/useContractAbi";

type AddressMapping = {
  [chainId in ChainId]?: {
    [contractName in ContractNames]?: ContractAddress;
  };
};

export const DeployAddress: AddressMapping = {
  [ChainId.BNB]: {
    [ContractNames.DagobangRouter]: {
      address: "0x1E2FbB5DD674244D6185571153Ca56297a5F2406",
    },
    [ContractNames.WETH]: {
      address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    },
    [ContractNames.UniswapFactoryV2]: {
      address: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    },
    [ContractNames.PancakeFactoryV2]: {
      address: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    },
    [ContractNames.UniswapFactoryV3]: {
      address: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    },
    [ContractNames.PancakeFactoryV3]: {
      address: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
    },
    [ContractNames.PoolManager]: {
      address: "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF",
    },
    [ContractNames.PancakeInfinityVault]: {
      address: "0x238a358808379702088667322f80aC48bAd5e6c4",
    },
    [ContractNames.PancakeInfinityClPoolManager]: {
      address: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
    },
    [ContractNames.PancakeInfinityBinPoolManager]: {
      address: "0xC697d2898e0D09264376196696c51D7aBbbAA4a9",
    },
    [ContractNames.FourMemeTokenManagerV2]: {
      address: "0x5c952063c7fc8610FFDB798152D69F0B9550762b",
    },
    [ContractNames.FlapshTokenManager]: {
      address: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
    },
    [ContractNames.TokenManagerHelper3]: {
      address: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034",
    },
  },
};

export const getDeploysByName = (chainId: string, name?: ContractNames): any => {
  const contracts = DeployAddress[chainId as unknown as ChainId];
  if (!contracts || !name) {
    return undefined;
  }
  return {
    name: name as ContractNames,
    address: contracts[name]?.address,
    abi: name,
  };
};


export const getDeploysByAddress = (chainId: ChainId, address: string) => {
  const contracts = DeployAddress[chainId];
  if (!contracts) {
    return undefined;
  }

  for (const contractName in contracts) {
    if (contracts.hasOwnProperty(contractName)) {
      const contract = contracts[contractName as ContractNames];
      if (contract && contract.address === address) {
        return {
          name: contractName as ContractNames,
          address: contract.address,
          abi: contractName,
        };
      }
    }
  }

  return undefined;
};
