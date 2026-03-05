import { parseAbi, encodeFunctionData, decodeEventLog } from 'viem';
import { FourmemeTokenInfo } from '@/types/token';
import { ChainId } from '@/constants/chains';
import { DeployAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import { ChainSettings, GasPreset } from '@/types';
import { RpcService } from '../rpc';
import { SettingsService } from '../settings';
import { TradeService } from '../trade';
import { WalletService } from '../wallet';


function parseGweiToWei(value: string): bigint {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return 0n;
    const intPart = match[1] || '0';
    const fracPartRaw = match[2] || '';
    const fracPadded = (fracPartRaw + '000000000').slice(0, 9);
    const intBig = BigInt(intPart);
    const fracBig = BigInt(fracPadded);
    return intBig * 1000000000n + fracBig;
}

function getGasPriceWei(chainSettings: ChainSettings, preset: GasPreset): bigint {
    const baseConfig = chainSettings.buyGasGwei;
    const fallbackConfig = {
        slow: '0.06',
        standard: '0.12',
        fast: '1',
        turbo: '5',
    };
    const cfg = baseConfig || fallbackConfig;
    let value = cfg.standard;
    if (preset === 'slow') value = cfg.slow;
    else if (preset === 'fast') value = cfg.fast;
    else if (preset === 'turbo') value = cfg.turbo;
    const wei = parseGweiToWei(value);
    if (wei <= 0n) {
        return parseGweiToWei(fallbackConfig.standard);
    }
    return wei;
}


const tokenManagerHelper3Abi = parseAbi([
    'function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)'
]);

const tokenManager2Abi = parseAbi([
    'function _tokenInfos(address token) view returns (address base, address quote, uint256 template, uint256 totalSupply, uint256 maxOffers, uint256 maxRaising, uint256 launchTime, uint256 offers, uint256 funds, uint256 lastPrice, uint256 k, uint256 t, uint256 status)'
]);

const fourMemeTokenManagerAbi = parseAbi([
    'function createToken(bytes createArg, bytes sign) returns (address token)',
    'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime)'
]);

const tokenManagerCacheByChain = new Map<number, `0x${string}`>();

export class TokenFourmemeService {
    private static getTokenManagerHelper3Address(chainId: number): string {
        const contracts = DeployAddress[chainId as ChainId] || {};
        return contracts[ContractNames.TokenManagerHelper3]?.address || '0x0000000000000000000000000000000000000000';
    }

    static async getTokenInfo(chainId: number, tokenAddress: string): Promise<FourmemeTokenInfo> {
        const client = await RpcService.getClient();
        const helperAddress = this.getTokenManagerHelper3Address(chainId);

        if (helperAddress === '0x0000000000000000000000000000000000000000') {
            throw new Error('TokenManagerHelper3 address not found for chain ' + chainId);
        }

        const cachedTokenManager = tokenManagerCacheByChain.get(chainId);
        const helperPromise = client.readContract({
            address: helperAddress as `0x${string}`,
            abi: tokenManagerHelper3Abi,
            functionName: 'getTokenInfo',
            args: [tokenAddress as `0x${string}`],
        });

        const templatePromise = cachedTokenManager
            ? client.readContract({
                address: cachedTokenManager,
                abi: tokenManager2Abi,
                functionName: '_tokenInfos',
                args: [tokenAddress as `0x${string}`],
            }).catch(() => null)
            : Promise.resolve(null);

        const [result, tokenInfoMaybe] = await Promise.all([helperPromise, templatePromise]);

        const [
            version,
            tokenManager,
            quote,
            lastPrice,
            tradingFeeRate,
            minTradingFee,
            launchTime,
            offers,
            maxOffers,
            funds,
            maxFunds,
            liquidityAdded
        ] = result;

        tokenManagerCacheByChain.set(chainId, tokenManager as `0x${string}`);

        let tokenInfo = tokenInfoMaybe;
        if (!tokenInfo || (cachedTokenManager && cachedTokenManager.toLowerCase() !== (tokenManager as string).toLowerCase())) {
            tokenInfo = await client.readContract({
                address: tokenManager as `0x${string}`,
                abi: tokenManager2Abi,
                functionName: '_tokenInfos',
                args: [tokenAddress as `0x${string}`],
            }).catch(() => null);
        }

        const aiCreator = tokenInfo ? (((tokenInfo[2] as bigint) & (1n << 85n)) !== 0n) : undefined;

        return {
            version: Number(version),
            tokenManager,
            quote,
            lastPrice: Number(lastPrice), // BNB
            tradingFeeRate: Number(tradingFeeRate),
            minTradingFee: Number(minTradingFee),
            launchTime: Number(launchTime),
            offers: Number(offers),
            maxOffers: Number(maxOffers),
            funds: Number(funds),
            maxFunds: Number(maxFunds),
            liquidityAdded,
            aiCreator
        };
    }

    static async createTokenOnChain(
        chainId: number,
        createArg: string,
        sign: string
    ): Promise<{ txHash: `0x${string}`; tokenAddress: `0x${string}` | null }> {
        const contracts = DeployAddress[chainId as ChainId] || {};
        const managerAddress = contracts[ContractNames.FourMemeTokenManagerV2]?.address;
        if (!managerAddress) {
            throw new Error('FourMemeTokenManagerV2 address not found for chain ' + chainId);
        }

        const account = await WalletService.getSigner();
        const client = await RpcService.getClient();
        const settings = await SettingsService.get();
        const chainSettings = settings.chains[chainId as ChainId] as ChainSettings;
        const gasPreset: GasPreset = chainSettings.buyGasPreset ?? chainSettings.gasPreset;

        const data = encodeFunctionData({
            abi: fourMemeTokenManagerAbi,
            functionName: 'createToken',
            args: [createArg as `0x${string}`, sign as `0x${string}`],
        });

        const gasPriceWei = getGasPriceWei(chainSettings, gasPreset);

        const { txHash } = await TradeService.sendTransaction(
            client,
            account,
            managerAddress,
            data,
            0n,
            gasPriceWei,
            chainId
        );

        let tokenAddress: `0x${string}` | null = null;
        try {
            const receipt = await client.waitForTransactionReceipt({ hash: txHash });
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() !== managerAddress.toLowerCase()) continue;
                try {
                    const decoded = decodeEventLog({
                        abi: fourMemeTokenManagerAbi,
                        data: log.data,
                        topics: log.topics,
                    });
                    if (decoded.eventName === 'TokenCreate') {
                        const args: any = decoded.args;
                        if (args && args.token) {
                            tokenAddress = args.token as `0x${string}`;
                            break;
                        }
                    }
                } catch {
                }
            }
        } catch {
            tokenAddress = null;
        }

        return { txHash, tokenAddress };
    }
}
