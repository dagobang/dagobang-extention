import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { Settings } from '@/types/extention';
import { RpcService } from '@/services/rpc';
import { t, type Locale } from '@/utils/i18n';
import { call } from '@/utils/messaging';

type RpcPanelProps = {
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  settings: Settings | null;
  locale: Locale;
};

type RpcLatency = {
  url: string;
  latencyMs: number | null;
  ok: boolean;
  measured: boolean;
  group: 'protected' | 'public';
};

type RpcNodeProfile = {
  url: string;
  ewmaLatencyMs: number;
  learnedNodeConcurrency: number;
  inFlight: number;
  cooldownUntil: number;
  cooldownRemainingMs: number;
  consecutive429: number;
  total429Count: number;
  last429At: number;
  businessSuccessCount: number;
  businessFailCount: number;
  probeSuccessCount: number;
  probeFailCount: number;
  lastProbeAt: number;
  lastCapacityProbeAt: number;
};

type SortKey = 'name' | 'score' | 'latency' | 'usage';

export function RpcPanel({ visible, onVisibleChange, settings, locale }: RpcPanelProps) {
  const [pos, setPos] = useState(() => {
    const width = window.innerWidth || 0;
    const defaultX = Math.max(0, width - 340);
    const defaultY = 420;
    return { x: defaultX, y: defaultY };
  });
  const posRef = useRef(pos);
  const dragging = useRef<null | { startX: number; startY: number; baseX: number; baseY: number }>(null);

  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  useEffect(() => {
    try {
      const key = 'dagobang_rpc_panel_pos';
      const stored = window.localStorage.getItem(key);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      const clampedX = Math.min(Math.max(0, parsed.x), Math.max(0, width - 340));
      const clampedY = Math.min(Math.max(0, parsed.y), Math.max(0, height - 80));
      setPos({ x: clampedX, y: clampedY });
    } catch {
    }
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - dragging.current.startX;
      const dy = e.clientY - dragging.current.startY;
      const nextX = dragging.current.baseX + dx;
      const nextY = dragging.current.baseY + dy;
      setPos({ x: nextX, y: nextY });
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      try {
        const key = 'dagobang_rpc_panel_pos';
        window.localStorage.setItem(key, JSON.stringify(posRef.current));
      } catch {
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  const [latencies, setLatencies] = useState<RpcLatency[]>([]);
  const [measuring, setMeasuring] = useState(false);
  const [profiles, setProfiles] = useState<RpcNodeProfile[]>([]);
  const [probeRunning, setProbeRunning] = useState(false);
  const [capacityProbeRequested, setCapacityProbeRequested] = useState(false);
  const [dynamicGlobalLimit, setDynamicGlobalLimit] = useState(0);
  const [globalInFlight, setGlobalInFlight] = useState(0);
  const [requestingProbe, setRequestingProbe] = useState(false);
  const [forcingProbe, setForcingProbe] = useState(false);
  const [resettingStats, setResettingStats] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('score');

  const tt = (key: string, subs?: Array<string | number>) => t(key, locale, subs);

  const protectedNodes = (() => {
    if (!settings) return [];
    const chainId = settings.chainId;
    const chain = settings.chains[chainId];
    if (!chain) return [];
    return chain.protectedRpcUrls;
  })();

  const publicNodes = (() => {
    if (!settings) return [];
    const chainId = settings.chainId;
    const chain = settings.chains[chainId];
    if (!chain) return [];
    return chain.rpcUrls;
  })();

  const nodeKey = `${protectedNodes.join(',')}|${publicNodes.join(',')}`;

  useEffect(() => {
    setLatencies((prev) => {
      const map = new Map(prev.map((x) => [x.url, x]));
      const next: RpcLatency[] = [];
      const seen = new Set<string>();
      for (const url of protectedNodes) {
        if (seen.has(url)) continue;
        seen.add(url);
        const existing = map.get(url);
        if (existing) next.push({ ...existing, group: 'protected' });
        else next.push({ url, latencyMs: null, ok: false, measured: false, group: 'protected' });
      }
      for (const url of publicNodes) {
        if (seen.has(url)) continue;
        seen.add(url);
        const existing = map.get(url);
        if (existing) next.push({ ...existing, group: 'public' });
        else next.push({ url, latencyMs: null, ok: false, measured: false, group: 'public' });
      }
      return next;
    });
  }, [nodeKey]);

  const fetchProfiles = async () => {
    if (!settings) return;
    const urls = (() => {
      const seen = new Set<string>();
      const next: string[] = [];
      for (const url of protectedNodes) {
        if (seen.has(url)) continue;
        seen.add(url);
        next.push(url);
      }
      for (const url of publicNodes) {
        if (seen.has(url)) continue;
        seen.add(url);
        next.push(url);
      }
      return next;
    })();
    if (!urls.length) {
      setProfiles([]);
      setProbeRunning(false);
      setCapacityProbeRequested(false);
      setDynamicGlobalLimit(0);
      setGlobalInFlight(0);
      return;
    }
    const res = await call({
      type: 'rpc:readProfiles',
      chainId: settings.chainId,
      urls,
    });
    setProfiles(res.profiles ?? []);
    setProbeRunning(!!res.probeRunning);
    setCapacityProbeRequested(!!res.capacityProbeRequested);
    setDynamicGlobalLimit(Number(res.dynamicGlobalLimit ?? 0));
    setGlobalInFlight(Number(res.globalInFlight ?? 0));
  };

  useEffect(() => {
    if (!visible || !settings) return;
    fetchProfiles().catch(() => {
    });
    const timer = window.setInterval(() => {
      fetchProfiles().catch(() => {
      });
    }, 2500);
    return () => {
      window.clearInterval(timer);
    };
  }, [visible, settings?.chainId, nodeKey]);

  const handleCapacityProbe = async (mode: 'request' | 'force') => {
    if (!settings) return;
    if (mode === 'request') setRequestingProbe(true);
    else setForcingProbe(true);
    try {
      const rsp = await call({ type: 'rpc:capacityProbe', chainId: settings.chainId, mode });
      if (rsp.ok) {
        toast.success(mode === 'force' ? '已触发立即容量压测' : '已加入容量压测队列', { icon: '✅' });
      }
      await fetchProfiles();
    } catch {
      toast.error('触发容量压测失败', { icon: '❌' });
    } finally {
      if (mode === 'request') setRequestingProbe(false);
      else setForcingProbe(false);
    }
  };

  const handleResetStats = async () => {
    if (!settings) return;
    setResettingStats(true);
    try {
      const urls = (() => {
        const seen = new Set<string>();
        const next: string[] = [];
        for (const url of protectedNodes) {
          if (seen.has(url)) continue;
          seen.add(url);
          next.push(url);
        }
        for (const url of publicNodes) {
          if (seen.has(url)) continue;
          seen.add(url);
          next.push(url);
        }
        return next;
      })();
      await call({
        type: 'rpc:resetProfiles',
        chainId: settings.chainId,
        urls,
      });
      toast.success('已清空统计', { icon: '✅' });
      await fetchProfiles();
    } catch {
      toast.error('清空统计失败', { icon: '❌' });
    } finally {
      setResettingStats(false);
    }
  };

  const handleMeasure = async () => {
    if (!settings) {
      toast.error(tt('contentUi.rpcPanel.settingsNotLoaded'), { icon: '❌' });
      return;
    }
    if (protectedNodes.length + publicNodes.length === 0) {
      toast.error(tt('contentUi.rpcPanel.rpcNotConfigured'), { icon: '❌' });
      return;
    }
    setMeasuring(true);
    try {
      const urls = (() => {
        const seen = new Set<string>();
        const next: string[] = [];
        for (const url of protectedNodes) {
          if (seen.has(url)) continue;
          seen.add(url);
          next.push(url);
        }
        for (const url of publicNodes) {
          if (seen.has(url)) continue;
          seen.add(url);
          next.push(url);
        }
        return next;
      })();
      const results: RpcLatency[] = await Promise.all(
        urls.map(async (url) => {
          try {
            const latencyMs = await RpcService.measureLatency(url);
            return { url, latencyMs, ok: true, measured: true, group: 'public' as const };
          } catch {
            return { url, latencyMs: null, ok: false, measured: true, group: 'public' as const };
          }
        }),
      );
      setLatencies((prev) => {
        const groupByUrl = new Map(prev.map((x) => [x.url, x.group]));
        return results.map((x) => ({
          ...x,
          group: groupByUrl.get(x.url) ?? x.group,
        }));
      });
      toast.success(tt('contentUi.rpcPanel.latencyUpdated'), { icon: '✅' });
    } finally {
      setMeasuring(false);
    }
  };

  if (!visible) {
    return null;
  }

  const latencyByUrl = new Map(latencies.map((x) => [x.url, x]));
  const profileByUrl = new Map(profiles.map((x) => [x.url, x]));
  const protectedUrls = protectedNodes;
  const protectedUrlSet = new Set(protectedUrls);
  const publicUrls = publicNodes.filter((x) => !protectedUrlSet.has(x));
  const totalCount = protectedUrls.length + publicUrls.length;

  const formatAgo = (ts: number) => {
    if (!ts || !Number.isFinite(ts)) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 1) return 'now';
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    return `${hr}h`;
  };

  const totalSuccess = profiles.reduce((acc, p) => acc + Math.max(0, Number(p.businessSuccessCount || 0)), 0);
  const totalBusinessSuccess = profiles.reduce((acc, p) => acc + Math.max(0, Number(p.businessSuccessCount || 0)), 0);
  const totalBusinessFail = profiles.reduce((acc, p) => acc + Math.max(0, Number(p.businessFailCount || 0)), 0);
  const totalBusinessRequests = totalBusinessSuccess + totalBusinessFail;
  const calcScore = (p?: RpcNodeProfile) => {
    if (!p) return null;
    const coolingPenalty = p.cooldownRemainingMs > 0 ? 260 : 0;
    const failPenalty = Math.min(Math.max(0, p.businessFailCount), 12) * 10;
    return p.ewmaLatencyMs + coolingPenalty + failPenalty;
  };
  const calcUsage = (p?: RpcNodeProfile) => {
    if (!p || totalSuccess <= 0) return null;
    return (Math.max(0, p.businessSuccessCount) / totalSuccess) * 100;
  };
  const sortUrls = (urls: string[]) => {
    return urls.slice().sort((a, b) => {
      const pa = profileByUrl.get(a);
      const pb = profileByUrl.get(b);
      const la = latencyByUrl.get(a);
      const lb = latencyByUrl.get(b);
      if (sortKey === 'name') return a.localeCompare(b);
      if (sortKey === 'score') {
        const sa = calcScore(pa);
        const sb = calcScore(pb);
        const va = sa == null ? Number.POSITIVE_INFINITY : sa;
        const vb = sb == null ? Number.POSITIVE_INFINITY : sb;
        if (va !== vb) return va - vb;
        return a.localeCompare(b);
      }
      if (sortKey === 'latency') {
        const va = la?.latencyMs == null ? Number.POSITIVE_INFINITY : la.latencyMs;
        const vb = lb?.latencyMs == null ? Number.POSITIVE_INFINITY : lb.latencyMs;
        if (va !== vb) return va - vb;
        return a.localeCompare(b);
      }
      const ua = calcUsage(pa);
      const ub = calcUsage(pb);
      const va = ua == null ? -1 : ua;
      const vb = ub == null ? -1 : ub;
      if (va !== vb) return vb - va;
      return a.localeCompare(b);
    });
  };
  const sortedProtectedUrls = sortUrls(protectedUrls);
  const sortedPublicUrls = sortUrls(publicUrls);
  const formatStatusText = () => {
    if (probeRunning) return '运行中';
    if (capacityProbeRequested) return '排队中';
    return '空闲';
  };
  const tips = {
    globalLimit: '当前并发请求数 / 全局读并发上限',
    globalRequests: '当前面板节点范围内累计业务请求数（成功+失败）',
    probeStatus: '容量压测任务状态：空闲 / 排队 / 运行中',
    score: '调度评分（越低越好）：延迟、冷却、业务失败的综合惩罚分',
    usage: '该节点累计成功请求占所有节点累计成功请求的比例',
    capacity: '学习得到的该节点建议并发容量（用于分流上限）',
    ewma: '指数加权平均延迟，越低越好',
    inflight: '该节点当前正在处理的请求数',
    rate429: '显示为 连续429/累计429；前者成功后会清零，后者用于反映最近是否持续触发过限流',
    health: '业务健康度 = 业务成功请求 / (业务成功 + 业务失败)',
    sucFail: '业务累计成功次数 / 业务累计失败次数',
    probeSucFail: '探测累计成功次数 / 探测累计失败次数',
    cooldown: '节点冷却剩余时间；冷却期内会降优先级',
    lastProbe: '最近一次延迟探测距今时间',
    lastCapProbe: '最近一次容量压测距今时间',
  } as const;

  return (
    <div
      className="fixed z-[2147483647]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="w-[360px] rounded-xl border border-zinc-800 bg-[#0F0F11] text-zinc-100 shadow-lg shadow-emerald-500/40 text-[12px]">
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 cursor-grab"
          onPointerDown={(e) => {
            dragging.current = {
              startX: e.clientX,
              startY: e.clientY,
              baseX: posRef.current.x,
              baseY: posRef.current.y,
            };
          }}
        >
          <div className="flex flex-col">
            <div className="text-xs font-semibold text-sky-300">{tt('contentUi.rpcPanel.title')}</div>
            <div className="text-[10px] text-zinc-500">
              {tt('contentUi.rpcPanel.subtitle')}
            </div>
          </div>
          <button
            className="text-[11px] text-zinc-400 hover:text-zinc-200"
            onClick={() => onVisibleChange(false)}
          >
            {tt('contentUi.rpcPanel.close')}
          </button>
        </div>
        <div className="p-3 space-y-3">
          <div className="flex items-center justify-between text-[11px] text-zinc-400">
            <div>{tt('contentUi.rpcPanel.nodeCount')}</div>
            <div className="font-mono text-[11px] text-zinc-200">{totalCount}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            <div className="rounded border border-zinc-800 px-2 py-1">
              <div className="text-zinc-500" title={tips.globalLimit}>当前并发 / 全局上限</div>
              <div className="font-mono text-[13px] font-semibold text-cyan-300">{globalInFlight} / {dynamicGlobalLimit || '-'}</div>
              <div className="mt-0.5 text-[10px] text-zinc-500" title={tips.globalRequests}>
                累计请求 {totalBusinessRequests} (成{totalBusinessSuccess}/败{totalBusinessFail})
              </div>
            </div>
            <div className="rounded border border-zinc-800 px-2 py-1">
              <div className="text-zinc-500" title={tips.probeStatus}>容量压测状态</div>
              <div className="font-mono text-[13px] font-semibold text-zinc-200">{formatStatusText()}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="w-full rounded-md bg-sky-500 text-[12px] font-semibold text-black py-2 hover:bg-sky-400 disabled:opacity-60"
              onClick={handleMeasure}
              disabled={measuring || totalCount === 0}
            >
              {measuring ? tt('contentUi.rpcPanel.measuring') : tt('contentUi.rpcPanel.measure')}
            </button>
            <button
              type="button"
              className="w-full rounded-md bg-zinc-700 text-[12px] font-semibold text-zinc-100 py-2 hover:bg-zinc-600 disabled:opacity-60"
              onClick={handleResetStats}
              disabled={resettingStats || totalCount === 0}
            >
              {resettingStats ? '清空中...' : '清空统计'}
            </button>
            <button
              type="button"
              className="w-full rounded-md bg-emerald-500 text-[12px] font-semibold text-black py-2 hover:bg-emerald-400 disabled:opacity-60"
              onClick={() => handleCapacityProbe('request')}
              disabled={requestingProbe || totalCount === 0}
            >
              {requestingProbe ? '排队中...' : '容量压测(队列)'}
            </button>
            <button
              type="button"
              className="w-full rounded-md bg-amber-400 text-[12px] font-semibold text-black py-2 hover:bg-amber-300 disabled:opacity-60"
              onClick={() => handleCapacityProbe('force')}
              disabled={forcingProbe || totalCount === 0}
            >
              {forcingProbe ? '触发中...' : '立即压测(手动)'}
            </button>
          </div>

          <div className="max-h-[260px] overflow-auto border border-zinc-800 rounded-md divide-y divide-zinc-800">
            {totalCount === 0 ? (
              <div className="px-3 py-2 text-[11px] text-zinc-500">
                {tt('contentUi.rpcPanel.empty')}
              </div>
            ) : (
              <>
                <div className="px-3 py-1.5 bg-black/20 border-b border-zinc-800/60 flex items-center justify-between gap-2">
                  <div className="text-[10px] text-zinc-500">排序</div>
                  <select
                    className="h-6 rounded border border-zinc-700 bg-zinc-900 px-2 text-[10px] text-zinc-200"
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                  >
                    <option value="name">名称</option>
                    <option value="score">评分</option>
                    <option value="latency">延迟</option>
                    <option value="usage">占比</option>
                  </select>
                </div>
                {protectedUrls.length > 0 && (
                  <div className="px-3 py-1 text-[10px] font-semibold text-zinc-500 bg-black/20">
                    {tt('contentUi.rpcPanel.groupProtected', [protectedUrls.length])}
                  </div>
                )}
                {sortedProtectedUrls.map((url) => {
                  const item = latencyByUrl.get(url) ?? { url, latencyMs: null, ok: false, measured: false, group: 'protected' as const };
                  const profile = profileByUrl.get(url);
                  const score = calcScore(profile);
                  const usage = calcUsage(profile);
                  const healthRate = profile
                    ? Math.round((profile.businessSuccessCount / Math.max(1, profile.businessSuccessCount + profile.businessFailCount)) * 100)
                    : null;
                  const latencyText = item.latencyMs != null
                    ? `${item.latencyMs.toFixed(0)} ms`
                    : (item.measured ? tt('contentUi.rpcPanel.measureFailed') : '未测量');
                  const statusColor = item.latencyMs == null
                    ? (item.measured ? 'text-red-400' : 'text-zinc-500')
                    : item.latencyMs < 200 ? 'text-emerald-400' : item.latencyMs < 500 ? 'text-yellow-300' : 'text-orange-400';
                  return (
                    <div
                      key={url}
                      className="px-3 py-2 flex flex-col gap-2 text-[11px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 break-all text-zinc-300">{url}</div>
                        <div className={`ml-2 font-mono text-[14px] font-semibold ${statusColor}`}>{latencyText}</div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 rounded border border-zinc-800/70 bg-black/20 p-2">
                        <div>
                          <div className="text-[10px] text-zinc-500" title={tips.score}>评分(越低越好)</div>
                          <div className="font-mono text-[14px] font-semibold text-cyan-300">{score != null ? score.toFixed(0) : '-'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-500" title={tips.usage}>使用占比</div>
                          <div className="font-mono text-[14px] font-semibold text-emerald-300">{usage != null ? `${usage.toFixed(1)}%` : '-'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-500" title={tips.capacity}>节点容量</div>
                          <div className="font-mono text-[14px] font-semibold text-amber-300">{profile ? profile.learnedNodeConcurrency.toFixed(1) : '-'}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-[10px]">
                        <div title={tips.ewma}><span className="text-zinc-500">EWMA</span> <span className="font-mono text-zinc-300">{profile ? `${profile.ewmaLatencyMs.toFixed(0)}ms` : '-'}</span></div>
                        <div title={tips.inflight}><span className="text-zinc-500">并发中</span> <span className="font-mono text-zinc-300">{profile ? profile.inFlight : '-'}</span></div>
                        <div title={tips.rate429}><span className="text-zinc-500">429</span> <span className="font-mono text-zinc-300">{profile ? `${profile.consecutive429}/${profile.total429Count}` : '-'}</span></div>
                        <div title={tips.health}><span className="text-zinc-500">健康度</span> <span className="font-mono text-zinc-300">{healthRate != null ? `${healthRate}%` : '-'}</span></div>
                        <div title={tips.sucFail}><span className="text-zinc-500">业务成败</span> <span className="font-mono text-zinc-300">{profile ? `${profile.businessSuccessCount}/${profile.businessFailCount}` : '-'}</span></div>
                        <div title={tips.probeSucFail}><span className="text-zinc-500">探测成败</span> <span className="font-mono text-zinc-300">{profile ? `${profile.probeSuccessCount}/${profile.probeFailCount}` : '-'}</span></div>
                        <div title={tips.cooldown}><span className="text-zinc-500">冷却</span> <span className="font-mono text-zinc-300">{profile && profile.cooldownRemainingMs > 0 ? `${Math.ceil(profile.cooldownRemainingMs / 1000)}s` : '-'}</span></div>
                        <div title={tips.lastProbe}><span className="text-zinc-500">最近探测</span> <span className="font-mono text-zinc-300">{profile ? formatAgo(profile.lastProbeAt) : '-'}</span></div>
                        <div title={tips.rate429}><span className="text-zinc-500">最近429</span> <span className="font-mono text-zinc-300">{profile ? formatAgo(profile.last429At) : '-'}</span></div>
                        <div title={tips.lastCapProbe}><span className="text-zinc-500">容量探测</span> <span className="font-mono text-zinc-300">{profile ? formatAgo(profile.lastCapacityProbeAt) : '-'}</span></div>
                      </div>
                    </div>
                  );
                })}

                {publicUrls.length > 0 && (
                  <div className="px-3 py-1 text-[10px] font-semibold text-zinc-500 bg-black/20">
                    {tt('contentUi.rpcPanel.groupPublic', [publicUrls.length])}
                  </div>
                )}
                {sortedPublicUrls.map((url) => {
                  const item = latencyByUrl.get(url) ?? { url, latencyMs: null, ok: false, measured: false, group: 'public' as const };
                  const profile = profileByUrl.get(url);
                  const score = calcScore(profile);
                  const usage = calcUsage(profile);
                  const healthRate = profile
                    ? Math.round((profile.businessSuccessCount / Math.max(1, profile.businessSuccessCount + profile.businessFailCount)) * 100)
                    : null;
                  const latencyText = item.latencyMs != null
                    ? `${item.latencyMs.toFixed(0)} ms`
                    : (item.measured ? tt('contentUi.rpcPanel.measureFailed') : '未测量');
                  const statusColor = item.latencyMs == null
                    ? (item.measured ? 'text-red-400' : 'text-zinc-500')
                    : item.latencyMs < 200 ? 'text-emerald-400' : item.latencyMs < 500 ? 'text-yellow-300' : 'text-orange-400';
                  return (
                    <div
                      key={url}
                      className="px-3 py-2 flex flex-col gap-2 text-[11px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 break-all text-zinc-300">{url}</div>
                        <div className={`ml-2 font-mono text-[14px] font-semibold ${statusColor}`}>{latencyText}</div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 rounded border border-zinc-800/70 bg-black/20 p-2">
                        <div>
                          <div className="text-[10px] text-zinc-500" title={tips.score}>评分(越低越好)</div>
                          <div className="font-mono text-[14px] font-semibold text-cyan-300">{score != null ? score.toFixed(0) : '-'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-500" title={tips.usage}>使用占比</div>
                          <div className="font-mono text-[14px] font-semibold text-emerald-300">{usage != null ? `${usage.toFixed(1)}%` : '-'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] text-zinc-500" title={tips.capacity}>节点容量</div>
                          <div className="font-mono text-[14px] font-semibold text-amber-300">{profile ? profile.learnedNodeConcurrency.toFixed(1) : '-'}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-[10px]">
                        <div title={tips.ewma}><span className="text-zinc-500">EWMA</span> <span className="font-mono text-zinc-300">{profile ? `${profile.ewmaLatencyMs.toFixed(0)}ms` : '-'}</span></div>
                        <div title={tips.inflight}><span className="text-zinc-500">并发中</span> <span className="font-mono text-zinc-300">{profile ? profile.inFlight : '-'}</span></div>
                        <div title={tips.rate429}><span className="text-zinc-500">429</span> <span className="font-mono text-zinc-300">{profile ? `${profile.consecutive429}/${profile.total429Count}` : '-'}</span></div>
                        <div title={tips.health}><span className="text-zinc-500">健康度</span> <span className="font-mono text-zinc-300">{healthRate != null ? `${healthRate}%` : '-'}</span></div>
                        <div title={tips.sucFail}><span className="text-zinc-500">业务成败</span> <span className="font-mono text-zinc-300">{profile ? `${profile.businessSuccessCount}/${profile.businessFailCount}` : '-'}</span></div>
                        <div title={tips.probeSucFail}><span className="text-zinc-500">探测成败</span> <span className="font-mono text-zinc-300">{profile ? `${profile.probeSuccessCount}/${profile.probeFailCount}` : '-'}</span></div>
                        <div title={tips.cooldown}><span className="text-zinc-500">冷却</span> <span className="font-mono text-zinc-300">{profile && profile.cooldownRemainingMs > 0 ? `${Math.ceil(profile.cooldownRemainingMs / 1000)}s` : '-'}</span></div>
                        <div title={tips.lastProbe}><span className="text-zinc-500">最近探测</span> <span className="font-mono text-zinc-300">{profile ? formatAgo(profile.lastProbeAt) : '-'}</span></div>
                        <div title={tips.rate429}><span className="text-zinc-500">最近429</span> <span className="font-mono text-zinc-300">{profile ? formatAgo(profile.last429At) : '-'}</span></div>
                        <div title={tips.lastCapProbe}><span className="text-zinc-500">容量探测</span> <span className="font-mono text-zinc-300">{profile ? formatAgo(profile.lastCapacityProbeAt) : '-'}</span></div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
