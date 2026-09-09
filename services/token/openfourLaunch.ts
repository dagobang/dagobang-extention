import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  maxUint256,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';

import { ChainId } from '@/constants/chains';
import { DeployAddress, OpenFourRegistryAddress } from '@/constants/contracts/address';
import { ContractNames } from '@/constants/contracts/names';
import {
  getOpenFour4StockTemplate,
  isOpenFour4StockName,
  OPENFOUR_4STOCK_MODE,
  type OpenFourLaunchMode,
} from '@/constants/openfour';
import FourmemeAPI, {
  type OpenFourCreateInitParams,
} from '@/services/api/fourmeme';
import { RpcService } from '@/services/rpc';
import { SettingsService } from '@/services/settings';
import { TradeService } from '@/services/trade';
import { getGasPriceWei } from '@/services/trade/tradeTx';
import { WalletService } from '@/services/wallet';
import type { ChainSettings, GasPreset } from '@/types';
import { browser } from 'wxt/browser';

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const OPENFOUR_CREATE_GAS_LIMIT = 8_000_000n;

const PARAM_DESCRIPTOR_COMPONENTS = [
  { name: 'name', type: 'string' },
  { name: 'abiType', type: 'string' },
  { name: 'decimals', type: 'uint8' },
  { name: 'optional', type: 'bool' },
  { name: 'title', type: 'string' },
  { name: 'defaultValue', type: 'string' },
  { name: 'hint', type: 'string' },
  { name: 'minValue', type: 'string' },
  { name: 'maxValue', type: 'string' },
] as const;

const MODULE_SCHEMA_COMPONENTS = [
  { name: 'kind', type: 'string' },
  { name: 'version', type: 'uint8' },
  { name: 'params', type: 'tuple[]', components: PARAM_DESCRIPTOR_COMPONENTS },
] as const;

const openFourRegistryAbi = [
  {
    type: 'function',
    name: 'openFourCore',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'openFourTool',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getPresetIds',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getPresetIdsCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getPresetIdsByBatch',
    stateMutability: 'view',
    inputs: [
      { name: 'index', type: 'uint256' },
      { name: 'count', type: 'uint256' },
    ],
    outputs: [{ name: 'ids', type: 'uint256[]' }],
  },
  {
    type: 'function',
    name: 'getPreset',
    stateMutability: 'view',
    inputs: [{ name: 'presetId', type: 'uint256' }],
    outputs: [{
      name: '',
      type: 'tuple',
      components: [
        { name: 'id', type: 'uint256' },
        { name: 'name', type: 'string' },
        { name: 'description', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'active', type: 'bool' },
        { name: 'createEnabled', type: 'bool' },
        { name: 'validator', type: 'address' },
        { name: 'tokenModuleId', type: 'bytes32' },
        { name: 'vaultModuleId', type: 'bytes32' },
        { name: 'curveModuleId', type: 'bytes32' },
        { name: 'tradeModuleId', type: 'bytes32' },
        { name: 'migrateModuleId', type: 'bytes32' },
        { name: 'tokenImplId', type: 'bytes32' },
        { name: 'customDataId', type: 'bytes32' },
        { name: 'author', type: 'address' },
      ],
    }],
  },
] as const;

const openFourToolsAbi = [
  {
    type: 'function',
    name: 'getPresetEncodeSchemas',
    stateMutability: 'view',
    inputs: [{ name: 'presetId', type: 'uint256' }],
    outputs: [
      { name: 'token', type: 'tuple', components: MODULE_SCHEMA_COMPONENTS },
      { name: 'vault', type: 'tuple', components: MODULE_SCHEMA_COMPONENTS },
      { name: 'curve', type: 'tuple', components: MODULE_SCHEMA_COMPONENTS },
      { name: 'trade', type: 'tuple', components: MODULE_SCHEMA_COMPONENTS },
      { name: 'migrate', type: 'tuple', components: MODULE_SCHEMA_COMPONENTS },
      { name: 'customData', type: 'tuple', components: MODULE_SCHEMA_COMPONENTS },
    ],
  },
] as const;

const openFourCoreAbi = [
  {
    type: 'function',
    name: 'createToken',
    stateMutability: 'payable',
    inputs: [
      { name: 'createArg', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { indexed: false, name: 'requestId', type: 'uint256' },
      { indexed: true, name: 'presetId', type: 'uint256' },
      { indexed: true, name: 'creator', type: 'address' },
      { indexed: true, name: 'token', type: 'address' },
      { indexed: false, name: 'name', type: 'string' },
      { indexed: false, name: 'symbol', type: 'string' },
      { indexed: false, name: 'maxSupply', type: 'uint256' },
      { indexed: false, name: 'saleAmount', type: 'uint256' },
      { indexed: false, name: 'raiseAmount', type: 'uint256' },
      { indexed: false, name: 'initialPrice', type: 'uint256' },
      { indexed: false, name: 'quoteAsset', type: 'address' },
      { indexed: false, name: 'vault', type: 'address' },
      { indexed: false, name: 'curveModule', type: 'address' },
      { indexed: false, name: 'tradeModule', type: 'address' },
      { indexed: false, name: 'migrateModule', type: 'address' },
      { indexed: false, name: 'customData', type: 'address' },
      { indexed: false, name: 'tokenModule', type: 'address' },
      { indexed: false, name: 'tokenMetaUri', type: 'string' },
      { indexed: false, name: 'flags', type: 'uint256' },
      { indexed: false, name: 'encodedTags', type: 'bytes' },
    ],
  },
] as const;

type ParamDescriptor = {
  name: string;
  abiType: string;
  decimals: number;
  optional: boolean;
  title: string;
  defaultValue: string;
  hint: string;
  minValue: string;
  maxValue: string;
};

type ModuleSchema = {
  kind: string;
  version: number;
  params: ParamDescriptor[];
};

type PresetSchemas = {
  token: ModuleSchema;
  vault: ModuleSchema;
  curve: ModuleSchema;
  trade: ModuleSchema;
  migrate: ModuleSchema;
  customData: ModuleSchema;
};

export type OpenFourResolvedTemplate = {
  mode: OpenFourLaunchMode;
  templateId: string;
  name: string;
  tag: string;
  descr: string;
  quoteSymbol: string;
  quoteAddress: Address;
  quoteDecimals: number;
  raisedAmount: string;
  saleAmount: string;
  totalSupply: string;
  createFee: string;
};

export type CreateOpenFourTokenInput = {
  launchFlowId?: string;
  mode?: OpenFourLaunchMode;
  name: string;
  symbol: string;
  desc: string;
  imgUrl: string;
  imgFallbackUrls?: string[];
  webUrl?: string;
  twitterUrl?: string;
  telegramUrl?: string;
  fromAddress?: Address;
  quoteAmount?: string;
  antiSniperEnabled?: boolean;
  taxEnabled?: boolean;
  buyTaxBps?: number;
  sellTaxBps?: number;
  taxAlloc?: {
    founder?: number;
    burn?: number;
    holder?: number;
    liquidity?: number;
  };
};

export type OpenFourLaunchProgressStage =
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

export type OpenFourLaunchProgressEvent = {
  stage: OpenFourLaunchProgressStage;
  message: string;
  txHash?: `0x${string}`;
  tokenAddress?: `0x${string}` | null;
};

const templateCache = new Map<string, OpenFourResolvedTemplate>();
const TEMPLATE_ID_STORAGE_KEY = 'dagobang_openfour_4stock_template_id_v1';

function parseNativeBudget(raw?: string): bigint {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed === '0') return 0n;
  try {
    return parseEther(trimmed);
  } catch {
    throw new Error('初始注入金额无效');
  }
}

function parseCreateFeeWei(raw?: string | number): bigint {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed === '0') return 0n;
  try {
    return parseEther(trimmed);
  } catch {
    return 0n;
  }
}

function mapParamDescriptor(raw: any): ParamDescriptor {
  return {
    name: String(raw?.name ?? ''),
    abiType: String(raw?.abiType ?? 'uint256'),
    decimals: Number(raw?.decimals ?? 0),
    optional: Boolean(raw?.optional),
    title: String(raw?.title ?? ''),
    defaultValue: String(raw?.defaultValue ?? ''),
    hint: String(raw?.hint ?? ''),
    minValue: String(raw?.minValue ?? ''),
    maxValue: String(raw?.maxValue ?? ''),
  };
}

function mapModuleSchema(raw: any): ModuleSchema {
  const params = Array.isArray(raw?.params) ? raw.params.map(mapParamDescriptor) : [];
  return {
    kind: String(raw?.kind ?? ''),
    version: Number(raw?.version ?? 0),
    params,
  };
}

function defaultFormFromSchema(params: ParamDescriptor[]): Record<string, unknown> {
  const form: Record<string, unknown> = {};
  for (const param of params) {
    if (param.defaultValue !== '') {
      form[param.name] = param.defaultValue;
      continue;
    }
    const type = param.abiType.toLowerCase();
    if (type === 'bytes32' && /vaulttypeid/i.test(param.name)) {
      form[param.name] = ZERO_BYTES32;
    } else if (type === 'bytes' && /initparams/i.test(param.name)) {
      form[param.name] = '0x';
    }
  }
  return form;
}

function zeroValueForAbiType(abiType: string): unknown {
  const type = abiType.toLowerCase();
  if (type === 'address') return '0x0000000000000000000000000000000000000000';
  if (type === 'bool') return false;
  if (type === 'string') return '';
  if (type === 'bytes') return '0x';
  if (type === 'bytes32') return ZERO_BYTES32;
  return 0n;
}

function resolveParam(param: ParamDescriptor, form: Record<string, unknown>): unknown {
  const raw = form[param.name];
  const str = raw == null ? '' : String(raw).trim();
  const missing = raw == null || str === '';
  if (missing) {
    if (param.optional) return zeroValueForAbiType(param.abiType);
    throw new Error(`OpenFour 模板缺少必填参数：${param.title || param.name}`);
  }
  const type = param.abiType.toLowerCase();
  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    return str === 'true' || str === '1';
  }
  if (type === 'address') {
    if (!isAddress(str)) throw new Error(`OpenFour 参数 ${param.name} 不是合法地址`);
    return getAddress(str);
  }
  if (type === 'string') return str;
  if (type === 'bytes32') return str as Hex;
  if (type === 'bytes') return (str || '0x') as Hex;
  if (param.decimals > 0) return parseUnits(str, param.decimals);
  try {
    return BigInt(str);
  } catch {
    throw new Error(`OpenFour 参数 ${param.name} 不是合法数字`);
  }
}

function encodeModuleParams(schema: ModuleSchema, form: Record<string, unknown>): Hex {
  if (!schema.params.length) return '0x';
  const values = schema.params.map((param) => resolveParam(param, form));
  return encodeAbiParameters(
    [{
      type: 'tuple',
      components: schema.params.map((param) => ({
        name: param.name,
        type: param.abiType,
      })),
    }] as any,
    [values as any],
  );
}

type OpenFourPresetRow = {
  id: bigint;
  name: string;
  description: string;
  active: boolean;
  createEnabled: boolean;
};

function pick4StockPreset(presets: OpenFourPresetRow[]): OpenFourPresetRow {
  const matches = presets.filter((item) => isOpenFour4StockName(String(item.name || ''), item.description));
  if (matches.length <= 0) {
    throw new Error('链上未找到 OpenFour 4Stock preset，已跳过 Four.Meme 模板搜索以免触发限流');
  }
  const exact = matches.find((item) => String(item.name || '').replace(/[\s_-]+/g, '').toLowerCase() === '4stock');
  return exact
    || matches.find((item) => item.createEnabled && item.active)
    || matches.find((item) => item.createEnabled)
    || matches[0];
}

function wrapChainError(error: unknown, label: string): never {
  const msg = String((error as any)?.shortMessage || (error as any)?.message || error || '');
  if (/failed to fetch|http request failed|networkerror|load failed/i.test(msg)) {
    throw new Error(`${label}失败：BSC RPC 连不上，请检查节点设置后重试`);
  }
  throw error instanceof Error ? error : new Error(msg || label);
}

async function loadPresetIds(
  client: Awaited<ReturnType<typeof RpcService.getClient>>,
  registryAddress: Address,
): Promise<bigint[]> {
  try {
    const ids = await client.readContract({
      address: registryAddress,
      abi: openFourRegistryAbi,
      functionName: 'getPresetIds',
    });
    return [...ids];
  } catch {
    const count = await client.readContract({
      address: registryAddress,
      abi: openFourRegistryAbi,
      functionName: 'getPresetIdsCount',
    });
    const ids: bigint[] = [];
    const batch = 20n;
    for (let index = 0n; index < count; index += batch) {
      const chunk = await client.readContract({
        address: registryAddress,
        abi: openFourRegistryAbi,
        functionName: 'getPresetIdsByBatch',
        args: [index, batch],
      });
      ids.push(...chunk);
    }
    return ids;
  }
}

function parseTokenAddressFromCreatedLog(
  log: { address?: Address; topics: readonly Hex[]; data: Hex },
): Address | null {
  try {
    const decoded = decodeEventLog({
      abi: openFourCoreAbi,
      data: log.data,
      topics: log.topics,
    });
    if (decoded.eventName === 'TokenCreated') {
      const token = (decoded.args as any)?.token;
      if (typeof token === 'string' && isAddress(token)) return getAddress(token);
    }
  } catch {
  }
  const tokenTopic = log.topics?.[3];
  if (tokenTopic && /^0x[a-fA-F0-9]{64}$/.test(tokenTopic) && log.topics.length >= 4) {
    const candidate = `0x${tokenTopic.slice(-40)}`;
    if (isAddress(candidate) && candidate !== '0x0000000000000000000000000000000000000000') {
      return getAddress(candidate);
    }
  }
  return null;
}

function local4StockTemplate(templateId = ''): OpenFourResolvedTemplate {
  const local = getOpenFour4StockTemplate();
  return {
    mode: OPENFOUR_4STOCK_MODE,
    templateId: String(templateId || local.templateId || ''),
    name: local.name,
    tag: local.tag,
    descr: local.descr,
    quoteSymbol: local.quoteSymbol,
    quoteAddress: local.quoteAddress,
    quoteDecimals: local.quoteDecimals,
    raisedAmount: local.raisedAmount,
    saleAmount: local.saleAmount,
    totalSupply: local.totalSupply,
    createFee: local.createFee,
  };
}

async function readStoredTemplateId(): Promise<string> {
  try {
    const res = await browser.storage.local.get(TEMPLATE_ID_STORAGE_KEY as any);
    return String((res as any)?.[TEMPLATE_ID_STORAGE_KEY] || '').trim();
  } catch {
    return '';
  }
}

async function writeStoredTemplateId(templateId: string) {
  const id = String(templateId || '').trim();
  if (!id) return;
  try {
    await browser.storage.local.set({ [TEMPLATE_ID_STORAGE_KEY]: id } as any);
  } catch {
  }
}

export class TokenOpenFourLaunchService {
  static getTemplate(mode: OpenFourLaunchMode = OPENFOUR_4STOCK_MODE): OpenFourResolvedTemplate {
    if (mode !== OPENFOUR_4STOCK_MODE) {
      throw new Error('当前仅支持 OpenFour 4Stock 模式');
    }
    const cacheKey = `${ChainId.BNB}:${mode}`;
    const cached = templateCache.get(cacheKey);
    if (cached?.templateId) return cached;
    return local4StockTemplate(cached?.templateId || '');
  }

  private static async resolveTemplateIdIfNeeded(
    template: OpenFourResolvedTemplate,
    client: Awaited<ReturnType<typeof RpcService.getClient>>,
    registryAddress: Address,
  ): Promise<OpenFourResolvedTemplate> {
    if (template.templateId) return template;
    const stored = await readStoredTemplateId();
    if (stored) {
      const resolved = local4StockTemplate(stored);
      templateCache.set(`${ChainId.BNB}:${OPENFOUR_4STOCK_MODE}`, resolved);
      return resolved;
    }

    const ids = await loadPresetIds(client, registryAddress).catch((error) => wrapChainError(error, '读取 OpenFour preset 列表'));
    if (ids.length <= 0) {
      throw new Error('链上 OpenFour preset 列表为空，已跳过 Four.Meme 模板搜索以免触发限流');
    }
    const presets = (await Promise.all(ids.map(async (id) => {
      try {
        const preset = await client.readContract({
          address: registryAddress,
          abi: openFourRegistryAbi,
          functionName: 'getPreset',
          args: [id],
        });
        return {
          id: preset.id,
          name: String(preset.name || ''),
          description: String(preset.description || ''),
          active: Boolean(preset.active),
          createEnabled: Boolean(preset.createEnabled),
        } satisfies OpenFourPresetRow;
      } catch {
        return null;
      }
    }))).filter((item): item is OpenFourPresetRow => item != null);

    const match = pick4StockPreset(presets);
    const resolved = local4StockTemplate(String(match.id));
    templateCache.set(`${ChainId.BNB}:${OPENFOUR_4STOCK_MODE}`, resolved);
    await writeStoredTemplateId(resolved.templateId);
    return resolved;
  }

  static async createToken(
    input: CreateOpenFourTokenInput,
    opts?: { onProgress?: (event: OpenFourLaunchProgressEvent) => void | Promise<void> },
  ): Promise<{ txHash: `0x${string}`; tokenAddress: `0x${string}` | null; templateId: string; fromAddress: Address }> {
    const mode = input.mode || OPENFOUR_4STOCK_MODE;
    await opts?.onProgress?.({
      stage: 'prepare',
      message: '正在准备 OpenFour 4Stock 发射参数',
    });

    const settings = await SettingsService.get();
    const chainId = ChainId.BNB;
    const chainSettings = settings.chains[chainId] as ChainSettings | undefined;
    if (!chainSettings) throw new Error('BSC 链设置缺失');

    const registryAddress = OpenFourRegistryAddress[chainId];
    if (!registryAddress || !isAddress(registryAddress)) {
      throw new Error('OpenFour Registry 地址未配置');
    }
    const wrappedNative = DeployAddress[chainId]?.[ContractNames.WETH]?.address as Address | undefined;
    if (!wrappedNative) throw new Error('WBNB 地址未配置');

    const account = await WalletService.getSigner(input.fromAddress);
    const client = await RpcService.getClient(chainId);
    const gasPreset: GasPreset = chainSettings.buyGasPreset ?? chainSettings.gasPreset;
    const gasPriceWei = getGasPriceWei(chainSettings, gasPreset, 'buy');

    const template = await this.resolveTemplateIdIfNeeded(
      this.getTemplate(mode),
      client,
      registryAddress as Address,
    );
    const nativeBudgetWei = parseNativeBudget(input.quoteAmount);
    const quoteIsNative = template.quoteAddress.toLowerCase() === wrappedNative.toLowerCase();

    const [coreAddress, toolsAddress] = await Promise.all([
      client.readContract({
        address: registryAddress as Address,
        abi: openFourRegistryAbi,
        functionName: 'openFourCore',
      }),
      client.readContract({
        address: registryAddress as Address,
        abi: openFourRegistryAbi,
        functionName: 'openFourTool',
      }),
    ]).catch((error) => wrapChainError(error, '读取 OpenFour Registry'));
    if (!isAddress(coreAddress) || coreAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('OpenFour Core 地址无效');
    }
    if (!isAddress(toolsAddress) || toolsAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('OpenFour Tools 地址无效');
    }

    const schemasRaw = await client.readContract({
      address: toolsAddress,
      abi: openFourToolsAbi,
      functionName: 'getPresetEncodeSchemas',
      args: [BigInt(template.templateId)],
    }).catch((error) => wrapChainError(error, '读取 OpenFour 4Stock schema'));
    const schemas: PresetSchemas = {
      token: mapModuleSchema(schemasRaw[0]),
      vault: mapModuleSchema(schemasRaw[1]),
      curve: mapModuleSchema(schemasRaw[2]),
      trade: mapModuleSchema(schemasRaw[3]),
      migrate: mapModuleSchema(schemasRaw[4]),
      customData: mapModuleSchema(schemasRaw[5]),
    };
    const antiSniperEnabled = input.antiSniperEnabled !== false;
    const taxEnabled = input.taxEnabled !== false;
    const buyTaxBps = Math.max(0, Math.min(1000, Number(input.buyTaxBps ?? 100)));
    const sellTaxBps = Math.max(taxEnabled ? 100 : 0, Math.min(1000, Number(input.sellTaxBps ?? 100)));
    const taxAlloc = {
      founder: Number(input.taxAlloc?.founder ?? 100),
      burn: Number(input.taxAlloc?.burn ?? 0),
      holder: Number(input.taxAlloc?.holder ?? 0),
      liquidity: Number(input.taxAlloc?.liquidity ?? 0),
    };
    if (taxEnabled && taxAlloc.founder + taxAlloc.burn + taxAlloc.holder + taxAlloc.liquidity !== 100) {
      throw new Error('税费分配总和必须为 100%');
    }
    const schemaForm = {
      ...defaultFormFromSchema(schemas.token.params),
      ...defaultFormFromSchema(schemas.vault.params),
      ...defaultFormFromSchema(schemas.curve.params),
      ...defaultFormFromSchema(schemas.trade.params),
      ...defaultFormFromSchema(schemas.migrate.params),
      ...defaultFormFromSchema(schemas.customData.params),
      antiSniperEnabled,
      buyFeeRate: taxEnabled ? buyTaxBps : 0,
      sellFeeRate: taxEnabled ? sellTaxBps : 0,
      rateFounder: taxEnabled ? taxAlloc.founder : 0,
      rateBurn: taxEnabled ? taxAlloc.burn : 0,
      rateHolder: taxEnabled ? taxAlloc.holder : 0,
      rateLiquidity: taxEnabled ? taxAlloc.liquidity : 0,
      founder: account.address,
      minShare: 1000000,
    };
    const initParams: OpenFourCreateInitParams = {
      tokenParams: encodeModuleParams(schemas.token, schemaForm),
      vaultParams: encodeModuleParams(schemas.vault, schemaForm),
      curveParams: encodeModuleParams(schemas.curve, schemaForm),
      tradeParams: encodeModuleParams(schemas.trade, schemaForm),
      migrateParams: encodeModuleParams(schemas.migrate, schemaForm),
      customDataParams: encodeModuleParams(schemas.customData, schemaForm),
    };

    await opts?.onProgress?.({
      stage: 'launch_request',
      message: '正在登录 Four.Meme 申请创建签名',
    });
    const accessToken = await FourmemeAPI.getAccessToken({
      address: account.address,
      networkCode: 'BSC',
      walletName: 'Dagobang',
      signMessage: (message) => account.signMessage({ message }),
    });
    const imageCandidates = [
      input.imgUrl,
      ...(Array.isArray(input.imgFallbackUrls) ? input.imgFallbackUrls : []),
    ].map((item) => String(item || '').trim()).filter(Boolean);
    const uploadedImgUrl = await FourmemeAPI.uploadImageFromUrl(imageCandidates, accessToken);

    let presaleQuoteWei = 0n;
    if (nativeBudgetWei > 0n && !quoteIsNative) {
      const beforeBalance = await client.readContract({
        address: template.quoteAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      await opts?.onProgress?.({
        stage: 'swap_request',
        message: `正在把 BNB 兑换成 ${template.quoteSymbol}`,
      });
      const swapResult = await TradeService.buy({
        chainId,
        tokenAddress: template.quoteAddress,
        nativeAmountWei: nativeBudgetWei.toString(),
        baseTokenAddress: '0x0000000000000000000000000000000000000000',
        fromAddress: account.address,
        executionModeOverride: 'default',
      });
      await opts?.onProgress?.({
        stage: 'swap_submitted',
        message: `${template.quoteSymbol} 兑换已提交，等待确认`,
        txHash: swapResult.txHash,
      });
      await client.waitForTransactionReceipt({ hash: swapResult.txHash });
      const afterBalance = await client.readContract({
        address: template.quoteAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      });
      presaleQuoteWei = afterBalance - beforeBalance;
      if (presaleQuoteWei <= 0n) {
        throw new Error(`BNB 兑换 ${template.quoteSymbol} 失败：未收到 ${template.quoteSymbol}`);
      }
      await opts?.onProgress?.({
        stage: 'swap_confirmed',
        message: `已兑换 ${formatUnits(presaleQuoteWei, template.quoteDecimals)} ${template.quoteSymbol}`,
        txHash: swapResult.txHash,
      });
    } else if (nativeBudgetWei > 0n && quoteIsNative) {
      presaleQuoteWei = nativeBudgetWei;
    }

    if (presaleQuoteWei > 0n && !quoteIsNative) {
      const allowance = await client.readContract({
        address: template.quoteAddress,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [account.address, coreAddress],
      });
      if (allowance < presaleQuoteWei) {
        await opts?.onProgress?.({
          stage: 'approve_request',
          message: `正在授权 ${template.quoteSymbol} 给 OpenFour Core`,
        });
        const approveTxHash = await TradeService.approve(
          chainId,
          template.quoteAddress,
          coreAddress,
          maxUint256.toString(),
          account.address,
        );
        await opts?.onProgress?.({
          stage: 'approve_submitted',
          message: '授权已提交，等待确认',
          txHash: approveTxHash,
        });
        await client.waitForTransactionReceipt({ hash: approveTxHash });
        await opts?.onProgress?.({
          stage: 'approve_confirmed',
          message: `${template.quoteSymbol} 授权已确认`,
          txHash: approveTxHash,
        });
      }
    }

    const presaleQuote = presaleQuoteWei > 0n
      ? formatUnits(presaleQuoteWei, quoteIsNative ? 18 : template.quoteDecimals)
      : '0';
    await opts?.onProgress?.({
      stage: 'launch_request',
      message: '正在向 OpenFour 申请创建签名',
    });
    const createData = await FourmemeAPI.createOpenFourToken({
      templateId: /^\d+$/.test(template.templateId) ? Number(template.templateId) : template.templateId,
      name: input.name,
      shortName: input.symbol,
      symbol: template.quoteSymbol,
      desc: input.desc,
      imgUrl: uploadedImgUrl,
      webUrl: input.webUrl,
      telegramUrl: input.telegramUrl,
      twitterUrl: input.twitterUrl,
      presaleQuote,
      feePlan: taxEnabled,
      antiSniperEnabled,
      raisedAmount: template.raisedAmount || undefined,
      saleAmount: template.saleAmount || undefined,
      totalSupply: template.totalSupply || undefined,
      quoteAsset: template.quoteAddress,
      initParams,
    }, accessToken);

    const createArg = createData?.createArg;
    const sign = createData?.signature || createData?.sign;
    if (!createArg || !sign) {
      throw new Error('OpenFour 创建接口未返回 createArg/signature');
    }

    const createFeeWei = parseCreateFeeWei(createData.createFee ?? template.createFee);
    const txValue = quoteIsNative ? createFeeWei + presaleQuoteWei : createFeeWei;
    const data = encodeFunctionData({
      abi: openFourCoreAbi,
      functionName: 'createToken',
      args: [createArg as Hex, sign as Hex],
    });

    await opts?.onProgress?.({
      stage: 'launch_submitted',
      message: '正在提交 OpenFour createToken',
    });
    const { txHash } = await TradeService.sendTransaction(
      client,
      account,
      coreAddress,
      data,
      txValue,
      gasPriceWei,
      chainId,
      { skipEstimateGas: true, gasLimit: OPENFOUR_CREATE_GAS_LIMIT },
    );

    let tokenAddress: Address | null = null;
    const apiTokenAddress = String(createData?.tokenAddress || '').trim();
    if (isAddress(apiTokenAddress)) {
      tokenAddress = getAddress(apiTokenAddress);
    }
    try {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        timeout: 180_000,
      });
      for (const log of receipt.logs) {
        const parsed = parseTokenAddressFromCreatedLog(log as any);
        if (parsed) {
          tokenAddress = parsed;
          break;
        }
      }
    } catch {
    }

    await opts?.onProgress?.({
      stage: 'launch_confirmed',
      message: tokenAddress
        ? `OpenFour 发射成功：${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`
        : 'OpenFour 发射交易已确认',
      txHash,
      tokenAddress,
    });

    return {
      txHash,
      tokenAddress,
      templateId: template.templateId,
      fromAddress: account.address,
    };
  }
}
