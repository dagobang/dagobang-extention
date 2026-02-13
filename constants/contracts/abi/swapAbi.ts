import { parseAbi, encodeFunctionData, getAddress } from 'viem';

export const dagobangAbi = parseAbi([
    'struct SwapDesc { uint8 swapType; address tokenIn; address tokenOut; address poolAddress; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; address poolManager; bytes32 parameters; bytes data; }',
    'function swap(SwapDesc[] descs, address feeToken, uint256 amountIn, uint256 minReturn, uint256 deadline) payable',
    'function swapPercent(SwapDesc[] descs, address feeToken, uint16 percentBps, uint256 minReturn, uint256 deadline) payable'
]);

export const erc20Abi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
]);

export const factoryV2Abi = parseAbi([
    'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);

export const factoryV3Abi = parseAbi([
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
]);

export const pairV2Abi = parseAbi([
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
]);

export const quoterV2Abi = parseAbi([
    'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
    'function quoteExactInputSingle(QuoteExactInputSingleParams params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
]);
