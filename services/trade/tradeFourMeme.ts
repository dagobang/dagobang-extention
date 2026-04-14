import { encodeAbiParameters, parseAbi, parseAbiParameters } from 'viem';
import { ContractNames } from '../../constants/contracts/names';
import { DeployAddress } from '../../constants/contracts/address';
import { ChainId } from '../../constants/chains/chainId';
import { Address, ZERO_ADDRESS } from './tradeTypes';

const tokenManagerHelper3Abi = parseAbi([
  'function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)',
  'function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)',
]);

const abiParamsUint256 = parseAbiParameters('uint256');
const abiParamsFourMemeBuyTokenParams = parseAbiParameters(
  'uint256 origin, address token, address to, uint256 amount, uint256 maxFunds, uint256 funds, uint256 minAmount'
);
const abiParamsFourMemeBuyTokenWrapper = parseAbiParameters('bytes args, uint256 time, bytes signature');

function getTokenManagerHelper3Address(chainId: number): Address {
  const contracts = DeployAddress[chainId as ChainId] || {};
  return (contracts[ContractNames.TokenManagerHelper3]?.address || ZERO_ADDRESS) as Address;
}

export async function tryFourMemeBuyEstimatedAmount(client: any, chainId: number, token: Address, funds: bigint) {
  const helperAddress = getTokenManagerHelper3Address(chainId);
  if (helperAddress === ZERO_ADDRESS) return null;
  const res = await client.readContract({
    address: helperAddress,
    abi: tokenManagerHelper3Abi,
    functionName: 'tryBuy',
    args: [token, 0n, funds],
  });
  const estimatedAmount = res[2] as bigint;
  return { estimatedAmount };
}

export async function tryFourMemeSellEstimatedFunds(client: any, chainId: number, token: Address, amount: bigint) {
  const helperAddress = getTokenManagerHelper3Address(chainId);
  if (helperAddress === ZERO_ADDRESS) return null;
  const res = await client.readContract({
    address: helperAddress,
    abi: tokenManagerHelper3Abi,
    functionName: 'trySell',
    args: [token, amount],
  });
  const tokenManager = res[0] as Address;
  const funds = res[2] as bigint;
  const fee = res[3] as bigint;
  return { tokenManager, funds, fee };
}

export function encodeFourMemeUint256(value: bigint) {
  return encodeAbiParameters(abiParamsUint256, [value]) as `0x${string}`;
}

export function encodeFourMemeBuyTokenData(input: {
  token: Address;
  to: Address;
  funds: bigint;
  minAmount: bigint;
}) {
  const args = encodeAbiParameters(abiParamsFourMemeBuyTokenParams, [
    0n,
    input.token,
    input.to,
    0n,
    0n,
    input.funds,
    input.minAmount,
  ]);
  return encodeAbiParameters(abiParamsFourMemeBuyTokenWrapper, [args, 0n, '0x']) as `0x${string}`;
}
