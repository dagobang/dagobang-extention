import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  maxUint256,
  parseUnits,
  toBytes,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey } from 'viem/accounts';

import { ChainId } from '@/constants/chains';
import {
  FLAP_MAGIC_DIVIDEND_STOCKS,
  FLAP_MAGIC_DIVIDEND_SELF,
  FlapPortalAddress,
  FlapQuoteTokensByChain,
  FlapStocksVaultFactoryAddress,
  FlapTokenImplByChain,
  FlapUploadApiUrl,
  FlapVaultPortalAddress,
  getFlapStocksPresetTokens,
} from '@/constants/flap';
import { ChainSettings, GasPreset } from '@/types';
import { RpcService } from '@/services/rpc';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { WalletService } from '@/services/wallet';
import { erc20Abi } from '@/constants/contracts/abi/swapAbi';

type FlapLaunchTaxMode = 'quote' | 'self' | 'custom' | 'stocks' | 'disabled';

export type CreateFlapTokenInput = {
  launchFlowId?: string;
  name: string;
  symbol: string;
  desc: string;
  imgUrl: string;
  imgFallbackUrls?: string[];
  webUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  fromAddress?: `0x${string}`;
  quoteTokenId: string;
  quoteAmount?: string;
  taxMode: FlapLaunchTaxMode;
  customDividendTokenAddress?: `0x${string}`;
  selectedStockSymbols?: string[];
  buyTaxRateBps?: number;
  sellTaxRateBps?: number;
};

type FlapLaunchProgressStage =
  | 'prepare'
  | 'swap_request'
  | 'swap_submitted'
  | 'swap_confirmed'
  | 'approve_request'
  | 'approve_submitted'
  | 'approve_confirmed'
  | 'launch_request'
  | 'launch_submitted'
  | 'launch_confirmed';

type FlapLaunchProgressEvent = {
  stage: FlapLaunchProgressStage;
  message: string;
  txHash?: `0x${string}`;
  tokenAddress?: `0x${string}` | null;
};

type UploadMetadataInput = {
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  description: string;
  creator: string;
};

type NewTokenV6Params = {
  name: string;
  symbol: string;
  meta: string;
  dexThresh: number;
  salt: Hex;
  migratorType: number;
  quoteToken: Address;
  quoteAmt: bigint;
  beneficiary: Address;
  permitData: Hex;
  extensionID: Hex;
  extensionData: Hex;
  dexId: number;
  lpFeeProfile: number;
  buyTaxRate: number;
  sellTaxRate: number;
  taxDuration: bigint;
  antiFarmerDuration: bigint;
  mktBps: number;
  deflationBps: number;
  dividendBps: number;
  lpBps: number;
  minimumShareBalance: bigint;
  dividendToken: Address;
  commissionReceiver: Address;
  tokenVersion: number;
};

type NewTokenV6WithVaultParams = {
  name: string;
  symbol: string;
  meta: string;
  dexThresh: number;
  salt: Hex;
  migratorType: number;
  quoteToken: Address;
  quoteAmt: bigint;
  permitData: Hex;
  extensionID: Hex;
  extensionData: Hex;
  dexId: number;
  lpFeeProfile: number;
  buyTaxRate: number;
  sellTaxRate: number;
  taxDuration: bigint;
  antiFarmerDuration: bigint;
  mktBps: number;
  deflationBps: number;
  dividendBps: number;
  lpBps: number;
  minimumShareBalance: bigint;
  dividendToken: Address;
  commissionReceiver: Address;
  tokenVersion: number;
  vaultFactory: Address;
  vaultData: Hex;
};

const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const EIP1167_PREFIX = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';
const TAX_TOKEN_SUFFIX = '7777';
const FLAP_DEFAULT_TAX_DURATION_SECONDS = 100n * 365n * 24n * 60n * 60n;
const FLAP_DEFAULT_ANTI_FARMER_SECONDS = 365n * 24n * 60n * 60n;
const FLAP_STOCKS_ANTI_FARMER_SECONDS = 30n * 24n * 60n * 60n;
const FLAP_DEFAULT_TAX_BPS = 100;
const FLAP_DEFAULT_MINIMUM_SHARE_BALANCE = 10_000n * 10n ** 18n;
const FLAP_REUSABLE_APPROVAL_FLOOR = maxUint256 / 2n;
const FLAP_VANITY_POOL_TARGET_SIZE = 1;
const FLAP_VANITY_SEARCH_YIELD_EVERY = 512;

const portalAbi = [
  {
    type: 'function',
    name: 'newTokenV6',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'name', type: 'string' },
        { name: 'symbol', type: 'string' },
        { name: 'meta', type: 'string' },
        { name: 'dexThresh', type: 'uint8' },
        { name: 'salt', type: 'bytes32' },
        { name: 'migratorType', type: 'uint8' },
        { name: 'quoteToken', type: 'address' },
        { name: 'quoteAmt', type: 'uint256' },
        { name: 'beneficiary', type: 'address' },
        { name: 'permitData', type: 'bytes' },
        { name: 'extensionID', type: 'bytes32' },
        { name: 'extensionData', type: 'bytes' },
        { name: 'dexId', type: 'uint8' },
        { name: 'lpFeeProfile', type: 'uint8' },
        { name: 'buyTaxRate', type: 'uint16' },
        { name: 'sellTaxRate', type: 'uint16' },
        { name: 'taxDuration', type: 'uint64' },
        { name: 'antiFarmerDuration', type: 'uint64' },
        { name: 'mktBps', type: 'uint16' },
        { name: 'deflationBps', type: 'uint16' },
        { name: 'dividendBps', type: 'uint16' },
        { name: 'lpBps', type: 'uint16' },
        { name: 'minimumShareBalance', type: 'uint256' },
        { name: 'dividendToken', type: 'address' },
        { name: 'commissionReceiver', type: 'address' },
        { name: 'tokenVersion', type: 'uint8' },
      ],
    }],
    outputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { name: 'ts', type: 'uint256', indexed: false },
      { name: 'creator', type: 'address', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'meta', type: 'string', indexed: false },
    ],
  },
] as const;

const vaultPortalAbi = [
  {
    type: 'function',
    name: 'newTokenV6WithVault',
    stateMutability: 'payable',
    inputs: [{
      name: 'params',
      type: 'tuple',
      components: [
        { name: 'name', type: 'string' },
        { name: 'symbol', type: 'string' },
        { name: 'meta', type: 'string' },
        { name: 'dexThresh', type: 'uint8' },
        { name: 'salt', type: 'bytes32' },
        { name: 'migratorType', type: 'uint8' },
        { name: 'quoteToken', type: 'address' },
        { name: 'quoteAmt', type: 'uint256' },
        { name: 'permitData', type: 'bytes' },
        { name: 'extensionID', type: 'bytes32' },
        { name: 'extensionData', type: 'bytes' },
        { name: 'dexId', type: 'uint8' },
        { name: 'lpFeeProfile', type: 'uint8' },
        { name: 'buyTaxRate', type: 'uint16' },
        { name: 'sellTaxRate', type: 'uint16' },
        { name: 'taxDuration', type: 'uint64' },
        { name: 'antiFarmerDuration', type: 'uint64' },
        { name: 'mktBps', type: 'uint16' },
        { name: 'deflationBps', type: 'uint16' },
        { name: 'dividendBps', type: 'uint16' },
        { name: 'lpBps', type: 'uint16' },
        { name: 'minimumShareBalance', type: 'uint256' },
        { name: 'dividendToken', type: 'address' },
        { name: 'commissionReceiver', type: 'address' },
        { name: 'tokenVersion', type: 'uint8' },
        { name: 'vaultFactory', type: 'address' },
        { name: 'vaultData', type: 'bytes' },
      ],
    }],
    outputs: [{ name: 'token', type: 'address' }],
  },
] as const;

function parseGweiToWei(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return 0n;
  const intPart = match[1] || '0';
  const fracPartRaw = match[2] || '';
  const fracPadded = (fracPartRaw + '000000000').slice(0, 9);
  return BigInt(intPart) * 1000000000n + BigInt(fracPadded);
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
  return wei > 0n ? wei : parseGweiToWei(fallbackConfig.standard);
}

function normalizeTaxBps(value: number | undefined): number {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 0) return FLAP_DEFAULT_TAX_BPS;
  return Math.max(0, Math.min(10_000, Math.round(next)));
}

function parseQuoteAmount(input: string | undefined, decimals: number): bigint {
  const raw = String(input || '').trim();
  if (!raw) return 0n;
  try {
    const amount = parseUnits(raw, decimals);
    if (amount < 0n) throw new Error('negative amount');
    return amount;
  } catch {
    throw new Error('请输入合法的 Flap 初始注入金额');
  }
}

function parseNativeBudget(input?: string): bigint {
  return parseQuoteAmount(input, 18);
}

function predictTokenAddress(salt: Hex, tokenImpl: Address, portal: Address): Address {
  const bytecode = `${EIP1167_PREFIX}${tokenImpl.slice(2).toLowerCase()}${EIP1167_SUFFIX}` as Hex;
  return getContractAddress({
    from: portal,
    salt: toBytes(salt),
    bytecode,
    opcode: 'CREATE2',
  });
}

type VanitySaltMatch = {
  salt: Hex;
  address: Address;
  iterations: number;
};

type VanitySaltPoolState = {
  ready: VanitySaltMatch[];
  filling: Promise<void> | null;
};

const vanitySaltPool = new Map<string, VanitySaltPoolState>();

function getVanitySaltPoolKey(tokenImpl: Address, portal: Address): string {
  return `${tokenImpl.toLowerCase()}:${portal.toLowerCase()}`;
}

function getVanitySaltPoolState(tokenImpl: Address, portal: Address): VanitySaltPoolState {
  const key = getVanitySaltPoolKey(tokenImpl, portal);
  let state = vanitySaltPool.get(key);
  if (!state) {
    state = {
      ready: [],
      filling: null,
    };
    vanitySaltPool.set(key, state);
  }
  return state;
}

function waitForMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function findVanityTokenSaltAsync(tokenImpl: Address, portal: Address): Promise<VanitySaltMatch> {
  const seed = generatePrivateKey();
  let salt = keccak256(toHex(seed));
  let iterations = 0;
  let attemptsSinceYield = 0;
  while (!predictTokenAddress(salt, tokenImpl, portal).endsWith(TAX_TOKEN_SUFFIX)) {
    salt = keccak256(salt);
    iterations++;
    attemptsSinceYield++;
    if (attemptsSinceYield >= FLAP_VANITY_SEARCH_YIELD_EVERY) {
      attemptsSinceYield = 0;
      await waitForMacrotask();
    }
  }
  return {
    salt,
    address: predictTokenAddress(salt, tokenImpl, portal),
    iterations,
  };
}

function scheduleVanitySaltPoolFill(tokenImpl: Address, portal: Address): void {
  const state = getVanitySaltPoolState(tokenImpl, portal);
  if (state.filling || state.ready.length >= FLAP_VANITY_POOL_TARGET_SIZE) return;
  state.filling = (async () => {
    while (state.ready.length < FLAP_VANITY_POOL_TARGET_SIZE) {
      const nextMatch = await findVanityTokenSaltAsync(tokenImpl, portal);
      state.ready.push(nextMatch);
      console.info('[flap.launch.vanity_prewarm_ready]', {
        predictedAddress: nextMatch.address,
        iterations: nextMatch.iterations,
      });
    }
  })()
    .catch((error) => {
      console.warn('[flap.launch.vanity_prewarm_failed]', error);
    })
    .finally(() => {
      state.filling = null;
      if (state.ready.length < FLAP_VANITY_POOL_TARGET_SIZE) {
        scheduleVanitySaltPoolFill(tokenImpl, portal);
      }
    });
}

function tryTakePreparedVanitySalt(tokenImpl: Address, portal: Address): VanitySaltMatch | null {
  const state = getVanitySaltPoolState(tokenImpl, portal);
  const nextMatch = state.ready.shift() ?? null;
  scheduleVanitySaltPoolFill(tokenImpl, portal);
  return nextMatch;
}

async function takePreparedVanitySalt(tokenImpl: Address, portal: Address): Promise<VanitySaltMatch> {
  const cached = tryTakePreparedVanitySalt(tokenImpl, portal);
  if (cached) return cached;
  const state = getVanitySaltPoolState(tokenImpl, portal);
  scheduleVanitySaltPoolFill(tokenImpl, portal);
  if (state.filling) {
    await state.filling;
  }
  const nextMatch = state.ready.shift();
  if (nextMatch) {
    scheduleVanitySaltPoolFill(tokenImpl, portal);
    return nextMatch;
  }
  const fallbackMatch = await findVanityTokenSaltAsync(tokenImpl, portal);
  scheduleVanitySaltPoolFill(tokenImpl, portal);
  return fallbackMatch;
}

async function fetchImageBlob(url: string): Promise<Blob> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('缺少图片地址');
  const response = await fetch(trimmed);
  if (!response.ok) {
    throw new Error(`图片下载失败：${response.status}`);
  }
  return await response.blob();
}

async function resolveImageFile(urls: string[], symbol: string): Promise<File> {
  let lastError: unknown = null;
  for (const rawUrl of urls) {
    const url = String(rawUrl || '').trim();
    if (!url) continue;
    try {
      const blob = await fetchImageBlob(url);
      const type = blob.type || 'image/png';
      const ext = type.includes('jpeg')
        ? 'jpg'
        : type.includes('webp')
          ? 'webp'
          : type.includes('gif')
            ? 'gif'
            : 'png';
      return new File([blob], `${symbol || 'flap-token'}.${ext}`, { type });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('图片下载失败');
}

async function uploadTokenMeta(image: File, meta: UploadMetadataInput): Promise<string> {
  const form = new FormData();
  form.append(
    'operations',
    JSON.stringify({
      query: `
mutation Create($file: Upload!, $meta: MetadataInput!) {
  create(file: $file, meta: $meta)
}
      `,
      variables: {
        file: null,
        meta,
      },
    }),
  );
  form.append('map', JSON.stringify({ '0': ['variables.file'] }));
  form.append('0', image);
  const res = await fetch(FlapUploadApiUrl, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Flap 元数据上传失败：${res.status}`);
  }
  const data = await res.json().catch(() => null) as { data?: { create?: unknown } } | null;
  const cid = data?.data?.create;
  if (typeof cid !== 'string' || !cid.trim()) {
    throw new Error('Flap 元数据上传失败：未返回 CID');
  }
  return cid.trim();
}

function normalizeMetaUri(meta: string): string {
  const trimmed = meta.trim();
  if (!trimmed) {
    throw new Error('Flap 元数据上传失败：CID 为空');
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://ipfs.io/ipfs/${trimmed}`;
}

function resolveDividendToken(input: {
  taxMode: FlapLaunchTaxMode;
  quoteToken: Address;
  customDividendTokenAddress?: Address;
}) {
  if (input.taxMode === 'self') {
    return FLAP_MAGIC_DIVIDEND_SELF as Address;
  }
  if (input.taxMode === 'custom') {
    const address = String(input.customDividendTokenAddress || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error('请填写合法的自定义分红代币地址');
    }
    return address as Address;
  }
  if (input.taxMode === 'quote') {
    return input.quoteToken;
  }
  throw new Error('当前 Flap 仅支持按底池币种 / 本币 / 自定义三种税收模式');
}

function resolveStocksVaultData(selectedStockSymbols: string[], basketName: string): Hex {
  const tokens = getFlapStocksPresetTokens(ChainId.BNB);
  const tokenMap = new Map(tokens.map((item) => [item.symbol.toUpperCase(), item.address]));
  const addresses = selectedStockSymbols
    .map((symbol) => tokenMap.get(String(symbol || '').trim().toUpperCase()))
    .filter((item): item is Address => !!item);
  const dedupedAddresses = Array.from(new Set(addresses.map((item) => item.toLowerCase())))
    .map((address) => tokens.find((item) => item.address.toLowerCase() === address)?.address)
    .filter((item): item is Address => !!item);

  if (dedupedAddresses.length <= 0) {
    throw new Error('请至少选择 1 个有效币股模板');
  }
  if (dedupedAddresses.length > 10) {
    throw new Error('币股模板最多支持 10 个');
  }

  // Matches the GMGN V6WithVault payload shape: abi.encode(address[] assets, string basketName, uint8 mode)
  return encodeAbiParameters(
    [
      { type: 'address[]' },
      { type: 'string' },
      { type: 'uint8' },
    ],
    [dedupedAddresses, basketName.trim(), 1],
  );
}

async function ensureQuoteAllowance(input: {
  client: Awaited<ReturnType<typeof RpcService.getClient>>;
  owner: Address;
  spender: Address;
  tokenAddress: Address;
  requiredAmount: bigint;
  onProgress?: (event: FlapLaunchProgressEvent) => void | Promise<void>;
}) {
  if (input.requiredAmount <= 0n) return;
  const allowance = await input.client.readContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [input.owner, input.spender],
  });
  if (allowance >= input.requiredAmount) return;

  await input.onProgress?.({
    stage: 'approve_request',
    message: '正在请求钱包授权底池代币',
  });
  const approveTxHash = await TradeService.approve(
    ChainId.BNB,
    input.tokenAddress,
    input.spender,
    maxUint256.toString(),
    input.owner,
  );
  await input.onProgress?.({
    stage: 'approve_submitted',
    message: '底池代币授权已提交，正在等待确认',
    txHash: approveTxHash,
  });
  await input.client.waitForTransactionReceipt({ hash: approveTxHash });
  await input.onProgress?.({
    stage: 'approve_confirmed',
    message: '底池代币授权已确认',
    txHash: approveTxHash,
  });
}

async function getQuoteAllowance(input: {
  client: Awaited<ReturnType<typeof RpcService.getClient>>;
  owner: Address;
  spender: Address;
  tokenAddress: Address;
}) {
  return await input.client.readContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [input.owner, input.spender],
  });
}

async function submitQuoteAllowanceApproval(input: {
  owner: Address;
  spender: Address;
  tokenAddress: Address;
  onProgress?: (event: FlapLaunchProgressEvent) => void | Promise<void>;
}) {
  await input.onProgress?.({
    stage: 'approve_request',
    message: '正在请求钱包授权底池代币',
  });
  const approveTxHash = await TradeService.approve(
    ChainId.BNB,
    input.tokenAddress,
    input.spender,
    maxUint256.toString(),
    input.owner,
  );
  await input.onProgress?.({
    stage: 'approve_submitted',
    message: '底池代币授权已提交，等待链上确认中',
    txHash: approveTxHash,
  });
  return approveTxHash;
}

async function submitNativeBudgetToQuoteTokenSwap(input: {
  client: Awaited<ReturnType<typeof RpcService.getClient>>;
  owner: Address;
  tokenAddress: Address;
  nativeBudgetWei: bigint;
  symbol: string;
  onProgress?: (event: FlapLaunchProgressEvent) => void | Promise<void>;
}) {
  if (input.nativeBudgetWei <= 0n) return null;
  const beforeBalance = await input.client.readContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [input.owner],
  });
  await input.onProgress?.({
    stage: 'swap_request',
    message: `正在请求钱包把 BNB 兑换成 ${input.symbol}`,
  });
  const swapResult = await TradeService.buy({
    chainId: ChainId.BNB,
    tokenAddress: input.tokenAddress,
    nativeAmountWei: input.nativeBudgetWei.toString(),
    baseTokenAddress: zeroAddress,
    fromAddress: input.owner,
    executionModeOverride: 'default',
  });
  await input.onProgress?.({
    stage: 'swap_submitted',
    message: `${input.symbol} 兑换已提交，等待链上确认中`,
    txHash: swapResult.txHash,
  });
  return {
    txHash: swapResult.txHash,
    beforeBalance,
  };
}

async function waitForNativeBudgetToQuoteTokenSwap(input: {
  client: Awaited<ReturnType<typeof RpcService.getClient>>;
  owner: Address;
  tokenAddress: Address;
  beforeBalance: bigint;
  txHash: `0x${string}`;
  symbol: string;
  onProgress?: (event: FlapLaunchProgressEvent) => void | Promise<void>;
}) {
  await input.client.waitForTransactionReceipt({ hash: input.txHash });
  await input.onProgress?.({
    stage: 'swap_confirmed',
    message: `${input.symbol} 兑换已确认`,
    txHash: input.txHash,
  });
  const afterBalance = await input.client.readContract({
    address: input.tokenAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [input.owner],
  });
  const receivedAmount = afterBalance - input.beforeBalance;
  if (receivedAmount > 0n) return receivedAmount;

  throw new Error(
    `BNB 兑换 ${input.symbol} 失败：未收到 ${input.symbol}`,
  );
}

export class TokenFlapLaunchService {
  static prewarmVanitySalt(): void {
    const portalAddress = FlapPortalAddress[ChainId.BNB];
    const tokenImpl = FlapTokenImplByChain[ChainId.BNB]?.taxV3;
    if (!portalAddress || !tokenImpl) return;
    scheduleVanitySaltPoolFill(tokenImpl, portalAddress);
  }

  static async createToken(
    input: CreateFlapTokenInput,
    opts?: { onProgress?: (event: FlapLaunchProgressEvent) => void | Promise<void> },
  ): Promise<{ txHash: `0x${string}`; tokenAddress: `0x${string}` | null }> {
    await opts?.onProgress?.({
      stage: 'prepare',
      message: '正在准备 Flap 发射参数',
    });
    if (input.taxMode === 'disabled') {
      throw new Error('当前 Flap 主网标准无税发射不可用，请改用税币模式');
    }
    const portalAddress = FlapPortalAddress[ChainId.BNB];
    const vaultPortalAddress = FlapVaultPortalAddress[ChainId.BNB];
    const stocksVaultFactory = FlapStocksVaultFactoryAddress[ChainId.BNB];
    const tokenImpl = FlapTokenImplByChain[ChainId.BNB]?.taxV3;
    if (!portalAddress || !tokenImpl) {
      throw new Error('Flap Portal 配置缺失');
    }
    if (input.taxMode === 'stocks' && (!vaultPortalAddress || !stocksVaultFactory)) {
      throw new Error('Flap Stocks Portal 配置缺失');
    }

    const quoteToken = FlapQuoteTokensByChain[ChainId.BNB]?.find((item) => item.id === input.quoteTokenId);
    if (!quoteToken) {
      throw new Error('不支持的 Flap 底池币种');
    }
    const nativeBudgetWei = quoteToken.isNative ? 0n : parseNativeBudget(input.quoteAmount);

    const settings = await SettingsService.get();
    const chainSettings = settings.chains[ChainId.BNB] as ChainSettings | undefined;
    if (!chainSettings) {
      throw new Error('BSC 链设置缺失');
    }

    const fromAddress = input.fromAddress;
    const account = await WalletService.getSigner(fromAddress);
    const client = await RpcService.getClient(ChainId.BNB);
    const gasPreset: GasPreset = chainSettings.buyGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset);
    const launchSpender = input.taxMode === 'stocks' ? vaultPortalAddress! : portalAddress;
    const cachedVanity = tryTakePreparedVanitySalt(tokenImpl, portalAddress);
    let markQuoteSubmissionReady = () => { };
    const quoteSubmissionReadyPromise = quoteToken.isNative
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        markQuoteSubmissionReady = resolve;
      });
    const quoteAmtPromise = quoteToken.isNative
      ? Promise.resolve(parseQuoteAmount(input.quoteAmount, quoteToken.decimals))
      : (async () => {
        const currentAllowance = await getQuoteAllowance({
          client,
          owner: account.address,
          spender: launchSpender,
          tokenAddress: quoteToken.address,
        });
        const approvalTxHash = currentAllowance >= FLAP_REUSABLE_APPROVAL_FLOOR
          ? null
          : await submitQuoteAllowanceApproval({
            owner: account.address,
            spender: launchSpender,
            tokenAddress: quoteToken.address,
            onProgress: opts?.onProgress,
          });
        const submittedSwap = await submitNativeBudgetToQuoteTokenSwap({
          client,
          owner: account.address,
          tokenAddress: quoteToken.address,
          nativeBudgetWei,
          symbol: quoteToken.label,
          onProgress: opts?.onProgress,
        });
        markQuoteSubmissionReady();
        const approvalConfirmedPromise = approvalTxHash
          ? client.waitForTransactionReceipt({ hash: approvalTxHash }).then(async () => {
            await opts?.onProgress?.({
              stage: 'approve_confirmed',
              message: '底池代币授权已确认',
              txHash: approvalTxHash,
            });
          })
          : Promise.resolve();

        let nextQuoteAmt = 0n;
        if (submittedSwap) {
          const swapState = submittedSwap;
          const [receivedQuoteAmount] = await Promise.all([
            waitForNativeBudgetToQuoteTokenSwap({
              client,
              owner: account.address,
              tokenAddress: quoteToken.address,
              beforeBalance: swapState.beforeBalance,
              txHash: swapState.txHash,
              symbol: quoteToken.label,
              onProgress: opts?.onProgress,
            }),
            approvalConfirmedPromise,
          ]);
          nextQuoteAmt = receivedQuoteAmount;
        } else {
          await approvalConfirmedPromise;
        }

        if (currentAllowance < nextQuoteAmt && !approvalTxHash) {
          await ensureQuoteAllowance({
            client,
            owner: account.address,
            spender: launchSpender,
            tokenAddress: quoteToken.address,
            requiredAmount: nextQuoteAmt,
            onProgress: opts?.onProgress,
          });
        }

        return nextQuoteAmt;
      })();
    const vanityPromise = cachedVanity
      ? Promise.resolve(cachedVanity)
      : quoteSubmissionReadyPromise.then(() => takePreparedVanitySalt(tokenImpl, portalAddress));

    const imageFile = await resolveImageFile(
      [
        input.imgUrl,
        ...(Array.isArray(input.imgFallbackUrls) ? input.imgFallbackUrls : []),
      ],
      input.symbol,
    );
    const cidPromise = uploadTokenMeta(imageFile, {
      website: input.webUrl?.trim() || null,
      twitter: input.twitterUrl?.trim() || null,
      telegram: input.telegramUrl?.trim() || null,
      description: input.desc.trim(),
      creator: account.address,
    });
    const [cid, vanity, quoteAmt] = await Promise.all([cidPromise, vanityPromise, quoteAmtPromise]);
    console.info('[flap.launch.salt]', {
      symbol: input.symbol,
      iterations: vanity.iterations,
      predictedAddress: vanity.address,
    });
    const txValue = quoteToken.isNative ? quoteAmt : 0n;
    if (!quoteToken.isNative && quoteAmt > 0n) {
      await ensureQuoteAllowance({
        client,
        owner: account.address,
        spender: launchSpender,
        tokenAddress: quoteToken.address,
        requiredAmount: quoteAmt,
        onProgress: opts?.onProgress,
      });
    }

    const commonParams = {
      name: input.name.trim(),
      symbol: input.symbol.trim(),
      meta: normalizeMetaUri(cid),
      dexThresh: 1,
      salt: vanity.salt,
      migratorType: 1,
      quoteToken: quoteToken.address,
      quoteAmt,
      permitData: '0x' as const,
      extensionID: ZERO_BYTES32,
      extensionData: '0x' as const,
      dexId: 0,
      lpFeeProfile: 0,
      buyTaxRate: normalizeTaxBps(input.buyTaxRateBps),
      sellTaxRate: normalizeTaxBps(input.sellTaxRateBps),
      taxDuration: FLAP_DEFAULT_TAX_DURATION_SECONDS,
      commissionReceiver: zeroAddress,
      tokenVersion: 6,
    };

    const data = input.taxMode === 'stocks'
      ? encodeFunctionData({
        abi: vaultPortalAbi,
        functionName: 'newTokenV6WithVault',
        args: [{
          ...commonParams,
          antiFarmerDuration: FLAP_STOCKS_ANTI_FARMER_SECONDS,
          mktBps: 10_000,
          deflationBps: 0,
          dividendBps: 0,
          lpBps: 0,
          minimumShareBalance: 10_000n * 10n ** 18n,
          dividendToken: FLAP_MAGIC_DIVIDEND_STOCKS as Address,
          vaultFactory: stocksVaultFactory!,
          vaultData: resolveStocksVaultData(input.selectedStockSymbols || [], input.name),
        } satisfies NewTokenV6WithVaultParams],
      })
      : encodeFunctionData({
        abi: portalAbi,
        functionName: 'newTokenV6',
        args: [{
          ...commonParams,
          beneficiary: account.address,
          antiFarmerDuration: FLAP_DEFAULT_ANTI_FARMER_SECONDS,
          mktBps: 0,
          deflationBps: 0,
          dividendBps: 10_000,
          lpBps: 0,
          minimumShareBalance: FLAP_DEFAULT_MINIMUM_SHARE_BALANCE,
          dividendToken: resolveDividendToken({
            taxMode: input.taxMode,
            quoteToken: quoteToken.address,
            customDividendTokenAddress: input.customDividendTokenAddress,
          }),
        } satisfies NewTokenV6Params],
      });

    await opts?.onProgress?.({
      stage: 'launch_request',
      message: input.taxMode === 'stocks'
        ? '正在请求钱包确认 Flap Stocks 发射'
        : '正在请求钱包确认 Flap 发射',
    });
    const { txHash } = await TradeService.sendTransaction(
      client,
      account,
      input.taxMode === 'stocks' ? vaultPortalAddress! : portalAddress,
      data,
      txValue,
      gasPriceWei,
      ChainId.BNB,
        { skipEstimateGas: true, gasLimit: 8_000_000n },
    );
    await opts?.onProgress?.({
      stage: 'launch_submitted',
      message: '发射交易已提交，正在等待链上确认',
      txHash,
    });

    let tokenAddress: `0x${string}` | null = vanity.address as `0x${string}`;
    try {
      const receipt = await client.waitForTransactionReceipt({ hash: txHash });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== portalAddress.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({
            abi: portalAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === 'TokenCreated') {
            const args = decoded.args as { token?: `0x${string}` };
            if (args?.token) {
              tokenAddress = args.token;
              break;
            }
          }
        } catch {
        }
      }
      await opts?.onProgress?.({
        stage: 'launch_confirmed',
        message: tokenAddress
          ? `发射已确认，代币地址 ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`
          : '发射已确认',
        txHash,
        tokenAddress,
      });
    } catch {
    }

    return { txHash, tokenAddress };
  }
}
