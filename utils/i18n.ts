import zhCN from '@/locales/zh_CN.json';
import zhTW from '@/locales/zh_TW.json';
import en from '@/locales/en.json';

export type Locale = 'zh_CN' | 'zh_TW' | 'en';

const DICTS: Record<Locale, Record<string, any>> = {
  zh_CN: zhCN as any,
  zh_TW: zhTW as any,
  en: en as any,
};

function getByPath(obj: any, path: string): any {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function formatMessage(template: string, subs?: Array<string | number>) {
  if (!subs || subs.length === 0) return template;
  return template.replace(/\{(\d+)\}/g, (_, idx) => {
    const i = Number(idx);
    return subs[i] !== undefined ? String(subs[i]) : `{${idx}}`;
  });
}

export function t(key: string, locale: Locale, subs?: Array<string | number>): string {
  const dict = DICTS[locale] ?? DICTS.zh_CN;
  const fallbackDict = DICTS.zh_CN;
  const value = getByPath(dict, key) ?? getByPath(fallbackDict, key);
  if (typeof value === 'string') return formatMessage(value, subs);
  return key;
}

export function normalizeLocale(input: any): Locale {
  if (input === 'zh_CN' || input === 'zh_TW' || input === 'en') return input;
  return 'zh_CN';
}

