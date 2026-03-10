export const isObject = (value: any): value is Record<string, any> => !!value && typeof value === 'object';

export const asAddress = (value: any): string | null =>
  typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;

const isEvmAddress = (value: string): boolean => asAddress(value) != null;

const isBase58Address = (value: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

export const toArrayPayload = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload) && Array.isArray((payload as any).data)) return (payload as any).data;
  return [];
};

const parseNumberish = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
};

const extractFirst = (value: any, keys: string[]): string | null => {
  if (!isObject(value)) return null;
  for (const key of keys) {
    const v = (value as any)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

const findInObject = (value: any, predicate: (v: any) => boolean, visited?: WeakSet<object>): any => {
  if (!isObject(value)) return null;
  const seen = visited ?? new WeakSet<object>();
  if (seen.has(value as object)) return null;
  seen.add(value as object);
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInObject(item, predicate, seen);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findInObject(item, predicate, seen);
    if (found) return found;
  }
  return null;
};

export const extractFirstFromObject = (payload: any, keys: string[]): string | null => {
  const found = findInObject(payload, (v) => isObject(v) && keys.some((key) => typeof (v as any)[key] === 'string'));
  if (!found) return null;
  return extractFirst(found, keys);
};

export const extractNumber = (payload: any, keys: string[]): number | null => {
  const found = findInObject(payload, (v) => {
    if (!isObject(v)) return false;
    for (const key of keys) {
      const val = (v as any)[key];
      if (parseNumberish(val) != null) return true;
    }
    return false;
  });
  if (!found) return null;
  for (const key of keys) {
    const parsed = parseNumberish((found as any)[key]);
    if (parsed != null) return parsed;
  }
  return null;
};

export const extractTokenAddress = (payload: any, text?: string | null): string | null => {
  const fromText = text?.match(/0x[a-fA-F0-9]{40}/)?.[0];
  if (fromText) return fromText;
  const tokenObj = isObject((payload as any)?.t) ? (payload as any).t : null;
  if (tokenObj) {
    const direct = extractFirst(tokenObj, ['a', 'address', 'contract', 'contractAddress', 'contract_address', 'tokenAddress', 'token_address', 'ca']);
    if (typeof direct === 'string' && (isEvmAddress(direct) || isBase58Address(direct))) return direct;
  }
  const found = findInObject(payload, (v) => {
    if (!isObject(v)) return false;
    const addr = extractFirst(v, ['tokenAddress', 'token_address', 'contract', 'contractAddress', 'contract_address', 'address', 'ca', 'a']);
    return !!addr && (isEvmAddress(addr) || isBase58Address(addr));
  });
  if (!found) return null;
  const addr = extractFirst(found, ['tokenAddress', 'token_address', 'contract', 'contractAddress', 'contract_address', 'address', 'ca', 'a']);
  return addr && (isEvmAddress(addr) || isBase58Address(addr)) ? addr : null;
};

export const extractTokenAddresses = (payload: any, text?: string | null): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (addr: string) => {
    const trimmed = typeof addr === 'string' ? addr.trim() : '';
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  if (typeof text === 'string' && text) {
    for (const m of text.matchAll(/0x[a-fA-F0-9]{40}/g)) {
      if (m[0]) push(m[0]);
    }
  }

  const tokenObj = isObject((payload as any)?.t) ? (payload as any).t : null;
  if (tokenObj) {
    const direct = extractFirst(tokenObj, ['a', 'address', 'contract', 'contractAddress', 'contract_address', 'tokenAddress', 'token_address', 'ca']);
    if (typeof direct === 'string' && (isEvmAddress(direct) || isBase58Address(direct))) push(direct);
  }

  const keys = ['tokenAddress', 'token_address', 'contract', 'contractAddress', 'contract_address', 'address', 'ca', 'a'];
  const visited = new WeakSet<object>();
  const stack: any[] = [payload];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i -= 1) stack.push(cur[i]);
      continue;
    }
    if (!isObject(cur)) continue;
    if (visited.has(cur as object)) continue;
    visited.add(cur as object);

    for (const k of keys) {
      const v = (cur as any)[k];
      if (typeof v === 'string' && (isEvmAddress(v) || isBase58Address(v))) push(v);
    }
    for (const v of Object.values(cur)) stack.push(v);
  }

  return out;
};

export const extractTweetId = (payload: any, text?: string | null): string | null => {
  const fromText = text?.match(/status\/(\d{10,})/i)?.[1];
  if (fromText) return fromText;
  const direct = extractFirst(payload, ['ti', 'si']);
  if (direct && /^\d{6,}$/.test(direct)) return direct;
  const found = findInObject(payload, (v) => {
    if (!isObject(v)) return false;
    const id = extractFirst(v, ['ti', 'si', 'tweetId', 'tweet_id', 'statusId', 'status_id', 'id_str', 'id']);
    return !!id && /^\d{6,}$/.test(id);
  });
  if (!found) return null;
  const id = extractFirst(found, ['ti', 'si', 'tweetId', 'tweet_id', 'statusId', 'status_id', 'id_str', 'id']);
  return id && /^\d{6,}$/.test(id) ? id : null;
};

export const extractText = (payload: any): string | null => {
  if (typeof (payload as any)?.fd === 'string') return (payload as any).fd;
  if (isObject((payload as any)?.f?.f) && typeof (payload as any).f.f.d === 'string') return (payload as any).f.f.d;
  if (isObject((payload as any)?.c) && typeof (payload as any).c.t === 'string') return (payload as any).c.t;
  if (typeof (payload as any)?.c === 'string') return (payload as any).c;
  if (isObject((payload as any)?.sc) && typeof (payload as any).sc.t === 'string') return (payload as any).sc.t;
  if (typeof (payload as any)?.sc === 'string') return (payload as any).sc;
  return extractFirstFromObject(payload, [
    'text',
    'full_text',
    'content',
    'body',
    'tweet_text',
    'tweet',
    'message',
    'desc',
    'title',
    'fd',
    'satl',
    'sat',
  ]);
};

export const extractMedia = (payload: any): Array<{ type: string; url: string }> => {
  const raw = isObject((payload as any)?.c) ? (payload as any).c.m : (payload as any)?.m;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ type: string; url: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const type =
      typeof (item as any).t === 'string'
        ? (item as any).t
        : typeof (item as any).type === 'string'
          ? (item as any).type
          : null;
    const url =
      typeof (item as any).u === 'string'
        ? (item as any).u
        : typeof (item as any).url === 'string'
          ? (item as any).url
          : null;
    if (!url) continue;
    out.push({ type: type ?? 'unknown', url });
  }
  return out;
};

export const extractGmgnTweetText = (payload: any): string | null => {
  return extractText(payload);
};

export const extractGmgnUserFields = (payload: any): {
  userScreen?: string;
  userName?: string;
  userAvatar?: string;
  userFollowers?: number;
} => {
  const candidates = [(payload as any)?.u, (payload as any)?.su, (payload as any)?.f?.u, (payload as any)?.f?.f].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const userScreen = typeof (candidate as any).s === 'string' ? (candidate as any).s : undefined;
    const userName = typeof (candidate as any).n === 'string' ? (candidate as any).n : undefined;
    const userAvatar = typeof (candidate as any).a === 'string' ? (candidate as any).a : undefined;
    const userFollowers = typeof (candidate as any).f === 'number' ? (candidate as any).f : undefined;
    if (userScreen || userName || userAvatar || userFollowers != null) {
      return { userScreen, userName, userAvatar, userFollowers };
    }
  }
  if (typeof (payload as any)?.u === 'string') {
    return { userScreen: (payload as any).u };
  }
  return {};
};

export const extractUser = (payload: any): string | null => {
  if (isObject((payload as any)?.u)) {
    const user = extractFirst((payload as any).u, ['s', 'n', 'screen_name', 'name', 'username']);
    if (user) return user;
  }
  if (isObject((payload as any)?.f?.u)) {
    const user = extractFirst((payload as any).f.u, ['s', 'n', 'screen_name', 'name', 'username']);
    if (user) return user;
  }
  return extractFirstFromObject(payload, ['user', 'username', 'screen_name', 'account', 'author', 'name']);
};

export const extractTimestampMs = (payload: any): number | null => {
  const raw = extractNumber(payload, [
    'timestamp',
    'ts',
    'serverTime',
    'server_time',
    'time',
    't',
    'createdAt',
    'created_at',
    'createdAtMs',
    'created_at_ms',
  ]);
  if (raw == null) return null;
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return Number.isFinite(ms) ? ms : null;
};

export const parseGmgnEnvelope = (data: any): { channel?: string; payload?: any } => {
  if (Array.isArray(data) && typeof data[0] === 'string') {
    return { channel: data[0], payload: data[1] };
  }
  if (data && typeof data === 'object') {
    const channel =
      typeof (data as any).channel === 'string'
        ? (data as any).channel
        : typeof (data as any).event === 'string'
          ? (data as any).event
          : typeof (data as any).type === 'string'
            ? (data as any).type
            : undefined;
    if (channel) {
      const payload = (data as any).data ?? (data as any).payload ?? (data as any).body ?? (data as any).msg;
      return { channel, payload: payload ?? data };
    }
  }
  return { payload: data };
};

export const extractGmgnWsConnectionInfo = (url: string): { device_id?: string | null; client_id?: string | null; uuid?: string | null } => {
  try {
    const urlObj = new URL(url);
    const params = new URLSearchParams(urlObj.search);
    return {
      device_id: params.get('device_id'),
      client_id: params.get('client_id'),
      uuid: params.get('uuid'),
    };
  } catch {
    return {};
  }
};
