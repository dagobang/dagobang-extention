import { useEffect, useState } from "react";

import { ChainId } from "@/constants/chains";
import { getDeploysByAddress } from "@/constants/contracts/address";

export type ContractAddress = {
  chainId?: string;
  address?: string;
  abi?: string;
};

export async function loadContractAbi(
  chainId?: ChainId,
  address?: string
): Promise<any> {
  const info = getDeploysByAddress(chainId!, address!);
  if (info) {
    return (await import(`@/constants/contracts/abi/${info.abi}.json`)).default;
  }
}

export function useContractAbi(
  chainId?: ChainId,
  address?: string,
): any {
  const [abi, setAbi] = useState<any>(undefined);

  useEffect(() => {
    loadContractAbi(chainId, address).then((json) => {
      return setAbi(json?.abi ? json.abi : json);
    });
  }, [chainId, address]);

  return abi;
}
