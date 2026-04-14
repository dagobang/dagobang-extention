export type BroadcastErrorClass = 'nonce' | 'already_known' | 'other';

const BROADCAST_ALREADY_KNOWN_PATTERNS = [
  'already known',
  'known transaction',
  'already imported',
  'already exists',
  'already in mempool',
] as const;

const BROADCAST_NONCE_PATTERNS = [
  'nonce too low',
  'nonce is too low',
  'nonce too high',
  'nonce is too high',
  'nonce has already been used',
  'future transaction',
  'replacement transaction underpriced',
  'transaction underpriced',
  'replacement',
] as const;

const NONCE_TOO_HIGH_PATTERNS = [
  'nonce too high',
  'nonce is too high',
  'future transaction',
] as const;

const NONCE_TOO_LOW_PATTERNS = [
  'nonce too low',
  'nonce is too low',
  'nonce has already been used',
  'already known',
  'known transaction',
  'replacement transaction underpriced',
  'transaction underpriced',
] as const;

function includesAny(haystack: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

export function collectErrorText(e: any, lowercase = true): string {
  const texts: string[] = [];
  const push = (v: any) => {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (!t) return;
    texts.push(lowercase ? t.toLowerCase() : t);
  };
  push(e?.shortMessage);
  push(e?.message);
  push(e?.details);
  push(e?.cause?.message);
  push(e?.cause?.details);
  if (Array.isArray(e?.metaMessages)) {
    for (const x of e.metaMessages) push(x);
  }
  return texts.join(' | ');
}

export function classifyBroadcastError(msg: string): BroadcastErrorClass {
  const m = msg.toLowerCase();
  if (includesAny(m, BROADCAST_ALREADY_KNOWN_PATTERNS)) return 'already_known';
  if (includesAny(m, BROADCAST_NONCE_PATTERNS)) return 'nonce';
  return 'other';
}

export function getNonceErrorKindFromText(msg: string): 'too_high' | 'too_low' | 'other' {
  const m = msg.toLowerCase();
  if (includesAny(m, NONCE_TOO_HIGH_PATTERNS)) return 'too_high';
  if (includesAny(m, NONCE_TOO_LOW_PATTERNS)) return 'too_low';
  if (m.includes('nonce') || m.includes('replacement')) return 'other';
  return 'other';
}

export function extractNextNonceHintFromText(msg: string): number | null {
  const patterns = [
    /next nonce\s+(\d+)\s*,?\s*tx nonce\s+(\d+)/i,
    /nonce too low:\s*address[^,]*,\s*tx:\s*(\d+)\s*state:\s*(\d+)/i,
    /account has nonce of\s*(\d+)\s*tx has nonce of\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(msg);
    if (!m) continue;
    let hinted: number;
    if (re === patterns[0]) hinted = Number(m[1]);
    else if (re === patterns[1]) hinted = Number(m[2]);
    else hinted = Number(m[1]);
    if (Number.isFinite(hinted) && hinted >= 0) return Math.floor(hinted);
  }
  return null;
}

export function isAllowanceLikeText(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('allowance') ||
    m.includes('insufficient allowance') ||
    m.includes('transfer amount exceeds allowance') ||
    m.includes('erc20: insufficient allowance') ||
    m.includes('fs2')
  );
}
