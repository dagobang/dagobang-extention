export function isHexPrivateKey(key: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(key);
}

export const parseNumberLoose = (v: string) => {
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

export const normalizePriceValue = (value: number, decimalsIfGte1 = 4, significantDigitsIfLt1 = 4) => {
  if (!Number.isFinite(value) || value <= 0) return value;
  const abs = Math.abs(value);
  if (!(abs > 0)) return value;

  const trunc = (v: number, factor: number) => {
    if (!Number.isFinite(factor) || factor <= 0) return v;
    return v >= 0 ? Math.floor(v * factor) / factor : Math.ceil(v * factor) / factor;
  };

  if (abs >= 1) {
    const d = Math.max(0, Math.min(18, Math.floor(Number(decimalsIfGte1) || 0)));
    const factor = 10 ** d;
    return trunc(value, factor);
  }

  const sig = Math.max(1, Math.min(18, Math.floor(Number(significantDigitsIfLt1) || 4)));
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.max(0, sig - 1 - exponent);
  const factor = 10 ** Math.min(18, decimals);
  return trunc(value, factor);
};

export const formatPriceValue = (value: number, decimalsIfGte1 = 4, significantDigitsIfLt1 = 4) => {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const abs = Math.abs(value);
  if (!(abs > 0)) return '-';

  const d = Math.max(0, Math.min(18, Math.floor(Number(decimalsIfGte1) || 0)));
  const sig = Math.max(1, Math.min(18, Math.floor(Number(significantDigitsIfLt1) || 4)));

  const normalized = normalizePriceValue(value, d, sig);
  if (!Number.isFinite(normalized) || normalized <= 0) return '-';

  if (abs >= 1) {
    const s = normalized.toFixed(d);
    return s.replace(/\.?0+$/, '');
  }

  if (abs < 1e-18) return normalized.toExponential(Math.max(0, sig - 1));
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.max(0, sig - 1 - exponent);
  const s = normalized.toFixed(Math.min(18, decimals));
  return s.replace(/\.?0+$/, '');
};

export const formatTime = (ms: number, locale: string = 'zh_CN') => {
  const jsLocale = locale === 'zh_TW' ? 'zh-TW' : locale === 'en' ? 'en-US' : 'zh-CN';
  try {
    return new Date(ms).toLocaleString(jsLocale, { hour12: false });
  } catch {
    return new Date(ms).toISOString();
  }
};


 export const formatBroadcastProvider = (via?: string, url?: string) => {
    if (via === 'bloxroute') return 'BloxRoute';
    if (via !== 'rpc') return '-';
    if (!url) return 'RPC';
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host.includes('blxrbdn.com')) return 'BloxRoute RPC';
      if (host.includes('publicnode.com')) return 'PublicNode';
      if (host.includes('nodereal.io')) return 'NodeReal';
      if (host.includes('bnbchain.org')) return 'BNB Chain';
      if (host.includes('defibit.io')) return 'Defibit';
      if (host.includes('nariox.org')) return 'Nariox';
      if (host.includes('ninicoin.io')) return 'NiniCoin';
      if (host.includes('chainstack.com')) return 'Chainstack';
      if (host.includes('getblock')) return 'GetBlock';
      if (host.includes('blockrazor.xyz')) return 'BlockRazor';
      return host;
    } catch {
      return 'RPC';
    }
  };
