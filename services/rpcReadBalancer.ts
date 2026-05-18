import { browser } from 'wxt/browser';

type NodeState = {
  inFlight: number;
  cooldownUntil: number;
  consecutive429: number;
  total429Count: number;
  last429At: number;
  ewmaLatencyMs: number;
  businessSuccessCount: number;
  businessFailCount: number;
  probeSuccessCount: number;
  probeFailCount: number;
  learnedNodeConcurrency: number;
  lastProbeAt: number;
  lastCapacityProbeAt: number;
};

type PersistedNodeState = {
  ewmaLatencyMs: number;
  learnedNodeConcurrency: number;
  businessSuccessCount: number;
  businessFailCount: number;
  total429Count?: number;
  last429At?: number;
  probeSuccessCount?: number;
  probeFailCount?: number;
  // backward-compatible fields (old schema)
  successCount?: number;
  failCount?: number;
  lastProbeAt: number;
  lastCapacityProbeAt: number;
};

const PROFILE_STORAGE_KEY = 'dagobang_rpc_read_balancer_profiles_v1';
const DEFAULT_EWMA_MS = 280;
const EWMA_ALPHA = 0.25;
const PROBE_INTERVAL_MS = 30_000;
const CAPACITY_PROBE_INTERVAL_MS = 30 * 60_000;
const GLOBAL_WAIT_TIMEOUT_MS = 120;
const MIN_NODE_CONCURRENCY = 1;
const MAX_NODE_CONCURRENCY = 30;
const MAX_GLOBAL_CONCURRENCY = 120;
const SCORE_NEAR_BAND_MS = 12;
const NEAR_GROUP_DOMINANT_SHARE = 0.9;
const NEAR_GROUP_SOFT_CAP_LOAD = 0.75;
const PROBE_LADDER = [2, 4, 6, 8, 10, 15, 20, 30] as const;
const IDLE_MIN_SILENCE_MS = 4000;
const TRADE_ACTIVE_WINDOW_MS = 90_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RpcReadBalancer {
  private static readonly stateByNode = new Map<string, NodeState>();
  private static initialized = false;
  private static initPromise: Promise<void> | null = null;
  private static saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static globalInFlight = 0;
  private static globalWaiters: Array<() => void> = [];
  private static readonly probeRunningByChain = new Set<number>();
  private static readonly capacityProbeRequestedByChain = new Map<number, number>();
  private static lastReadCompletedAt = 0;
  private static lastTradeActivityAt = 0;

  static requestCapacityProbe(chainId: number) {
    this.capacityProbeRequestedByChain.set(chainId, Date.now());
  }

  static noteTradeActivity() {
    this.lastTradeActivityAt = Date.now();
  }

  static async triggerCapacityProbe(input: {
    chainId: number;
    urls: string[];
    probe: (url: string) => Promise<number | void>;
    mode?: 'request' | 'force';
  }): Promise<{ queued: boolean; mode: 'request' | 'force' }> {
    await this.ensureInitialized();
    const mode = input.mode === 'force' ? 'force' : 'request';
    const urls = Array.from(new Set((input.urls ?? []).map((u) => String(u || '').trim()).filter(Boolean)));
    if (!urls.length) return { queued: false, mode };
    if (mode === 'request') {
      this.requestCapacityProbe(input.chainId);
      this.kickoffProbeIfNeeded(input.chainId, urls, input.probe);
      return { queued: true, mode };
    }
    if (this.probeRunningByChain.has(input.chainId)) return { queued: false, mode };
    this.probeRunningByChain.add(input.chainId);
    this.capacityProbeRequestedByChain.delete(input.chainId);
    void this.maybeProbe(input.chainId, urls, input.probe, true)
      .catch(() => {
      })
      .finally(() => {
        this.probeRunningByChain.delete(input.chainId);
      });
    return { queued: true, mode };
  }

  static async getProfiles(input: { chainId: number; urls: string[] }) {
    await this.ensureInitialized();
    const urls = Array.from(new Set((input.urls ?? []).map((u) => String(u || '').trim()).filter(Boolean)));
    const now = Date.now();
    const profiles = urls.map((url) => {
      const state = this.getNodeState(input.chainId, url);
      return {
        url,
        ewmaLatencyMs: state.ewmaLatencyMs,
        learnedNodeConcurrency: state.learnedNodeConcurrency,
        inFlight: state.inFlight,
        cooldownUntil: state.cooldownUntil,
        cooldownRemainingMs: Math.max(0, state.cooldownUntil - now),
        consecutive429: state.consecutive429,
        total429Count: state.total429Count,
        last429At: state.last429At,
        businessSuccessCount: state.businessSuccessCount,
        businessFailCount: state.businessFailCount,
        probeSuccessCount: state.probeSuccessCount,
        probeFailCount: state.probeFailCount,
        lastProbeAt: state.lastProbeAt,
        lastCapacityProbeAt: state.lastCapacityProbeAt,
      };
    });
    return {
      profiles,
      probeRunning: this.probeRunningByChain.has(input.chainId),
      capacityProbeRequested: this.capacityProbeRequestedByChain.has(input.chainId),
      dynamicGlobalLimit: this.getDynamicGlobalConcurrency(input.chainId, urls),
      globalInFlight: this.globalInFlight,
    };
  }

  static async resetProfiles(input?: { chainId?: number; urls?: string[] }) {
    await this.ensureInitialized();
    const chainId = input?.chainId;
    const urlSet = new Set((input?.urls ?? []).map((u) => String(u || '').trim()).filter(Boolean));
    for (const [key, state] of this.stateByNode.entries()) {
      const idx = key.indexOf(':');
      const keyChainId = idx > 0 ? Number(key.slice(0, idx)) : NaN;
      const keyUrl = idx > 0 ? key.slice(idx + 1) : '';
      if (Number.isFinite(chainId) && keyChainId !== chainId) continue;
      if (urlSet.size > 0 && !urlSet.has(keyUrl)) continue;
      state.businessSuccessCount = 0;
      state.businessFailCount = 0;
      state.probeSuccessCount = 0;
      state.probeFailCount = 0;
      state.consecutive429 = 0;
      state.total429Count = 0;
      state.last429At = 0;
      state.cooldownUntil = 0;
      state.inFlight = 0;
    }
    this.schedulePersist();
  }

  private static getNodeKey(chainId: number, url: string) {
    return `${chainId}:${url}`;
  }

  private static async ensureInitialized() {
    if (this.initialized) return;
    if (this.initPromise) return await this.initPromise;
    this.initPromise = (async () => {
      try {
        const res = await browser.storage.local.get(PROFILE_STORAGE_KEY as any);
        const raw = (res as any)?.[PROFILE_STORAGE_KEY];
        if (raw && typeof raw === 'object') {
          for (const [key, value] of Object.entries(raw as Record<string, PersistedNodeState>)) {
            if (!value || typeof value !== 'object') continue;
            const migratedSuccess = Number.isFinite(value.businessSuccessCount)
              ? Number(value.businessSuccessCount)
              : (Number.isFinite(value.successCount) ? Number(value.successCount) : 0);
            const migratedFail = Number.isFinite(value.businessFailCount)
              ? Number(value.businessFailCount)
              : (Number.isFinite(value.failCount) ? Number(value.failCount) : 0);
            this.stateByNode.set(key, {
              inFlight: 0,
              cooldownUntil: 0,
              consecutive429: 0,
              total429Count: Number.isFinite(value.total429Count) ? Number(value.total429Count) : 0,
              last429At: Number.isFinite(value.last429At) ? Number(value.last429At) : 0,
              ewmaLatencyMs: Number.isFinite(value.ewmaLatencyMs) ? value.ewmaLatencyMs : DEFAULT_EWMA_MS,
              businessSuccessCount: migratedSuccess,
              businessFailCount: migratedFail,
              probeSuccessCount: Number.isFinite(value.probeSuccessCount) ? Number(value.probeSuccessCount) : 0,
              probeFailCount: Number.isFinite(value.probeFailCount) ? Number(value.probeFailCount) : 0,
              learnedNodeConcurrency: Number.isFinite(value.learnedNodeConcurrency)
                ? Math.max(MIN_NODE_CONCURRENCY, Math.min(MAX_NODE_CONCURRENCY, value.learnedNodeConcurrency))
                : 1,
              lastProbeAt: Number.isFinite(value.lastProbeAt) ? value.lastProbeAt : 0,
              lastCapacityProbeAt: Number.isFinite(value.lastCapacityProbeAt) ? value.lastCapacityProbeAt : 0,
            });
          }
        }
      } catch {
      } finally {
        this.initialized = true;
        this.initPromise = null;
      }
    })();
    await this.initPromise;
  }

  private static schedulePersist() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      const payload: Record<string, PersistedNodeState> = {};
      for (const [key, value] of this.stateByNode.entries()) {
        payload[key] = {
          ewmaLatencyMs: value.ewmaLatencyMs,
          learnedNodeConcurrency: value.learnedNodeConcurrency,
          businessSuccessCount: value.businessSuccessCount,
          businessFailCount: value.businessFailCount,
          total429Count: value.total429Count,
          last429At: value.last429At,
          probeSuccessCount: value.probeSuccessCount,
          probeFailCount: value.probeFailCount,
          lastProbeAt: value.lastProbeAt,
          lastCapacityProbeAt: value.lastCapacityProbeAt,
        };
      }
      try {
        await browser.storage.local.set({ [PROFILE_STORAGE_KEY]: payload } as any);
      } catch {
      }
    }, 800);
  }

  private static getNodeState(chainId: number, url: string): NodeState {
    const key = this.getNodeKey(chainId, url);
    const hit = this.stateByNode.get(key);
    if (hit) return hit;
    const created: NodeState = {
      inFlight: 0,
      cooldownUntil: 0,
      consecutive429: 0,
      total429Count: 0,
      last429At: 0,
      ewmaLatencyMs: DEFAULT_EWMA_MS,
      businessSuccessCount: 0,
      businessFailCount: 0,
      probeSuccessCount: 0,
      probeFailCount: 0,
      learnedNodeConcurrency: 1,
      lastProbeAt: 0,
      lastCapacityProbeAt: 0,
    };
    this.stateByNode.set(key, created);
    this.schedulePersist();
    return created;
  }

  private static isRateLimitedLike(error: unknown): boolean {
    const e: any = error;
    const texts: string[] = [];
    const push = (v: any) => {
      if (typeof v !== 'string') return;
      const t = v.trim().toLowerCase();
      if (t) texts.push(t);
    };
    push(e?.shortMessage);
    push(e?.message);
    push(e?.details);
    push(e?.cause?.message);
    push(e?.cause?.details);
    if (Array.isArray(e?.metaMessages)) {
      for (const x of e.metaMessages) push(x);
    }
    const merged = texts.join(' | ');
    return (
      merged.includes('429') ||
      merged.includes('too many requests') ||
      merged.includes('rate limit') ||
      merged.includes('rate exceeded') ||
      merged.includes('quota') ||
      merged.includes('daily limit') ||
      merged.includes('exceeded') ||
      merged.includes('resource exhausted')
    );
  }

  private static isUnavailableLike(error: unknown): boolean {
    const e: any = error;
    const texts: string[] = [];
    const push = (v: any) => {
      if (typeof v !== 'string') return;
      const t = v.trim().toLowerCase();
      if (t) texts.push(t);
    };
    push(e?.shortMessage);
    push(e?.message);
    push(e?.details);
    push(e?.cause?.message);
    const merged = texts.join(' | ');
    return (
      merged.includes('failed to fetch') ||
      merged.includes('network request failed') ||
      merged.includes('connection refused') ||
      merged.includes('unreachable') ||
      merged.includes('service unavailable') ||
      merged.includes('temporarily unavailable')
    );
  }

  private static computeCooldownMs(consecutive429: number): number {
    if (consecutive429 <= 1) return 3000;
    if (consecutive429 === 2) return 5000;
    return 8000;
  }

  private static getDynamicGlobalConcurrency(chainId: number, urls: string[]): number {
    const sum = urls.reduce((acc, url) => {
      const state = this.getNodeState(chainId, url);
      const cap = Math.max(MIN_NODE_CONCURRENCY, Math.ceil(state.learnedNodeConcurrency));
      return acc + cap;
    }, 0);
    return Math.max(2, Math.min(MAX_GLOBAL_CONCURRENCY, sum));
  }

  private static async acquireGlobalSlot(limit: number): Promise<() => void> {
    const startedAt = Date.now();
    while (this.globalInFlight >= limit) {
      if (Date.now() - startedAt >= GLOBAL_WAIT_TIMEOUT_MS) {
        // Availability-first: do not block indefinitely.
        break;
      }
      await new Promise<void>((resolve) => this.globalWaiters.push(resolve));
    }
    this.globalInFlight += 1;
    return () => {
      this.globalInFlight = Math.max(0, this.globalInFlight - 1);
      const next = this.globalWaiters.shift();
      if (next) next();
    };
  }

  private static scoreNode(state: NodeState, now: number): number {
    const coolingPenalty = state.cooldownUntil > now ? 260 : 0;
    const failPenalty = Math.min(state.businessFailCount, 12) * 10;
    // Strict quality-first score: do not penalize in-flight here, so fast nodes are filled up
    // to their learned capacity before spilling to slower nodes.
    return state.ewmaLatencyMs + coolingPenalty + failPenalty;
  }

  private static median(values: number[]): number {
    if (!values.length) return DEFAULT_EWMA_MS;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid]!;
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  private static percentile(values: number[], p: number): number {
    if (!values.length) return DEFAULT_EWMA_MS;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
    return sorted[idx]!;
  }

  private static isTimeoutLike(error: unknown): boolean {
    const e: any = error;
    const texts: string[] = [];
    const push = (v: any) => {
      if (typeof v !== 'string') return;
      const t = v.trim().toLowerCase();
      if (t) texts.push(t);
    };
    push(e?.shortMessage);
    push(e?.message);
    push(e?.details);
    push(e?.cause?.message);
    const merged = texts.join(' | ');
    return merged.includes('timeout') || merged.includes('timed out') || merged.includes('network request failed');
  }

  private static async runProbeBurst(
    url: string,
    concurrency: number,
    probe: (url: string) => Promise<number | void>,
  ): Promise<{ success: number; fail: number; fail429: number; failTimeout: number; latencies: number[] }> {
    const tasks = Array.from({ length: Math.max(1, concurrency) }, async () => {
      const started = Date.now();
      try {
        const maybe = await probe(url);
        const latency = Math.max(1, Number.isFinite(maybe as number) ? Number(maybe) : Date.now() - started);
        return { ok: true as const, latency };
      } catch (e) {
        return {
          ok: false as const,
          err429: this.isRateLimitedLike(e),
          errTimeout: this.isTimeoutLike(e),
        };
      }
    });
    const settled = await Promise.all(tasks);
    let success = 0;
    let fail = 0;
    let fail429 = 0;
    let failTimeout = 0;
    const latencies: number[] = [];
    for (const item of settled) {
      if (item.ok) {
        success += 1;
        latencies.push(item.latency);
      } else {
        fail += 1;
        if (item.err429) fail429 += 1;
        if (item.errTimeout) failTimeout += 1;
      }
    }
    return { success, fail, fail429, failTimeout, latencies };
  }

  private static async runCapacityProbe(
    url: string,
    state: NodeState,
    probe: (url: string) => Promise<number | void>,
  ) {
    let baseline = DEFAULT_EWMA_MS;
    let accepted = 1;
    for (const step of PROBE_LADDER) {
      const burst = await this.runProbeBurst(url, step, probe);
      const total = Math.max(1, burst.success + burst.fail);
      const successRate = burst.success / total;
      const rate429 = burst.fail429 / total;
      const rateTimeout = burst.failTimeout / total;
      const p95 = this.percentile(burst.latencies, 95);
      if (step === PROBE_LADDER[0] && burst.latencies.length > 0) {
        baseline = this.median(burst.latencies);
      }
      const degradedByLatency = p95 > baseline * 2.6;
      const unhealthy = successRate < 0.9 || rate429 > 0.08 || rateTimeout > 0.12 || degradedByLatency;
      if (unhealthy) break;
      accepted = step;
    }
    state.learnedNodeConcurrency = Math.max(MIN_NODE_CONCURRENCY, Math.min(MAX_NODE_CONCURRENCY, accepted));
    state.lastCapacityProbeAt = Date.now();
    state.lastProbeAt = Date.now();
    this.schedulePersist();
  }

  private static pickCandidate(chainId: number, urls: string[], excluded: Set<string>): string | null {
    const now = Date.now();
    const candidates = urls
      .filter((url) => !excluded.has(url))
      .map((url) => ({ url, state: this.getNodeState(chainId, url) }));
    if (!candidates.length) return null;

    const belowNodeLimit = candidates.filter((item) => item.state.inFlight < Math.max(1, Math.ceil(item.state.learnedNodeConcurrency)));
    const active = belowNodeLimit.length > 0 ? belowNodeLimit : candidates;
    const nonCooling = active.filter((item) => item.state.cooldownUntil <= now);
    const pool = nonCooling.length > 0 ? nonCooling : active;
    const scored = pool.slice().map((item) => ({
      ...item,
      score: this.scoreNode(item.state, now),
    }));
    const sorted = scored.sort((a, b) => {
      const sa = this.scoreNode(a.state, now);
      const sb = this.scoreNode(b.state, now);
      if (sa !== sb) return sa - sb;
      const ca = Math.max(1, Math.ceil(a.state.learnedNodeConcurrency));
      const cb = Math.max(1, Math.ceil(b.state.learnedNodeConcurrency));
      const ua = a.state.inFlight / ca;
      const ub = b.state.inFlight / cb;
      return ua - ub;
    });
    const best = sorted[0];
    if (!best) return null;
    const near = sorted.filter((x) => x.score <= best.score + SCORE_NEAR_BAND_MS);
    if (near.length <= 1) return best.url;
    const totalNearBusinessSuccess = near.reduce((acc, x) => acc + Math.max(0, x.state.businessSuccessCount), 0);
    const nearCapSum = near.reduce((acc, x) => acc + Math.max(1, Math.ceil(x.state.learnedNodeConcurrency)), 0);
    const nearInFlightSum = near.reduce((acc, x) => acc + Math.max(0, x.state.inFlight), 0);
    const nearLoad = nearCapSum > 0 ? nearInFlightSum / nearCapSum : 1;
    const enforceSoftCap = nearLoad < NEAR_GROUP_SOFT_CAP_LOAD;
    const withBalance = near.map((x) => {
      const cap = Math.max(1, Math.ceil(x.state.learnedNodeConcurrency));
      const util = x.state.inFlight / cap;
      const share = totalNearBusinessSuccess > 0
        ? Math.max(0, x.state.businessSuccessCount) / totalNearBusinessSuccess
        : 0;
      const dominancePenalty = (enforceSoftCap && share > NEAR_GROUP_DOMINANT_SHARE)
        ? (share - NEAR_GROUP_DOMINANT_SHARE) * 260
        : 0;
      return {
        ...x,
        util,
        share,
        effective: x.score + util * 8 + share * 16 + dominancePenalty,
      };
    }).sort((a, b) => a.effective - b.effective);
    return withBalance[0]?.url ?? best.url;
  }

  private static learnSuccess(state: NodeState, elapsedMs: number, source: 'business' | 'probe') {
    state.ewmaLatencyMs = state.ewmaLatencyMs * (1 - EWMA_ALPHA) + elapsedMs * EWMA_ALPHA;
    state.cooldownUntil = 0;
    state.consecutive429 = 0;
    if (source === 'business') state.businessSuccessCount += 1;
    else state.probeSuccessCount += 1;
    this.schedulePersist();
  }

  private static learnFailure(state: NodeState, error: unknown, source: 'business' | 'probe') {
    if (source === 'business') state.businessFailCount += 1;
    else state.probeFailCount += 1;
    if (this.isRateLimitedLike(error)) {
      state.consecutive429 += 1;
      state.total429Count += 1;
      state.last429At = Date.now();
      state.cooldownUntil = Date.now() + this.computeCooldownMs(state.consecutive429);
      // Multiplicative decrease on explicit rate-limit signal.
      state.learnedNodeConcurrency = Math.max(MIN_NODE_CONCURRENCY, state.learnedNodeConcurrency * 0.7);
    } else if (this.isTimeoutLike(error) || this.isUnavailableLike(error)) {
      // Short cooldown for transport instability to avoid immediate hammering.
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + 2500);
      state.learnedNodeConcurrency = Math.max(MIN_NODE_CONCURRENCY, state.learnedNodeConcurrency * 0.85);
    }
    this.schedulePersist();
  }

  private static async maybeProbe(
    chainId: number,
    urls: string[],
    probe?: (url: string) => Promise<number | void>,
    forceCapacityProbe = false,
  ) {
    if (!probe) return;
    const now = Date.now();
    const due = urls.filter((url) => {
      const state = this.getNodeState(chainId, url);
      const dueLatency = state.lastProbeAt <= 0 || now - state.lastProbeAt >= PROBE_INTERVAL_MS;
      const dueCapacity = forceCapacityProbe || state.lastCapacityProbeAt <= 0 || now - state.lastCapacityProbeAt >= CAPACITY_PROBE_INTERVAL_MS;
      return dueLatency || dueCapacity;
    });
    if (!due.length) return;
    for (const url of due) {
      const state = this.getNodeState(chainId, url);
      const shouldCapacityProbe = forceCapacityProbe || state.lastCapacityProbeAt <= 0 || now - state.lastCapacityProbeAt >= CAPACITY_PROBE_INTERVAL_MS;
      if (shouldCapacityProbe) {
        try {
          await this.runCapacityProbe(url, state, probe);
        } catch (e) {
          state.lastCapacityProbeAt = Date.now();
          this.learnFailure(state, e, 'probe');
        }
        continue;
      }
      const started = Date.now();
      try {
        const latencyMaybe = await probe(url);
        const elapsed = Math.max(1, Number.isFinite(latencyMaybe as number) ? Number(latencyMaybe) : Date.now() - started);
        state.lastProbeAt = Date.now();
        this.learnSuccess(state, elapsed, 'probe');
      } catch (e) {
        state.lastProbeAt = Date.now();
        this.learnFailure(state, e, 'probe');
      }
    }
  }

  private static isIdleForCapacityProbe() {
    const now = Date.now();
    const readSilent = this.lastReadCompletedAt > 0 && (now - this.lastReadCompletedAt >= IDLE_MIN_SILENCE_MS);
    const tradeSilent = now - this.lastTradeActivityAt >= TRADE_ACTIVE_WINDOW_MS;
    return this.globalInFlight <= 0 && readSilent && tradeSilent;
  }

  private static kickoffProbeIfNeeded(
    chainId: number,
    urls: string[],
    probe?: (url: string) => Promise<number | void>,
  ) {
    if (!probe || !urls.length) return;
    if (this.probeRunningByChain.has(chainId)) return;
    const requestedAt = this.capacityProbeRequestedByChain.get(chainId) ?? 0;
    const forceCapacityProbe = requestedAt > 0;
    if (forceCapacityProbe && !this.isIdleForCapacityProbe()) return;
    this.probeRunningByChain.add(chainId);
    void this.maybeProbe(chainId, urls, probe, forceCapacityProbe)
      .then(() => {
        if (forceCapacityProbe) {
          const cur = this.capacityProbeRequestedByChain.get(chainId) ?? 0;
          if (cur === requestedAt) this.capacityProbeRequestedByChain.delete(chainId);
        }
      })
      .catch(() => {
      })
      .finally(() => {
        this.probeRunningByChain.delete(chainId);
      });
  }

  static async execute<T>(input: {
    chainId: number;
    urls: string[];
    operation: (url: string) => Promise<T>;
    probe?: (url: string) => Promise<number | void>;
  }): Promise<T> {
    await this.ensureInitialized();
    const urls = Array.from(new Set((input.urls ?? []).map((u) => String(u || '').trim()).filter(Boolean)));
    if (!urls.length) throw new Error('No RPC URLs configured for read balancing');
    this.kickoffProbeIfNeeded(input.chainId, urls, input.probe);

    const dynamicGlobalLimit = this.getDynamicGlobalConcurrency(input.chainId, urls);
    const releaseGlobal = await this.acquireGlobalSlot(dynamicGlobalLimit);
    try {
      const tried = new Set<string>();
      let lastError: unknown = null;

      while (tried.size < urls.length) {
        const selected = this.pickCandidate(input.chainId, urls, tried);
        if (!selected) break;
        tried.add(selected);
        const state = this.getNodeState(input.chainId, selected);
        state.inFlight += 1;
        const start = Date.now();
        try {
          const out = await input.operation(selected);
          const elapsed = Math.max(1, Date.now() - start);
          this.learnSuccess(state, elapsed, 'business');
          return out;
        } catch (e) {
          lastError = e;
          this.learnFailure(state, e, 'business');
          if (this.isRateLimitedLike(e)) await wait(8);
        } finally {
          state.inFlight = Math.max(0, state.inFlight - 1);
        }
      }

      // Availability-first escape hatch: never hard-fail only because of cooldown state.
      const now = Date.now();
      const fallbackUrl = urls
        .map((url) => ({ url, state: this.getNodeState(input.chainId, url) }))
        .sort((a, b) => this.scoreNode(a.state, now) - this.scoreNode(b.state, now))[0]?.url;
      if (fallbackUrl) {
        const state = this.getNodeState(input.chainId, fallbackUrl);
        state.inFlight += 1;
        const start = Date.now();
        try {
          const out = await input.operation(fallbackUrl);
          const elapsed = Math.max(1, Date.now() - start);
          this.learnSuccess(state, elapsed, 'business');
          return out;
        } catch (e) {
          lastError = e;
          this.learnFailure(state, e, 'business');
        } finally {
          state.inFlight = Math.max(0, state.inFlight - 1);
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'RPC read failed'));
    } finally {
      this.lastReadCompletedAt = Date.now();
      releaseGlobal();
    }
  }
}
