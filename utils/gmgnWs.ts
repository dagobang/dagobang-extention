export const isObject = (value: any): value is Record<string, any> => !!value && typeof value === 'object';

export const asAddress = (value: any): string | null =>
  typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value : null;

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
  const found = findInObject(payload, (v) => {
    if (!isObject(v)) return false;
    const addr = extractFirst(v, ['tokenAddress', 'token_address', 'contract', 'contractAddress', 'contract_address', 'address', 'ca']);
    return !!addr && /^0x[a-fA-F0-9]{40}$/.test(addr);
  });
  if (!found) return null;
  const addr = extractFirst(found, ['tokenAddress', 'token_address', 'contract', 'contractAddress', 'contract_address', 'address', 'ca']);
  return addr && /^0x[a-fA-F0-9]{40}$/.test(addr) ? addr : null;
};

export const extractTweetId = (payload: any, text?: string | null): string | null => {
  const fromText = text?.match(/status\/(\d{10,})/i)?.[1];
  if (fromText) return fromText;
  const found = findInObject(payload, (v) => {
    if (!isObject(v)) return false;
    const id = extractFirst(v, ['tweetId', 'tweet_id', 'statusId', 'status_id', 'id_str', 'id']);
    return !!id && /^\d{6,}$/.test(id);
  });
  if (!found) return null;
  const id = extractFirst(found, ['tweetId', 'tweet_id', 'statusId', 'status_id', 'id_str', 'id']);
  return id && /^\d{6,}$/.test(id) ? id : null;
};

export const extractText = (payload: any): string | null =>
  extractFirstFromObject(payload, ['text', 'full_text', 'content', 'body', 'tweet_text', 'tweet', 'message', 'desc', 'title']);

export const extractUser = (payload: any): string | null =>
  extractFirstFromObject(payload, ['user', 'username', 'screen_name', 'account', 'author', 'name']);

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
