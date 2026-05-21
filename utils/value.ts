export const pickFiniteNumber = (next: unknown, prev?: number): number | undefined => {
  return typeof next === 'number' && Number.isFinite(next) ? next : prev;
};

export const normalizePercentValue = (value: number | null | undefined): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value >= 0 && value <= 1) return value * 100;
  return value;
};

export const pickMaxFiniteNumber = (next: unknown, prev?: number): number | undefined => {
  const nextNum = typeof next === 'number' && Number.isFinite(next) ? next : null;
  const prevNum = typeof prev === 'number' && Number.isFinite(prev) ? prev : null;
  if (nextNum == null) return prevNum ?? undefined;
  if (prevNum == null) return nextNum;
  return Math.max(prevNum, nextNum);
};

export const pickMaxPercentValue = (next: unknown, prev?: number): number | undefined => {
  const nextNorm = normalizePercentValue(typeof next === 'number' && Number.isFinite(next) ? next : null);
  const prevNorm = typeof prev === 'number' && Number.isFinite(prev) ? prev : undefined;
  return pickMaxFiniteNumber(nextNorm, prevNorm);
};
