export function isHexPrivateKey(key: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(key);
}

export const parseNumberLoose = (v: string) => {
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};
export const formatAmount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  const truncByFactor = (v: number, factor: number) => {
    if (v >= 0) return Math.floor(v * factor) / factor;
    return Math.ceil(v * factor) / factor;
  };

  if (abs >= 1) {
    const truncated = truncByFactor(value, 100);
    return (truncated.toFixed(2));
  }

  if (abs < 1e-15) return value.toExponential(2);
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.max(0, 1 - exponent);
  const factor = 10 ** decimals;
  if (!Number.isFinite(factor) || factor <= 0) return String(value);
  const truncated = truncByFactor(value, factor);
  return truncated.toFixed(decimals);
};

export const formatTime = (ms: number, locale: string = 'zh_CN') => {
  const jsLocale = locale === 'zh_TW' ? 'zh-TW' : locale === 'en' ? 'en-US' : 'zh-CN';
  try {
    return new Date(ms).toLocaleString(jsLocale, { hour12: false });
  } catch {
    return new Date(ms).toISOString();
  }
};
