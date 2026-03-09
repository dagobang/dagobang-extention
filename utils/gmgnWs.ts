export const isObject = (value: any): value is Record<string, any> => !!value && typeof value === 'object';

export const asAddress = (value: any): string | null =>
  typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;

const isEvmAddress = (value: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(value);

const isBase58Address = (value: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

export const toArrayPayload = (payload: any): any[] => {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload) && Array.isArray((payload as any).data)) return (payload as any).data;
  return [];
};

const extractFirst = (value: any, keys: string[]): string | null => {
  if (!isObject(value)) return null;
  for (const key of keys) {
    const v = (value as any)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

const findInObject = (value: any, predicate: (v: any) => boolean): any => {
  if (!isObject(value)) return null;
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInObject(item, predicate);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findInObject(item, predicate);
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
      if (typeof val === 'number' && Number.isFinite(val)) return true;
      if (typeof val === 'string' && val.trim() && Number.isFinite(Number(val))) return true;
    }
    return false;
  });
  if (!found) return null;
  for (const key of keys) {
    const val = (found as any)[key];
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string' && val.trim() && Number.isFinite(Number(val))) return Number(val);
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
    'satl',
    'sat',
  ]);
};

export const extractGmgnTweetText = (payload: any): string | null => {
  if (isObject((payload as any)?.c) && typeof (payload as any).c.t === 'string') return (payload as any).c.t;
  if (typeof (payload as any)?.c === 'string') return (payload as any).c;
  if (typeof (payload as any)?.text === 'string') return (payload as any).text;
  if (typeof (payload as any)?.full_text === 'string') return (payload as any).full_text;
  return null;
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
