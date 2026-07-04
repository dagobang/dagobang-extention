import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { validateSettings } from '@/utils/validate';
import { call } from '@/utils/messaging';
import type { SolanaSwqosProviderType } from '@/types/extention';
import type { SettingsDraftProps } from './types';
import { defaultSettings } from '@/utils/defaults';
import { ChainId } from '@/constants/chains/chainId';
import { chainNames, getNativeSymbol } from '@/constants/chains';

type NetworkSettingsProps = SettingsDraftProps;
const SOLANA_SWQOS_STRATEGIES = ['single', 'concurrent'] as const;
const SOLANA_SWQOS_REGIONS = ['default', 'newyork', 'frankfurt', 'amsterdam', 'slc', 'tokyo', 'london', 'losangeles'] as const;
const SOLANA_SWQOS_PROVIDERS = ['jito', 'blox', 'nextblock', 'temporal', 'zeroslot', 'node1', 'flashblock', 'blockrazor', 'astralane'] as const;
const SOLANA_SWQOS_ENDPOINT_CUSTOM = '__custom__';
const SOLANA_SWQOS_ENDPOINT_DEFAULT = '__default__';
const SOLANA_SWQOS_PROVIDER_ENDPOINTS: Record<(typeof SOLANA_SWQOS_PROVIDERS)[number], Record<(typeof SOLANA_SWQOS_REGIONS)[number], string>> = {
  jito: {
    default: 'https://mainnet.block-engine.jito.wtf',
    newyork: 'https://ny.mainnet.block-engine.jito.wtf',
    frankfurt: 'https://frankfurt.mainnet.block-engine.jito.wtf',
    amsterdam: 'https://amsterdam.mainnet.block-engine.jito.wtf',
    slc: 'https://slc.mainnet.block-engine.jito.wtf',
    tokyo: 'https://tokyo.mainnet.block-engine.jito.wtf',
    london: 'https://london.mainnet.block-engine.jito.wtf',
    losangeles: 'https://ny.mainnet.block-engine.jito.wtf',
  },
  blox: {
    default: 'https://germany.solana.dex.blxrbdn.com',
    newyork: 'https://ny.solana.dex.blxrbdn.com',
    frankfurt: 'https://germany.solana.dex.blxrbdn.com',
    amsterdam: 'https://amsterdam.solana.dex.blxrbdn.com',
    slc: 'https://ny.solana.dex.blxrbdn.com',
    tokyo: 'https://tokyo.solana.dex.blxrbdn.com',
    london: 'https://uk.solana.dex.blxrbdn.com',
    losangeles: 'https://la.solana.dex.blxrbdn.com',
  },
  nextblock: {
    default: 'http://frankfurt.nextblock.io',
    newyork: 'http://ny.nextblock.io',
    frankfurt: 'http://frankfurt.nextblock.io',
    amsterdam: 'http://amsterdam.nextblock.io',
    slc: 'http://slc.nextblock.io',
    tokyo: 'http://tokyo.nextblock.io',
    london: 'http://london.nextblock.io',
    losangeles: 'http://singapore.nextblock.io',
  },
  temporal: {
    default: 'http://fra2.nozomi.temporal.xyz',
    newyork: 'http://ewr1.nozomi.temporal.xyz',
    frankfurt: 'http://fra2.nozomi.temporal.xyz',
    amsterdam: 'http://ams1.nozomi.temporal.xyz',
    slc: 'http://ewr1.nozomi.temporal.xyz',
    tokyo: 'http://tyo1.nozomi.temporal.xyz',
    london: 'http://sgp1.nozomi.temporal.xyz',
    losangeles: 'http://pit1.nozomi.temporal.xyz',
  },
  zeroslot: {
    default: 'http://de.0slot.trade',
    newyork: 'http://ny.0slot.trade',
    frankfurt: 'http://de.0slot.trade',
    amsterdam: 'http://ams.0slot.trade',
    slc: 'http://ny.0slot.trade',
    tokyo: 'http://jp.0slot.trade',
    london: 'http://ams.0slot.trade',
    losangeles: 'http://la.0slot.trade',
  },
  node1: {
    default: 'http://fra.node1.me',
    newyork: 'http://ny.node1.me',
    frankfurt: 'http://fra.node1.me',
    amsterdam: 'http://ams.node1.me',
    slc: 'http://ny.node1.me',
    tokyo: 'http://fra.node1.me',
    london: 'http://ams.node1.me',
    losangeles: 'http://ny.node1.me',
  },
  flashblock: {
    default: 'http://ny.flashblock.trade',
    newyork: 'http://ny.flashblock.trade',
    frankfurt: 'http://fra.flashblock.trade',
    amsterdam: 'http://ams.flashblock.trade',
    slc: 'http://slc.flashblock.trade',
    tokyo: 'http://singapore.flashblock.trade',
    london: 'http://london.flashblock.trade',
    losangeles: 'http://ny.flashblock.trade',
  },
  blockrazor: {
    default: 'http://frankfurt.solana.blockrazor.xyz:443/sendTransaction',
    newyork: 'http://newyork.solana.blockrazor.xyz:443/sendTransaction',
    frankfurt: 'http://frankfurt.solana.blockrazor.xyz:443/sendTransaction',
    amsterdam: 'http://amsterdam.solana.blockrazor.xyz:443/sendTransaction',
    slc: 'http://newyork.solana.blockrazor.xyz:443/sendTransaction',
    tokyo: 'http://tokyo.solana.blockrazor.xyz:443/sendTransaction',
    london: 'http://frankfurt.solana.blockrazor.xyz:443/sendTransaction',
    losangeles: 'http://newyork.solana.blockrazor.xyz:443/sendTransaction',
  },
  astralane: {
    default: 'http://lim.gateway.astralane.io/iris',
    newyork: 'http://ny.gateway.astralane.io/iris',
    frankfurt: 'http://fr.gateway.astralane.io/iris',
    amsterdam: 'http://ams.gateway.astralane.io/iris',
    slc: 'http://ny.gateway.astralane.io/iris',
    tokyo: 'http://jp.gateway.astralane.io/iris',
    london: 'http://ny.gateway.astralane.io/iris',
    losangeles: 'http://lax.gateway.astralane.io/iris',
  },
};

export function NetworkSettings({ settingsDraft, setSettingsDraft, tt }: NetworkSettingsProps) {
  const chainId = settingsDraft.chainId;
  const defaults = defaultSettings();
  const fallbackChainDraft = defaults.chains[defaults.chainId];
  const chainDraft = settingsDraft.chains[chainId] ?? defaults.chains[chainId] ?? fallbackChainDraft;
  const isSolana = chainId === ChainId.SOL;
  const protectedRpcUrlsBuyDraft = (chainDraft.protectedRpcUrlsBuy ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const protectedRpcUrlsSellDraft = (chainDraft.protectedRpcUrlsSell ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const protectedRpcUrlsDraft = (chainDraft.protectedRpcUrls ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
  const validatedChain = validateSettings(settingsDraft)?.chains[chainId];
  const protectedRpcUrlsValidated = validatedChain?.protectedRpcUrls ?? [];
  const protectedRpcUrlsBuyValidated = validatedChain?.protectedRpcUrlsBuy ?? [];
  const protectedRpcUrlsSellValidated = validatedChain?.protectedRpcUrlsSell ?? [];
  const hasInvalidProtectedRpcUrls = protectedRpcUrlsValidated.length < protectedRpcUrlsDraft.length && !settingsDraft.bloxrouteAuthHeader;
  const hasInvalidProtectedRpcUrlsBuy = protectedRpcUrlsBuyValidated.length < protectedRpcUrlsBuyDraft.length && !settingsDraft.bloxrouteAuthHeader;
  const hasInvalidProtectedRpcUrlsSell = protectedRpcUrlsSellValidated.length < protectedRpcUrlsSellDraft.length && !settingsDraft.bloxrouteAuthHeader;
  const protectedRpcHint1 = isSolana
    ? tt('popup.settings.protectedRpcUrlsSolHint1')
    : tt('popup.settings.protectedRpcUrlsHint1');
  const protectedRpcHint2 = isSolana
    ? tt('popup.settings.protectedRpcUrlsSolHint2')
    : tt('popup.settings.protectedRpcUrlsHint2');
  const [bloxProbe, setBloxProbe] = useState<null | { status: 'reachable' | 'failed'; httpStatus?: number; message?: string; hasAuthHeader: boolean }>(null);
  const [bloxProbeLoading, setBloxProbeLoading] = useState(false);
  const [solanaSwqosProbeMap, setSolanaSwqosProbeMap] = useState<Record<string, {
    status: 'reachable' | 'failed';
    category?: 'ok' | 'auth_required' | 'auth_failed' | 'bad_endpoint' | 'rate_limited' | 'payload_rejected' | 'server_error' | 'timeout' | 'network_error';
    httpStatus?: number;
    message?: string;
    submitUrl?: string;
    hasAuthKey: boolean;
  }>>({});
  const [solanaSwqosProbeLoadingType, setSolanaSwqosProbeLoadingType] = useState<string | null>(null);
  const [expandedSolanaSwqosProvider, setExpandedSolanaSwqosProvider] = useState<SolanaSwqosProviderType | null>('jito');
  const [solanaSwqosEndpointModeMap, setSolanaSwqosEndpointModeMap] = useState<Record<string, string>>({});
  const [showEnabledSolanaSwqosOnly, setShowEnabledSolanaSwqosOnly] = useState(false);
  const bloxAuthDraft = useMemo(() => String(settingsDraft.bloxrouteAuthHeader ?? '').replace(/[\r\n]+/g, '').trim(), [settingsDraft.bloxrouteAuthHeader]);
  const showBloxrouteSettings = !isSolana && chainId !== ChainId.HYPER;
  const solanaSwqosDraft = chainDraft.solanaSwqos ?? defaults.chains[ChainId.SOL]?.solanaSwqos ?? {
    enabled: false,
    strategy: 'concurrent',
    timeoutMs: 10_000,
    region: 'default',
    providers: [],
  };
  const solanaSwqosProviders = SOLANA_SWQOS_PROVIDERS.map((type) => {
    const provider = (solanaSwqosDraft.providers ?? []).find((item) => item.type === type);
    return provider ?? { type, enabled: false, authKey: '', endpoint: '', weight: 1 };
  });
  const visibleSolanaSwqosProviders = useMemo(() => {
    const ordered = [...solanaSwqosProviders].sort((left, right) => {
      if (!!left.enabled !== !!right.enabled) return left.enabled ? -1 : 1;
      return SOLANA_SWQOS_PROVIDERS.indexOf(left.type) - SOLANA_SWQOS_PROVIDERS.indexOf(right.type);
    });
    return showEnabledSolanaSwqosOnly ? ordered.filter((provider) => provider.enabled) : ordered;
  }, [solanaSwqosProviders, showEnabledSolanaSwqosOnly]);
  const enabledSolanaSwqosProviderCount = useMemo(
    () => solanaSwqosProviders.filter((provider) => provider.enabled).length,
    [solanaSwqosProviders]
  );
  const solanaSwqosRegionLabelMap = useMemo(
    () =>
      SOLANA_SWQOS_REGIONS.reduce<Record<string, string>>((acc, region) => {
        acc[region] = tt(`popup.settings.solanaSwqosRegionOptions.${region}`);
        return acc;
      }, {}),
    [tt]
  );

  function updateCurrentChain(mutator: (chain: typeof chainDraft) => typeof chainDraft) {
    setSettingsDraft((s) => ({
      ...s,
      chains: {
        ...s.chains,
        [s.chainId]: mutator(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
      },
    }));
  }

  function updateSolanaSwqos(patch: Partial<typeof solanaSwqosDraft>) {
    updateCurrentChain((chain) => ({
      ...chain,
      solanaSwqos: {
        ...(chain.solanaSwqos ?? solanaSwqosDraft),
        ...patch,
      },
    }));
  }

  function updateSolanaSwqosProvider(type: (typeof SOLANA_SWQOS_PROVIDERS)[number], patch: Record<string, unknown>) {
    updateCurrentChain((chain) => {
      const current = chain.solanaSwqos ?? solanaSwqosDraft;
      const providers = [...(current.providers ?? [])];
      const index = providers.findIndex((provider) => provider.type === type);
      const base = index >= 0
        ? providers[index]
        : { type, enabled: false, authKey: '', endpoint: '', weight: 1 };
      const next = { ...base, ...patch };
      if (index >= 0) providers[index] = next as any;
      else providers.push(next as any);
      return {
        ...chain,
        solanaSwqos: {
          ...current,
          providers,
        },
      };
    });
  }

  function getProviderEndpointSelectValue(provider: (typeof solanaSwqosProviders)[number]): string {
    const storedMode = solanaSwqosEndpointModeMap[provider.type];
    if (storedMode) return storedMode;
    const endpoint = String(provider.endpoint ?? '').trim();
    if (!endpoint) return SOLANA_SWQOS_ENDPOINT_DEFAULT;
    const presetValues = Object.values(SOLANA_SWQOS_PROVIDER_ENDPOINTS[provider.type] ?? {});
    return presetValues.includes(endpoint) ? endpoint : SOLANA_SWQOS_ENDPOINT_CUSTOM;
  }

  function getProviderEndpointOptions(providerType: (typeof SOLANA_SWQOS_PROVIDERS)[number]) {
    const endpointMap = SOLANA_SWQOS_PROVIDER_ENDPOINTS[providerType];
    const grouped = new Map<string, string[]>();
    SOLANA_SWQOS_REGIONS.forEach((region) => {
      const endpoint = endpointMap[region];
      const nextRegions = grouped.get(endpoint) ?? [];
      nextRegions.push(solanaSwqosRegionLabelMap[region] ?? region);
      grouped.set(endpoint, nextRegions);
    });
    return Array.from(grouped.entries()).map(([endpoint, regionLabels]) => ({
      value: endpoint,
      label: `${regionLabels.join(' / ')} · ${endpoint}`,
    }));
  }

  function getProviderEndpointSummaryLabel(endpointSelectValue: string) {
    if (endpointSelectValue === SOLANA_SWQOS_ENDPOINT_DEFAULT) {
      return tt('popup.settings.solanaSwqosEndpointSummaryDefault');
    }
    if (endpointSelectValue === SOLANA_SWQOS_ENDPOINT_CUSTOM) {
      return tt('popup.settings.solanaSwqosEndpointSummaryCustom');
    }
    return tt('popup.settings.solanaSwqosEndpointSummaryPreset');
  }

  function getProbeCategoryKey(probe?: {
    status: 'reachable' | 'failed';
    category?: 'ok' | 'auth_required' | 'auth_failed' | 'bad_endpoint' | 'rate_limited' | 'payload_rejected' | 'server_error' | 'timeout' | 'network_error';
  }) {
    return probe?.category || (probe?.status === 'reachable' ? 'ok' : 'network_error');
  }

  useEffect(() => {
    if (isSolana) return;
    setSettingsDraft((s) => {
      const cid = s.chainId;
      const chain = s.chains[cid] ?? defaults.chains[cid] ?? fallbackChainDraft;
      if (chain?.antiMev && s.chains[cid]) return s;
      return {
        ...s,
        chains: {
          ...s.chains,
          [cid]: {
            ...chain,
            antiMev: true,
          },
        },
      };
    });
  }, [setSettingsDraft, chainId, defaults.chains, fallbackChainDraft, isSolana]);

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-zinc-300">
        当前链：<span className="font-semibold uppercase">{chainNames[chainId] || String(chainId)}</span>（{getNativeSymbol(chainId)}）
      </div>

      <div className="space-y-3 pt-4 border-t border-zinc-800">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{tt('popup.settings.network')}</div>
        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.rpcUrls')}</div>
          <textarea
            rows={4}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
            value={(chainDraft.rpcUrls ?? []).join('\n')}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                chains: {
                  ...s.chains,
                  [s.chainId]: {
                    ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                    rpcUrls: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.protectedRpcUrls')}</div>
          <textarea
            rows={4}
            aria-multiline={true}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
            value={(chainDraft.protectedRpcUrls ?? []).join('\n')}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                chains: {
                  ...s.chains,
                  [s.chainId]: {
                    ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                    antiMev: true,
                    protectedRpcUrls: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
          <div className="text-[11px] text-zinc-500">{protectedRpcHint1}</div>
          <div className="text-[11px] text-zinc-500">{protectedRpcHint2}</div>
          {hasInvalidProtectedRpcUrls && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsInvalidWarning')}</div>
          )}
          {protectedRpcUrlsValidated.length === 0 && !settingsDraft.bloxrouteAuthHeader && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsEmptyError')}</div>
          )}
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.protectedRpcUrlsBuy')}</div>
          <textarea
            rows={3}
            aria-multiline={true}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
            value={(chainDraft.protectedRpcUrlsBuy ?? []).join('\n')}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                chains: {
                  ...s.chains,
                  [s.chainId]: {
                    ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                    antiMev: true,
                    protectedRpcUrlsBuy: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.protectedRpcUrlsBuyHint')}</div>
          {hasInvalidProtectedRpcUrlsBuy && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsInvalidWarning')}</div>
          )}
        </label>

        <label className="block space-y-1">
          <div className="text-[14px] text-zinc-400">{tt('popup.settings.protectedRpcUrlsSell')}</div>
          <textarea
            rows={3}
            aria-multiline={true}
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[14px] outline-none resize-y"
            value={(chainDraft.protectedRpcUrlsSell ?? []).join('\n')}
            onChange={(e) =>
              setSettingsDraft((s) => ({
                ...s,
                chains: {
                  ...s.chains,
                  [s.chainId]: {
                    ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                    antiMev: true,
                    protectedRpcUrlsSell: e.target.value.split('\n'),
                  },
                },
              }))
            }
          />
          <div className="text-[11px] text-zinc-500">{tt('popup.settings.protectedRpcUrlsSellHint')}</div>
          {hasInvalidProtectedRpcUrlsSell && (
            <div className="text-[11px] text-red-400">{tt('popup.settings.protectedRpcUrlsInvalidWarning')}</div>
          )}
        </label>

        {showBloxrouteSettings ? (
          <label className="block space-y-1">
            <div className="text-[14px] text-zinc-400">{tt('popup.settings.bloxrouteAuthHeaderLabel')}</div>
            <input
              type="password"
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[14px] outline-none"
              value={settingsDraft.bloxrouteAuthHeader ?? ''}
              onChange={(e) =>
                setSettingsDraft((s) => ({
                  ...s,
                  bloxrouteAuthHeader: e.target.value,
                }))
              }
              placeholder={tt('popup.settings.bloxrouteAuthHeaderPlaceholder')}
            />
            <div className="text-[11px] text-zinc-500">
              {tt('popup.settings.bloxrouteAuthHeaderApplyHint')}{' '}
              <a className="underline hover:text-zinc-300" href="https://portal.bloxroute.com/" target="_blank" rel="noreferrer">
                https://portal.bloxroute.com/
              </a>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-[12px] text-zinc-300">{tt('popup.settings.bloxrouteBuyEnabled')}</div>
                <input
                  type="checkbox"
                  checked={chainDraft.bloxrouteBuyEnabled ?? true}
                  onChange={(e) =>
                    setSettingsDraft((s) => ({
                      ...s,
                      chains: {
                        ...s.chains,
                        [s.chainId]: {
                          ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                          bloxrouteBuyEnabled: e.target.checked,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2">
                <div className="text-[12px] text-zinc-300">{tt('popup.settings.bloxrouteSellEnabled')}</div>
                <input
                  type="checkbox"
                  checked={chainDraft.bloxrouteSellEnabled ?? true}
                  onChange={(e) =>
                    setSettingsDraft((s) => ({
                      ...s,
                      chains: {
                        ...s.chains,
                        [s.chainId]: {
                          ...(s.chains[s.chainId] ?? defaults.chains[s.chainId] ?? fallbackChainDraft),
                          bloxrouteSellEnabled: e.target.checked,
                        },
                      },
                    }))
                  }
                />
              </label>
            </div>
            <div className="text-[11px] text-zinc-500">
              优先费模式下若 bloXroute 连通性测试通过，则优先走 bloXroute；否则回退到 BlockRazor/RPC Bundle 路由。
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
                disabled={bloxProbeLoading}
                onClick={async () => {
                  setBloxProbeLoading(true);
                  try {
                    const res = await call({ type: 'bloxroute:probe', authHeader: bloxAuthDraft } as const);
                    setBloxProbe(res);
                  } catch (e: any) {
                    setBloxProbe({ status: 'failed', message: String(e?.message || e || ''), hasAuthHeader: !!bloxAuthDraft });
                  } finally {
                    setBloxProbeLoading(false);
                  }
                }}
              >
                {bloxProbeLoading ? tt('popup.settings.bloxrouteProbeTesting') : tt('popup.settings.bloxrouteProbeTest')}
              </button>
              <button
                type="button"
                className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
                onClick={() => call({ type: 'bloxroute:openCertPage' } as const).catch(() => { })}
              >
                {tt('popup.settings.bloxrouteOpenCertPage')}
              </button>
            </div>
            {bloxProbe?.status === 'reachable' && (
              <div className="text-[11px] text-emerald-400">
                {tt('popup.settings.bloxrouteProbeOk')} {typeof bloxProbe.httpStatus === 'number' ? `(${bloxProbe.httpStatus})` : ''}
                {!bloxProbe.hasAuthHeader ? ` · ${tt('popup.settings.bloxrouteProbeNoAuth')}` : ''}
              </div>
            )}
            {bloxProbe?.status === 'failed' && (
              <div className="text-[11px] text-red-400">
                {tt('popup.settings.bloxrouteProbeFailed')}
                {bloxProbe.message ? `: ${bloxProbe.message}` : ''}
                {' · '}
                {tt('popup.settings.bloxrouteProbeFailedHint')}
              </div>
            )}
          </label>
        ) : null}

        {isSolana ? (
          <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[14px] text-zinc-300">{tt('popup.settings.solanaSwqos')}</div>
                <div className="text-[11px] text-zinc-500">{tt('popup.settings.solanaSwqosHint')}</div>
              </div>
              <input
                type="checkbox"
                checked={!!solanaSwqosDraft.enabled}
                onChange={(e) => updateSolanaSwqos({ enabled: e.target.checked })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <div className="text-[12px] text-zinc-400">{tt('popup.settings.solanaSwqosStrategy')}</div>
                <select
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-[14px] outline-none"
                  value={solanaSwqosDraft.strategy ?? 'concurrent'}
                  onChange={(e) => updateSolanaSwqos({ strategy: e.target.value as (typeof SOLANA_SWQOS_STRATEGIES)[number] })}
                >
                  {SOLANA_SWQOS_STRATEGIES.map((strategy) => (
                    <option key={strategy} value={strategy}>{tt(`popup.settings.solanaSwqosStrategyOptions.${strategy}`)}</option>
                  ))}
                </select>
              </label>

              <label className="block space-y-1">
                <div className="text-[12px] text-zinc-400">{tt('popup.settings.solanaSwqosRegion')}</div>
                <select
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-[14px] outline-none"
                  value={solanaSwqosDraft.region ?? 'default'}
                  onChange={(e) => updateSolanaSwqos({ region: e.target.value as (typeof SOLANA_SWQOS_REGIONS)[number] })}
                >
                  {SOLANA_SWQOS_REGIONS.map((region) => (
                    <option key={region} value={region}>{tt(`popup.settings.solanaSwqosRegionOptions.${region}`)}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <div className="text-[12px] text-zinc-400">{tt('popup.settings.solanaSwqosTimeoutMs')}</div>
              <input
                type="number"
                min={1000}
                max={30000}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-2 text-[14px] outline-none"
                value={solanaSwqosDraft.timeoutMs ?? 10000}
                onChange={(e) => updateSolanaSwqos({ timeoutMs: Number(e.target.value || 10000) })}
              />
            </label>

            <div className="space-y-2">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                  <div className="text-[12px] text-zinc-400">{tt('popup.settings.solanaSwqosProviders')}</div>
                  <div className="text-[11px] text-zinc-500">{tt('popup.settings.solanaSwqosProvidersHint')}</div>
                  </div>
                  <div className="shrink-0 rounded-full border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-500">
                    {enabledSolanaSwqosProviderCount}/{solanaSwqosProviders.length}
                  </div>
                </div>
                <div className="flex justify-end">
                  <label className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-800 bg-zinc-950 px-2 py-1 text-[10px] text-zinc-500">
                    <input
                      type="checkbox"
                      checked={showEnabledSolanaSwqosOnly}
                      onChange={(e) => setShowEnabledSolanaSwqosOnly(e.target.checked)}
                    />
                    <span>{tt('popup.settings.solanaSwqosShowEnabledOnly')}</span>
                  </label>
                </div>
              </div>
              {visibleSolanaSwqosProviders.map((provider) => (
                (() => {
                  const isExpanded = expandedSolanaSwqosProvider === provider.type;
                  const endpointSelectValue = getProviderEndpointSelectValue(provider);
                  const endpointOptions = getProviderEndpointOptions(provider.type);
                  const probe = solanaSwqosProbeMap[provider.type];
                  const summaryEndpoint = getProviderEndpointSummaryLabel(endpointSelectValue);
                  const probeCategoryKey = getProbeCategoryKey(probe);
                  return (
                    <div
                      key={provider.type}
                      className={`rounded-md border px-3 py-2 transition-colors ${provider.enabled ? 'border-cyan-800/50 bg-zinc-950' : 'border-zinc-800 bg-zinc-950/70'}`}
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => setExpandedSolanaSwqosProvider((prev) => (prev === provider.type ? null : provider.type))}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            {isExpanded ? <ChevronDown size={14} className="shrink-0 text-zinc-400" /> : <ChevronRight size={14} className="shrink-0 text-zinc-400" />}
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-200">{tt(`popup.settings.solanaSwqosProviderLabels.${provider.type}`)}</span>
                            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${provider.enabled ? 'bg-cyan-900/60 text-cyan-200' : 'bg-zinc-800 text-zinc-400'}`}>
                              {provider.enabled ? tt('popup.settings.solanaSwqosEnabled') : tt('popup.settings.solanaSwqosDisabled')}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6 text-[10px] text-zinc-500">
                            <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 whitespace-nowrap">
                              {tt('popup.settings.solanaSwqosWeight')}: {provider.weight ?? 1}
                            </span>
                            <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 whitespace-nowrap">
                              {provider.authKey ? tt('popup.settings.solanaSwqosAuthConfigured') : tt('popup.settings.solanaSwqosAuthPublic')}
                            </span>
                            <span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 whitespace-nowrap">
                              {summaryEndpoint}
                            </span>
                          </div>
                          {probe ? (
                            <div className="mt-2 pl-6">
                              <span
                                title={tt(`popup.settings.solanaSwqosProbeCategory.${probeCategoryKey}`)}
                                className={`inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[10px] whitespace-nowrap ${
                                  probe.status === 'reachable'
                                    ? 'bg-emerald-950/70 text-emerald-300'
                                    : 'bg-red-950/60 text-red-300'
                                }`}
                              >
                                {tt(`popup.settings.solanaSwqosProbeCompactCategory.${probeCategoryKey}`)}
                              </span>
                            </div>
                          ) : null}
                        </button>
                        <div className="flex shrink-0 items-start pt-0.5">
                          <input
                            type="checkbox"
                            checked={!!provider.enabled}
                            onChange={(e) => updateSolanaSwqosProvider(provider.type, { enabled: e.target.checked })}
                          />
                        </div>
                      </div>
                      {isExpanded ? (
                        <div className="mt-3 space-y-3 border-t border-zinc-800/80 pt-3">
                          <div className="grid grid-cols-2 gap-3">
                            <label className="block space-y-1">
                              <div className="text-[11px] text-zinc-500">{tt('popup.settings.solanaSwqosWeight')}</div>
                              <input
                                type="number"
                                min={1}
                                max={100}
                                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[13px] outline-none"
                                value={provider.weight ?? 1}
                                onChange={(e) => updateSolanaSwqosProvider(provider.type, { weight: Number(e.target.value || 1) })}
                              />
                            </label>
                            <label className="block space-y-1">
                              <div className="text-[11px] text-zinc-500">{tt('popup.settings.solanaSwqosAuthKey')}</div>
                              <input
                                type="password"
                                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[13px] outline-none"
                                value={provider.authKey ?? ''}
                                onChange={(e) => updateSolanaSwqosProvider(provider.type, { authKey: e.target.value })}
                                placeholder={tt('popup.settings.solanaSwqosAuthKeyPlaceholder')}
                              />
                            </label>
                          </div>
                          <label className="block space-y-1">
                            <div className="text-[11px] text-zinc-500">{tt('popup.settings.solanaSwqosEndpoint')}</div>
                            <select
                              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[13px] outline-none"
                              value={endpointSelectValue}
                              onChange={(e) => {
                                const nextValue = e.target.value;
                                setSolanaSwqosEndpointModeMap((prev) => ({ ...prev, [provider.type]: nextValue }));
                                if (nextValue === SOLANA_SWQOS_ENDPOINT_DEFAULT) {
                                  updateSolanaSwqosProvider(provider.type, { endpoint: '' });
                                  return;
                                }
                                if (nextValue === SOLANA_SWQOS_ENDPOINT_CUSTOM) {
                                  if (!String(provider.endpoint ?? '').trim() || endpointOptions.some((option) => option.value === String(provider.endpoint ?? '').trim())) {
                                    updateSolanaSwqosProvider(provider.type, { endpoint: '' });
                                  }
                                  return;
                                }
                                updateSolanaSwqosProvider(provider.type, { endpoint: nextValue });
                              }}
                            >
                              <option value={SOLANA_SWQOS_ENDPOINT_DEFAULT}>{tt('popup.settings.solanaSwqosEndpointOptionDefault')}</option>
                              {endpointOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                              <option value={SOLANA_SWQOS_ENDPOINT_CUSTOM}>{tt('popup.settings.solanaSwqosEndpointOptionCustom')}</option>
                            </select>
                          </label>
                          {endpointSelectValue === SOLANA_SWQOS_ENDPOINT_CUSTOM ? (
                            <label className="block space-y-1">
                              <div className="text-[11px] text-zinc-500">{tt('popup.settings.solanaSwqosEndpointCustom')}</div>
                              <input
                                type="text"
                                className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2 text-[13px] outline-none"
                                value={provider.endpoint ?? ''}
                                onChange={(e) => updateSolanaSwqosProvider(provider.type, { endpoint: e.target.value })}
                                placeholder={tt('popup.settings.solanaSwqosEndpointPlaceholder')}
                              />
                            </label>
                          ) : null}
                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              className="rounded-md bg-zinc-800 px-3 py-2 text-xs font-semibold disabled:opacity-60 hover:bg-zinc-700 transition-colors"
                              disabled={solanaSwqosProbeLoadingType === provider.type}
                              onClick={async () => {
                                setSolanaSwqosProbeLoadingType(provider.type);
                                try {
                                  const res = await call({
                                    type: 'solanaSwqos:probe',
                                    providerType: provider.type,
                                    authKey: provider.authKey ?? '',
                                    endpoint: provider.endpoint ?? '',
                                    region: solanaSwqosDraft.region ?? 'default',
                                    timeoutMs: solanaSwqosDraft.timeoutMs ?? 5000,
                                  } as const);
                                  setSolanaSwqosProbeMap((prev) => ({
                                    ...prev,
                                    [provider.type]: {
                                      status: res.status,
                                      category: res.category,
                                      httpStatus: res.httpStatus,
                                      message: res.message,
                                      submitUrl: res.submitUrl,
                                      hasAuthKey: res.hasAuthKey,
                                    },
                                  }));
                                } catch (e: any) {
                                  setSolanaSwqosProbeMap((prev) => ({
                                    ...prev,
                                    [provider.type]: {
                                      status: 'failed',
                                      category: 'network_error',
                                      message: String(e?.message || e || ''),
                                      hasAuthKey: !!String(provider.authKey ?? '').trim(),
                                    },
                                  }));
                                } finally {
                                  setSolanaSwqosProbeLoadingType((prev) => (prev === provider.type ? null : prev));
                                }
                              }}
                            >
                              {solanaSwqosProbeLoadingType === provider.type
                                ? tt('popup.settings.solanaSwqosProbeTesting')
                                : tt('popup.settings.solanaSwqosProbeTest')}
                            </button>
                            {probe?.status === 'reachable' ? (
                              <div className="text-[11px] text-emerald-400">
                                {tt(`popup.settings.solanaSwqosProbeCategory.${probe.category || 'ok'}`)}
                                {typeof probe.httpStatus === 'number' ? ` (${probe.httpStatus})` : ''}
                                {!probe.hasAuthKey ? ` · ${tt('popup.settings.solanaSwqosProbeNoAuth')}` : ''}
                              </div>
                            ) : null}
                            {probe?.status === 'failed' ? (
                              <div className="text-[11px] text-red-400">
                                {tt(`popup.settings.solanaSwqosProbeCategory.${probe.category || 'network_error'}`)}
                                {probe.message ? `: ${probe.message}` : ''}
                              </div>
                            ) : null}
                          </div>
                          {probe?.submitUrl ? (
                            <div className="text-[11px] text-zinc-500 break-all">
                              {tt('popup.settings.solanaSwqosProbeSubmitUrl')}: {probe.submitUrl}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })()
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
